// Chain monitoring helpers: confirmation polling and refund-height
// countdowns. Pure glue around our own bitcoind (BTC, via the swap
// API, falling back to public indexers — see btc-api.js) and the
// Fistbump explorer API (FBC). Callers wire the return values into
// UI — this module never touches the DOM itself.
//
// Polling strategy: start fast (5s) while the tx is young, back off
// to 20s once confirmations are accumulating and the user is just
// waiting out time. Each pollTx returns a stopper so the caller can
// cancel when the user navigates away or the swap advances.

import { btcFetch } from "./btc-api.js";

const FBC_API_BASE = "https://explorer.fistbump.org";
const FBC_API = `${FBC_API_BASE}/api`;

const BTC_BLOCK_SECONDS = 600;
const FBC_BLOCK_SECONDS = 120;

/**
 * Poll a BTC tx's confirmation count. `onUpdate({confirmations, tip})`
 * is called each time a new tip is observed. Returns a function that
 * stops the poll.
 */
export function pollBtcConfirmations(txid, onUpdate) {
  return startPoller(async () => {
    const [txStatus, tip] = await Promise.all([
      btcFetch(`/tx/${txid}/status`).then((r) => (r.ok ? r.json() : null)),
      btcFetch(`/blocks/tip/height`).then((r) => (r.ok ? r.text() : null)),
    ]);
    const tipH = tip !== null ? Number(tip) : null;
    let confirmations = 0;
    if (txStatus && txStatus.confirmed && txStatus.block_height && Number.isFinite(tipH)) {
      confirmations = Math.max(0, tipH - txStatus.block_height + 1);
    }
    onUpdate({ confirmations, tip: tipH, confirmed: !!txStatus?.confirmed });
  });
}

/**
 * Poll an FBC tx's confirmation count. The FBC explorer API returns
 * block height on a /tx/<txid> endpoint — we compute confirmations
 * against the latest block from /blocks.
 */
export function pollFbcConfirmations(txid, onUpdate) {
  return startPoller(async () => {
    // Was hitting `${FBC_API}/tx/${txid}`, which the explorer serves as an
    // HTML page — so this reported 0 confirmations forever.
    const res = await fetch(`${FBC_API_BASE}/tx/${txid}?json=1`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      onUpdate({ confirmations: 0, tip: null, confirmed: false });
      return;
    }
    const d = await res.json();
    onUpdate({
      confirmations: Number(d.confirmations) || 0,
      tip: Number(d.chain_tip) || null,
      confirmed: d.found === true && d.confirmed === true,
    });
  });
}

export async function fetchBtcFeeRate() {
  // Blockstream Esplora fee-estimates returns { "1": N, "3": N, "6": N, ... }
  // where key = target blocks, value = sat/vB. Use target 3 (~30 min).
  // Floor at 3 sat/vB: HTLC claims are time-sensitive and sub-1 sat/vB
  // txs may never relay.
  // Ceiling at 500 sat/vB: a Blockstream hiccup returning nonsense (or a
  // real pathological fee market) shouldn't be able to drain a 50k-sat HTLC
  // into fees. 500 sat/vB is already ~75k sats on a 150-vbyte claim, which
  // exceeds the dust floor we enforce; if the real rate is above this the
  // user should be signing manually with Sparrow anyway.
  const FLOOR = 3;
  const CEILING = 500;
  try {
    const res = await btcFetch(`/fee-estimates`);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const rate = Number(j["3"]);
    const chosen = rate > 0 && isFinite(rate) ? Math.ceil(rate) : 20;
    return Math.min(Math.max(chosen, FLOOR), CEILING);
  } catch {
    return 20;
  }
}

/**
 * What a transaction actually paid, in sat/vB, or null if it cannot be read.
 *
 * This exists so a stalled swap can explain itself. A funding transaction that
 * underpaid sits unconfirmed while the maker waits for six confirmations, and
 * with nothing on screen but "0/6" that is indistinguishable from a broken
 * page — which is exactly how one real swap was experienced.
 *
 * null, never 0, when unknown. Zero is a rate a caller would warn about, and
 * "we could not tell" is not something to warn about.
 */
export async function fetchBtcTxFeeRate(txid) {
  try {
    const res = await btcFetch(`/tx/${txid}`);
    if (!res.ok) return null;
    const tx = await res.json();
    const vbytes = Number(tx?.weight) / 4;
    const fee = Number(tx?.fee);
    if (!Number.isFinite(fee) || !Number.isFinite(vbytes) || vbytes <= 0) return null;
    return fee / vbytes;
  } catch {
    return null;
  }
}

/**
 * Confirmations on one BTC transaction, or 0 when it is unconfirmed.
 *
 * null means "could not tell" and is deliberately distinct from 0: an
 * unreachable source and a transaction that has not landed are different
 * facts, and only one of them is a reason to rebroadcast.
 */
export async function fetchBtcConfirmations(txid) {
  if (!txid) return null;
  try {
    const [status, tip] = await Promise.all([
      btcFetch(`/tx/${txid}/status`).then((r) => (r.ok ? r.json() : null)),
      btcFetch(`/blocks/tip/height`).then((r) => (r.ok ? r.text() : null)),
    ]);
    if (!status) return null;
    if (!status.confirmed || !status.block_height) return 0;
    const tipH = Number(tip);
    if (!Number.isFinite(tipH)) return null;
    return Math.max(0, tipH - status.block_height + 1);
  } catch {
    return null;
  }
}

/**
 * Push an already-signed transaction again.
 *
 * For a refund that was accepted for relay and then evicted. The signed hex is
 * kept precisely so this needs no wallet and no re-derivation of the HTLC —
 * the transaction is already correct, it simply is not in a mempool any more.
 *
 * A node that already has it answers with an error rather than a txid. That is
 * a success as far as the caller is concerned, so the message is passed
 * through intact for them to classify rather than being flattened here.
 */
export async function rebroadcastRawTx(rawHex) {
  const res = await btcFetch(`/tx`, { method: "POST", body: rawHex });
  const text = (await res.text()).trim();
  if (!res.ok) throw new Error(text || `broadcast failed (HTTP ${res.status})`);
  return text;
}

/** One-shot tip reads. Used to validate offer heights before locking funds. */
export async function fetchBtcTip() {
  const res = await btcFetch(`/blocks/tip/height`);
  if (!res.ok) throw new Error(`BTC tip unavailable (${res.status})`);
  const n = Number(await res.text());
  if (!Number.isInteger(n) || n <= 0) throw new Error("BTC tip is not a height");
  return n;
}

export async function fetchFbcTip() {
  const res = await fetch(`${FBC_API}/blocks?limit=1`);
  if (!res.ok) throw new Error(`FBC tip unavailable (${res.status})`);
  const blocks = await res.json();
  const h = Array.isArray(blocks) && blocks[0] ? Number(blocks[0].height) : NaN;
  if (!Number.isInteger(h) || h <= 0) throw new Error("FBC tip is not a height");
  return h;
}

/**
 * Read one output of a BTC transaction, plus its confirmation count.
 *
 * Verifying a counterparty's `funded_btc` blob against the offer proves the
 * blob is self-consistent; it proves nothing about the chain. Without this the
 * blob can name any transaction at all and the recipient funds their own leg
 * against an outpoint that pays someone else.
 */
export async function fetchBtcOutput(txid, vout) {
  const [txRes, tipRes] = await Promise.all([
    btcFetch(`/tx/${txid}`),
    btcFetch(`/blocks/tip/height`),
  ]);
  if (!txRes.ok) return null;
  const tx = await txRes.json();
  const tipH = tipRes.ok ? Number(await tipRes.text()) : NaN;
  const out = (tx.vout || [])[vout];
  if (!out) return null;

  const blockH = tx.status?.block_height ?? null;
  const confirmations =
    blockH != null && Number.isFinite(tipH) ? Math.max(0, tipH - Number(blockH) + 1) : 0;

  return {
    address: out.scriptpubkey_address ?? null,
    value: Number(out.value),
    confirmations,
    tip: Number.isFinite(tipH) ? tipH : null,
  };
}

/**
 * Read one output of an FBC transaction, plus its confirmation count.
 *
 * This is how a counterparty's `funded_fbc` claim gets checked against the
 * chain rather than taken on trust. Returns `{address, value, confirmations}`;
 * `confirmations` is 0 while the tx is unconfirmed, and the caller MUST treat
 * an unconfirmed funding output as unusable — claiming against one leaks the
 * preimage while the funding tx can still be replaced.
 */
export async function fetchFbcOutput(txid, vout) {
  // Returns null for "could not read the chain" and throws for "the chain says
  // something wrong". Those are different: the first is a degraded state a
  // user may knowingly accept, the second never is.
  //
  // `?json=1` is content negotiation on the explorer's normal page routes —
  // same lookup, same queries, JSON instead of HTML.
  let res;
  try {
    res = await fetch(`${FBC_API_BASE}/tx/${txid}?json=1`, {
      headers: { Accept: "application/json" },
    });
  } catch {
    return null; // network/CORS — unreadable, not absent
  }
  // 404 is a real answer: the explorer looked and this tx is not on chain yet.
  if (res.status === 404) {
    return { found: false, confirmations: 0, address: null, value: null, tip: null };
  }
  if (!res.ok) return null;

  let d;
  try {
    d = await res.json();
  } catch {
    return null; // HTML error page or a proxy in the way
  }
  if (!d || d.found !== true) {
    return { found: false, confirmations: 0, address: null, value: null, tip: d?.chain_tip ?? null };
  }

  const out = (d.vout || d.outputs || [])[vout];
  if (!out) {
    throw new Error(`transaction ${txid} has no output ${vout}`);
  }
  return {
    found: true,
    address: out.address ?? null,
    value: Number(out.value),
    confirmations: Number(d.confirmations) || 0,
    tip: Number(d.chain_tip) || null,
  };
}

/** Poll a chain's tip height on an interval. Used for refund countdowns. */
export function pollBtcTip(onUpdate) {
  return startPoller(async () => {
    const res = await btcFetch(`/blocks/tip/height`);
    if (!res.ok) return;
    const n = Number(await res.text());
    if (Number.isInteger(n) && n >= 0) onUpdate(n);
  }, 30_000);
}

export function pollFbcTip(onUpdate) {
  return startPoller(async () => {
    const res = await fetch(`${FBC_API}/blocks?limit=1`);
    if (!res.ok) return;
    const blocks = await res.json();
    const h = Array.isArray(blocks) && blocks[0] && Number(blocks[0].height);
    if (Number.isInteger(h) && h > 0) onUpdate(h);
  }, 15_000);
}

/**
 * Find the transaction that spends `fundingTxid:fundingVout` on FBC and
 * return the preimage from its witness — but only if that preimage actually
 * hashes to `expectedHashlockHex`.
 *
 * The verification is the point. This value is read from a public explorer
 * over the network, and it is the input to a transaction that moves the
 * caller's money. An explorer that is buggy, stale, or hostile could return
 * any 64 hex characters; hashing them against the hashlock the caller already
 * holds is what makes the answer trustworthy without trusting the source.
 *
 * Returns null while the spend does not exist yet, and also when a spend
 * exists but is a refund rather than a claim — the counterparty timing out is
 * not an error, it just never produces a preimage.
 */
async function findFbcOutspendPreimage(
  fundingTxid,
  fundingVout,
  htlcAddress,
  expectedHashlockHex,
) {
  const spend = await fetchFbcOutspend(fundingTxid, fundingVout, htlcAddress);
  if (!spend || !spend.spent || !spend.txid) return null;

  const witness = spend.witness || (await fetchFbcWitness(spend.txid, fundingTxid, fundingVout));
  if (!Array.isArray(witness)) return null;

  // Claim spends the hashlock branch: [sig, preimage, 0x01, script]. A refund
  // takes the other branch and is one element shorter, with no secret in it.
  if (witness.length < 4) return null;
  const candidate = String(witness[1] || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(candidate)) return null;
  if (!(await preimageMatchesHashlock(candidate, expectedHashlockHex))) return null;

  return { preimageHex: candidate, spendingTxid: spend.txid };
}

/**
 * SHA-256 the candidate and compare against the hashlock from our own HTLC
 * script. WebCrypto rather than a bundled hash so this module keeps no
 * dependencies; it is present in every browser that can run the rest of this.
 *
 * A caller that supplies no hashlock gets `false`, not a pass. "I could not
 * check" and "it checks out" are different answers, and only one of them
 * should unlock a claim button.
 */
async function preimageMatchesHashlock(preimageHex, expectedHashlockHex) {
  if (!/^[0-9a-f]{64}$/.test(String(expectedHashlockHex || "").toLowerCase())) {
    return false;
  }
  try {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(preimageHex.slice(i * 2, i * 2 + 2), 16);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let hex = "";
    for (const b of digest) hex += b.toString(16).padStart(2, "0");
    return hex === expectedHashlockHex.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Ask the explorer what spent an outpoint.
 *
 * `/tx/:txid/outspend/:vout` carries the witness inline, so the common case is
 * one request. The address scan is the fallback for an explorer that has not
 * deployed that route.
 *
 * The fallback fetches each candidate transaction in full rather than reading
 * inputs off the address listing, because the listing does not carry them —
 * an earlier version looped over `t.vin` on a payload that has no `vin`, so it
 * matched nothing, ever, while looking like a working safety net. That is the
 * same shape as the bug this whole path exists to fix: three endpoint probes
 * that all failed silently and left the preimage watch permanently dark.
 */
const ADDRESS_SCAN_LIMIT = 20;

async function fetchFbcOutspend(fundingTxid, fundingVout, htlcAddress) {
  try {
    const res = await fetch(`${FBC_API_BASE}/tx/${fundingTxid}/outspend/${fundingVout}`);
    if (res.ok) return await res.json();
  } catch { /* fall through to the address scan */ }

  if (!htlcAddress) return null;
  try {
    const res = await fetch(`${FBC_API_BASE}/address/${htlcAddress}?json=1`);
    if (!res.ok) return null;
    const data = await res.json();
    const txs = Array.isArray(data.txs || data.transactions)
      ? data.txs || data.transactions
      : [];
    // An HTLC address sees the funding tx and, at most, the tx that spends it.
    // The cap is there so a reused or dusted address cannot turn one poll tick
    // into an unbounded fetch storm.
    for (const t of txs.slice(0, ADDRESS_SCAN_LIMIT)) {
      const txid = t.hash || t.txid;
      if (!txid || txid === fundingTxid) continue;
      const witness = await fetchFbcWitness(txid, fundingTxid, fundingVout);
      if (witness) return { spent: true, txid, witness };
    }
  } catch { /* keep polling */ }
  return null;
}

/** The witness of the input that spent our outpoint, from the spending tx. */
async function fetchFbcWitness(spenderTxid, fundingTxid, fundingVout) {
  try {
    const res = await fetch(`${FBC_API_BASE}/tx/${spenderTxid}?json=1`);
    if (!res.ok) return null;
    const tx = await res.json();
    for (const inp of tx.vin || tx.inputs || []) {
      const inTxid = inp.prevout_hash || inp.txid;
      const inVout = inp.prevout_index ?? inp.vout;
      if (inTxid === fundingTxid && Number(inVout) === Number(fundingVout)) {
        return inp.witness || null;
      }
    }
  } catch { /* keep polling */ }
  return null;
}

/**
 * Continuously look for a spend of `fundingTxid:fundingVout` on FBC. When one
 * appears whose witness carries a preimage matching `expectedHashlockHex`,
 * `onFound({preimageHex, spendingTxid})` fires once and polling stops.
 *
 * `expectedHashlockHex` is required. Without it there is no way to tell a real
 * preimage from 64 hex characters an explorer happened to return, and the
 * caller's next move is to spend money on the answer.
 */
export function pollFbcPreimageReveal(
  fundingTxid,
  fundingVout,
  htlcAddress,
  expectedHashlockHex,
  onFound,
) {
  let cancelled = false;
  let stopFn = null;
  stopFn = startPoller(async () => {
    if (cancelled) return;
    const hit = await findFbcOutspendPreimage(
      fundingTxid,
      fundingVout,
      htlcAddress,
      expectedHashlockHex,
    );
    if (hit && !cancelled) {
      cancelled = true;
      if (stopFn) stopFn();
      onFound(hit);
    }
  });
  return () => { cancelled = true; if (stopFn) stopFn(); };
}

/**
 * Generic polling loop. Uses an accelerating cadence: 5s while early,
 * 20s once stable, 60s after a minute of no change. Always calls `fn`
 * once immediately before scheduling the first delay.
 */
function startPoller(fn, fixedInterval) {
  let cancelled = false;
  let timer = null;
  let tick = 0;

  const schedule = (delay) => {
    if (cancelled) return;
    timer = setTimeout(run, delay);
  };

  const run = async () => {
    tick++;
    try { await fn(); } catch { /* swallow — individual failures shouldn't abort the poll */ }
    if (cancelled) return;
    const delay = fixedInterval ?? (tick < 6 ? 5_000 : tick < 12 ? 20_000 : 60_000);
    schedule(delay);
  };

  run();

  return () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Convert a block-height delta on BTC/FBC to an approximate wall-clock
 * string. Rough — miners are stochastic — but good enough for a
 * "refund in ~3h 20m" UI.
 */
export function estimateWallClock(blocksRemaining, chain) {
  const secs = blocksRemaining * (chain === "btc" ? BTC_BLOCK_SECONDS : FBC_BLOCK_SECONDS);
  if (secs <= 0) return "now";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 24) return `~${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `~${h}h ${m}m`;
  return `~${m}m`;
}

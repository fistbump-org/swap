// Fistbump swap frontend. Pure client-side — no backend, no custody.
//
// Delegates all signing to the user's wallets:
//   - FBC side: window.fistbump (Fistbump browser extension)
//   - BTC side: window.unisat (Unisat / compatible BIP-174 wallet)
//
// This file exists to:
//   1. Walk the user through the protocol step-by-step.
//   2. Construct HTLC scripts + addresses via @fistbump/swap-core.
//   3. Encode/decode offer and accept blobs.
//   4. Invoke wallet APIs for signing and broadcast.
//
// All cryptographic work happens in the core library and in the wallets.

import {
  buildHTLCScript,
  parseHTLCScript,
  btcHTLCAddress,
  fbcHTLCAddress,
  generatePreimage,
  hashlockOf,
  generateOfferId,
  encodeBlob,
  decodeBlob,
  htlcsFromOfferAccept,
  verifyFundedBtc,
  verifyFundedFbc,
  toHex,
  fromHex,
  buildHTLCSpendPsbt,
  finalizeHTLCSpend,
  signAndFinalizeWithWIF,
  blobQrDataUrl,
} from "./core/bundle.js";

import { loadState, patchState, clearState, hasState } from "./state.js";
import {
  pollBtcConfirmations,
  pollFbcConfirmations,
  pollBtcTip,
  pollFbcTip,
  pollFbcPreimageReveal,
  estimateWallClock,
} from "./chain.js";

const params = new URLSearchParams(location.search);
const BTC_NETWORK = "main";
const FBC_NETWORK = "main";

// ---- UI primitives: toast + modal confirm + field-note helper ----
//
// Inline (not a separate module) because the whole app is one file and
// shipping another module just for three helpers isn't worth the round-trip.

const TOAST_STACK = document.getElementById("toast-stack");

function showToast(message, kind) {
  if (!TOAST_STACK) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? ` ${kind}` : "");
  el.textContent = message;
  TOAST_STACK.appendChild(el);
  const lifespan = kind === "error" ? 5200 : 2600;
  setTimeout(() => {
    el.classList.add("fade-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, lifespan);
}

function setFieldNote(el, message, kind) {
  if (!el) return;
  el.textContent = message || "";
  el.classList.remove("ok", "warn", "error");
  if (kind) el.classList.add(kind);
}

// Background browser notifications. Fired when a poller flips a state the
// user was waiting on — they may have gone to do something else while a
// BTC tx accrues confirmations, and we'd rather tap them on the shoulder
// than expect them to watch the tab.
//
// Permission is requested lazily: the first call with a not-yet-decided
// prompt kicks off Notification.requestPermission(). Subsequent calls
// honour whatever the user chose. We never spam: `notifyOnce(key, …)`
// guarantees a given event fires at most once per page load.
const NOTIFIED_KEYS = new Set();

async function maybeRequestNotificationPermission() {
  if (!("Notification" in window)) return "denied";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

function notify(title, body) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, icon: "./favicon-96x96.png" });
  } catch (err) {
    console.warn("notify failed:", err);
  }
}

function notifyOnce(key, title, body) {
  if (NOTIFIED_KEYS.has(key)) return;
  NOTIFIED_KEYS.add(key);
  notify(title, body);
}

// Modal-based replacement for the native `confirm()` prompt. Returns a
// promise that resolves to true if the user confirms, false otherwise.
// `danger=true` styles the confirm button red for destructive actions.
function confirmModal({ title, body, confirmLabel, cancelLabel, danger }) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    backdrop.appendChild(modal);

    const h = document.createElement("h3");
    h.textContent = title;
    modal.appendChild(h);

    const p = document.createElement("p");
    p.textContent = body;
    modal.appendChild(p);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn";
    cancel.textContent = cancelLabel || "Cancel";
    actions.appendChild(cancel);

    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "btn primary";
    if (danger) confirm.style.cssText = "background: var(--fb-red); border-color: var(--fb-red);";
    confirm.textContent = confirmLabel || "Confirm";
    actions.appendChild(confirm);

    modal.appendChild(actions);
    document.body.appendChild(backdrop);
    confirm.focus();

    const close = (ok) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(ok);
    };
    const onKey = (e) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };
    cancel.addEventListener("click", () => close(false));
    confirm.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(false); });
    document.addEventListener("keydown", onKey);
  });
}

// Blockstream Esplora for BTC data + broadcast. 3xpl for explorer links.
const BTC_API = "https://blockstream.info/api";
const BTC_EXPLORER = "https://3xpl.com/bitcoin/transaction";
const FBC_EXPLORER = "https://explorer.fistbump.org";
const FBC_API = "https://explorer.fistbump.org/api";

// Block time heuristics for converting refund-window hours → block heights.
// These match SPEC.md §4.2 defaults.
const BTC_BLOCK_SECONDS = 600;
const FBC_BLOCK_SECONDS = 120;

// Dust floors per SPEC.md §8. Rejections go through validateOffer().
const MIN_AMOUNT_BTC_SAT = 10_000;
const MIN_AMOUNT_FBC_DOLLARYDOOS = 1_000_000;

// Reference-height staleness guard from SPEC.md §4.3. If the offer says
// btc/fbc tip was N blocks behind the accepter's observed tip, reject —
// the parties are out of sync and T1/T2 estimates can't be compared safely.
const MAX_REF_HEIGHT_STALENESS_BTC = 10;
const MAX_REF_HEIGHT_STALENESS_FBC = 20;

// Wall-clock buffer floor from SPEC.md §4.2: T2 − T1 ≥ 12 hours.
const MIN_DELTA_HOURS = 12;

/**
 * Validate an offer before Bob acts on it, or before Alice re-funds against
 * a stored one. Returns { ok: true } or { ok: false, reason }. Centralised
 * so all call-sites stay consistent.
 *
 * `observed` carries the accepter's current view of BTC+FBC tips; when
 * omitted the staleness check is skipped (useful for Alice re-opening her
 * own offer without making explorer calls).
 */
function validateOffer(offer, observed) {
  if (!offer || typeof offer !== "object") return { ok: false, reason: "not an offer" };
  if (offer.version !== 1 || offer.kind !== "offer") {
    return { ok: false, reason: "wrong blob version or kind" };
  }
  if (!offer.network || offer.network.btc !== BTC_NETWORK || offer.network.fbc !== FBC_NETWORK) {
    return {
      ok: false,
      reason: `offer is for ${offer.network?.btc}/${offer.network?.fbc}, this site is ${BTC_NETWORK}/${FBC_NETWORK}`,
    };
  }
  if (!Number.isInteger(offer.amount_btc) || offer.amount_btc < MIN_AMOUNT_BTC_SAT) {
    return { ok: false, reason: `amount_btc must be ≥ ${MIN_AMOUNT_BTC_SAT.toLocaleString()} sat` };
  }
  if (!Number.isInteger(offer.amount_fbc) || offer.amount_fbc < MIN_AMOUNT_FBC_DOLLARYDOOS) {
    return {
      ok: false,
      reason: `amount_fbc must be ≥ ${MIN_AMOUNT_FBC_DOLLARYDOOS.toLocaleString()} dollarydoos (1 FBC)`,
    };
  }
  // Safety buffer (SPEC §4.2): T2 - T1 in wall-clock seconds, computed from
  // each chain's own reference tip. Raw-height comparison would be meaningless
  // since BTC and FBC heights advance on independent chains.
  const btcSecondsToT1 = (offer.btc_refund_height - offer.btc_reference_height) * BTC_BLOCK_SECONDS;
  const fbcSecondsToT2 = (offer.fbc_refund_height - offer.fbc_reference_height) * FBC_BLOCK_SECONDS;
  const deltaHours = (fbcSecondsToT2 - btcSecondsToT1) / 3600;
  if (deltaHours < MIN_DELTA_HOURS) {
    return {
      ok: false,
      reason: `Δ = ${deltaHours.toFixed(1)}h, must be ≥ ${MIN_DELTA_HOURS}h (SPEC §4.2)`,
    };
  }
  if (offer.expires_at) {
    const expiry = Date.parse(offer.expires_at);
    if (!Number.isNaN(expiry) && expiry < Date.now()) {
      return { ok: false, reason: `offer expired at ${offer.expires_at}` };
    }
  }
  if (observed) {
    if (Number.isInteger(observed.btcTip) &&
        offer.btc_reference_height < observed.btcTip - MAX_REF_HEIGHT_STALENESS_BTC) {
      return {
        ok: false,
        reason: `BTC reference height ${offer.btc_reference_height} is > ${MAX_REF_HEIGHT_STALENESS_BTC} blocks behind current tip ${observed.btcTip}`,
      };
    }
    if (Number.isInteger(observed.fbcTip) &&
        offer.fbc_reference_height < observed.fbcTip - MAX_REF_HEIGHT_STALENESS_FBC) {
      return {
        ok: false,
        reason: `FBC reference height ${offer.fbc_reference_height} is > ${MAX_REF_HEIGHT_STALENESS_FBC} blocks behind current tip ${observed.fbcTip}`,
      };
    }
  }
  return { ok: true };
}

// Session state for the Alice role.
const alice = {
  btc: null,
  fbc: null,
  preimage: null,
  hashlock: null,
  offerId: null,
  offer: null,
  accept: null,
  btcScript: null,
  fbcScript: null,
  btcFundedTxid: null,
  btcFundedVout: null,
};

// Session state for the Bob role.
const bob = {
  fbc: null,
  btc: null,
  offer: null,
  accept: null,
  btcScript: null,
  fbcScript: null,
  fbcFundedTxid: null,
  fbcFundedVout: null,
};

// ---- Role switch ----

const roleAlice = document.getElementById("role-alice");
const roleBob = document.getElementById("role-bob");
const flowAlice = document.getElementById("flow-alice");
const flowBob = document.getElementById("flow-bob");

function selectRole(name) {
  const isAlice = name === "alice";
  roleAlice.setAttribute("aria-selected", String(isAlice));
  roleBob.setAttribute("aria-selected", String(!isAlice));
  flowAlice.classList.toggle("hidden", !isAlice);
  flowBob.classList.toggle("hidden", isAlice);
  // Refresh the in-progress pill on role switch so the indicator on the
  // now-inactive tab picks up any changes written since the last tick.
  if (typeof updateRolePill === "function") updateRolePill();
}
roleAlice.addEventListener("click", () => selectRole("alice"));
roleBob.addEventListener("click", () => selectRole("bob"));

// ---- Wallet connection helpers ----

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("connected", "error");
  if (kind) el.classList.add(kind);
}

async function connectFistbump() {
  if (!window.fistbump || !window.fistbump.isFistbump) {
    throw new Error(
      "Fistbump wallet extension not found. Install the Fistbump desktop wallet.",
    );
  }
  const conn = await window.fistbump.connect();
  const { pubkey } = await window.fistbump.getPublicKey();
  return { address: conn.address, pubkey };
}

async function connectUnisat() {
  if (!window.unisat) {
    throw new Error(
      "Unisat wallet not found. Install Unisat, Xverse, or another BIP-174 wallet.",
    );
  }
  const accounts = await window.unisat.requestAccounts();
  if (!accounts || !accounts[0]) throw new Error("No Bitcoin account available");
  const pubkey = await window.unisat.getPublicKey();
  return { address: accounts[0], pubkey };
}

// ---- Alice: wallet connect ----

document.getElementById("btc-connect").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-status");
  try {
    setStatus(statusEl, "connecting…", null);
    alice.btc = await connectUnisat();
    setStatus(statusEl, alice.btc.address, "connected");
    updateAliceBuildOfferEnabled();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

document.getElementById("fbc-connect").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-status");
  try {
    setStatus(statusEl, "connecting…", null);
    alice.fbc = await connectFistbump();
    setStatus(statusEl, alice.fbc.address, "connected");
    updateAliceBuildOfferEnabled();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

// ---- Alice: offer building ----

const amountBtcInput = document.getElementById("amount-btc");
const amountFbcInput = document.getElementById("amount-fbc");
const btcHoursInput = document.getElementById("btc-hours");
const fbcHoursInput = document.getElementById("fbc-hours");
const timelockNote = document.getElementById("timelock-note");
const buildOfferBtn = document.getElementById("build-offer");

function updateTimelockNote() {
  const btcH = Number(btcHoursInput.value);
  const fbcH = Number(fbcHoursInput.value);
  if (fbcH - btcH < MIN_DELTA_HOURS) {
    timelockNote.textContent =
      `FBC window must exceed BTC window by at least ${MIN_DELTA_HOURS} hours. Currently ${fbcH - btcH} hrs.`;
    timelockNote.classList.remove("ok");
    timelockNote.classList.add("error");
  } else {
    timelockNote.textContent = `Your funds refund ${btcH}h after broadcast; their FBC refund is ${fbcH}h.`;
    timelockNote.classList.remove("error");
    timelockNote.classList.add("ok");
  }
}
[btcHoursInput, fbcHoursInput].forEach((el) =>
  el.addEventListener("input", () => {
    updateTimelockNote();
    updateAliceBuildOfferEnabled();
  }),
);
[amountBtcInput, amountFbcInput].forEach((el) =>
  el.addEventListener("input", updateAliceBuildOfferEnabled),
);
updateTimelockNote();

function updateAliceBuildOfferEnabled() {
  const amtBtcSat = Math.round(Number(amountBtcInput.value) * 1e8);
  const amtFbcDd = Math.round(Number(amountFbcInput.value) * 1e6);
  const btcH = Number(btcHoursInput.value);
  const fbcH = Number(fbcHoursInput.value);
  const valid =
    alice.btc &&
    alice.fbc &&
    amtBtcSat >= MIN_AMOUNT_BTC_SAT &&
    amtFbcDd >= MIN_AMOUNT_FBC_DOLLARYDOOS &&
    btcH >= 1 &&
    fbcH >= 2 &&
    fbcH - btcH >= MIN_DELTA_HOURS;
  buildOfferBtn.disabled = !valid;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scan a Bitcoin tx for the output paying `address`, returning its vout
 * index. Polls Blockstream up to `tries` times with exponential-ish backoff
 * because the indexer may not have the tx yet right after broadcast.
 *
 * Throws if the tx still isn't indexed after all tries — the caller is
 * expected to surface this to the user rather than fall back to vout=0,
 * which would produce an invalid funded_btc blob.
 */
async function resolveFundingVout(txid, address, statusEl) {
  const TRIES = 6;
  const DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 13000];
  let lastErr = null;
  for (let i = 0; i < TRIES; i++) {
    try {
      const res = await fetch(`${BTC_API}/tx/${txid}`);
      if (res.ok) {
        const txData = await res.json();
        const idx = txData.vout.findIndex(
          (o) => o.scriptpubkey_address === address,
        );
        if (idx >= 0) return idx;
        throw new Error("tx has no output paying the HTLC address");
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    if (statusEl) {
      setFieldNote(
        statusEl,
        `Waiting for Blockstream indexer to pick up tx… (${i + 1}/${TRIES})`,
      );
    }
    await sleep(DELAYS_MS[i]);
  }
  throw new Error(
    `Could not resolve funding vout for ${txid} after ${TRIES} tries. ` +
    `Last error: ${lastErr?.message || "unknown"}. ` +
    `The tx DID broadcast — wait a minute, reload the page, and use the ` +
    `resume flow with the txid to continue.`,
  );
}

async function fetchBtcTipHeight() {
  const res = await fetch(`${BTC_API}/blocks/tip/height`);
  if (!res.ok) throw new Error(`BTC tip fetch failed: ${res.status}`);
  const n = Number(await res.text());
  if (!Number.isInteger(n) || n < 0) throw new Error("invalid tip height");
  return n;
}

async function fetchBtcFeeRate() {
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
    const res = await fetch(`${BTC_API}/fee-estimates`);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    const rate = Number(j["3"]);
    const chosen = rate > 0 && isFinite(rate) ? Math.ceil(rate) : 20;
    return Math.min(Math.max(chosen, FLOOR), CEILING);
  } catch {
    return 20;
  }
}

async function fetchFbcTipHeight() {
  const res = await fetch(`${FBC_API}/blocks?limit=1`);
  if (!res.ok) throw new Error(`FBC tip fetch failed: ${res.status}`);
  const blocks = await res.json();
  const h = Array.isArray(blocks) && blocks[0] && Number(blocks[0].height);
  if (Number.isInteger(h) && h > 0) return h;
  throw new Error("could not parse FBC tip height");
}

buildOfferBtn.addEventListener("click", async () => {
  buildOfferBtn.disabled = true;
  try {
    const amtBtcSats = Math.round(Number(amountBtcInput.value) * 1e8);
    const amtFbcBumps = Math.round(Number(amountFbcInput.value) * 1e6);
    const btcH = Number(btcHoursInput.value);
    const fbcH = Number(fbcHoursInput.value);

    const [btcTip, fbcTip] = await Promise.all([
      fetchBtcTipHeight().catch((e) => {
        throw new Error(`BTC tip: ${e.message}`);
      }),
      fetchFbcTipHeight().catch((e) => {
        throw new Error(`FBC tip: ${e.message}`);
      }),
    ]);

    alice.preimage = generatePreimage();
    alice.hashlock = hashlockOf(alice.preimage);
    alice.offerId = generateOfferId();

    const offer = {
      version: 1,
      kind: "offer",
      network: { btc: BTC_NETWORK, fbc: FBC_NETWORK },
      hashlock: toHex(alice.hashlock),
      alice_btc_pubkey: alice.btc.pubkey,
      alice_fbc_pubkey: alice.fbc.pubkey,
      amount_btc: amtBtcSats,
      amount_fbc: amtFbcBumps,
      btc_refund_height: btcTip + Math.ceil((btcH * 3600) / BTC_BLOCK_SECONDS),
      fbc_refund_height: fbcTip + Math.ceil((fbcH * 3600) / FBC_BLOCK_SECONDS),
      btc_reference_height: btcTip,
      fbc_reference_height: fbcTip,
      expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      offer_id: alice.offerId,
    };
    alice.offer = offer;

    const envelope = encodeBlob(offer);
    document.getElementById("offer-blob").value = envelope;
    document.getElementById("offer-json").textContent = JSON.stringify(offer, null, 2);
    document.getElementById("process-accept").disabled = false;

    wireShareButtons(
      document.getElementById("offer-blob").closest(".blob-panel"),
      () => envelope,
      { label: "Offer link" },
    );

    // Cue the user that the ball is in the counterparty's court.
    renderWaitingPanel(
      document.getElementById("offer-blob").closest(".step-body"),
      "Your counterparty's turn:",
      "they paste this offer into the \"I have FBC\" flow at Step 2, then send you back an accept blob (paste it at Step 4 below).",
    );

    // Checkpoint — if Alice closes the tab here, the preimage and offer
    // can be recovered on next load. Without this the preimage is ONLY
    // in memory, and losing it means forfeiting the claim (must refund).
    patchState("alice", {
      preimage: toHex(alice.preimage),
      hashlock: toHex(alice.hashlock),
      offerId: alice.offerId,
      offer,
      step: "offer-built",
    });
  } catch (err) {
    showToast(`Could not build offer: ${err.message}`, "error");
  } finally {
    updateAliceBuildOfferEnabled();
  }
});

document.getElementById("copy-offer").addEventListener("click", () => {
  const v = document.getElementById("offer-blob").value;
  if (!v) return;
  navigator.clipboard.writeText(v);
  showToast("Offer blob copied to clipboard", "ok");
});

// ---- Alice: process accept, fund BTC ----

document.getElementById("process-accept").addEventListener("click", async () => {
  const raw = document.getElementById("accept-blob-in").value.trim();
  const statusEl = document.getElementById("accept-status");
  try {
    const accept = decodeBlob(raw);
    if (accept.kind !== "accept") throw new Error(`expected an accept blob, got ${accept.kind}`);
    if (accept.offer_id !== alice.offerId) throw new Error("offer_id mismatch");
    alice.accept = accept;

    const { btc, fbc } = htlcsFromOfferAccept(alice.offer, accept);
    alice.btcScript = buildHTLCScript(btc);
    alice.fbcScript = buildHTLCScript(fbc);

    const btcAddr = btcHTLCAddress(alice.btcScript, BTC_NETWORK);
    // Live fee preview so Alice isn't surprised by the BTC claim/refund
    // burden. This is the rate that her refund tx would use today —
    // her funding tx fee is set by the wallet, not us.
    const feeRate = await fetchBtcFeeRate();
    renderSummary(document.getElementById("btc-fund-summary"), [
      { label: "Fund amount", text: `${alice.offer.amount_btc.toLocaleString()} sat` },
      { label: "HTLC address", mono: btcAddr },
      {
        label: "Refund at block",
        text: alice.offer.btc_refund_height.toLocaleString(),
      },
      { label: "Hashlock", mono: `${alice.offer.hashlock.slice(0, 24)}…` },
      { label: "BTC fee estimate (refund)", text: `~${feeRate} sat/vB × ~150 vB ≈ ${(feeRate * 150).toLocaleString()} sat` },
    ]);
    document.getElementById("fund-btc").disabled = false;

    statusEl.textContent = "Accept verified. Review and fund when ready.";
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");

    patchState("alice", { accept, step: "accept-verified" });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("fund-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-fund-status");
  try {
    if (!window.unisat) throw new Error("BTC wallet not connected");
    // SPEC §5.1: if `expires_at` has passed, warn before funding. The offer
    // was built with a 1h expiry by default; Bob may have sat on the accept,
    // in which case Alice could be funding against an agreement Bob has
    // since forgotten about.
    if (alice.offer?.expires_at) {
      const expiry = Date.parse(alice.offer.expires_at);
      if (Number.isFinite(expiry) && expiry < Date.now()) {
        const ok = await confirmModal({
          title: "Offer has expired",
          body: `This offer expired at ${alice.offer.expires_at}. Your counterparty may not be watching for your BTC funding anymore. Continue anyway?`,
          confirmLabel: "Fund anyway",
          danger: true,
        });
        if (!ok) return;
      }
    }
    const addr = btcHTLCAddress(alice.btcScript, BTC_NETWORK);
    setFieldNote(statusEl, "Signing BTC funding tx in wallet…");
    const txid = await window.unisat.sendBitcoin(addr, alice.offer.amount_btc);
    alice.btcFundedTxid = txid;
    // Unisat only returns the txid — it does not guarantee which output
    // index is the HTLC. Poll Blockstream until the tx appears so we can
    // scan its outputs for the one paying our P2WSH address. Silently
    // falling back to vout=0 used to be a footgun: Bob's verifyFundedBtc
    // would pass (amount+script still match) but his on-chain claim would
    // spend the wrong output and fail.
    setFieldNote(statusEl, "Resolving funding output (Blockstream indexer)…");
    const actualVout = await resolveFundingVout(txid, addr, statusEl);
    alice.btcFundedVout = actualVout;
    const fundedBlob = encodeBlob({
      version: 1,
      kind: "funded_btc",
      offer_id: alice.offerId,
      funding_txid: txid,
      funding_vout: actualVout,
      funding_amount: alice.offer.amount_btc,
      witness_script_hex: toHex(alice.btcScript.scriptBytes),
    });
    // Clipboard writes can fail if the wallet popup stole focus from this
    // tab ("Document is not focused"). The blob is already on-chain, so this
    // MUST NOT abort the rest of the flow — share block and state persistence
    // below are what Alice actually needs to continue.
    const copied = await navigator.clipboard.writeText(fundedBlob).then(() => true, () => false);
    renderTxStatus(statusEl, {
      label: "BTC funding broadcast.",
      txid,
      chain: "btc",
      followup: copied
        ? "funded_btc blob copied to your clipboard — send it to your counterparty."
        : "Send the funded_btc blob below to your counterparty — use the Copy button (auto-copy failed, likely because your wallet popup took focus).",
    });
    if (copied) showToast("funded_btc blob copied to clipboard", "ok");
    appendShareBlock(statusEl, fundedBlob, "funded_btc");
    document.getElementById("claim-fbc").disabled = false;

    // Live "N/6 confirmations" under the fund status so Alice can tell
    // her counterparty when BTC is safe to act on, without leaving the
    // tab for an explorer.
    startBtcConfWatch(statusEl, txid, BTC_CONF_TARGET);
    renderWaitingPanel(
      statusEl.closest(".step-body"),
      "Your counterparty's turn:",
      "once your BTC has 6 confirmations, they fund the FBC side. Then paste their funded_fbc blob at Step 6 below.",
    );
    // Start the refund countdown. The button stays disabled until the
    // BTC tip reaches T1; the countdown provides the context so the user
    // knows how long until recovery becomes available.
    startAliceBtcRefundCountdown();

    patchState("alice", {
      btcFundedTxid: txid,
      btcFundedVout: actualVout,
      step: "btc-funded",
    });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Alice: claim FBC ----

// ---- Alice: refund BTC after T1 if counterparty never claimed ----

document.getElementById("refund-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("refund-btc-status");
  try {
    if (!alice.btcFundedTxid || !alice.btcScript) {
      throw new Error("you haven't funded BTC in this session");
    }
    const ok = await confirmModal({
      title: "Refund your BTC?",
      body: "Only valid after the BTC refund height. If you already claimed FBC in step 6, DO NOT refund — the swap has already completed and refunding will just burn a tx fee.",
      confirmLabel: "Refund",
      danger: true,
    });
    if (!ok) return;

    const witnessScript = alice.btcScript.scriptBytes;
    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: alice.btcFundedTxid,
      fundingVout: alice.btcFundedVout,
      fundingAmountSats: alice.offer.amount_btc,
      witnessScript,
      destination: alice.btc.address,
      feeRateSatPerVb: feeRate,
      branch: "refund",
      locktime: alice.offer.btc_refund_height,
      network: BTC_NETWORK,
    });

    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [
        {
          index: 0,
          address: alice.btc.address,
          publicKey: alice.btc.pubkey,
          sighashTypes: [1],
          disableTweakSigner: true,
        },
      ],
    });

    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript,
      branch: "refund",
    });

    const broadcastTxid = await window.unisat.pushTx(rawTxHex);
    renderTxStatus(statusEl, {
      label: "BTC refund broadcast.",
      txid: broadcastTxid || txid,
      chain: "btc",
    });
    // Swap is now terminally refunded — no reason to keep the preimage.
    clearState("alice");
    showToast("Refund broadcast. Swap cleared from storage.", "ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("claim-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("claim-status");
  try {
    const raw = document.getElementById("funded-fbc-in").value.trim();
    const funded = decodeBlob(raw);
    if (funded.kind !== "funded_fbc") throw new Error("not a funded_fbc blob");
    const v = verifyFundedFbc(alice.offer, alice.accept, funded);
    if (!v.ok) throw new Error(`funded_fbc verification failed: ${v.reason}`);

    // SPEC §5.4: ≥ 12 FBC confirmations before claim. A claim before that
    // risks a reorg burying the claim tx while Bob still gets to keep his
    // side; atomicity isn't violated but it can cause a protocol hang.
    const fbcLatest = await checkFbcConfirmations(funded.funding_txid);
    if (fbcLatest.confirmations < FBC_CONF_TARGET) {
      const proceed = await confirmModal({
        title: "FBC not yet confirmed enough",
        body: `Their FBC funding has ${fbcLatest.confirmations}/${FBC_CONF_TARGET} confirmations. Recommended: wait. Claim anyway?`,
        confirmLabel: "Claim anyway",
        danger: true,
      });
      if (!proceed) return;
    }

    const res = await window.fistbump.signHtlcSpend({
      fundingTxid: funded.funding_txid,
      fundingVout: funded.funding_vout,
      fundingAmount: funded.funding_amount,
      witnessScriptHex: funded.witness_script_hex,
      branch: "claim",
      preimageHex: toHex(alice.preimage),
      destinationAddress: alice.fbc.address,
      feeRate: 1000,
    });
    renderTxStatus(statusEl, {
      label: "FBC claim broadcast.",
      txid: res.txid,
      chain: "fbc",
      followup: "Counterparty can now claim their BTC using the preimage below.",
    });
    // Mark the swap as complete in storage but keep the preimage so the
    // reload banner can re-display the hand-off panel until Alice dismisses.
    patchState("alice", { step: "fbc-claimed" });
    renderPreimagePanel(statusEl, toHex(alice.preimage));
    renderWaitingPanel(
      statusEl.closest(".step-body"),
      "Your counterparty's turn:",
      "they use the preimage above (or read it off your FBC claim tx) to claim their BTC. Swap completes when that lands on-chain.",
    );
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: wallet connect ----

document.getElementById("fbc-connect-bob").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-status-bob");
  try {
    setStatus(statusEl, "connecting…", null);
    bob.fbc = await connectFistbump();
    setStatus(statusEl, bob.fbc.address, "connected");
    updateBobButtons();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});
document.getElementById("btc-connect-bob").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-status-bob");
  try {
    setStatus(statusEl, "connecting…", null);
    bob.btc = await connectUnisat();
    setStatus(statusEl, bob.btc.address, "connected");
    updateBobButtons();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

function updateBobButtons() {
  document.getElementById("process-offer").disabled = !(bob.fbc && bob.btc);
}

// ---- Bob: read offer, send accept ----

document.getElementById("process-offer").addEventListener("click", async () => {
  const statusEl = document.getElementById("offer-status");
  try {
    const raw = document.getElementById("offer-blob-in").value.trim();
    const offer = decodeBlob(raw);
    if (offer.kind !== "offer") throw new Error("not an offer blob");

    // Observe live tips so we can reject offers built against stale heights.
    // Fetches are best-effort — if either explorer is down, validate without
    // the staleness leg rather than forcing the user to retry.
    setFieldNote(statusEl, "Checking offer against current chain tips…");
    const [btcTip, fbcTip] = await Promise.all([
      fetchBtcTipHeight().catch(() => null),
      fetchFbcTipHeight().catch(() => null),
    ]);
    const v = validateOffer(offer, { btcTip, fbcTip });
    if (!v.ok) throw new Error(v.reason);

    bob.offer = offer;

    const summary = document.getElementById("offer-summary");
    const btcSecondsToT1 = (offer.btc_refund_height - offer.btc_reference_height) * BTC_BLOCK_SECONDS;
    const fbcSecondsToT2 = (offer.fbc_refund_height - offer.fbc_reference_height) * FBC_BLOCK_SECONDS;
    renderSummary(summary, [
      { label: "They send", text: `${offer.amount_btc.toLocaleString()} sat BTC` },
      { label: "You send", text: `${(offer.amount_fbc / 1e6).toLocaleString()} FBC` },
      { label: "BTC refund after", text: `block ${offer.btc_refund_height.toLocaleString()} (~${(btcSecondsToT1 / 3600).toFixed(1)}h)` },
      { label: "FBC refund after", text: `block ${offer.fbc_refund_height.toLocaleString()} (~${(fbcSecondsToT2 / 3600).toFixed(1)}h)` },
      { label: "Hashlock", mono: `${offer.hashlock.slice(0, 24)}…` },
    ]);
    summary.classList.remove("hidden");

    const accept = {
      version: 1,
      kind: "accept",
      offer_id: offer.offer_id,
      bob_btc_pubkey: bob.btc.pubkey,
      bob_fbc_pubkey: bob.fbc.pubkey,
    };
    bob.accept = accept;
    const acceptEnvelope = encodeBlob(accept);
    document.getElementById("accept-blob").value = acceptEnvelope;
    document.getElementById("fund-fbc").disabled = false;
    setFieldNote(statusEl, "Offer verified. Send your accept below.", "ok");

    wireShareButtons(
      document.getElementById("accept-blob").closest(".blob-panel"),
      () => acceptEnvelope,
      { label: "Accept link" },
    );

    renderWaitingPanel(
      document.getElementById("accept-blob").closest(".step-body"),
      "Your counterparty's turn:",
      "they paste your accept, fund their BTC HTLC, and send you a funded_btc blob. Paste it at Step 4 below.",
    );

    patchState("bob", {
      offer,
      accept,
      step: "accept-sent",
    });
  } catch (err) {
    setFieldNote(statusEl, err.message, "error");
  }
});

document.getElementById("copy-accept").addEventListener("click", () => {
  const v = document.getElementById("accept-blob").value;
  if (!v) return;
  navigator.clipboard.writeText(v);
  showToast("Accept blob copied to clipboard", "ok");
});

// ---- Bob: verify counterparty BTC funding, fund FBC ----

document.getElementById("fund-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-fund-status");
  try {
    const raw = document.getElementById("funded-btc-in").value.trim();
    if (!raw) throw new Error("paste the counterparty's funded_btc blob first");
    const funded = decodeBlob(raw);
    if (funded.kind !== "funded_btc") throw new Error("not a funded_btc blob");
    const v = verifyFundedBtc(bob.offer, bob.accept, funded);
    if (!v.ok) throw new Error(`funded_btc verification failed: ${v.reason}`);
    // Keep the verified funded_btc around — Bob needs its txid, vout,
    // amount, and script to build the claim PSBT in step 5.
    bob.btcFunded = funded;

    // SPEC §5.3 requires ≥ 6 BTC confirmations before funding FBC.
    // Block on a live confirmation check rather than trusting the user
    // to read the counter.
    const latest = await checkBtcConfirmations(funded.funding_txid);
    if (latest.confirmations < BTC_CONF_TARGET) {
      const proceed = await confirmModal({
        title: "BTC not yet confirmed",
        body: `Their BTC funding has ${latest.confirmations}/${BTC_CONF_TARGET} confirmations. Funding FBC now means if BTC is reorged out, your FBC sits in an HTLC that no one can claim — only refund at T2. Recommended: wait. Proceed anyway?`,
        confirmLabel: "Fund FBC anyway",
        danger: true,
      });
      if (!proceed) return;
    }

    const { fbc } = htlcsFromOfferAccept(bob.offer, bob.accept);
    bob.fbcScript = buildHTLCScript(fbc);
    const fbcAddr = fbcHTLCAddress(bob.fbcScript, FBC_NETWORK);
    console.debug("FBC HTLC address:", fbcAddr);

    const res = await window.fistbump.fundHtlc({
      witnessScriptHex: toHex(bob.fbcScript.scriptBytes),
      amount: bob.offer.amount_fbc / 1e6,
      memo: `atomic swap ${bob.offer.offer_id.slice(0, 8)}`,
    });
    bob.fbcFundedTxid = res.txid;
    bob.fbcFundedVout = res.vout;

    const fundedFbcBlob = encodeBlob({
      version: 1,
      kind: "funded_fbc",
      offer_id: bob.offer.offer_id,
      funding_txid: res.txid,
      funding_vout: res.vout,
      funding_amount: bob.offer.amount_fbc,
      witness_script_hex: toHex(bob.fbcScript.scriptBytes),
    });
    // Clipboard writes can fail if the wallet popup stole focus from this
    // tab ("Document is not focused"). FBC is already on-chain, so this
    // MUST NOT abort the rest of the flow — share block and state persistence
    // below are what Bob actually needs to continue.
    const copied = await navigator.clipboard.writeText(fundedFbcBlob).then(() => true, () => false);
    renderTxStatus(statusEl, {
      label: "FBC HTLC funded.",
      txid: res.txid,
      chain: "fbc",
      followup: copied
        ? "funded_fbc blob copied to your clipboard — send it to your counterparty."
        : "Send the funded_fbc blob below to your counterparty — use the Copy button (auto-copy failed, likely because your wallet popup took focus).",
    });
    if (copied) showToast("funded_fbc blob copied to clipboard", "ok");
    appendShareBlock(statusEl, fundedFbcBlob, "funded_fbc");

    // claim-btc stays disabled until either (a) user pastes preimage
    // manually, or (b) the auto-extract poller finds Alice's claim on-chain
    // and fills the field. This prevents accidental clicks with an empty
    // preimage, and makes the transition obvious.
    document.getElementById("claim-btc").disabled = true;

    startBobFbcRefundCountdown();
    startPreimageAutoExtract();
    renderWaitingPanel(
      statusEl.closest(".step-body"),
      "Your counterparty's turn:",
      "they wait for 12 FBC confirmations, then claim — which reveals the preimage on-chain. You use that preimage to claim BTC at Step 5 below.",
    );

    patchState("bob", {
      btcFunded: funded,
      fbcFundedTxid: res.txid,
      fbcFundedVout: res.vout,
      step: "fbc-funded",
    });
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: claim BTC with revealed preimage ----

document.getElementById("claim-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("claim-btc-status");
  try {
    if (!bob.btcFunded) throw new Error("no verified funded_btc in this session");
    if (!bob.btc) {
      throw new Error(
        "connect Unisat first (step 1 above) — claim needs your BTC wallet to sign",
      );
    }
    const preimageHex = document.getElementById("preimage-in").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
      throw new Error("preimage must be 64 hex chars (32 bytes)");
    }
    const preimage = fromHex(preimageHex);

    // Pull the hashlock straight from the witness script so we don't depend
    // on bob.offer (which is null in resume mode). The script is the ground
    // truth anyway — if the preimage doesn't hash to what the script commits
    // to, nothing we try on-chain will work.
    const witnessScript = fromHex(bob.btcFunded.witness_script_hex);
    const parsed = parseHTLCScript(witnessScript);
    if (!parsed) throw new Error("witness script is not a valid HTLC");
    const computed = toHex(hashlockOf(preimage));
    const expectedHashlock = toHex(parsed.hashlock);
    if (computed !== expectedHashlock) {
      throw new Error(
        `preimage does not match the HTLC's hashlock. ` +
        `SHA256(preimage) = ${computed.slice(0, 16)}… ` +
        `but the HTLC commits to ${expectedHashlock.slice(0, 16)}…. ` +
        `(Hint: the 64-char hex from the "Unknown inputs not allowed" error ` +
        `was a txid, not a preimage. The preimage comes from Alice's FBC ` +
        `claim tx witness stack, item [1].)`,
      );
    }
    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: bob.btcFunded.funding_txid,
      fundingVout: bob.btcFunded.funding_vout,
      fundingAmountSats: bob.btcFunded.funding_amount,
      witnessScript,
      destination: bob.btc.address,
      feeRateSatPerVb: feeRate,
      branch: "claim",
      network: BTC_NETWORK,
    });

    // Unisat refuses to sign inputs it can't classify unless we explicitly
    // list both the address and the public key it should sign with — P2WSH
    // with a custom HTLC script doesn't match any of its known templates.
    // Unisat classifies inputs by output template. P2WSH with custom script
    // falls into "other" which it refuses by default. The rescue is
    // toSignInputs with explicit pubkey AND disableTweakSigner=true (the
    // tweak signer path is for Taproot; forcing it off tells Unisat to
    // produce a plain ECDSA signature, which is what CHECKSIG expects).
    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [
        {
          index: 0,
          address: bob.btc.address,
          publicKey: bob.btc.pubkey,
          sighashTypes: [1],
          disableTweakSigner: true,
        },
      ],
    });

    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript,
      branch: "claim",
      preimage,
    });

    const broadcastTxid = await window.unisat.pushTx(rawTxHex);
    renderTxStatus(statusEl, {
      label: "BTC claim broadcast.",
      txid: broadcastTxid || txid,
      chain: "btc",
    });
    clearState("bob");
    showToast("BTC claim broadcast. Swap complete.", "ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: export PSBT for external signing (Sparrow etc.) ----

document.getElementById("export-psbt").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  const out = document.getElementById("unsigned-psbt");
  try {
    if (!bob.btcFunded) throw new Error("no verified funded_btc in this session");
    const preimageHex = document.getElementById("preimage-in").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
      throw new Error("enter the preimage first (64 hex chars)");
    }
    const preimage = fromHex(preimageHex);
    const witnessScript = fromHex(bob.btcFunded.witness_script_hex);
    const parsed = parseHTLCScript(witnessScript);
    if (!parsed) throw new Error("witness script is not a valid HTLC");
    if (toHex(hashlockOf(preimage)) !== toHex(parsed.hashlock)) {
      throw new Error("preimage does not hash to the HTLC's hashlock");
    }
    // Destination: if Bob's Unisat is connected, use that address; otherwise
    // ask inline. Signer can change it in Sparrow anyway before signing.
    const dest = bob.btc?.address
      || prompt("Destination BTC address for your claimed funds:")?.trim();
    if (!dest) throw new Error("destination address required");

    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: bob.btcFunded.funding_txid,
      fundingVout: bob.btcFunded.funding_vout,
      fundingAmountSats: bob.btcFunded.funding_amount,
      witnessScript,
      destination: dest,
      feeRateSatPerVb: feeRate,
      branch: "claim",
      network: BTC_NETWORK,
    });
    out.value = psbtHex;
    // Stash for finalize step so we don't re-derive.
    bob.externalPreimage = preimage;
    bob.externalWitnessScript = witnessScript;
    statusEl.textContent = "PSBT ready. Sign in Sparrow, then paste the signed PSBT below.";
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("sign-with-wif").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  const wifInput = document.getElementById("wif-in");
  try {
    if (!bob.externalWitnessScript || !bob.externalPreimage) {
      throw new Error("click Export PSBT first");
    }
    const psbtHex = document.getElementById("unsigned-psbt").value.trim();
    if (!psbtHex) throw new Error("click Export PSBT first");
    const wif = wifInput.value.trim();
    if (!wif) throw new Error("paste your WIF private key");

    const { rawTxHex, txid } = signAndFinalizeWithWIF({
      psbtHex,
      witnessScript: bob.externalWitnessScript,
      branch: "claim",
      preimage: bob.externalPreimage,
      wif,
      network: BTC_NETWORK,
    });
    // Discard the WIF from the DOM immediately; we don't need it again.
    wifInput.value = "";

    const res = await fetch(`${BTC_API}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected: ${body}`);
    renderTxStatus(statusEl, {
      label: "BTC claim broadcast.",
      txid: body || txid,
      chain: "btc",
    });
    clearState("bob");
    showToast("BTC claim broadcast. Swap complete.", "ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("finalize-external").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  try {
    if (!bob.externalWitnessScript || !bob.externalPreimage) {
      throw new Error("click Export PSBT first");
    }
    const signedPsbtHex = document.getElementById("signed-psbt-in").value.trim();
    if (!signedPsbtHex) throw new Error("paste the signed PSBT first");
    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript: bob.externalWitnessScript,
      branch: "claim",
      preimage: bob.externalPreimage,
    });
    // Broadcast via Blockstream Esplora since Unisat may not cooperate.
    const res = await fetch(`${BTC_API}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected: ${body}`);
    renderTxStatus(statusEl, {
      label: "BTC claim broadcast.",
      txid: body || txid,
      chain: "btc",
    });
    clearState("bob");
    showToast("BTC claim broadcast. Swap complete.", "ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: refund FBC if counterparty never claimed ----

document.getElementById("refund-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("refund-fbc-status");
  try {
    if (!bob.fbcFundedTxid || !bob.fbcScript) {
      throw new Error("you haven't funded FBC in this session");
    }
    const ok = await confirmModal({
      title: "Refund your FBC?",
      body: "Only valid after the FBC refund height. Continue?",
      confirmLabel: "Refund",
      danger: true,
    });
    if (!ok) return;

    // locktime is REQUIRED for the refund branch per SPEC.md Appendix B —
    // without it the wallet can't set nLockTime on the tx and OP_CLTV fails.
    const res = await window.fistbump.signHtlcSpend({
      fundingTxid: bob.fbcFundedTxid,
      fundingVout: bob.fbcFundedVout,
      fundingAmount: bob.offer.amount_fbc,
      witnessScriptHex: toHex(bob.fbcScript.scriptBytes),
      branch: "refund",
      locktime: bob.offer.fbc_refund_height,
      destinationAddress: bob.fbc.address,
      feeRate: 1000,
    });
    renderTxStatus(statusEl, {
      label: "FBC refund broadcast.",
      txid: res.txid,
      chain: "fbc",
    });
    clearState("bob");
    showToast("FBC refund broadcast. Swap cleared from storage.", "ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Blob sharing helpers (QR + deep link) ----
//
// The copy-paste dance is the highest-friction step of the flow. These
// helpers offer two shortcuts the counterparty can follow to pre-populate
// their side:
//
//   - Link: `https://swap.fistbump.org/#b=<envelope>` opens the page with
//     the right role auto-selected and the paste field pre-filled.
//   - QR code: same link, rendered for phone-camera capture so two people
//     side by side don't have to paste at all.
//
// The envelope itself (`fistbump-swap:v1:...base64url...`) is URL-safe,
// so we don't need to re-encode it to put it in the hash.

function buildShareLink(envelope) {
  // location.origin + pathname strips any existing query/hash; the
  // resulting URL loads the page fresh with our blob in #b=.
  return `${location.origin}${location.pathname}#b=${envelope}`;
}

// Append a compact "Share link / Show QR" block after a tx-status line so
// the just-broadcast funded_* envelope can be sent via link or QR without
// the user remembering which tab has the clipboard contents.
function appendShareBlock(statusEl, envelope, kind) {
  if (!statusEl || !envelope) return;
  statusEl.querySelector(".share-buttons")?.remove();
  statusEl.querySelector(".qr-wrap")?.remove();
  const wrap = document.createElement("div");
  wrap.style.cssText = "margin-top:10px;";
  statusEl.appendChild(wrap);
  wireShareButtons(wrap, () => envelope, { label: `${kind} link` });
}

// Attach a "Show QR" + "Copy link" button pair to an existing blob panel.
// Idempotent: calling twice replaces the prior buttons.
function wireShareButtons(panelEl, getEnvelope, opts = {}) {
  if (!panelEl) return;
  panelEl.querySelector(".share-buttons")?.remove();
  panelEl.querySelector(".qr-wrap")?.remove();

  const row = document.createElement("div");
  row.className = "share-buttons";
  row.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;";

  const linkBtn = document.createElement("button");
  linkBtn.type = "button";
  linkBtn.className = "btn";
  linkBtn.textContent = "Copy link";
  linkBtn.addEventListener("click", () => {
    const env = getEnvelope();
    if (!env) return;
    navigator.clipboard.writeText(buildShareLink(env));
    showToast(`${opts.label || "Link"} copied — they can paste it straight into their browser`, "ok");
  });
  row.appendChild(linkBtn);

  const qrBtn = document.createElement("button");
  qrBtn.type = "button";
  qrBtn.className = "btn";
  qrBtn.textContent = "Show QR";
  qrBtn.addEventListener("click", async () => {
    const existing = panelEl.querySelector(".qr-wrap");
    if (existing) { existing.remove(); qrBtn.textContent = "Show QR"; return; }
    const env = getEnvelope();
    if (!env) return;
    qrBtn.textContent = "…";
    const url = await blobQrDataUrl(buildShareLink(env));
    qrBtn.textContent = "Hide QR";
    if (!url) { showToast("QR generation failed", "error"); return; }
    const wrap = document.createElement("div");
    wrap.className = "qr-wrap";
    const qp = document.createElement("div");
    qp.className = "qr-panel";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "QR code encoding the swap blob link";
    qp.appendChild(img);
    wrap.appendChild(qp);
    const cap = document.createElement("div");
    cap.className = "caption";
    cap.textContent = "Counterparty scans → opens the flow with this blob pre-filled.";
    wrap.appendChild(cap);
    panelEl.appendChild(wrap);
  });
  row.appendChild(qrBtn);

  panelEl.appendChild(row);
}

// Render a subtle "waiting on counterparty" panel inside `container`.
// If one already exists in the container it's replaced, so calling this
// multiple times advances the displayed message instead of stacking.
// `content` is a string of text (body of the panel); `strong` is optionally
// a bold lead-in (first phrase of the message).
function renderWaitingPanel(container, strong, content) {
  if (!container) return;
  container.querySelector(".waiting-panel")?.remove();
  const panel = document.createElement("div");
  panel.className = "waiting-panel";
  const body = document.createElement("span");
  if (strong) {
    const s = document.createElement("strong");
    s.textContent = strong + " ";
    body.appendChild(s);
  }
  body.appendChild(document.createTextNode(content));
  panel.appendChild(body);
  container.appendChild(panel);
}

function clearWaitingPanel(container) {
  container?.querySelector(".waiting-panel")?.remove();
}

// Render a "Preimage — send this to your counterparty" panel. Factored so
// the post-claim moment AND the persistence-restore banner can both use it.
// The preimage is already on-chain by the time this renders, so displaying
// it isn't a security change — the counterparty needs it to claim BTC and
// the explorer won't always render witness data cleanly.
function renderPreimagePanel(parent, preimageHex) {
  const existing = parent.querySelector(".preimage-panel");
  if (existing) existing.remove();
  const panel = document.createElement("div");
  panel.className = "preimage-panel";

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = "Preimage — send this to your counterparty:";
  panel.appendChild(label);

  const mono = document.createElement("code");
  mono.textContent = preimageHex;
  panel.appendChild(mono);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn";
  copyBtn.style.cssText = "margin-right:8px;height:26px;padding:0 10px;font-size:12px;";
  copyBtn.textContent = "Copy preimage";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(preimageHex);
    showToast("Preimage copied to clipboard", "ok");
  });
  panel.appendChild(copyBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "btn";
  dismissBtn.style.cssText = "height:26px;padding:0 10px;font-size:12px;";
  dismissBtn.textContent = "Dismiss and clear swap";
  dismissBtn.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: "Clear this swap?",
      body: "Only do this once your counterparty has successfully claimed their BTC. The preimage will be forgotten locally — it remains public on-chain, but dismissing removes the reload banner.",
      confirmLabel: "Clear",
    });
    if (!ok) return;
    clearState("alice");
    panel.remove();
    showToast("Swap cleared from browser storage", "ok");
  });
  panel.appendChild(dismissBtn);

  parent.appendChild(panel);
}

// ---- Detail card renderer (DOM-safe, no innerHTML) ----
// Matches the .detail-card / .detail-row pattern used by web/ and docs/.

// Render a tx broadcast status line: full txid in mono + copy + explorer
// link. No truncation. If you truncate a hash in a status line your users
// will spend twenty minutes figuring out how to see the rest of it —
// don't do it.
function renderTxStatus(statusEl, opts) {
  const { label, txid, chain, followup } = opts;
  statusEl.replaceChildren();
  statusEl.classList.remove("error");
  statusEl.classList.add("ok");

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label + " ";
  statusEl.appendChild(labelSpan);

  const mono = document.createElement("code");
  mono.textContent = txid;
  mono.style.cssText = "word-break:break-all;user-select:all;";
  statusEl.appendChild(mono);

  statusEl.appendChild(document.createTextNode(" "));

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn";
  copyBtn.style.cssText = "height:22px;padding:0 8px;font-size:11px;vertical-align:middle;";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(txid);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1200);
  });
  statusEl.appendChild(copyBtn);

  statusEl.appendChild(document.createTextNode(" "));

  const explorer = document.createElement("a");
  explorer.target = "_blank";
  explorer.rel = "noreferrer";
  explorer.textContent = "Open in explorer";
  explorer.style.cssText = "font-size:12px;";
  if (chain === "btc") {
    explorer.href = `${BTC_EXPLORER}/${txid}`;
  } else if (chain === "fbc") {
    explorer.href = `${FBC_EXPLORER}/tx/${txid}`;
  }
  statusEl.appendChild(explorer);

  if (followup) {
    statusEl.appendChild(document.createElement("br"));
    const f = document.createElement("span");
    f.textContent = followup;
    f.style.cssText = "color:var(--fb-text-muted);";
    statusEl.appendChild(f);
  }
}

function renderSummary(container, rows) {
  container.replaceChildren();
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "detail-row";

    const label = document.createElement("span");
    label.className = "detail-label";
    label.textContent = row.label;
    rowEl.appendChild(label);

    const value = document.createElement("span");
    value.className = "detail-value";
    if (row.mono) {
      const code = document.createElement("code");
      code.textContent = row.mono;
      value.appendChild(code);
    } else {
      value.textContent = row.text;
    }
    rowEl.appendChild(value);
    container.appendChild(rowEl);
  }
}

updateAliceBuildOfferEnabled();
updateBobButtons();

// ---- Live confirmation tracking ----
//
// SPEC.md §5.3 and §5.4 require ≥ 6 BTC confirmations (Bob before funding
// FBC) and ≥ 12 FBC confirmations (Alice before claiming FBC). Prior UI
// left enforcement to prose — now we poll the chain and gate the button.

const BTC_CONF_TARGET = 6;
const FBC_CONF_TARGET = 12;
const activePolls = []; // cleanup on refresh/navigate

window.addEventListener("beforeunload", () => {
  for (const stop of activePolls.splice(0)) stop();
});

function renderConfLine(container, label, state, target) {
  const existing = container.querySelector(".conf-line");
  const line = existing || document.createElement("div");
  if (!existing) {
    line.className = "conf-line";
    container.appendChild(line);
  }
  line.replaceChildren();

  const text = document.createElement("span");
  const ready = state.confirmations >= target;
  text.textContent = ready
    ? `${label}: ${state.confirmations}/${target} confirmations — ready.`
    : state.confirmed
      ? `${label}: ${state.confirmations}/${target} confirmations…`
      : `${label}: waiting for tx to enter a block…`;
  line.appendChild(text);

  const bar = document.createElement("span");
  bar.className = "bar";
  const fill = document.createElement("span");
  fill.className = "fill";
  fill.style.width = `${Math.min(100, (state.confirmations / target) * 100)}%`;
  bar.appendChild(fill);
  line.appendChild(bar);

  line.classList.toggle("ready", ready);
  return ready;
}

function startBtcConfWatch(container, txid, target) {
  maybeRequestNotificationPermission();
  const stop = pollBtcConfirmations(txid, (state) => {
    const ready = renderConfLine(container, "BTC funding", state, target);
    if (ready) {
      notifyOnce(
        `btc-conf-${txid}`,
        "BTC funding confirmed",
        `${state.confirmations}/${target} confirmations — it's safe to act on this swap.`,
      );
    }
  });
  activePolls.push(stop);
  return stop;
}

async function checkFbcConfirmations(txid) {
  try {
    const [txRes, tipRes] = await Promise.all([
      fetch(`${FBC_API}/tx/${txid}`),
      fetch(`${FBC_API}/blocks?limit=1`),
    ]);
    const txData = txRes.ok ? await txRes.json() : null;
    const tipData = tipRes.ok ? await tipRes.json() : null;
    const tip = Array.isArray(tipData) && tipData[0] ? Number(tipData[0].height) : null;
    const blockH = txData?.block_height ?? txData?.height ?? null;
    if (blockH != null && Number.isFinite(tip)) {
      return { confirmations: Math.max(0, tip - Number(blockH) + 1), confirmed: true };
    }
    return { confirmations: 0, confirmed: false };
  } catch {
    return { confirmations: 0, confirmed: false };
  }
}

// One-shot variant used by the pre-fund safety check on Bob's side.
async function checkBtcConfirmations(txid) {
  try {
    const [statusRes, tipRes] = await Promise.all([
      fetch(`https://blockstream.info/api/tx/${txid}/status`),
      fetch(`https://blockstream.info/api/blocks/tip/height`),
    ]);
    const status = statusRes.ok ? await statusRes.json() : null;
    const tip = tipRes.ok ? Number(await tipRes.text()) : null;
    if (status?.confirmed && status.block_height && Number.isFinite(tip)) {
      return { confirmations: Math.max(0, tip - status.block_height + 1), confirmed: true };
    }
    return { confirmations: 0, confirmed: false };
  } catch {
    return { confirmations: 0, confirmed: false };
  }
}

function startFbcConfWatch(container, txid, target) {
  maybeRequestNotificationPermission();
  const stop = pollFbcConfirmations(txid, (state) => {
    const ready = renderConfLine(container, "FBC funding", state, target);
    if (ready) {
      notifyOnce(
        `fbc-conf-${txid}`,
        "FBC funding confirmed",
        `${state.confirmations}/${target} confirmations — it's safe to claim.`,
      );
    }
  });
  activePolls.push(stop);
  return stop;
}

// ---- Refund countdowns ----
//
// Live "Refund in ~3h 20m (block T1)" text under each refund button,
// with the button gated on (current tip ≥ refund height). Prevents the
// user from broadcasting a refund tx that the mempool would reject
// because its nLockTime is in the future.

function wireRefundCountdown({ buttonId, noteId, chain, getHeight }) {
  const button = document.getElementById(buttonId);
  const note = document.getElementById(noteId);
  if (!button || !note) return;
  const poll = chain === "btc" ? pollBtcTip : pollFbcTip;
  let ready = false;
  const stop = poll((tip) => {
    const target = getHeight();
    if (!Number.isFinite(target)) return;
    const remaining = target - tip;
    if (remaining <= 0) {
      if (!ready) {
        notifyOnce(
          `refund-ready-${chain}-${target}`,
          `${chain.toUpperCase()} refund window open`,
          `Tip reached block ${target}. You can broadcast your refund now if the swap didn't complete.`,
        );
      }
      ready = true;
      button.disabled = false;
      setFieldNote(note, `Refund available now (tip ${tip} ≥ ${target}).`, "ok");
    } else {
      if (!ready) button.disabled = true;
      const clock = estimateWallClock(remaining, chain);
      setFieldNote(note, `Refund available in ${clock} — at block ${target} (current tip ${tip}, ${remaining} to go).`);
    }
  });
  activePolls.push(stop);
}

function startAliceBtcRefundCountdown() {
  if (!alice.offer) return;
  wireRefundCountdown({
    buttonId: "refund-btc",
    noteId: "refund-btc-countdown",
    chain: "btc",
    getHeight: () => alice.offer?.btc_refund_height,
  });
}

function startBobFbcRefundCountdown() {
  if (!bob.offer) return;
  wireRefundCountdown({
    buttonId: "refund-fbc",
    noteId: "refund-fbc-countdown",
    chain: "fbc",
    getHeight: () => bob.offer?.fbc_refund_height,
  });
}

/**
 * Start watching for Alice's on-chain FBC claim. When detected, extract
 * the preimage from the witness stack, auto-fill Bob's preimage input,
 * and fire a toast + browser notification. Removes the manual out-of-band
 * hand-off entirely in the common case.
 *
 * Safe to call multiple times — the poller deduplicates on fundingTxid.
 */
const activePreimageWatches = new Set();
function startPreimageAutoExtract() {
  if (!bob.fbcFundedTxid || !bob.fbcScript) return;
  const key = `${bob.fbcFundedTxid}:${bob.fbcFundedVout}`;
  if (activePreimageWatches.has(key)) return;
  activePreimageWatches.add(key);

  const addr = fbcHTLCAddress(bob.fbcScript, FBC_NETWORK);
  maybeRequestNotificationPermission();
  const preimageInput = document.getElementById("preimage-in");
  const stop = pollFbcPreimageReveal(
    bob.fbcFundedTxid,
    bob.fbcFundedVout,
    addr,
    ({ preimageHex, spendingTxid }) => {
      activePreimageWatches.delete(key);
      if (!preimageInput) return;
      // Only overwrite if the user hasn't already entered the preimage
      // themselves (they may have copied it off the explorer first).
      if (!preimageInput.value.trim()) {
        preimageInput.value = preimageHex;
        preimageInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      document.getElementById("claim-btc").disabled = false;
      showToast("Preimage detected on-chain — you can claim BTC now", "ok");
      notifyOnce(
        `preimage-${bob.fbcFundedTxid}`,
        "Preimage revealed",
        `Your counterparty claimed FBC in tx ${spendingTxid.slice(0, 16)}…. Return to the tab to claim your BTC.`,
      );
    },
  );
  activePolls.push(stop);
}

// ---- Blob-type hints ----
//
// Attach a live "Detected: <kind> for offer <prefix>" hint under every
// paste field. Pasting the wrong kind of blob into the wrong box is easy
// and the error messages that follow are opaque; this gives immediate
// feedback while typing/pasting.
function wireBlobHint(inputId, expectedKind) {
  const el = document.getElementById(inputId);
  if (!el) return;
  const hint = document.createElement("div");
  hint.className = "field-note";
  hint.style.cssText = "margin:4px 0 8px;font-family:var(--fb-font-mono);font-size:var(--fb-text-xs);";
  el.insertAdjacentElement("afterend", hint);
  el.addEventListener("input", () => {
    const val = el.value.trim();
    if (!val) {
      hint.replaceChildren();
      hint.classList.remove("ok", "error");
      return;
    }
    try {
      const blob = decodeBlob(val);
      const idFrag = blob.offer_id ? ` for offer ${blob.offer_id.slice(0, 8)}…` : "";
      if (blob.kind === expectedKind) {
        hint.textContent = `Detected: ${blob.kind}${idFrag} ✓`;
        hint.classList.add("ok");
        hint.classList.remove("error");
      } else {
        hint.textContent =
          `Detected: ${blob.kind}${idFrag} — but this field expects a ${expectedKind} blob.`;
        hint.classList.add("error");
        hint.classList.remove("ok");
      }
    } catch {
      hint.textContent = "Not a recognisable fistbump-swap envelope.";
      hint.classList.add("error");
      hint.classList.remove("ok");
    }
  });
}
wireBlobHint("accept-blob-in", "accept");
wireBlobHint("funded-fbc-in", "funded_fbc");
wireBlobHint("offer-blob-in", "offer");
wireBlobHint("funded-btc-in", "funded_btc");

// Real-time preimage validation: tell the user *while typing* whether the
// 64 hex chars they pasted actually hash to the HTLC's committed hashlock.
// Without this the only feedback was at click-time, and the most common
// failure mode (pasting the txid instead of the preimage) burned a round
// trip to discover. The hint also gates the Claim button: only enable
// claim-btc when the preimage in the field actually matches the HTLC,
// so an accidental Enter after pasting a txid can't broadcast.
(function wirePreimageHint() {
  const input = document.getElementById("preimage-in");
  const claimBtn = document.getElementById("claim-btc");
  if (!input) return;
  const hint = document.createElement("div");
  hint.className = "field-note";
  hint.style.cssText = "margin:4px 0 var(--fb-space-md);font-family:var(--fb-font-mono);font-size:var(--fb-text-xs);";
  input.insertAdjacentElement("afterend", hint);
  const gate = (valid) => {
    if (!claimBtn) return;
    // Only gate if Bob has already funded FBC — otherwise the button
    // is disabled for a different reason (no funded state yet).
    if (bob.fbcFundedTxid) claimBtn.disabled = !valid;
  };
  input.addEventListener("input", () => {
    const val = input.value.trim().toLowerCase();
    if (!val) {
      hint.replaceChildren();
      hint.classList.remove("ok", "error");
      gate(false);
      return;
    }
    if (!/^[0-9a-f]{64}$/.test(val)) {
      setFieldNote(hint, `Not 64 hex chars yet (${val.length}/64).`, "error");
      gate(false);
      return;
    }
    if (!bob.btcFunded?.witness_script_hex) {
      setFieldNote(hint, "Valid 32-byte hex. Paste the funded_btc blob above to verify against the HTLC hashlock.", "ok");
      gate(true);
      return;
    }
    try {
      const parsed = parseHTLCScript(fromHex(bob.btcFunded.witness_script_hex));
      if (!parsed) { setFieldNote(hint, "Witness script is not a valid HTLC.", "error"); gate(false); return; }
      const computed = toHex(hashlockOf(fromHex(val)));
      const expected = toHex(parsed.hashlock);
      if (computed === expected) {
        setFieldNote(hint, `Preimage matches the HTLC hashlock ✓ (SHA-256 = ${expected.slice(0, 16)}…)`, "ok");
        gate(true);
      } else {
        setFieldNote(hint, `Hash mismatch — SHA-256 = ${computed.slice(0, 16)}…, expected ${expected.slice(0, 16)}…`, "error");
        gate(false);
      }
    } catch (err) {
      setFieldNote(hint, `Could not verify: ${err.message}`, "error");
      gate(false);
    }
  });
})();

// Live confirmation watch attached to Bob's funded_btc paste field. As
// soon as the user pastes a valid envelope, start polling so they can
// watch confirms accrue before clicking Fund FBC.
let bobBtcWatchStop = null;
document.getElementById("funded-btc-in").addEventListener("input", (e) => {
  if (bobBtcWatchStop) { bobBtcWatchStop(); bobBtcWatchStop = null; }
  const val = e.target.value.trim();
  if (!val) return;
  try {
    const blob = decodeBlob(val);
    if (blob.kind !== "funded_btc" || !blob.funding_txid) return;
    const statusEl = document.getElementById("fbc-fund-status");
    bobBtcWatchStop = startBtcConfWatch(statusEl, blob.funding_txid, BTC_CONF_TARGET);
  } catch {
    /* ignore — wireBlobHint already surfaces a parse error */
  }
});

// Same for Alice's funded_fbc paste — show FBC confirms accruing so she
// knows when it's safe to claim (SPEC §5.4 requires ≥ 12 FBC confirms).
let aliceFbcWatchStop = null;
document.getElementById("funded-fbc-in").addEventListener("input", (e) => {
  if (aliceFbcWatchStop) { aliceFbcWatchStop(); aliceFbcWatchStop = null; }
  const val = e.target.value.trim();
  if (!val) return;
  try {
    const blob = decodeBlob(val);
    if (blob.kind !== "funded_fbc" || !blob.funding_txid) return;
    const statusEl = document.getElementById("claim-status");
    aliceFbcWatchStop = startFbcConfWatch(statusEl, blob.funding_txid, FBC_CONF_TARGET);
  } catch {
    /* ignore */
  }
});

// ---- Automatic restore from localStorage ----
//
// If a prior session left persisted state, rehydrate the in-memory role
// objects and show a banner at the top of the matching flow. This is the
// mechanism that prevents Alice from losing her preimage if she closes the
// tab mid-swap. We deliberately do NOT auto-select a role: the user opts
// in by clicking the banner's "Resume" button, which avoids stomping on
// fresh swaps on a shared machine.
function renderResumeBanner(role, data) {
  const container = (role === "alice" ? flowAlice : flowBob).querySelector(".container");
  if (!container) return;
  const banner = document.createElement("div");
  banner.className = "resume-banner";
  banner.dataset.role = role;

  const text = document.createElement("span");
  const idFrag = data.offerId ? ` ${data.offerId.slice(0, 8)}…` : "";
  const when = data._savedAt ? ` (saved ${relTime(data._savedAt)})` : "";
  text.textContent = `You have a ${role} swap${idFrag} in progress at "${data.step || "?"}"${when}.`;
  banner.appendChild(text);

  const actions = document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;";

  const resumeBtn = document.createElement("button");
  resumeBtn.type = "button";
  resumeBtn.className = "btn primary";
  resumeBtn.style.cssText = "height:28px;padding:0 12px;font-size:12px;";
  resumeBtn.textContent = "Resume";
  resumeBtn.addEventListener("click", () => {
    selectRole(role);
    hydrate(role, data);
    banner.remove();
    updateRolePill();
    showToast(`Resumed ${role} swap from ${data.step || "saved state"}`, "ok");
  });
  actions.appendChild(resumeBtn);

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "dismiss";
  dismiss.textContent = "Discard";
  dismiss.addEventListener("click", async () => {
    const ok = await confirmModal({
      title: `Discard saved ${role} swap?`,
      body: "Only discard if you're sure the on-chain swap is resolved. For Alice, discarding before claiming FBC forfeits the swap; she'll have to wait until the BTC refund height to recover her coins.",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
    clearState(role);
    banner.remove();
    updateRolePill();
  });
  actions.appendChild(dismiss);

  banner.appendChild(actions);
  container.prepend(banner);
}

// Short relative-time formatter: "3m ago", "2h ago", "5d ago".
function relTime(ms) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.floor(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Reconstruct in-memory state from persisted data, enabling the buttons
// appropriate for the step reached. Called only when the user clicks
// "Resume" on the banner.
function hydrate(role, data) {
  if (role === "alice") {
    if (data.preimage) alice.preimage = fromHex(data.preimage);
    if (data.hashlock) alice.hashlock = fromHex(data.hashlock);
    if (data.offerId) alice.offerId = data.offerId;
    if (data.offer) {
      alice.offer = data.offer;
      document.getElementById("offer-blob").value = encodeBlob(data.offer);
      document.getElementById("offer-json").textContent = JSON.stringify(data.offer, null, 2);
      document.getElementById("process-accept").disabled = false;
    }
    if (data.accept) {
      alice.accept = data.accept;
      document.getElementById("accept-blob-in").value = encodeBlob(data.accept);
      if (data.offer) {
        const { btc, fbc } = htlcsFromOfferAccept(data.offer, data.accept);
        alice.btcScript = buildHTLCScript(btc);
        alice.fbcScript = buildHTLCScript(fbc);
        const btcAddr = btcHTLCAddress(alice.btcScript, BTC_NETWORK);
        renderSummary(document.getElementById("btc-fund-summary"), [
          { label: "Fund amount", text: `${data.offer.amount_btc.toLocaleString()} sat` },
          { label: "HTLC address", mono: btcAddr },
          { label: "Refund at block", text: data.offer.btc_refund_height.toLocaleString() },
          { label: "Hashlock", mono: `${data.offer.hashlock.slice(0, 24)}…` },
        ]);
        document.getElementById("fund-btc").disabled = false;
      }
    }
    if (data.btcFundedTxid) {
      alice.btcFundedTxid = data.btcFundedTxid;
      alice.btcFundedVout = data.btcFundedVout ?? 0;
      document.getElementById("claim-fbc").disabled = false;
      // Button stays disabled by default; countdown enables it when the
      // BTC tip reaches T1.
      startBtcConfWatch(
        document.getElementById("btc-fund-status"),
        data.btcFundedTxid,
        BTC_CONF_TARGET,
      );
      startAliceBtcRefundCountdown();
    }
    if (data.step === "fbc-claimed" && data.preimage) {
      const claimStatus = document.getElementById("claim-status");
      setFieldNote(claimStatus, "Swap completed in a previous session. Preimage shown below for hand-off.", "ok");
      renderPreimagePanel(claimStatus, data.preimage);
    }
  } else if (role === "bob") {
    if (data.offer) {
      bob.offer = data.offer;
      document.getElementById("offer-blob-in").value = encodeBlob(data.offer);
    }
    if (data.accept) {
      bob.accept = data.accept;
      document.getElementById("accept-blob").value = encodeBlob(data.accept);
      if (data.offer) {
        const { fbc } = htlcsFromOfferAccept(data.offer, data.accept);
        bob.fbcScript = buildHTLCScript(fbc);
      }
    }
    if (data.btcFunded) {
      bob.btcFunded = data.btcFunded;
      document.getElementById("funded-btc-in").value = encodeBlob(data.btcFunded);
    }
    if (data.fbcFundedTxid) {
      bob.fbcFundedTxid = data.fbcFundedTxid;
      bob.fbcFundedVout = data.fbcFundedVout ?? 0;
      // Stays disabled until a valid preimage lands in the input field
      // (either manually or via auto-extract). See wirePreimageHint.
      document.getElementById("claim-btc").disabled = true;
      startBobFbcRefundCountdown();
      startPreimageAutoExtract();
    }
  }
}

// ---- Role-switch "swap in progress" pill ----
// Shown on the *inactive* role tab so the user doesn't lose track of a
// half-finished Alice swap while looking at the Bob flow (or vice versa).
function updateRolePill() {
  for (const [role, btn] of [["alice", roleAlice], ["bob", roleBob]]) {
    const sub = btn.querySelector(".role-sub");
    if (!sub) continue;
    sub.querySelector(".resume-pill")?.remove();
    if (hasState(role)) {
      const pill = document.createElement("span");
      pill.className = "resume-pill";
      pill.textContent = "in progress";
      sub.appendChild(pill);
    }
  }
}
updateRolePill();

(function restoreFromStorage() {
  for (const role of ["alice", "bob"]) {
    const data = loadState(role);
    if (data) renderResumeBanner(role, data);
  }
})();

// ---- Deep link routing (#b=<envelope>) ----
//
// Counterparty shares `https://swap.fistbump.org/#b=fistbump-swap:v1:...`.
// On page load, decode the envelope, pick the correct role and paste
// field based on blob.kind, and dispatch an input event so the existing
// blob-hint + confirmation-watch wiring picks it up. Doesn't auto-click
// any buttons — the user still reviews and hits Verify/Fund themselves.
(function routeDeepLink() {
  const hash = location.hash || "";
  const match = hash.match(/^#b=(.+)$/);
  if (!match) return;
  const envelope = decodeURIComponent(match[1]);
  let blob;
  try { blob = decodeBlob(envelope); }
  catch (err) { showToast("Deep link: " + err.message, "error"); return; }

  // kind → (role to select, input field to populate).
  const ROUTES = {
    offer:      { role: "bob",   fieldId: "offer-blob-in",  label: "offer" },
    accept:     { role: "alice", fieldId: "accept-blob-in", label: "accept" },
    funded_btc: { role: "bob",   fieldId: "funded-btc-in",  label: "funded_btc" },
    funded_fbc: { role: "alice", fieldId: "funded-fbc-in",  label: "funded_fbc" },
  };
  const route = ROUTES[blob.kind];
  if (!route) return;

  selectRole(route.role);
  const field = document.getElementById(route.fieldId);
  if (!field) return;
  field.value = envelope;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.scrollIntoView({ behavior: "smooth", block: "center" });
  // Clear the hash so a reload doesn't re-route and the user can share
  // a plain link going forward.
  history.replaceState(null, "", location.pathname);
  showToast(`Loaded ${route.label} blob from link — review and continue`, "ok");
})();

// ---- Dev resume ----
//
// Add `?resume=bob-claim-btc&funded=<base64url>&preimage=<hex>` to the URL
// to skip straight to Bob's step 5 with state preloaded, so iterating on
// the BTC claim signing path doesn't require redoing the full swap each
// time. `funded` is the `funded_btc` envelope Alice sent you; `preimage`
// is the hex string.
(async function maybeResume() {
  const mode = params.get("resume");
  if (!mode) return;
  try {
    if (mode === "bob-claim-btc") {
      selectRole("bob");
      // Pop a banner at the top of the Bob flow.
      const banner = document.createElement("div");
      banner.className = "field-note warn";
      banner.style.cssText =
        "border:1px solid var(--fb-accent-dim);padding:12px;border-radius:var(--fb-radius);margin-bottom:16px;";
      banner.textContent =
        "Resume mode: connect Unisat, then paste the preimage and click Claim my BTC. " +
        "Other steps are skipped.";
      flowBob.querySelector(".container").prepend(banner);

      // Need Unisat connected to sign. Wallet-connect stays manual.
      const fundedParam = params.get("funded");
      if (!fundedParam) throw new Error("resume=bob-claim-btc requires ?funded=<blob>");
      const envelope = fundedParam.startsWith("fistbump-swap:")
        ? fundedParam
        : `fistbump-swap:v1:${fundedParam}`;
      const funded = decodeBlob(envelope);
      if (funded.kind !== "funded_btc") {
        throw new Error("?funded= must be a funded_btc envelope");
      }
      bob.btcFunded = funded;

      const preimageParam = params.get("preimage");
      if (preimageParam && /^[0-9a-f]{64}$/i.test(preimageParam)) {
        document.getElementById("preimage-in").value = preimageParam.toLowerCase();
      }
      document.getElementById("claim-btc").disabled = false;
    }
  } catch (err) {
    console.error("resume failed:", err);
    showToast("Resume failed: " + err.message, "error");
  }
})();

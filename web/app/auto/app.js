// Automated buy-FBC: query maker directory, pick best quote, settle HTLC.
// ?demo=1 → in-page mock maker (no network).
// ?api=<origin> → pin one maker (MM_API.md) and use only it, ignoring the directory.

import { BTC_SOURCES } from "../btc-api.js";
import {
  generatePreimage,
  hashlockOf,
  generateOfferId,
  buildHTLCScript,
  btcHTLCAddress,
  fbcHTLCAddress,
  htlcsFromOfferAccept,
  htlcParamsForRecovery,
  buildHTLCSpendPsbt,
  finalizeHTLCSpend,
  checkTimelocks,
  fbcClaimDeadline,
  verifyFundedFbc,
  toHex,
  fromHex,
} from "../core/bundle.js";
import { selectBtcWallet } from "../btc-wallet.js";
import {
  fetchBtcTip,
  fetchFbcTip,
  fetchFbcOutput,
  fetchBtcOutput,
  fetchBtcFeeRate,
  fetchBtcTxFeeRate,
  fetchBtcConfirmations,
  rebroadcastRawTx,
} from "../chain.js";

const params = new URLSearchParams(location.search);
const DEMO =
  params.get("demo") === "1" ||
  params.get("demo") === "true" ||
  localStorage.getItem("mm_demo") === "1";

const BTC_NETWORK = "main";
const FBC_NETWORK = "main";
const BTC_CONF_TARGET = 6;
const FBC_CONF_TARGET = 12;

/**
 * Demo-mode pubkeys.
 *
 * These must be real points on secp256k1 — `buildHTLCScript` validates the
 * curve, not just the length, so the `02` + repeated-byte placeholders that
 * used to live here now throw. They are the first four multiples of the
 * generator: public, keyless, and obviously not anybody's wallet.
 */
const DEMO_PK = {
  aliceBtc: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  aliceFbc: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
  mmBtc: "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
  mmFbc: "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
};

/** localStorage multi-swap sessions (preimage + resume state). */
const SWAPS_STORAGE_KEY = "mm_swaps_v1";
const SWAPS_MAX = 40;
/** How long a finished swap stays listed after its secret has been wiped. */
const DONE_RETENTION_MS = 7 * 864e5;
/**
 * Grace period before a completed swap's preimage is wiped.
 *
 * "Done" is set the moment `signHtlcSpend` returns, which is zero
 * confirmations — the claim can still fail to broadcast, be evicted at the
 * hardcoded fee, or be reorged out. Wiping the secret at that instant turns a
 * retriable swap into an unrecoverable one, so hold it for a day first. The
 * point of the wipe is to stop secrets accumulating indefinitely, and a day
 * costs nothing against that.
 */
const PREIMAGE_RETENTION_AFTER_DONE_MS = 864e5;

/**
 * How long a swap's own FBC refund window still has to run.
 *
 * A claim being broadcast is not a claim being final. Until it is buried it
 * can be evicted or reorged away — and if it was mined and then reorged, the
 * preimage is already public while the FBC is not yet ours. The maker can then
 * refund the FBC at T2 and use that public secret to take the BTC, and a taker
 * who has deleted their copy cannot re-claim to stop it. That is both legs.
 *
 * So retention has to track the window in which the secret could still matter,
 * not a constant chosen in the abstract. The window is the offer's own: FBC
 * blocks are 120 seconds, so the refund height is that many blocks away from
 * the reference height it was quoted against.
 *
 * Derived rather than polled because this runs on every localStorage write and
 * cannot await a chain tip. Erring long costs nothing but a secret sitting in
 * storage slightly past its usefulness; erring short costs the swap.
 */
const FBC_BLOCK_MS = 120_000;
function fbcRefundWindowEndsAt(session) {
  const o = session?.offer;
  const blocks = Number(o?.fbc_refund_height) - Number(o?.fbc_reference_height);
  if (!Number.isFinite(blocks) || blocks <= 0) return null;
  const from = Number(session.created_at) || Number(session.updated_at) || 0;
  if (!from) return null;
  return from + blocks * FBC_BLOCK_MS;
}

// ── helpers ───────────────────────────────────────────────────────────────

const TOAST_STACK = document.getElementById("toast-stack");

function showToast(message, kind) {
  if (!TOAST_STACK) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? ` ${kind}` : "");
  el.textContent = message;
  TOAST_STACK.appendChild(el);
  setTimeout(() => {
    el.classList.add("fade-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
    // Durations by how long the message takes to act on, not by severity.
    // "do not send again" has to survive being looked away from.
  }, kind === "error" ? 5200 : kind === "warn" ? 14000 : 2600);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtBtc(sats) {
  return (sats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
}
function fmtFbc(dd) {
  const n = dd / 1e6;
  const maxFrac = n >= 1000 ? 2 : n >= 10 ? 4 : 6;
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFrac,
  });
}
function shortHex(h, n = 10) {
  if (!h || h.length < n * 2) return h || "—";
  return `${h.slice(0, n)}…`;
}
function normalizeMakerUrl(raw) {
  let u = (raw || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

/**
 * `?api=` pins one maker (MM_API.md). It is user intent, so it wins over the
 * directory — but "the user pasted it" is not "it is safe to hand to fetch()",
 * and the link itself may have been written by someone else. Reduce it to a
 * bare origin or reject it:
 *   - credentials in the URL would be replayed to the maker on every call, and
 *     appear in referrers/logs;
 *   - a path or query would be prefixed to every API path we build, so
 *     `?api=https://host/x%3Fy=` turns `/v1/quote` into someone else's endpoint;
 *   - plaintext http would expose the whole swap to any on-path observer, who
 *     can rewrite pubkeys and heights at will. Loopback is exempt: the sample
 *     maker in bot/ binds 127.0.0.1 with no certificate, and connect-src in
 *     index.html already allows exactly that.
 * @returns {string} normalized origin, or "" if the pin is unusable.
 */
function parsePinnedMakerUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return "";
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return "";
  }
  const loopback =
    u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return "";
  if (u.username || u.password) return "";
  return u.origin;
}

// ── DOM ───────────────────────────────────────────────────────────────────

const el = {
  amountIn: document.getElementById("amount-in"),
  amountOut: document.getElementById("amount-out"),
  amountHint: document.getElementById("amount-hint"),
  quoteList: document.getElementById("quote-list"),
  quoteEmpty: document.getElementById("quote-empty"),
  quoteVia: document.getElementById("quote-via"),
  quoteRate: document.getElementById("quote-rate"),
  quoteSpread: document.getElementById("quote-spread"),
  quoteExpires: document.getElementById("quote-expires"),
  swapBtn: document.getElementById("swap-btn"),
  marketCard: document.getElementById("market-card"),
  marketUsd: document.getElementById("market-usd"),
  marketSub: document.getElementById("market-sub"),
  marketPerBtc: document.getElementById("market-perbtc"),
  receiveHint: document.getElementById("receive-hint"),
  resumeCallout: document.getElementById("resume-callout"),
  resumeText: document.getElementById("resume-text"),
  marketTrades: document.getElementById("market-trades"),
  swapCard: document.getElementById("swap-card"),
  progressCard: document.getElementById("progress-card"),
  progressTitle: document.getElementById("progress-title"),
  progressSummary: document.getElementById("progress-summary"),
  progressSteps: document.getElementById("progress-steps"),
  progressAction: document.getElementById("progress-action"),
  progressActionBtn: document.getElementById("progress-action-btn"),
  progressDone: document.getElementById("progress-done"),
  progressDoneText: document.getElementById("progress-done-text"),
  resetBtn: document.getElementById("reset-btn"),
  doneResetBtn: document.getElementById("done-reset-btn"),
  refreshQuotes: document.getElementById("refresh-quotes"),
  sessionsSection: document.getElementById("sessions-section"),
  sessionsList: document.getElementById("sessions-list"),
  sessionsEmpty: document.getElementById("sessions-empty"),
  psbtPanel: document.getElementById("psbt-panel"),
  psbtTitle: document.getElementById("psbt-title"),
  psbtNote: document.getElementById("psbt-note"),
  psbtText: document.getElementById("psbt-text"),
  psbtCopy: document.getElementById("psbt-copy"),
};

// ── Maker directory ───────────────────────────────────────────────────────
// Loaded from makers.json + optional custom URLs. UI never requires pasting a URL.

/** @type {{ name: string, url: string, note?: string }[]} */
let directory = [];

/**
 * @typedef {{
 *   maker: { name: string, url: string },
 *   declined: boolean,
 *   quote: object | null,
 *   error: string | null,
 * }} QuoteRow
 *
 * `declined` means the maker answered *and* said no, with a reason — a
 * different thing from being unreachable, and the difference is the whole
 * point: telling a user "the maker is offline, try Refresh" when it is
 * actually up and saying "that is more than my inventory" sends them to retry
 * something that will never work.
 *
 * Reachability is not stored separately. It is `quote || declined`, and an
 * `online` field carrying the same fact is one more thing that can disagree
 * with the other two — which is precisely how this bug arose.
 */

/** @type {QuoteRow[]} */
let rows = [];
/** @type {QuoteRow | null} */
let selected = null;
let quoteSeq = 0;
let quoteTimer = null;

const state = {
  running: false,
  /** @type {Uint8Array | null} */
  preimage: null,
  offer: null,
  accept: null,
  swapId: null,
  mmApi: "",
  /** @type {string | null} active session id while running */
  activeSessionId: null,
};

// ── Multi-swap localStorage ───────────────────────────────────────────────
/**
 * @typedef {{
 *   swap_id: string,
 *   maker_url: string,
 *   maker_name: string,
 *   preimage_hex: string,
 *   offer: object,
 *   accept: object,
 *   funded_btc: object | null,
 *   funded_fbc: object | null,
 *   btc_confs: number,
 *   fbc_confs: number,
 *   maker_state: string | null,
 *   btc_htlc_address: string | null,
 *   alice_btc_address: string | null,
 *   alice_fbc_address: string | null,
 *   phase: "accepted" | "awaiting_fund" | "waiting_maker" | "claimable" | "done" | "failed",
 *   claim_txid: string | null,
 *   error: string | null,
 *   created_at: number,
 *   updated_at: number,
 *   dismissed: boolean,
 * }} SavedSwap
 */

function readSwapsDb() {
  try {
    const raw = localStorage.getItem(SWAPS_STORAGE_KEY);
    if (!raw) return { version: 1, swaps: {} };
    const db = JSON.parse(raw);
    if (!db || typeof db !== "object") return { version: 1, swaps: {} };
    if (!db.swaps || typeof db.swaps !== "object") db.swaps = {};
    db.version = 1;
    return db;
  } catch {
    return { version: 1, swaps: {} };
  }
}

/**
 * Preimages sit in plaintext localStorage, so anything that can run script on
 * this origin can read every one of them. A live swap has no alternative — the
 * secret is the only way to claim, and it must survive a refresh. A *finished*
 * swap is different: the preimage is already published on-chain by the claim
 * tx, so keeping a copy buys nothing and only widens the blast radius of an
 * XSS. Drop it the moment the swap is done, then drop the row itself once it
 * has aged out of the list. Unfinished rows are never deleted, whatever their
 * age: losing that secret loses the coins.
 */
function pruneSwaps(db) {
  const swaps = db.swaps || {};
  const now = Date.now();
  for (const s of Object.values(swaps)) {
    if (!s?.swap_id) continue;
    if (s.phase !== "done" && s.phase !== "refunded") continue;
    const age = now - (s.updated_at || 0);
    // The secret outlives the timer whenever the swap's own refund window
    // outlives it. `claim_confirmed` short-circuits this: once the claim is
    // buried the FBC is ours, nothing can undo it, and the preimage is public
    // on chain anyway — keeping a copy then only widens an XSS.
    const windowEnds = fbcRefundWindowEndsAt(s);
    const stillUseful = !s.claim_confirmed && windowEnds !== null && now < windowEnds;
    if (s.preimage_hex && age > PREIMAGE_RETENTION_AFTER_DONE_MS && !stillUseful) {
      s.preimage_hex = "";
    }
    // Never drop a row whose terminal spend has not confirmed. Deleting it
    // takes the txid and the raw transaction with it, and with them the only
    // way to rebroadcast a refund that was evicted from the mempool.
    const spendUnconfirmed =
      (s.phase === "done" && !s.claim_confirmed) ||
      (s.phase === "refunded" && !s.refund_confirmed);
    if (age > DONE_RETENTION_MS && !spendUnconfirmed && !stillUseful) {
      delete swaps[s.swap_id];
    }
  }
  const entries = Object.values(swaps);
  if (entries.length > SWAPS_MAX) {
    entries
      .sort((a, b) => (a.updated_at || 0) - (b.updated_at || 0))
      .slice(0, entries.length - SWAPS_MAX)
      .forEach((s) => {
        // Same rule as the age prune: a terminal phase whose spend has not
        // confirmed is not finished, and evicting it to stay under the cap
        // discards the only copy of a refund that may need rebroadcasting.
        // The cap is a tidiness bound, not a reason to lose coins.
        if (s.phase === "done" && !s.claim_confirmed) return;
        if (s.phase === "refunded" && !s.refund_confirmed) return;
        if (s.phase === "done" || s.phase === "refunded" || s.dismissed) delete swaps[s.swap_id];
      });
  }
}

function writeSwapsDb(db) {
  pruneSwaps(db);
  localStorage.setItem(SWAPS_STORAGE_KEY, JSON.stringify(db));
}

/** @returns {SavedSwap[]} */
function listSavedSwaps({ includeDismissed = false, includeDone = true } = {}) {
  const db = readSwapsDb();
  return Object.values(db.swaps)
    .filter((s) => {
      // A row with no preimage is unresumable and worthless — unless it is
      // done, in which case the secret was wiped on purpose (see pruneSwaps).
      if (!s?.swap_id) return false;
      if (!s.preimage_hex && s.phase !== "done" && s.phase !== "refunded") return false;
      if (!includeDismissed && s.dismissed) return false;
      // `refunded` is as finished as `done`. Excluding only `done` made a
      // refunded swap show as "1 swap in progress", and resuming it re-notified
      // the maker, rewound phase to waiting_maker and re-offered "Recover BTC"
      // on an outpoint that is already spent.
      if (!includeDone && (s.phase === "done" || s.phase === "refunded")) return false;
      return true;
    })
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/** @returns {SavedSwap | null} */
function getSavedSwap(swapId) {
  if (!swapId) return null;
  return readSwapsDb().swaps[swapId] || null;
}

/** @param {Partial<SavedSwap> & { swap_id: string }} patch */
function upsertSavedSwap(patch) {
  const db = readSwapsDb();
  const prev = db.swaps[patch.swap_id] || {};
  /** @type {SavedSwap} */
  const next = {
    swap_id: patch.swap_id,
    maker_url: patch.maker_url ?? prev.maker_url ?? "",
    maker_name: patch.maker_name ?? prev.maker_name ?? "",
    preimage_hex: patch.preimage_hex ?? prev.preimage_hex ?? "",
    offer: patch.offer ?? prev.offer ?? null,
    accept: patch.accept ?? prev.accept ?? null,
    funded_btc: patch.funded_btc !== undefined ? patch.funded_btc : prev.funded_btc ?? null,
    // Recorded the instant the funding tx is broadcast, before the vout is
    // known, so a crash between the two can never cause a second send.
    btc_funding_txid:
      patch.btc_funding_txid !== undefined
        ? patch.btc_funding_txid
        : prev.btc_funding_txid ?? null,
    funded_fbc: patch.funded_fbc !== undefined ? patch.funded_fbc : prev.funded_fbc ?? null,
    btc_confs: patch.btc_confs ?? prev.btc_confs ?? 0,
    fbc_confs: patch.fbc_confs ?? prev.fbc_confs ?? 0,
    maker_state: patch.maker_state !== undefined ? patch.maker_state : prev.maker_state ?? null,
    btc_htlc_address:
      patch.btc_htlc_address !== undefined
        ? patch.btc_htlc_address
        : prev.btc_htlc_address ?? null,
    alice_btc_address:
      patch.alice_btc_address !== undefined
        ? patch.alice_btc_address
        : prev.alice_btc_address ?? null,
    alice_fbc_address:
      patch.alice_fbc_address !== undefined
        ? patch.alice_fbc_address
        : prev.alice_fbc_address ?? null,
    phase: patch.phase ?? prev.phase ?? "accepted",
    claim_txid: patch.claim_txid !== undefined ? patch.claim_txid : prev.claim_txid ?? null,
    refund_txid: patch.refund_txid !== undefined ? patch.refund_txid : prev.refund_txid ?? null,
    error: patch.error !== undefined ? patch.error : prev.error ?? null,
    created_at: prev.created_at || Date.now(),
    updated_at: Date.now(),
    dismissed: patch.dismissed !== undefined ? patch.dismissed : prev.dismissed ?? false,
  };
  // A completed swap has had its preimage wiped on purpose, so a missing
  // secret there is expected rather than a bug. Keyed on the STORED phase as
  // well as the incoming one: an error written after completion arrives with
  // phase "waiting_maker", and refusing that write would silently swallow the
  // error instead of showing it on the session row.
  const alreadyDone = prev.phase === "done" || prev.phase === "refunded";
  if (
    next.phase !== "done" &&
    next.phase !== "refunded" &&
    !alreadyDone &&
    (!next.preimage_hex || !/^[0-9a-f]{64}$/i.test(next.preimage_hex))
  ) {
    console.warn("[sessions] refusing to save swap without preimage_hex", next.swap_id);
    return null;
  }
  db.swaps[next.swap_id] = next;
  writeSwapsDb(db);
  renderSessions();
  return next;
}

function dismissSavedSwap(swapId) {
  const s = getSavedSwap(swapId);
  if (!s) return;
  upsertSavedSwap({ swap_id: swapId, dismissed: true });
}

function phaseLabel(phase) {
  switch (phase) {
    case "accepted":
    case "awaiting_fund":
      return "Fund BTC";
    case "waiting_maker":
      return "Waiting";
    case "claimable":
      return "Claim FBC";
    case "done":
      return "Done";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Failed";
    default:
      return phase || "—";
  }
}

/** CSS modifier for status pill */
function phaseTone(phase) {
  switch (phase) {
    case "accepted":
    case "awaiting_fund":
      return "fund";
    case "waiting_maker":
      return "wait";
    case "claimable":
      return "claim";
    case "done":
      return "done";
    case "refunded":
      return "done";
    case "failed":
      return "fail";
    default:
      return "wait";
  }
}

function confProgressHtml(s) {
  if (s.phase === "claimable") {
    return `<div class="session-progress claim-ready">
      <span class="session-progress-label">Ready to claim FBC</span>
      <div class="session-bar"><div class="session-bar-fill" style="width:100%"></div></div>
    </div>`;
  }
  if (s.phase === "done") {
    const tx = s.claim_txid ? shortHex(s.claim_txid, 8) : "complete";
    return `<div class="session-progress done-line">
      <span class="session-progress-label">Claimed · ${escapeHtml(tx)}</span>
    </div>`;
  }
  if (s.phase === "awaiting_fund" || s.phase === "accepted") {
    return `<div class="session-progress">
      <span class="session-progress-label">Awaiting BTC deposit</span>
      <div class="session-bar"><div class="session-bar-fill dim" style="width:6%"></div></div>
    </div>`;
  }
  // waiting_maker (and failed with partial progress)
  const btc = Math.min(BTC_CONF_TARGET, Math.max(0, s.btc_confs || 0));
  const fbcOn = !!s.funded_fbc;
  const fbc = Math.min(FBC_CONF_TARGET, Math.max(0, s.fbc_confs || 0));
  // Weighted: first half = BTC confs, second = FBC fund+confs
  let pct;
  if (!fbcOn) {
    pct = Math.round((btc / BTC_CONF_TARGET) * 55);
  } else {
    pct = 55 + Math.round((fbc / FBC_CONF_TARGET) * 45);
  }
  const barW = pct > 0 ? pct : 0;
  let label;
  let sub = "";
  if (fbcOn) {
    label = `BTC ${btc}/${BTC_CONF_TARGET} · FBC ${fbc}/${FBC_CONF_TARGET}`;
  } else if (btc === 0) {
    label = `BTC confirmations ${btc}/${BTC_CONF_TARGET}`;
    sub = "Waiting on first block";
  } else {
    label = `BTC confirmations ${btc}/${BTC_CONF_TARGET}`;
  }
  return `<div class="session-progress">
    <div class="session-progress-row">
      <span class="session-progress-label">${escapeHtml(label)}</span>
      ${sub ? `<span class="session-progress-sub">${escapeHtml(sub)}</span>` : ""}
    </div>
    <div class="session-bar"><div class="session-bar-fill" style="width:${barW}%"></div></div>
  </div>`;
}

/**
 * Whether "Recover BTC" should be offered for a saved swap.
 *
 * Shown once BTC has been funded and the swap has not completed. The button
 * itself re-checks the height against the chain before signing — this is only
 * about not offering an action that is obviously wrong, e.g. after a claim has
 * already completed the swap (refunding then just burns a fee) or before any
 * BTC was ever committed.
 *
 * It IS offered while claimable: if the FBC leg turned out to be unclaimable
 * for any reason, the refund is the taker's only way out.
 */
function canRecoverBtc(s) {
  if (!s) return false;
  if (s.phase === "done" || s.phase === "refunded") return false;
  if (!s.offer || !s.accept) return false;
  return Boolean(s.funded_btc?.funding_txid || s.btc_funding_txid);
}

function renderSessions() {
  // The callout mirrors this list, so they are repainted together — two
  // sources of truth for "do you have a swap running" is how one of them ends
  // up stale and wrong.
  paintResumeCallout();
  if (!el.sessionsSection || !el.sessionsList) return;
  const open = listSavedSwaps({ includeDismissed: false, includeDone: true }).filter(
    (s) =>
      (s.phase !== "done" && s.phase !== "refunded") ||
      Date.now() - (s.updated_at || 0) < DONE_RETENTION_MS,
  );
  el.sessionsList.innerHTML = "";
  if (!open.length) {
    // The panel is a tab now, so it is always reachable and has to say
    // something when empty rather than render as a blank rectangle.
    el.sessionsSection.classList.remove("hidden");
    if (el.sessionsEmpty) {
      el.sessionsEmpty.textContent = "No swaps yet. One will appear here once you start.";
      el.sessionsEmpty.classList.remove("hidden");
    }
    const c = el.sessionsSection.querySelector(".sessions-count");
    if (c) c.textContent = "";
    return;
  }
  el.sessionsEmpty?.classList.add("hidden");
  el.sessionsSection.classList.remove("hidden");

  const countEl = el.sessionsSection.querySelector(".sessions-count");
  if (countEl) {
    const active = open.filter((s) => s.phase !== "done" && s.phase !== "refunded").length;
    countEl.textContent = active ? `${active} open` : `${open.length}`;
  }

  for (const s of open) {
    const row = document.createElement("div");
    row.className =
      "session-card" +
      (s.phase === "done" ? " is-done" : "") +
      (s.phase === "claimable" ? " is-claimable" : "") +
      (s.phase === "failed" || s.error ? " is-error" : "");
    row.setAttribute("data-swap-id", s.swap_id);

    const maker = s.maker_name || (s.maker_url || "").replace(/^https?:\/\//, "") || "maker";
    const btcAmt = s.offer ? fmtBtc(s.offer.amount_btc) : "—";
    const fbcAmt = s.offer ? fmtFbc(s.offer.amount_fbc) : "—";

    row.innerHTML = `
      <div class="session-card-top">
        <span class="session-pill tone-${phaseTone(s.phase)}">${escapeHtml(phaseLabel(s.phase))}</span>
        <span class="session-id mono" title="${escapeHtml(s.swap_id)}">${escapeHtml(shortHex(s.swap_id, 8))}</span>
      </div>
      <div class="session-amounts">
        <div class="session-amt">
          <span class="session-amt-label">You pay</span>
          <span class="session-amt-val mono"><span class="num">${escapeHtml(btcAmt)}</span> <span class="unit">BTC</span></span>
        </div>
        <div class="session-amt-arrow" aria-hidden="true">→</div>
        <div class="session-amt">
          <span class="session-amt-label">You receive</span>
          <span class="session-amt-val mono accent"><span class="num">${escapeHtml(fbcAmt)}</span> <span class="unit">FBC</span></span>
        </div>
      </div>
      <div class="session-tags">
        <span class="session-tag" title="${escapeHtml(s.maker_url || "")}">via ${escapeHtml(maker)}</span>
      </div>
      ${confProgressHtml(s)}
      ${s.error ? `<div class="session-err" title="${escapeHtml(s.error)}">${escapeHtml(s.error)}</div>` : ""}
      <div class="session-footer">
        ${
          s.phase === "done"
            ? `<span class="session-done-note">Completed</span>`
            : s.phase === "refunded"
              ? `<span class="session-done-note">BTC recovered</span>`
              : `<button type="button" class="btn primary session-resume" data-act="resume">Resume</button>`
        }
        ${
          canRecoverBtc(s)
            ? `<button type="button" class="session-recover" data-act="recover" title="Spend your BTC HTLC back to your own wallet after the refund height">Recover BTC</button>`
            : ""
        }
        <button type="button" class="session-hide" data-act="dismiss" title="Hide from list (data kept until pruned)">Hide</button>
      </div>
    `;
    row.querySelector('[data-act="resume"]')?.addEventListener("click", () => {
      resumeSavedSwap(s.swap_id).catch((err) => {
        console.error(err);
        showToast(err.message || "Resume failed", "error");
      });
    });
    row.querySelector('[data-act="recover"]')?.addEventListener("click", async () => {
      const btn = row.querySelector('[data-act="recover"]');
      btn.disabled = true;
      try {
        const txid = await refundBtc(s.swap_id);
        showToast(`BTC refund broadcast: ${shortHex(txid, 10)}`, "ok");
        renderSessions();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Recover failed", "error");
        btn.disabled = false;
      }
    });
    row.querySelector('[data-act="dismiss"]')?.addEventListener("click", () => {
      dismissSavedSwap(s.swap_id);
      showToast("Session hidden", "ok");
    });
    el.sessionsList.appendChild(row);
  }
}

const REGISTRY_URL =
  params.get("registry") ||
  window.__MM_REGISTRY__ ||
  localStorage.getItem("mm_registry") ||
  // same origin when deployed on swap.fistbump.org
  (location.hostname.endsWith("fistbump.org")
    ? `${location.origin}/api`
    : "http://127.0.0.1:8790");

/** Maker pinned with ?api= — the only maker used when present. @see parsePinnedMakerUrl */
const PINNED_MAKER = parsePinnedMakerUrl(params.get("api"));

async function loadDirectory() {
  // A pin replaces the directory instead of joining it. Merging would mean the
  // "best" price still wins, so the maker the user asked for would usually not
  // be the maker they swap with — the pin has to be exclusive to mean anything.
  if (PINNED_MAKER) {
    directory = [
      {
        name: PINNED_MAKER.replace(/^https?:\/\//, ""),
        url: PINNED_MAKER,
        note: "pinned via ?api=",
      },
    ];
    return;
  }

  const makers = [];
  if (DEMO) {
    makers.push({ name: "Demo maker", url: "demo://local" });
  }

  // Live registry (bots self-register here)
  try {
    const res = await fetch(`${REGISTRY_URL.replace(/\/+$/, "")}/v1/makers`, {
      cache: "no-store",
    });
    if (res.ok) {
      const doc = await res.json();
      for (const m of doc.makers || []) {
        makers.push({
          name: m.name || m.url,
          url: normalizeMakerUrl(m.url),
          note: m.note || "",
        });
      }
    }
  } catch {
    /* registry offline */
  }

  // Optional static fallback / curated pins
  try {
    const res = await fetch("../makers.json", { cache: "no-store" });
    if (res.ok) {
      const doc = await res.json();
      for (const m of doc.makers || []) {
        makers.push({
          name: m.name || m.url,
          url: normalizeMakerUrl(m.url),
          note: m.note,
        });
      }
    }
  } catch {
    /* ignore */
  }

  const seen = new Set();
  directory = makers.filter((m) => {
    if (!m.url || seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });
}

// ── Demo maker ────────────────────────────────────────────────────────────

const demoMm = (() => {
  const quotes = new Map();
  const swaps = new Map();
  const MID = 42000;
  const SPREAD = 50;
  return {
    async getQuote(amountBtc) {
      await sleep(120);
      const amount_btc = Math.round(amountBtc * 1e8);
      const amount_fbc = Math.round(
        ((amountBtc * MID) / (1 + SPREAD / 10000)) * 1e6,
      );
      const q = {
        quote_id: `q_demo_${Date.now()}`,
        amount_btc,
        amount_fbc,
        mid_fbc_per_btc: MID,
        spread_bps: SPREAD,
        mm_btc_pubkey: DEMO_PK.mmBtc,
        mm_fbc_pubkey: DEMO_PK.mmFbc,
        // SPEC §4.2 ordering: BTC (the taker's refund) 48h, FBC 24h.
        btc_reference_height: 900000,
        fbc_reference_height: 100000,
        btc_refund_height: 900288,
        fbc_refund_height: 100720,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      };
      quotes.set(q.quote_id, q);
      return q;
    },
    async accept(quoteId, offer) {
      const q = quotes.get(quoteId);
      if (!q) throw new Error("unknown quote");
      const accept = {
        version: 1,
        kind: "accept",
        offer_id: offer.offer_id,
        bob_btc_pubkey: q.mm_btc_pubkey,
        bob_fbc_pubkey: q.mm_fbc_pubkey,
      };
      const swap_id = `s_${offer.offer_id.slice(0, 12)}`;
      swaps.set(swap_id, {
        swap_id,
        state: "accepted",
        offer,
        accept,
        funded_btc: null,
        funded_fbc: null,
        btc_confs: 0,
        fbc_confs: 0,
      });
      return { swap_id, accept };
    },
    async fundedBtc(swapId, funded) {
      const s = swaps.get(swapId);
      s.funded_btc = funded;
      s.state = "waiting_btc_confs";
      (async () => {
        for (let c = 1; c <= 6; c++) {
          await sleep(700);
          s.btc_confs = c;
        }
        s.funded_fbc = {
          version: 1,
          kind: "funded_fbc",
          offer_id: s.offer.offer_id,
          funding_txid: "f".repeat(64),
          funding_vout: 0,
          funding_amount: s.offer.amount_fbc,
          witness_script_hex: "00",
          htlc_address: "fb1qdemo",
        };
        s.state = "waiting_fbc_confs";
        for (let c = 1; c <= 12; c++) {
          await sleep(250);
          s.fbc_confs = c;
        }
        s.state = "claimable";
      })();
      return s;
    },
    async getSwap(id) {
      return { ...swaps.get(id) };
    },
  };
})();

/**
 * A maker answered and refused.
 *
 * Separate from a plain Error so the caller can tell "nobody is home" from
 * "somebody is home and explained why not". Only the first of those is worth
 * retrying.
 */
class MakerRefusal extends Error {
  constructor(message, status) {
    super(message);
    this.name = "MakerRefusal";
    this.status = status;
  }
}

async function makerFetch(base, path, opts = {}) {
  if (base.startsWith("demo:")) {
    if (path === "/v1/quote" && opts.method === "POST") {
      const body = JSON.parse(opts.body || "{}");
      return demoMm.getQuote(body.amount_btc);
    }
    throw new Error("demo path");
  }
  const res = await fetch(base + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* handled below — an unparseable body is a broken maker, not a refusal */
  }
  if (body === null || typeof body !== "object") {
    throw new Error(`${res.status} ${text.slice(0, 80)}`);
  }
  if (!res.ok) {
    // 4xx with a reason is the maker working correctly and declining this
    // particular request: wrong size, no inventory, quote expired. 5xx is the
    // maker being broken, and an unparseable body means something in front of
    // it answered instead — both are "offline" in the sense the user cares
    // about, because there is nothing to do but wait or pick someone else.
    if (res.status >= 400 && res.status < 500 && typeof body.error === "string") {
      throw new MakerRefusal(body.error, res.status);
    }
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

// ── Quote all makers ──────────────────────────────────────────────────────

/** Maker-supplied text is untrusted and unbounded; show a readable slice. */
const MAX_REASON_CHARS = 160;

function reasonText(err) {
  const raw = err instanceof Error ? err.message : String(err);
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON_CHARS
    ? `${flat.slice(0, MAX_REASON_CHARS - 1)}…`
    : flat;
}

const isPosInt = (v) => Number.isInteger(v) && v > 0;
const isPubkey = (v) => typeof v === "string" && /^0[23][0-9a-f]{64}$/i.test(v);

/**
 * Why this quote is unusable, or null if it is fine.
 *
 * A maker can return HTTP 200 with any body it likes, and everything
 * downstream assumed the fields were there. `{}` sailed through as a live
 * quote: `r.quote` is truthy, and since every comparison against `undefined`
 * is false, the seedless reduce that picks the best quote returned it over
 * honest ones. It got auto-selected, the card read "You receive NaN FBC", and
 * the Swap button went live.
 *
 * Checked here rather than at swap time because the damage is in the
 * selection: a maker that returns junk should never outrank one that answered
 * properly.
 */
function quoteProblem(q, expectedSats) {
  if (!q || typeof q !== "object") return "returned no quote";
  if (typeof q.quote_id !== "string" || !q.quote_id) return "quote is missing an id";
  if (!isPosInt(q.amount_btc) || !isPosInt(q.amount_fbc)) return "quote has invalid amounts";
  if (q.amount_btc !== expectedSats) {
    // A quote for a different size than we asked for. Caught later at swap
    // time too, but by then it has already been shown as the best price.
    return "quoted a different amount than requested";
  }
  if (!isPubkey(q.mm_btc_pubkey) || !isPubkey(q.mm_fbc_pubkey)) {
    return "quote has invalid maker pubkeys";
  }
  for (const k of [
    "btc_refund_height",
    "fbc_refund_height",
    "btc_reference_height",
    "fbc_reference_height",
  ]) {
    if (!isPosInt(q[k])) return `quote has an invalid ${k}`;
  }
  // An unparseable expiry never expires, so the countdown never fires and the
  // Swap button never re-disables.
  if (!Number.isFinite(Date.parse(q.expires_at))) return "quote has no valid expiry";
  return null;
}

async function quoteOne(maker, amountBtc) {
  const expectedSats = Math.round(amountBtc * 1e8);
  try {
    if (maker.url.startsWith("demo:")) {
      const quote = await demoMm.getQuote(amountBtc);
      return { maker, declined: false, quote, error: null };
    }
    // light health optional — quote is enough
    //
    // Both spellings: `amount_sat` is unambiguous and is what the response
    // echoes back, so the equality check below compares like with like.
    // `amount_btc` stays for makers written against the older shape, which
    // would otherwise read no amount at all.
    const quote = await makerFetch(maker.url, "/v1/quote", {
      method: "POST",
      body: JSON.stringify({
        side: "buy_fbc",
        amount_sat: expectedSats,
        amount_btc: amountBtc,
      }),
    });
    const problem = quoteProblem(quote, expectedSats);
    if (problem) return { maker, declined: true, quote: null, error: problem };
    return { maker, declined: false, quote, error: null };
  } catch (err) {
    // A refusal still means the maker is up. Reporting it as offline is what
    // made "1 BTC" render as "Makers listed but none answered — try Refresh",
    // when the maker had in fact answered immediately with its inventory cap.
    const declined = err instanceof MakerRefusal;
    return {
      maker,
      declined,
      quote: null,
      error: reasonText(err),
    };
  }
}

/**
 * What one FBC costs from this quote, as a label.
 *
 * The effective price, not the maker's mid: it includes the fixed claim fee,
 * which is 4.2% of a 10,000 sat swap and 0.005% of a large one. Quoting the
 * mid would show the same figure at every size and hide exactly the thing a
 * buyer is trying to compare.
 *
 * USD needs a BTC price this page does not own, so it uses the most recent one
 * the registry saw and says "≈". The FBC-per-BTC figure beside it is exact and
 * needs nothing external — and since every quote is for the same BTC amount,
 * comparing makers is exact regardless.
 */
function effectivePriceLabel(q) {
  const fbcPerBtc = q.amount_fbc / 1e6 / (q.amount_btc / 1e8);
  const rate = `${fbcPerBtc.toLocaleString(undefined, { maximumFractionDigits: 0 })} FBC/BTC`;
  if (!lastMarketBtcUsd) return rate;
  const usd = lastMarketBtcUsd / fbcPerBtc;
  return `≈ $${usd.toFixed(6)} / FBC · ${rate}`;
}

function renderQuoteList() {
  const list = el.quoteList;
  const empty = el.quoteEmpty;
  // clear cards
  list.querySelectorAll(".qcard").forEach((n) => n.remove());

  const live = rows.filter((r) => r.quote);
  const declined = rows.filter((r) => !r.quote && r.declined);
  const dead = rows.filter((r) => !r.quote && !r.declined);

  if (!rows.length) {
    empty.style.display = "";
    empty.textContent = "No makers in directory yet.";
    return;
  }
  if (!live.length && !declined.length && !dead.length) {
    empty.style.display = "";
    empty.textContent = "Looking for makers…";
    return;
  }
  empty.style.display = "none";

  const bestFbc = live.reduce(
    (m, r) => Math.max(m, r.quote.amount_fbc),
    0,
  );

  const ordered = [...live].sort(
    (a, b) => b.quote.amount_fbc - a.quote.amount_fbc,
  );
  for (const r of ordered) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className =
      "qcard" +
      (selected && selected.maker.url === r.maker.url ? " selected" : "");
    btn.setAttribute("role", "option");
    btn.setAttribute(
      "aria-selected",
      selected && selected.maker.url === r.maker.url ? "true" : "false",
    );
    const isBest = r.quote.amount_fbc === bestFbc && live.length > 1;
    // How much worse than the best offer, exactly — the amounts are all for
    // the same BTC, so this is a true comparison rather than an estimate.
    const worse =
      live.length > 1 && r.quote.amount_fbc < bestFbc
        ? `−${(((bestFbc - r.quote.amount_fbc) / bestFbc) * 100).toFixed(2)}%`
        : "";
    const host = (r.maker.note || r.maker.url.replace(/^https?:\/\//, "")).replace(
      /\/$/,
      "",
    );
    btn.innerHTML = `
      <div class="qcard-top">
        <div class="qcard-id">
          <span class="qcard-name">${escapeHtml(r.maker.name)}</span>
          ${isBest ? '<span class="qcard-badge best">Best</span>' : ""}
        </div>
        <span class="qcard-host" title="${escapeHtml(r.maker.url)}">${escapeHtml(host)}</span>
      </div>
      <div class="qcard-mid">
        <span class="qcard-out-label">You receive</span>
        <span class="qcard-out"><span class="qcard-out-num">${escapeHtml(fmtFbc(r.quote.amount_fbc))}</span> <span class="qcard-out-unit">FBC</span></span>
      </div>
      <div class="qcard-price">
        <span>${escapeHtml(effectivePriceLabel(r.quote))}</span>
        ${worse ? `<span class="qcard-worse">${escapeHtml(worse)}</span>` : ""}
      </div>
    `;
    btn.addEventListener("click", () => selectRow(r));
    list.appendChild(btn);
  }

  // Declined and unreachable are rendered apart on purpose. A maker that told
  // us why is giving the user something to act on — usually "change the
  // amount" — whereas an unreachable one is only worth a Refresh.
  for (const r of [...declined, ...dead]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = r.declined ? "qcard declined" : "qcard offline";
    btn.disabled = true;
    const host = (r.maker.note || r.maker.url.replace(/^https?:\/\//, "")).replace(
      /\/$/,
      "",
    );
    const badge = r.declined
      ? '<span class="qcard-badge declined">No quote</span>'
      : '<span class="qcard-badge off">Offline</span>';
    const detail = r.declined
      ? `<span class="qcard-reason">${escapeHtml(r.error || "Declined")}</span>`
      : '<span class="qcard-out muted">—</span>';
    btn.innerHTML = `
      <div class="qcard-top">
        <div class="qcard-id">
          <span class="qcard-name">${escapeHtml(r.maker.name)}</span>
          ${badge}
        </div>
        <span class="qcard-host">${escapeHtml(host)}</span>
      </div>
      <div class="qcard-mid">
        <span class="qcard-out-label">${r.declined ? "Reason" : "Unavailable"}</span>
        ${detail}
      </div>
    `;
    list.appendChild(btn);
  }
}

// Maker names, notes and URLs come from a registry anyone can list themselves
// in, so every one of them is attacker-controlled. `'` and `/` are escaped too:
// no interpolation currently sits in a single-quoted attribute, but that is one
// template edit away from an injection, and escaping them costs nothing.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\//g, "&#x2f;");
}

function selectRow(row) {
  if (!row?.quote) return;
  selected = row;
  state.mmApi = row.maker.url;
  localStorage.setItem("mm_api", row.maker.url);
  renderQuoteList();
  paintSelectedQuote();
  startExpiry();
}

function paintSelectedQuote() {
  const q = selected?.quote;
  if (!q) {
    // A refusal — below minimum, above max, no liquidity — is not a reason to
    // erase what someone typed. This used to blank the receive field
    // unconditionally while leaving fbcTarget set, producing an enabled Swap
    // button above an empty box. The target is released here so the two agree,
    // and the amount they entered stays on screen.
    if (fbcTarget == null) setAmountOut("");
    fbcTarget = null;
    setReceiveHint(null, null);
    el.amountOut.classList.add("pending");
    el.quoteVia.textContent = "—";
    el.quoteRate.textContent = "—";
    el.quoteSpread.textContent = "—";
    el.quoteExpires.textContent = "—";
    el.swapBtn.disabled = true;
    el.swapBtn.textContent = "No quote";
    return;
  }
  // Only paint the DERIVED side. With an FBC target the person typed that
  // number and it stays; what moves is the BTC needed to reach it, and
  // refreshQuotes has already re-quoted for that amount.
  if (fbcTarget == null) {
    setAmountOut(q.amount_fbc / 1e6);
    setReceiveHint(null, null);
  } else {
    setReceiveHint(fbcTarget, q.amount_fbc / 1e6);
  }
  el.amountOut.classList.remove("pending");
  el.amountIn.classList.remove("pending");
  el.quoteVia.textContent = selected.maker.name;
  const eff = q.amount_fbc / 1e6 / (q.amount_btc / 1e8);
  el.quoteRate.textContent = `${eff.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  })} FBC/BTC`;
  el.quoteSpread.textContent = `${(q.spread_bps / 100).toFixed(2)}%`;
  el.swapBtn.disabled = false;
  el.swapBtn.textContent = `Swap · ${fmtBtc(q.amount_btc)} BTC`;
}

function startExpiry() {
  if (quoteTimer) clearInterval(quoteTimer);
  const tick = () => {
    if (!selected?.quote || state.running) return;
    const ms = Date.parse(selected.quote.expires_at) - Date.now();
    if (ms <= 0) {
      el.quoteExpires.textContent = "expired";
      el.swapBtn.disabled = true;
      clearInterval(quoteTimer);
      refreshQuotes();
      return;
    }
    el.quoteExpires.textContent = `${Math.ceil(ms / 1000)}s`;
  };
  tick();
  quoteTimer = setInterval(tick, 250);
}

async function refreshQuotes() {
  if (state.running) return;
  const seq = ++quoteSeq;
  const amountBtc = Number(el.amountIn.value);
  el.swapBtn.disabled = true;
  el.swapBtn.textContent = "Getting quotes…";
  el.amountOut.classList.add("pending");
  el.amountHint.textContent = "";
  el.amountHint.classList.remove("error");
  el.quoteEmpty.style.display = "";
  el.quoteEmpty.textContent = "Asking makers…";
  el.quoteList.querySelectorAll(".qcard").forEach((n) => n.remove());

  if (!(amountBtc > 0)) {
    el.amountHint.textContent = "Enter a positive amount";
    el.amountHint.classList.add("error");
    el.swapBtn.textContent = "Enter amount";
    return;
  }

  if (!directory.length) await loadDirectory();
  if (!directory.length) {
    el.quoteEmpty.textContent = "No makers online right now. Try Refresh in a moment.";
    el.swapBtn.textContent = "No makers";
    return;
  }

  const results = await Promise.all(
    directory.map((m) => quoteOne(m, amountBtc)),
  );
  if (seq !== quoteSeq) return;

  rows = results;
  const live = rows.filter((r) => r.quote);
  if (!live.length) {
    selected = null;
    renderQuoteList();
    paintSelectedQuote();
    const declined = rows.filter((r) => r.declined);
    if (declined.length) {
      // Every maker answered and said no. "Try Refresh" is wrong advice here —
      // refreshing re-asks the same question and gets the same answer. Show
      // what they actually said, so the user knows to change the amount.
      el.amountHint.textContent =
        declined.length === 1
          ? `${declined[0].maker.name}: ${declined[0].error}`
          : `No maker will quote this size. ${declined[0].maker.name}: ${declined[0].error}`;
      el.swapBtn.textContent = "No quote at this size";
    } else {
      el.amountHint.textContent =
        "Makers listed but none answered. They may be offline — try Refresh.";
      el.swapBtn.textContent = "No liquidity";
    }
    el.amountHint.classList.add("error");
    return;
  }

  // Best price wins. The previously-used maker is kept ONLY when it is
  // effectively tied, which stops the selection flapping between makers whose
  // quotes differ in the last decimal.
  //
  // It used to be `prefer || best`: whoever you used first, remembered in
  // localStorage forever, was chosen even when someone else offered more. With
  // one maker that is invisible; with two it silently costs money on every
  // swap, and nothing on screen said it was happening.
  const prevUrl = selected?.maker.url || localStorage.getItem("mm_api");
  const best = live.reduce((a, b) =>
    b.quote.amount_fbc > a.quote.amount_fbc ? b : a,
  );
  const remembered = live.find((r) => r.maker.url === prevUrl);
  const TIE = 0.0005; // 5 bps — below this the difference is not worth moving for
  const isTie =
    remembered && (best.quote.amount_fbc - remembered.quote.amount_fbc) / best.quote.amount_fbc < TIE;
  selectRow(isTie ? remembered : best);

  // Holding an FBC target: the quote we just got tells us this maker's real
  // pricing at this size, which may need a different BTC amount than the
  // estimate asked for. Correct the BTC field and quote again for it, so the
  // held quote and the field agree — startSwap refuses to proceed when they
  // do not.
  //
  // At most one correction per cycle. The model is exact given `mid`, so one
  // pass lands within a satoshi; anything left is BTC ticking between requests
  // and chasing it would never settle.
  if (fbcTarget != null && !refiningForTarget) {
    const m = pricingModel();
    if (m) {
      const needed = Math.ceil(satsForFbc(fbcTarget, m));
      const held = selected?.quote?.amount_btc;
      // Re-check the sequence immediately before touching an input. Everything
      // above this point only reads; this writes, and a cycle started for an
      // earlier target must never overwrite a field the person has since typed
      // into. Without it the guard at the top of the fetch is not enough — it
      // runs before this correction exists.
      if (seq !== quoteSeq) return;
      if (needed > 0 && held && Math.abs(needed - held) > 1) {
        refiningForTarget = true;
        el.amountIn.value = sanitizeAmount(
          String((needed / 1e8).toFixed(BTC_DECIMALS)),
          BTC_DECIMALS,
        ).replace(/\.?0+$/, "");
        lastFieldValue.set(el.amountIn, el.amountIn.value);
        try {
          await refreshQuotes();
        } finally {
          refiningForTarget = false;
        }
        return;
      }
    }
  }
}


// ── Verified market data ──────────────────────────────────────────────────
//
// Everything here comes from the registry's /v1/price and /v1/trades, which
// are built from swaps it checked against BOTH chains — funding amounts, the
// spends, and the shared preimage that proves the two legs are one atomic
// swap. No maker's quote contributes to any of it.
//
// The panel stays hidden until there is a real trade to show. An empty price
// display reads as broken rather than new, and a price of "—" next to a Swap
// button invites the reading that the swap is broken too.

const MARKET_REFRESH_MS = 120_000;

function fmtAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** USD with enough places to be useful at sub-cent prices. */
function fmtUsd(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return v < 0.01 ? `$${v.toFixed(6)}` : `$${v.toFixed(4)}`;
}

async function refreshMarket() {
  const base = REGISTRY_URL.replace(/\/+$/, "");
  let price;
  let trades = [];
  let pending = [];
  try {
    const [p, t] = await Promise.all([
      fetch(`${base}/v1/price`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${base}/v1/trades?limit=25`).then((r) => (r.ok ? r.json() : null)),
    ]);
    price = p;
    trades = (t && Array.isArray(t.trades) ? t.trades : []);
    // A registry that predates pending rows simply omits the key, and this
    // stays an empty list rather than an error.
    pending = (t && Array.isArray(t.pending) ? t.pending : []);
  } catch {
    return; // a registry that is down leaves the last good numbers up
  }
  if (!price || !price.last_trade) return; // nothing settled yet

  el.marketCard.classList.remove("hidden");

  const last = price.last_trade;
  if (typeof last.fbc_per_btc === "number") lastMarketFbcPerBtc = last.fbc_per_btc;
  if (typeof last.btc_usd === "number") lastMarketBtcUsd = last.btc_usd;
  el.marketUsd.textContent = fmtUsd(last.fbc_usd);
  // The subline carries provenance, not a second number: the headline is a
  // price, and a reader's first question is how old it is.
  el.marketSub.textContent = fmtAgo(last.settled_at);
  el.marketPerBtc.textContent = Number(last.fbc_per_btc).toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });



  // Swaps still settling go above the settled ones, marked and without a price.
  //
  // No price is deliberate rather than missing. The registry cannot prove a
  // pending swap's two legs share a preimage — the BTC leg is unspent, and a
  // P2WSH does not reveal its script until it is spent — so the amounts have
  // been checked on chain but the pairing has not. Printing a rate from that
  // would put an unproven number beside proven ones in the same column.
  const pendingRows = pending
    .map((p) => {
      const fbc = Number(p.amount_fbc_bumps / 1e6).toLocaleString(undefined, {
        maximumFractionDigits: 4,
      });
      return `
        <div class="market-trade pending" title="Both legs are on chain and the FBC side has been claimed. Waiting for the maker's BTC claim to be buried before this counts as a settled trade.">
          <span class="market-trade-when">${escapeHtml(fmtAgo(p.settling_since))}</span>
          <span class="market-trade-size">${escapeHtml(fbc)} FBC</span>
          <span class="market-trade-px market-trade-settling">settling</span>
        </div>`;
    })
    .join("");

  const settledRows = trades
    .map((t) => {
      const fbc = Number(t.amount_fbc).toLocaleString(undefined, { maximumFractionDigits: 4 });
      const px = typeof t.fbc_usd === "number" ? fmtUsd(t.fbc_usd) : "—";
      return `
        <div class="market-trade">
          <span class="market-trade-when">${escapeHtml(fmtAgo(t.settled_at))}</span>
          <span class="market-trade-size">${escapeHtml(fbc)} FBC</span>
          <span class="market-trade-px">${escapeHtml(px)}</span>
        </div>`;
    })
    .join("");

  el.marketTrades.innerHTML =
    pendingRows + settledRows || '<p class="market-empty">No settled swaps yet.</p>';
}



// ── Amount fields ─────────────────────────────────────────────────────────
//
// Both sides are editable and each drives the other. The BTC field is what the
// quote request is built from; the FBC field is a way of expressing "about
// this much" that gets converted to a BTC amount.
//
// Only the maker can say what a given amount of BTC actually buys — the price
// includes a fee deduction we do not model — so anything shown while typing is
// an ESTIMATE from the last known rate, marked as such, and is replaced by the
// quote the moment it arrives. The alternative is showing a number nobody
// offered, which is worse than showing none.

/**
 * Base units. A bump is 1e-6 FBC and a satoshi is 1e-8 BTC, so digits past
 * these are not small — they do not exist. Accepting them means quietly
 * rounding away something a person deliberately typed.
 */
const FBC_DECIMALS = 6;
const BTC_DECIMALS = 8;

/**
 * Keep an amount to digits, one dot, and its currency's precision.
 *
 * The fields are `type="text"` with a decimal keypad rather than
 * `type="number"`, which cannot do this: number accepts exponent notation
 * ("1e5" reads as 100000) and reports `value` as "" for anything it considers
 * malformed, so a sanitiser attached to it cannot see what to fix.
 */
function sanitizeAmount(raw, maxDecimals) {
  let v = String(raw).replace(/[^0-9.]/g, "");
  const dot = v.indexOf(".");
  if (dot >= 0) {
    // Keep the first dot, drop the rest: "1.2.3" is a typo, not a number.
    v = v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
    const parts = v.split(".");
    const frac = parts[1] || "";
    if (frac.length > maxDecimals) v = `${parts[0]}.${frac.slice(0, maxDecimals)}`;
  }
  return v;
}

/**
 * Text each field last held, so a keystroke that changes nothing can be told
 * apart from one that does.
 *
 * Typing a space, a letter, or a ninth decimal into BTC all sanitise back to
 * the value already there. Those fire an `input` event like any other, and
 * treating them as edits handed the sticky role to BTC and recomputed FBC from
 * the derived amount — so 666 FBC became 666.01253 after pressing space. That
 * 0.01253 is the Math.ceil that rounds the satoshi amount UP so the person
 * gets at least what they asked for; it only became visible because a
 * round-trip happened that should not have.
 */
const lastFieldValue = new WeakMap();

/** True when this input event actually changed the number. */
function fieldChanged(input, maxDecimals) {
  sanitizeField(input, maxDecimals);
  const now = input.value;
  const before = lastFieldValue.get(input);
  lastFieldValue.set(input, now);
  return before !== now;
}

/** Sanitise in place, keeping the caret where the person was typing. */
function sanitizeField(input, maxDecimals) {
  const before = input.value;
  const after = sanitizeAmount(before, maxDecimals);
  if (after === before) return;
  const caret = input.selectionStart;
  input.value = after;
  const moved = Math.max(0, (caret == null ? after.length : caret) - (before.length - after.length));
  try {
    input.setSelectionRange(moved, moved);
  } catch {
    /* some inputs do not expose selection; the caret lands at the end */
  }
}

/**
 * Whichever side the person typed. That field is STICKY — it holds exactly
 * what they entered and is never rewritten. The other side is derived and
 * moves as quotes move.
 *
 * When an FBC target is set, a changing price means the BTC cost changes, not
 * the amount of FBC they asked for. Overwriting their 500,000 with the quote's
 * 499,999.99527 answered a question nobody asked.
 */
let lastEdited = "btc";
/** The FBC amount typed, in whole FBC, or null when BTC is the sticky side. */
let fbcTarget = null;
/** Guards the one re-quote a changed price is allowed to trigger. */
let refiningForTarget = false;
/** Last price seen from the registry — a rough rate, used only before any quote. */
let lastMarketFbcPerBtc = null;
/** Most recent BTC/USD the registry reported, for approximate per-FBC pricing. */
let lastMarketBtcUsd = null;

function setAmountOut(v) {
  el.amountOut.value =
    v === "" || v == null
      ? ""
      : sanitizeAmount(String(Number(v).toFixed(FBC_DECIMALS)), FBC_DECIMALS).replace(/\.?0+$/, "");
  // Keep the baseline in step with what we just wrote, so the next keystroke
  // is compared against what is on screen rather than what was there before.
  lastFieldValue.set(el.amountOut, el.amountOut.value);
}

/**
 * How this maker prices, recovered from its last quote.
 *
 * NOT a rate. The price is affine, not linear:
 *
 *     fbc = ((sat - claimCost) / 1e8 * mid) / spreadMult * 1e6
 *
 * `claimCost` is the fixed cost of the one BTC transaction the maker must
 * broadcast to claim, and it is the same ~417 sat whether the swap is $6 or
 * $6,000. So the *effective* rate depends on size — measured live, 6,146,821
 * FBC/BTC at 10,000 sat versus 6,413,956 at 7.8M sat, from the same maker in
 * the same minute. That is 4.3% apart.
 *
 * Converting with any single rate is therefore wrong at every size except the
 * one it was sampled at. Typing 500,000 FBC against a rate sampled from a tiny
 * quote asked for too much BTC and came back as 501,418 — the error this
 * models away.
 *
 * The quote carries `mid_fbc_per_btc` and `spread_bps`, so `claimCost` falls
 * out of one quote by rearrangement. No second request needed.
 */
function pricingModel() {
  const q = selected?.quote;
  if (q && q.amount_btc > 0 && q.amount_fbc > 0 && q.mid_fbc_per_btc > 0) {
    const mult = 1 + (q.spread_bps || 0) / 10_000;
    const claimCost = q.amount_btc - (q.amount_fbc / 1e6) * mult / q.mid_fbc_per_btc * 1e8;
    // A negative or absurd solve means the maker does not price the way we
    // assume. Fall back rather than extrapolate from a model that does not fit.
    if (Number.isFinite(claimCost) && claimCost >= 0 && claimCost < 1e6) {
      return { mid: q.mid_fbc_per_btc, mult, claimCost };
    }
  }
  // Before any quote exists: a plain rate from the last settled trade. Good
  // enough to type against, and wrong by the fee — which is why it is replaced
  // as soon as a real quote lands.
  if (lastMarketFbcPerBtc) return { mid: lastMarketFbcPerBtc, mult: 1, claimCost: 0 };
  return null;
}

function fbcForSats(sat, m) {
  return ((sat - m.claimCost) / 1e8 * m.mid) / m.mult;
}

function satsForFbc(fbc, m) {
  return (fbc * m.mult) / m.mid * 1e8 + m.claimCost;
}

/**
 * Say what will actually arrive when it differs from the number typed.
 *
 * A target lands between two satoshis — 666 FBC needs 10,760.12 of them — and
 * the amount is rounded UP so the person gets at least what they asked for.
 * That surplus is under a satoshi, but at this price a satoshi is 0.064 FBC,
 * so it shows. Left unsaid, it stays hidden until the BTC field is next
 * touched, at which point the FBC figure jumps and looks like a bug.
 */
function setReceiveHint(target, actual) {
  if (!el.receiveHint) return;
  if (target == null || actual == null || Math.abs(actual - target) < 1e-6) {
    el.receiveHint.textContent = "";
    return;
  }
  const shown = actual.toFixed(FBC_DECIMALS).replace(/\.?0+$/, "");
  el.receiveHint.textContent = `You will receive ${shown} — amounts round up to a whole satoshi`;
}

function estimateFromBtc() {
  const m = pricingModel();
  const btc = Number(el.amountIn.value);
  if (!m || !(btc > 0)) { setAmountOut(""); return; }
  const fbc = fbcForSats(Math.round(btc * 1e8), m);
  setAmountOut(fbc > 0 ? fbc : "");
  el.amountOut.classList.add("pending");
  el.amountIn.classList.remove("pending");
}

function estimateFromFbc() {
  const m = pricingModel();
  const fbc = Number(el.amountOut.value);
  if (!m || !(fbc > 0)) {
    // Do NOT clear the BTC field. Before the first quote there is no pricing
    // model, and clearing it made refreshQuotes bail with "Enter a positive
    // amount" while bumping quoteSeq — discarding the in-flight round and
    // sending no new one, so the page stopped responding entirely. Leaving the
    // last good amount means the quote that is already on its way still lands.
    return;
  }
  const sat = Math.ceil(satsForFbc(fbc, m));
  el.amountIn.value = sanitizeAmount(
    String((sat / 1e8).toFixed(BTC_DECIMALS)),
    BTC_DECIMALS,
  ).replace(/\.?0+$/, "");
  lastFieldValue.set(el.amountIn, el.amountIn.value);
  // The BTC side is the estimate here, not the FBC side they are typing.
  el.amountIn.classList.add("pending");
}

// ── Tabs and the resume callout ───────────────────────────────────────────

const TABS = ["market", "liquidity", "activity"];

function showTab(name) {
  for (const t of TABS) {
    const btn = document.getElementById(`tab-${t}`);
    const panel = document.getElementById(`panel-${t}`);
    if (!btn || !panel) continue;
    const on = t === name;
    btn.setAttribute("aria-selected", String(on));
    panel.classList.toggle("hidden", !on);
  }
}

for (const t of TABS) {
  document.getElementById(`tab-${t}`)?.addEventListener("click", () => showTab(t));
}

// The maker name in the terms line is the obvious place to go looking for
// "who am I trading with, and can I change it", so it is the control rather
// than a label. The list itself is a tab away and nothing else pointed at it.
el.quoteVia?.addEventListener("click", () => {
  showTab("liquidity");
  document.getElementById("panel-liquidity")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

/**
 * Surface an unfinished swap where it cannot be missed.
 *
 * A swap in flight has timelocks: someone who closed the tab and came back has
 * a deadline, and "it is in the Activity tab" is not good enough for that. The
 * callout renders only when there is something to resume, so it never becomes
 * furniture people learn to skip.
 */
function paintResumeCallout() {
  const open = listSavedSwaps({ includeDone: false }).filter(
    (s) => s.phase !== "done" && s.phase !== "refunded",
  );
  const badge = document.getElementById("tab-activity-count");
  if (badge) {
    badge.textContent = String(open.length);
    badge.classList.toggle("hidden", open.length === 0);
  }
  const callout = el.resumeCallout;
  if (!callout) return;
  // Never while a swap is on screen. renderSessions repaints this on every
  // state change, so hiding it once in showProgress was undone within seconds —
  // and it was offering to resume the swap already open in front of you.
  const inSwap = !el.progressCard.classList.contains("hidden");
  if (!open.length || inSwap) {
    callout.classList.add("hidden");
    return;
  }
  el.resumeText.textContent =
    open.length === 1 ? "1 swap in progress" : `${open.length} swaps in progress`;
  callout.classList.remove("hidden");
  callout.onclick = () => {
    if (open.length === 1) {
      resumeSavedSwap(open[0].swap_id).catch((e) =>
        showToast(e.message || "Resume failed", "error"),
      );
    } else {
      showTab("activity");
      document.getElementById("panel-activity")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  };
}

// ── Wallets ───────────────────────────────────────────────────────────────

const wallets = { btc: null, fbc: null };

async function connectFistbump() {
  if (!window.fistbump?.isFistbump) {
    throw new Error("Install Fistbump wallet + extension");
  }
  const conn = await window.fistbump.connect();
  const { pubkey } = await window.fistbump.getPublicKey();
  return { address: conn.address, pubkey };
}

/** The BTC provider in use for this session, once one has been chosen. */
let btcWallet = null;

async function connectBtcWallet() {
  btcWallet = selectBtcWallet(localStorage.getItem("btc_wallet") || undefined);
  if (!btcWallet) {
    throw new Error(
      "No BTC wallet detected. Install Unisat, OKX or Xverse — or fund the HTLC " +
        "from any wallet and use tools/refund-htlc.mjs to recover.",
    );
  }
  localStorage.setItem("btc_wallet", btcWallet.id);
  const acct = await btcWallet.connect();
  if (!acct?.address || !/^0[23][0-9a-f]{64}$/i.test(acct.pubkey || "")) {
    throw new Error(`${btcWallet.label} returned an unusable account`);
  }
  return acct;
}

/**
 * @param {boolean} isDemo — must be derived from the swap's own maker URL, not
 *   from the global DEMO flag. A stale `mm_demo` in localStorage must never be
 *   able to hand a real swap mock wallets.
 */
async function ensureWallets(isDemo) {
  if (isDemo) {
    wallets.btc = { address: "bc1qdemo", pubkey: DEMO_PK.aliceBtc };
    wallets.fbc = { address: "fb1qdemo", pubkey: DEMO_PK.aliceFbc };
    return;
  }
  if (!wallets.btc) wallets.btc = await connectBtcWallet();
  if (!wallets.fbc) wallets.fbc = await connectFistbump();
}

// ── MM API (maker base URL explicit for multi-swap resume) ────────────────

function makerBase(url) {
  return (url || selected?.maker.url || state.mmApi || "").replace(/\/+$/, "");
}

async function apiAccept(quoteId, offer, makerUrl) {
  const base = makerBase(makerUrl);
  if (base.startsWith("demo:")) return demoMm.accept(quoteId, offer);
  return makerFetch(base, "/v1/swaps", {
    method: "POST",
    body: JSON.stringify({ quote_id: quoteId, offer }),
  });
}

async function apiFundedBtc(swapId, funded, makerUrl) {
  const base = makerBase(makerUrl);
  if (base.startsWith("demo:")) return demoMm.fundedBtc(swapId, funded);
  return makerFetch(base, `/v1/swaps/${swapId}/funded_btc`, {
    method: "POST",
    body: JSON.stringify(funded),
  });
}

async function apiGetSwap(swapId, makerUrl) {
  const base = makerBase(makerUrl);
  if (base.startsWith("demo:")) return demoMm.getSwap(swapId);
  return makerFetch(base, `/v1/swaps/${swapId}`);
}

// ── Progress UI ───────────────────────────────────────────────────────────

const STEPS = [
  { id: "wallets", label: "Connect wallets" },
  { id: "accept", label: "Maker accepts" },
  { id: "fund", label: "Fund BTC" },
  { id: "btc_confs", label: "BTC confirmations" },
  { id: "mm_fbc", label: "Maker funds FBC" },
  { id: "fbc_confs", label: "FBC confirmations" },
  { id: "claim", label: "Claim FBC" },
  { id: "done", label: "Complete" },
];

/**
 * @param {{ amountBtc?: number, amountFbc?: number, makerName?: string, swapId?: string, text?: string }} opts
 */
function setProgressSummary(opts = {}) {
  if (!el.progressSummary) return;
  if (opts.text && opts.amountBtc == null) {
    el.progressSummary.className = "progress-summary plain";
    el.progressSummary.textContent = opts.text;
    return;
  }
  const btc =
    opts.amountBtc != null ? fmtBtc(opts.amountBtc) : "—";
  const fbc =
    opts.amountFbc != null ? fmtFbc(opts.amountFbc) : "—";
  const maker = opts.makerName || "maker";
  const sid = opts.swapId
    ? `<span class="progress-summary-id mono" title="${escapeHtml(opts.swapId)}">${escapeHtml(shortHex(opts.swapId, 8))}</span>`
    : "";
  el.progressSummary.className = "progress-summary";
  el.progressSummary.innerHTML = `
    <div class="progress-summary-amts">
      <div class="progress-summary-side">
        <span class="ps-label">Pay</span>
        <span class="ps-val mono">${escapeHtml(btc)} <span class="ps-unit">BTC</span></span>
      </div>
      <span class="progress-summary-arrow" aria-hidden="true">→</span>
      <div class="progress-summary-side recv">
        <span class="ps-label">Receive</span>
        <span class="ps-val mono accent">${escapeHtml(fbc)} <span class="ps-unit">FBC</span></span>
      </div>
    </div>
    <div class="progress-summary-meta">
      <span class="progress-summary-via">via ${escapeHtml(maker)}</span>
      ${sid}
    </div>
  `;
}

/**
 * Replaces the "usually ~10 minutes per block" line once we know the wait has a
 * cause worth naming. Module-level because the confirmation renderer is called
 * from several places and threading it through all of them would be noise; it
 * is set once per swap and cleared when a new one starts.
 */
let stallNote = "";

function formatFocusDetail(raw, stepId) {
  if (raw == null || raw === "") {
    const hints = {
      wallets: "Connecting UniSat & Fistbump…",
      accept: "Sending offer to maker…",
      fund: "Waiting for you to fund the BTC HTLC…",
      btc_confs: "Waiting for the first Bitcoin confirmation…",
      mm_fbc: "Maker is locking FBC…",
      fbc_confs: "Waiting for FBC confirmations…",
      claim: "Ready when you are",
      done: "All set",
    };
    return `<p class="prog-focus-hint">${escapeHtml(hints[stepId] || "Working…")}</p>`;
  }
  const conf = String(raw).match(/^(\d+)\s*\/\s*(\d+)$/);
  if (conf) {
    const cur = Number(conf[1]);
    const max = Number(conf[2]) || 1;
    const pct = Math.min(100, Math.round((cur / max) * 100));
    // At zero, the default line is a guess about timing. If the transaction's
    // own fee rate turns out to explain the wait, that is a better thing to say
    // than "usually ~10 minutes" to someone who has been waiting an hour.
    const sub =
      cur === 0
        ? stallNote || "Usually ~10 minutes per block"
        : cur >= max
          ? "Confirmations complete"
          : `${max - cur} more to go`;
    return `<div class="prog-conf">
      <div class="prog-conf-top">
        <span class="prog-conf-nums mono"><span class="cur">${cur}</span><span class="sep">/</span><span class="max">${max}</span></span>
        <span class="prog-conf-sub">${escapeHtml(sub)}</span>
      </div>
      <div class="prog-conf-bar" role="progressbar" aria-valuenow="${cur}" aria-valuemin="0" aria-valuemax="${max}">
        <div class="prog-conf-fill" style="width:${Math.max(pct, cur > 0 ? 4 : 0)}%"></div>
      </div>
    </div>`;
  }
  // Txids / short addresses — mono chip, not screaming green
  return `<div class="prog-focus-chip mono" title="${escapeHtml(String(raw))}">${escapeHtml(String(raw))}</div>`;
}

function shortStepLabel(label) {
  return label
    .replace(/^Connect wallets$/, "Wallets")
    .replace(/^Maker accepts$/, "Accept")
    .replace(/^Fund BTC$/, "Fund")
    .replace(/^BTC confirmations$/, "BTC confs")
    .replace(/^Maker funds FBC$/, "Fund FBC")
    .replace(/^FBC confirmations$/, "FBC confs")
    .replace(/^Claim FBC$/, "Claim")
    .replace(/^Complete$/, "Done");
}

function renderSteps(activeId, details = {}) {
  const total = STEPS.length;
  const isComplete = activeId === "done";
  let activeIdx = idsIndex(activeId);
  if (isComplete) activeIdx = total - 1;
  if (activeIdx < 0) activeIdx = 0;

  const doneCount = isComplete ? total : activeIdx;
  const stepNum = isComplete ? total : activeIdx + 1;
  const trackPct = Math.round((doneCount / total) * 100);

  const segs = STEPS.map((s, i) => {
    let cls = "pending";
    if (isComplete || i < activeIdx) cls = "done";
    else if (i === activeIdx) cls = "active";
    return `<div class="prog-seg ${cls}" title="${escapeHtml(s.label)}"></div>`;
  }).join("");

  const current = STEPS[activeIdx];
  const raw = details[current.id];
  const next = !isComplete && activeIdx + 1 < total ? STEPS[activeIdx + 1] : null;

  const doneBits = STEPS.slice(0, doneCount)
    .map((s) => escapeHtml(shortStepLabel(s.label)))
    .join('<span class="prog-done-dot">·</span>');

  el.progressSteps.innerHTML = `
    <div class="prog-track" aria-label="Swap progress">
      <div class="prog-segs">${segs}</div>
      <div class="prog-track-meta">
        <span>Step ${stepNum} of ${total}</span>
        <span class="mono">${isComplete ? 100 : trackPct}%</span>
      </div>
    </div>

    ${
      doneCount > 0 && !isComplete
        ? `<div class="prog-done-row">
            <span class="prog-done-badge">Done</span>
            <span class="prog-done-list">${doneBits}</span>
          </div>`
        : ""
    }

    <div class="prog-focus${isComplete ? " is-complete" : ""}">
      <div class="prog-focus-kicker">${isComplete ? "Finished" : "Current step"}</div>
      <div class="prog-focus-title">${escapeHtml(current.label)}</div>
      ${formatFocusDetail(raw, current.id)}
    </div>

    ${
      next
        ? `<div class="prog-next">
            <span class="prog-next-label">Up next</span>
            <span class="prog-next-step">${escapeHtml(next.label)}</span>
          </div>`
        : ""
    }
  `;
}

function idsIndex(activeId) {
  return STEPS.findIndex((s) => s.id === activeId);
}

/**
 * Surface an unsigned PSBT for signing somewhere else.
 *
 * Not a debug affordance. Every HTLC spend is a custom P2WSH input, Unisat
 * rejects those on some builds (SPEC §11.2), and no hardware wallet will ever
 * accept one — so "your wallet said no" has to lead somewhere other than lost
 * coins. Both hex and base64 are offered because Sparrow takes either and
 * bitcoin-cli wants base64.
 */
/** How long to keep trying before admitting we cannot read the chain. */
const UNREADABLE_TRIES_BEFORE_ASKING = 3;

/**
 * Explain precisely what is unverified and what it risks.
 *
 * The check this replaces exists because a hostile maker can report a
 * confirmation count it has not earned, get the taker to publish the preimage
 * against an unconfirmed funding tx, then replace that tx and claim the BTC
 * leg with the revealed secret. Skipping the check means trusting the maker
 * not to do that — which is fine when you run the maker, and is not fine
 * otherwise. Say so in those terms rather than as a generic warning.
 */
function showUnverifiedWarning(ready, offer) {
  showPsbtLikePanel({
    title: "Could not verify the FBC leg on-chain",
    body:
      `The maker reports ${ready.fbc_confs ?? 0} confirmations, but this browser has no way ` +
      `to check that independently — the Fistbump explorer does not expose a transaction API.\n\n` +
      `Claiming publishes your secret. If the maker's funding transaction is not really ` +
      `confirmed, they can replace it and use that secret to take your BTC. You would lose ` +
      `${fmtBtc(offer.amount_btc)} BTC and receive nothing.\n\n` +
      `Only continue if you trust this maker — for example if it is your own. ` +
      `Otherwise close this and recover your BTC at block ${offer.btc_refund_height}.`,
  });
}

function hideUnverifiedWarning() {
  el.psbtPanel?.classList.add("hidden");
}

/** Reuses the PSBT panel's chrome for any block of explanatory text. */
function showPsbtLikePanel({ title, body }) {
  if (!el.psbtPanel) return;
  el.psbtTitle.textContent = title;
  el.psbtNote.textContent = body;
  el.psbtText.value = "";
  el.psbtText.classList.add("hidden");
  el.psbtPanel.classList.remove("hidden");
}

function showPsbt({ title, note, psbtHex }) {
  if (!el.psbtPanel) return;
  const b64 = hexToBase64(psbtHex);
  el.psbtTitle.textContent = title;
  el.psbtNote.textContent = note;
  el.psbtText.value = b64;
  el.psbtText.classList.remove("hidden");
  el.psbtPanel.classList.remove("hidden");
  el.psbtCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(b64);
      showToast("PSBT copied", "ok");
    } catch {
      el.psbtText.select();
      showToast("Select and copy the PSBT above", "error");
    }
  };
  // The hex form is useful for tooling that wants it; keep it reachable
  // without cluttering the panel.
  console.info("[psbt] base64:", b64, "\n[psbt] hex:", psbtHex);
}

function hidePsbt() {
  el.psbtPanel?.classList.add("hidden");
}

function hexToBase64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function showProgress() {
  hidePsbt();
  el.swapCard.classList.add("hidden");
  el.progressCard.classList.remove("hidden");
  // Market, Liquidity and Activity are reference material for choosing a swap.
  // During one they are noise above the only thing that matters, and the resume
  // callout is pointing at the swap already on screen.
  setSecondaryVisible(false);
  el.progressDone.classList.add("hidden");
  el.progressAction.classList.add("hidden");
}

function showSwapCard() {
  el.progressCard.classList.add("hidden");
  el.swapCard.classList.remove("hidden");
  setSecondaryVisible(true);
  state.running = false;
  refreshQuotes();
}

/**
 * Show or hide everything that is not the swap itself.
 *
 * The tabs and the resume callout belong to choosing a swap, not to running
 * one. Left up during a swap they push the current step down the page and the
 * callout offers to resume what is already open.
 */
function setSecondaryVisible(visible) {
  document.querySelector(".tabs")?.classList.toggle("hidden", !visible);
  for (const t of TABS) document.getElementById(`panel-${t}`)?.classList.add("hidden");
  if (visible) {
    // Restore whichever tab was selected rather than always snapping to Market.
    const active = TABS.find(
      (t) => document.getElementById(`tab-${t}`)?.getAttribute("aria-selected") === "true",
    );
    document.getElementById(`panel-${active || "market"}`)?.classList.remove("hidden");
  }
  if (!visible) el.resumeCallout?.classList.add("hidden");
  else paintResumeCallout();
}

/** Cleanup for the currently-armed confirmation button, if any. */
let pendingClick = null;

/**
 * Wait for the user to confirm the one action shown in the progress card.
 *
 * There is a single button, so only one waiter may ever be armed. "Close"
 * backgrounds a running swap without ending it, so a second flow could
 * previously arm the same button while the first was still listening — and one
 * click would then resolve both, authorising two different on-chain actions
 * (e.g. funding one swap and claiming another) from a single confirmation.
 * Arming again cancels the previous waiter instead of stacking on it.
 */
function waitClick(label) {
  if (pendingClick) pendingClick("superseded by a newer action");
  return new Promise((resolve, reject) => {
    el.progressAction.classList.remove("hidden");
    el.progressActionBtn.textContent = label;

    const cleanup = () => {
      el.progressActionBtn.removeEventListener("click", on);
      el.progressAction.classList.add("hidden");
      pendingClick = null;
    };
    const on = () => {
      cleanup();
      resolve();
    };
    pendingClick = (why) => {
      cleanup();
      reject(new Error(why));
    };
    el.progressActionBtn.addEventListener("click", on);
  });
}

/**
 * Which output of the funding transaction pays the HTLC.
 *
 * Called seconds after broadcasting, so the transaction is in the mempool but a
 * third-party indexer may not have it yet. This used to give up after 32
 * seconds against a single API — and did, on a real swap, leaving the coins
 * correctly funded while the page reported failure.
 *
 * Two changes. It asks more than one indexer, because one being slow is
 * independent of the other. And it waits about three minutes, because the money
 * has already moved: the cost of waiting is a slower screen, the cost of giving
 * up is a swap that looks broken and has to be resumed by hand.
 */
async function resolveFundingVout(txid, address) {
  // Our own node first (it has the transaction the instant it relays), public
  // indexers behind it. @see ../btc-api.js
  const sources = BTC_SOURCES;
  // ~3 minutes, front-loaded — propagation is usually seconds, occasionally not.
  const delays = [1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000, 30000, 30000, 30000];
  let looked = 0;
  for (let i = 0; i < delays.length; i++) {
    for (const api of sources) {
      try {
        const res = await fetch(`${api}/tx/${txid}`);
        looked++;
        if (res.ok) {
          const tx = await res.json();
          const idx = tx.vout.findIndex((o) => o.scriptpubkey_address === address);
          if (idx >= 0) return idx;
          // Found the transaction but not the address: that is a real
          // mismatch, not a propagation delay, and waiting will not fix it.
          throw new Error(
            `Funding transaction ${txid.slice(0, 16)}… does not pay the HTLC address. ` +
              `Do not fund again — check the transaction before retrying.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Funding transaction")) throw err;
        /* not indexed yet, or this source is down — try the next */
      }
    }
    await sleep(delays[i]);
  }
  throw new Error(
    `Your BTC was sent (${txid.slice(0, 16)}…) but no block explorer has indexed it yet ` +
      `after ${looked} attempts. Nothing is lost — reload this page and press Resume; ` +
      `it will pick up the same transaction rather than sending again.`,
  );
}

/**
 * Poll until fn returns truthy.
 * @param {() => Promise<any>} fn
 * @param {{ interval?: number, timeout?: number, onError?: (e: Error) => void }} opts
 *   timeout 0 = never give up (survives long conf waits / offline)
 */
/**
 * Mark an error as final, so `pollUntil` stops rather than retrying it.
 *
 * The blanket catch below is deliberate for transient failures — an indexer
 * blip must not end a swap. But it also swallowed the one error that means
 * "this will never succeed": a maker reporting `state: "failed"`. With
 * `timeout: 0` that became an infinite loop, so a taker whose maker had
 * abandoned the swap watched a spinner forever and was never told to refund,
 * while their BTC sat in an HTLC with a deadline.
 */
function terminal(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.terminal = true;
  return e;
}

async function pollUntil(fn, { interval = 5000, timeout = 0, onError } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // A final answer is not something to retry. Everything else is.
      if (e.terminal) throw e;
      console.warn("[poll]", e.message);
      onError?.(e);
    }
    if (timeout > 0 && Date.now() - start > timeout) {
      throw new Error("timed out waiting for maker");
    }
    await sleep(interval);
  }
}

function detailsFromSession(session, extra = {}) {
  const d = { ...extra };
  if (session.swap_id) d.accept = shortHex(session.swap_id, 12);
  if (session.funded_btc?.funding_txid) d.fund = shortHex(session.funded_btc.funding_txid);
  if (session.btc_confs != null) {
    d.btc_confs = `${session.btc_confs || 0}/${BTC_CONF_TARGET}`;
  }
  if (session.funded_fbc?.funding_txid) {
    d.mm_fbc = shortHex(session.funded_fbc.funding_txid);
    d.fbc_confs = `${session.fbc_confs || 0}/${FBC_CONF_TARGET}`;
  }
  if (session.claim_txid) d.claim = shortHex(session.claim_txid);
  if (session.alice_btc_address || session.alice_fbc_address) {
    d.wallets = `${shortHex(session.alice_btc_address || "—", 8)} / ${shortHex(session.alice_fbc_address || "—", 8)}`;
  }
  return d;
}

function stepFromMakerState(s) {
  if (!s) return "btc_confs";
  if (s.state === "funding_fbc" || s.state === "waiting_fbc_confs") {
    return s.funded_fbc ? "fbc_confs" : "mm_fbc";
  }
  if (s.state === "claimable" || s.state === "claiming_btc" || s.state === "done") {
    return "claim";
  }
  return "btc_confs";
}

// ── Swap ──────────────────────────────────────────────────────────────────

async function runSwap() {
  if (!selected?.quote) throw new Error("no quote selected");
  const quote = selected.quote;
  const makerUrl = selected.maker.url;
  const makerName = selected.maker.name;
  const isDemo = makerUrl.startsWith("demo:");
  const details = {};
  // Belongs to the swap, not to the page. A note about the previous swap's fee
  // rate shown against this one's confirmations would be simply false.
  stallNote = "";

  el.progressTitle.textContent = "Swap";
  setProgressSummary({
    amountBtc: quote.amount_btc,
    amountFbc: quote.amount_fbc,
    makerName,
  });
  renderSteps("wallets", details);

  await ensureWallets(isDemo);
  details.wallets = isDemo
    ? "demo"
    : `${shortHex(wallets.btc.address, 8)} / ${shortHex(wallets.fbc.address, 8)}`;
  renderSteps("accept", details);

  // Persist preimage ASAP (before network) so refresh never loses the secret mid-accept.
  const preimage = generatePreimage();
  const hashlock = hashlockOf(preimage);
  state.preimage = preimage;
  const preimageHex = toHex(preimage);
  const offerId = generateOfferId();
  // provisional id until maker returns swap_id (same scheme as bot)
  const provisionalId = `s_${offerId.slice(0, 16)}`;

  const offer = {
    version: 1,
    kind: "offer",
    network: { btc: BTC_NETWORK, fbc: FBC_NETWORK },
    hashlock: toHex(hashlock),
    alice_btc_pubkey: wallets.btc.pubkey,
    alice_fbc_pubkey: wallets.fbc.pubkey,
    amount_btc: quote.amount_btc,
    amount_fbc: quote.amount_fbc,
    btc_refund_height: quote.btc_refund_height,
    fbc_refund_height: quote.fbc_refund_height,
    btc_reference_height: quote.btc_reference_height,
    fbc_reference_height: quote.fbc_reference_height,
    expires_at: quote.expires_at,
    offer_id: offerId,
  };

  // Every height above came from the maker. Anyone can list themselves in the
  // registry, so none of it is trusted: check it against tips we read ourselves
  // before a single satoshi moves. A maker that picks these freely can put our
  // BTC refund years out while making their own FBC refund live immediately.
  if (!isDemo) {
    let tips;
    try {
      const [btcTip, fbcTip] = await Promise.all([fetchBtcTip(), fetchFbcTip()]);
      tips = { btcTip, fbcTip };
    } catch (err) {
      throw new Error(
        `Cannot verify this maker's timelocks against the chain (${err.message}). ` +
          `Refusing to fund.`,
      );
    }
    const v = checkTimelocks(offer, tips);
    if (!v.ok) throw new Error(`Maker quote rejected: ${v.reason}`);
    if (quote.amount_btc !== Math.round(Number(el.amountIn.value) * 1e8)) {
      throw new Error("Maker quoted a different BTC amount than you entered");
    }
  }

  upsertSavedSwap({
    swap_id: provisionalId,
    maker_url: makerUrl,
    maker_name: makerName,
    preimage_hex: preimageHex,
    offer,
    accept: null,
    phase: "accepted",
    alice_btc_address: wallets.btc.address,
    alice_fbc_address: wallets.fbc.address,
    dismissed: false,
    error: null,
  });

  const { swap_id, accept } = await apiAccept(quote.quote_id, offer, makerUrl);

  // The maker chooses swap_id, and we key our local sessions on it — so a
  // hostile (or buggy) maker returning the id of another swap we already hold
  // would overwrite that record and destroy its preimage, losing those coins.
  // Validate the shape and refuse to collide with anything already stored.
  if (typeof swap_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(swap_id)) {
    throw new Error(`Maker returned an unusable swap id: ${String(swap_id).slice(0, 40)}`);
  }
  if (swap_id !== provisionalId) {
    const db = readSwapsDb();
    if (db.swaps[swap_id]) {
      throw new Error(
        `Maker returned a swap id that collides with one of your saved swaps (${shortHex(swap_id, 10)}). ` +
          `Refusing to continue — this would destroy that swap's secret.`,
      );
    }
    if (db.swaps[provisionalId]) {
      db.swaps[swap_id] = { ...db.swaps[provisionalId], swap_id };
      delete db.swaps[provisionalId];
      writeSwapsDb(db);
    }
  }
  state.swapId = swap_id;
  state.offer = offer;
  state.accept = accept;
  state.mmApi = makerUrl;
  state.activeSessionId = swap_id;
  details.accept = shortHex(swap_id, 12);
  setProgressSummary({
    amountBtc: offer.amount_btc,
    amountFbc: offer.amount_fbc,
    makerName,
    swapId: swap_id,
  });
  renderSteps("fund", details);

  const { btc } = htlcsFromOfferAccept(offer, accept);
  const btcScript = buildHTLCScript(btc);
  const btcAddr = btcHTLCAddress(btcScript, BTC_NETWORK);

  upsertSavedSwap({
    swap_id,
    maker_url: makerUrl,
    maker_name: makerName,
    preimage_hex: preimageHex,
    offer,
    accept,
    phase: "awaiting_fund",
    btc_htlc_address: btcAddr,
    alice_btc_address: wallets.btc.address,
    alice_fbc_address: wallets.fbc.address,
    error: null,
  });

  await fundAndWaitAndClaim({
    swap_id,
    makerUrl,
    makerName,
    offer,
    accept,
    preimageHex,
    btcAddr,
    btcScript,
    isDemo,
    details,
    alreadyFunded: null,
  });
}

/**
 * Shared path for new swaps and resume: fund (if needed) → poll maker → claim.
 */
async function fundAndWaitAndClaim({
  swap_id,
  makerUrl,
  makerName,
  offer,
  accept,
  preimageHex,
  btcAddr,
  btcScript,
  isDemo,
  details,
  alreadyFunded,
}) {
  let funded = alreadyFunded;

  // The maker is authoritative about whether funding arrived. Ask it before
  // deciding anything: on resume our own session may have lost the blob — it is
  // only written after the vout resolves, and that step can fail after the
  // money has already left — while the maker has verified the outpoint against
  // its own node and moved on.
  if (!funded && !isDemo) {
    try {
      const remote = await apiGetSwap(swap_id, makerUrl);
      if (remote?.funded_btc?.funding_txid) {
        console.warn("[fund] maker already has our funding", remote.funded_btc.funding_txid);
        funded = remote.funded_btc;
        upsertSavedSwap({ swap_id, funded_btc: funded, phase: "waiting_maker" });
      }
    } catch {
      /* maker unreachable — fall through to the local paths below */
    }
  }

  if (!funded) {
    // A previously-broadcast txid means the coins have already gone. Asking
    // "Fund 0.0001 BTC" then is both wrong and frightening — it reads as a
    // request to send a second time. Resume the resolve instead, silently.
    const priorTxid = isDemo ? null : getSavedSwap(swap_id)?.btc_funding_txid;
    el.progressTitle.textContent = priorTxid ? "Resuming funding" : "Fund BTC";

    // A funding transaction is not an ordinary payment. The maker holds the FBC
    // side until this has BTC_CONF_TARGET confirmations, and the refund
    // timelock runs the whole time — so a wallet's default fee, aimed at
    // confirming eventually, turns the swap into a stall. One mainnet funding
    // went out at 1.0 sat/vB against a 1.14 sat/vB six-block estimate and sat
    // unconfirmed for the best part of an hour, which reads as a broken page.
    //
    // fetchBtcFeeRate floors at 3 sat/vB, which is what makes this a fix rather
    // than a hint: it is above the market rate in all but a congested mempool.
    let feeRate = null;
    if (!isDemo && !priorTxid) {
      try {
        feeRate = await fetchBtcFeeRate();
      } catch {
        /* the wallet's default is still better than not funding */
      }
    }

    if (!isDemo && !priorTxid) {
      // Naming the rate matters for wallets that will not take one from us —
      // Xverse prompts for its own, and the user needs a number to type.
      await waitClick(
        feeRate
          ? `Fund ${fmtBtc(offer.amount_btc)} BTC at ${feeRate} sat/vB`
          : `Fund ${fmtBtc(offer.amount_btc)} BTC`,
      );
    }
    details.fund = priorTxid ? "already sent — locating output…" : "signing…";
    renderSteps("fund", details);

    let fundedTxid;
    let fundedVout;
    if (isDemo) {
      await sleep(400);
      fundedTxid = "b".repeat(64);
      fundedVout = 0;
    } else {
      // If a previous attempt already broadcast, reuse that txid. Resolving
      // the vout can take minutes and can fail; without this, a failure there
      // loses the txid and Resume sends the BTC a second time.
      if (priorTxid) {
        console.warn("[fund] reusing already-broadcast funding tx", priorTxid);
        fundedTxid = priorTxid;
      } else {
        fundedTxid = await btcWallet.sendBitcoin(btcAddr, offer.amount_btc, {
          feeRate,
        });
        // Persist before anything else can throw — the money has left.
        upsertSavedSwap({
          swap_id,
          btc_funding_txid: fundedTxid,
          btc_htlc_address: btcAddr,
          phase: "waiting_maker",
        });
      }
      details.fund = "resolving vout…";
      renderSteps("fund", details);
      fundedVout = await resolveFundingVout(fundedTxid, btcAddr);
    }
    funded = {
      version: 1,
      kind: "funded_btc",
      offer_id: offer.offer_id,
      funding_txid: fundedTxid,
      funding_vout: fundedVout,
      funding_amount: offer.amount_btc,
      witness_script_hex: toHex(btcScript.scriptBytes),
    };
    details.fund = shortHex(fundedTxid);
    renderSteps("btc_confs", details);

    upsertSavedSwap({
      swap_id,
      funded_btc: funded,
      phase: "waiting_maker",
      error: null,
    });

    await apiFundedBtc(swap_id, funded, makerUrl);
  } else {
    details.fund = shortHex(funded.funding_txid);
    renderSteps("btc_confs", details);
    // Re-notify maker if they lost state (idempotent when already waiting)
    try {
      await apiFundedBtc(swap_id, funded, makerUrl);
    } catch (err) {
      console.warn("[resume] funded_btc notify:", err);
    }
  }

  upsertSavedSwap({ swap_id, funded_btc: funded, phase: "waiting_maker", error: null });

  el.progressTitle.textContent = "Waiting…";
  setProgressSummary({
    amountBtc: offer.amount_btc,
    amountFbc: offer.amount_fbc,
    makerName,
    swapId: swap_id,
  });

  // A funding transaction that underpaid sits in the mempool for hours, and
  // "BTC confirmations 0/6" with no explanation is how a working swap comes to
  // look like a broken one. Once it has been a while with nothing, read what
  // the transaction actually paid and say so.
  //
  // Checked once, not per poll: the answer cannot change, and the poll runs
  // every few seconds for as long as the swap takes.
  let stallChecked = false;
  const stallDeadline = Date.now() + 12 * 60_000;

  const ready = await pollUntil(
    async () => {
      const s = await apiGetSwap(swap_id, makerUrl);
      details.btc_confs = `${s.btc_confs || 0}/${BTC_CONF_TARGET}`;

      if (!stallChecked && !isDemo && !(s.btc_confs > 0) && Date.now() > stallDeadline) {
        stallChecked = true;
        const [paid, want] = await Promise.all([
          fetchBtcTxFeeRate(funded.funding_txid),
          fetchBtcFeeRate().catch(() => null),
        ]);
        // Only speak up when the number explains the wait. A transaction paying
        // a healthy rate that simply has not been mined yet needs no commentary,
        // and inventing an explanation for ordinary variance is worse than
        // silence.
        if (paid != null && want != null && paid < want * 0.9) {
          stallNote = `paid ${paid.toFixed(2)} sat/vB — under the ${want} sat/vB going rate, so this may take hours`;
          // Said once, out loud, because the sub-line above is easy to miss and
          // the thing a user does when a swap looks stuck is fund it again.
          showToast(
            `Your funding transaction paid ${paid.toFixed(2)} sat/vB, below the ${want} ` +
              `sat/vB the network is currently taking. It is valid and will confirm, but ` +
              `it may take a few hours. Nothing is lost — do not send again.`,
            "warn",
          );
        }
      }
      if (s.funded_fbc) {
        details.mm_fbc = shortHex(s.funded_fbc.funding_txid);
        details.fbc_confs = `${s.fbc_confs || 0}/${FBC_CONF_TARGET}`;
      }
      const step = stepFromMakerState(s);
      // Terminal: the maker has given up. Retrying cannot change that, and
      // the taker needs to reach the recovery path while their refund window
      // is still open.
      if (s.state === "failed") throw terminal(s.error || "swap failed");
      renderSteps(step, details);
      upsertSavedSwap({
        swap_id,
        funded_btc: funded,
        funded_fbc: s.funded_fbc || null,
        btc_confs: s.btc_confs || 0,
        fbc_confs: s.fbc_confs || 0,
        maker_state: s.state || null,
        phase:
          s.state === "claimable" || s.state === "claiming_btc" || s.state === "done"
            ? "claimable"
            : "waiting_maker",
        error: s.error || null,
      });
      if (
        (s.state === "claimable" ||
          s.state === "claiming_btc" ||
          s.state === "done") &&
        s.funded_fbc
      ) {
        return s;
      }
      return null;
    },
    {
      interval: isDemo ? 400 : 8000,
      timeout: 0, // never drop session on long waits / offline
      onError: (e) => {
        upsertSavedSwap({
          swap_id,
          phase: "waiting_maker",
          error: e.message,
        });
        el.progressTitle.textContent = "Reconnecting…";
      },
    },
  );

  renderSteps("claim", details);
  el.progressTitle.textContent = "Claim FBC";

  if (!isDemo) {
    // The blob must be internally consistent with our offer...
    const v = verifyFundedFbc(offer, accept, ready.funded_fbc);
    if (!v.ok) throw new Error(`funded_fbc invalid: ${v.reason}`);

    // ...and, far more importantly, it must actually exist on the FBC chain
    // with enough confirmations. Up to here every number about the FBC leg —
    // including fbc_confs — came from the maker, who has every incentive to
    // say "ready". Claiming against an unconfirmed funding output publishes
    // the preimage while that output can still be replaced, which is exactly
    // how a maker takes the BTC leg without ever locking a confirmed coin.
    el.progressTitle.textContent = "Verifying FBC on-chain…";
    const expectedAddr = fbcHTLCAddress(
      buildHTLCScript(htlcsFromOfferAccept(offer, accept).fbc),
      FBC_NETWORK,
    );

    // A missing output is transient (not relayed/indexed yet); a *wrong* one
    // is fatal and must abort rather than retry. `pollUntil` swallows throws,
    // so the distinction is made here rather than inside the predicate.
    let confirmed = null;
    let unreadableTries = 0;
    for (;;) {
      let out = null;
      try {
        out = await fetchFbcOutput(
          ready.funded_fbc.funding_txid,
          ready.funded_fbc.funding_vout,
        );
      } catch (err) {
        // fetchFbcOutput draws exactly the distinction this loop needs: it
        // RETURNS null when the chain could not be read, and THROWS when the
        // chain answered and the answer is wrong — a vout that does not exist
        // on a transaction that does. Catching both flattened them into the
        // same "unreadable" state, and after three tries the UI offered
        // "Claim anyway" against an outpoint the chain had already disproven.
        // Claiming there publishes the preimage for nothing.
        console.warn("[verify-fbc]", err.message);
        throw new Error(
          `${err.message}. The maker's funding output does not exist as described. ` +
            `Do not claim — refund your BTC at the refund height instead.`,
        );
      }

      // found:false means the explorer answered and the tx is not on chain yet
      // — keep waiting. Only a null (unreadable) counts toward the prompt.
      if (out && out.found === false) {
        details.fbc_confs = `0/${FBC_CONF_TARGET}`;
        renderSteps("claim", details);
        await sleep(8000);
        continue;
      }

      if (out) {
        if (out.address !== expectedAddr) {
          throw new Error(
            `Maker's FBC funding output pays ${out.address}, not the HTLC address ` +
              `${expectedAddr}. Do not claim — refund your BTC at the refund height instead.`,
          );
        }
        if (Number(out.value) !== offer.amount_fbc) {
          throw new Error(
            `Maker's FBC funding output holds ${out.value} bumps, expected ${offer.amount_fbc}. ` +
              `Do not claim — refund your BTC at the refund height instead.`,
          );
        }
        // Confirmations are only half the question. The other half is whether
        // T2 is still far enough away to claim safely: past the deadline the
        // maker's refund branch is live, and a claim that loses that race still
        // publishes the preimage while our BTC leg is spendable — so the maker
        // takes the FBC back AND claims our BTC. Never reveal `s` after this.
        const deadline = fbcClaimDeadline(offer);
        if (out.tip > deadline) {
          throw new Error(
            `Too late to claim safely: FBC height ${out.tip} is past the safe deadline ` +
              `${deadline} (maker's refund opens at ${offer.fbc_refund_height}). ` +
              `Do NOT claim — revealing the secret now can lose both legs. ` +
              `Recover your BTC at height ${offer.btc_refund_height} instead.`,
          );
        }

        details.fbc_confs = `${out.confirmations}/${FBC_CONF_TARGET}`;
        renderSteps("claim", details);
        upsertSavedSwap({ swap_id, fbc_confs: out.confirmations });
        if (out.confirmations >= FBC_CONF_TARGET) {
          confirmed = out;
          break;
        }
      }
      if (!out) {
        unreadableTries += 1;
        // No browser-reachable FBC chain source exists today (the explorer
        // serves HTML, not JSON). Waiting forever strands the user with their
        // BTC locked and no way forward, which is worse than telling them the
        // truth: we could not check, here is exactly what that risks, you
        // decide. Never silently downgrade — this must be an explicit choice.
        if (unreadableTries >= UNREADABLE_TRIES_BEFORE_ASKING) {
          el.progressTitle.textContent = "Cannot verify FBC on-chain";
          details.claim = "";
          renderSteps("claim", details);
          showUnverifiedWarning(ready, offer);
          await waitClick("Claim anyway — I trust this maker");
          hideUnverifiedWarning();
          confirmed = { confirmations: ready.fbc_confs ?? 0, unverified: true };
          break;
        }
      }
      await sleep(8000);
    }

    details.fbc_confs = confirmed.unverified
      ? `${confirmed.confirmations}/${FBC_CONF_TARGET} (unverified)`
      : `${confirmed.confirmations}/${FBC_CONF_TARGET}`;
    renderSteps("claim", details);
    el.progressTitle.textContent = "Claim FBC";
    upsertSavedSwap({
      swap_id,
      funded_fbc: ready.funded_fbc,
      phase: "claimable",
      fbc_confs: confirmed.confirmations,
      error: null,
    });

    await ensureWallets(isDemo);
    await waitClick("Claim FBC");
    details.claim = "signing…";
    renderSteps("claim", details);

    // Re-check the deadline right before signing. The button above can sit
    // unclicked for hours, and the safe window is measured in FBC blocks.
    const deadline = fbcClaimDeadline(offer);
    const tipNow = await fetchFbcTip().catch(() => null);
    if (tipNow === null) {
      throw new Error(
        "Cannot read the FBC chain to confirm it is still safe to claim. Not revealing the secret.",
      );
    }
    if (tipNow > deadline) {
      throw new Error(
        `Too late to claim safely: FBC height ${tipNow} is past the safe deadline ${deadline}. ` +
          `Do NOT claim — recover your BTC at height ${offer.btc_refund_height} instead.`,
      );
    }

    const dest =
      wallets.fbc?.address ||
      getSavedSwap(swap_id)?.alice_fbc_address;
    if (!dest) throw new Error("FBC destination address missing — reconnect Fistbump");
    const res = await window.fistbump.signHtlcSpend({
      fundingTxid: ready.funded_fbc.funding_txid,
      fundingVout: ready.funded_fbc.funding_vout,
      fundingAmount: ready.funded_fbc.funding_amount,
      witnessScriptHex: ready.funded_fbc.witness_script_hex,
      branch: "claim",
      preimageHex,
      destinationAddress: dest,
      feeRate: 1000,
    });
    details.claim = shortHex(res.txid);
    upsertSavedSwap({
      swap_id,
      claim_txid: res.txid,
      phase: "done",
      error: null,
    });
  } else {
    await sleep(300);
    details.claim = "demo";
    upsertSavedSwap({ swap_id, phase: "done", claim_txid: "demo", error: null });
  }

  renderSteps("done", details);
  el.progressTitle.textContent = "Done";
  el.progressDone.classList.remove("hidden");
  el.progressDoneText.textContent = `Received ${fmtFbc(offer.amount_fbc)} FBC`;
  showToast("Swap complete", "ok");
  state.running = false;
  state.activeSessionId = null;
  // The claim tx published the preimage; the stored copy was wiped by the
  // phase:"done" write above, so drop the in-memory one to match.
  state.preimage = null;
}

// ── BTC recovery ──────────────────────────────────────────────────────────

/**
 * Spend our own BTC HTLC through the refund branch.
 *
 * Without this the Auto flow had no way out at all: a maker who takes the
 * offer, lets the taker fund, and then vanishes leaves those coins locked with
 * nothing in the UI to recover them. The refund branch needs no counterparty
 * and no preimage — only that T1 has passed — so it is always available once
 * the deadline is reached, and it is the honest answer to every failure mode
 * where the FBC leg never became claimable.
 *
 * Deliberately NOT offered while the swap is claimable or done: refunding
 * after already claiming the FBC just burns a fee, and refunding instead of
 * claiming forfeits FBC that is sitting there waiting.
 */
async function refundBtc(swapId) {
  const session = getSavedSwap(swapId);
  if (!session) throw new Error("session not found");
  if (!session.offer || !session.accept) {
    throw new Error("session is missing the offer/accept needed to rebuild the HTLC");
  }

  const fundingTxid = session.funded_btc?.funding_txid || session.btc_funding_txid;
  if (!fundingTxid) throw new Error("this swap never funded BTC — nothing to recover");

  // Recovery, not entry: rebuild the exact script that locked the coins
  // without re-applying timelock policy, which this offer may no longer meet.
  const { btc } = htlcParamsForRecovery(session.offer, session.accept);
  const btcScript = buildHTLCScript(btc);
  const btcAddr = btcHTLCAddress(btcScript, BTC_NETWORK);

  const tip = await fetchBtcTip();
  const refundHeight = session.offer.btc_refund_height;
  if (tip < refundHeight) {
    const blocks = refundHeight - tip;
    throw new Error(
      `Too early: the refund branch opens at block ${refundHeight}, ` +
        `${blocks} block${blocks === 1 ? "" : "s"} away (~${Math.round((blocks * 10) / 6) / 10}h).`,
    );
  }

  // The vout may never have been resolved (the failure that persists
  // btc_funding_txid on its own), so recover it from the chain here.
  let vout = session.funded_btc?.funding_vout;
  if (typeof vout !== "number") vout = await resolveFundingVout(fundingTxid, btcAddr);

  const out = await fetchBtcOutput(fundingTxid, vout);
  if (!out) throw new Error(`Cannot read ${shortHex(fundingTxid)}:${vout} on the BTC chain`);
  if (out.address !== btcAddr) {
    throw new Error(`That outpoint pays ${out.address}, not this swap's HTLC ${btcAddr}`);
  }

  await ensureWallets(false);
  const feeRate = await fetchBtcFeeRate();
  const { psbtHex } = buildHTLCSpendPsbt({
    fundingTxid,
    fundingVout: vout,
    fundingAmountSats: out.value,
    witnessScript: btcScript.scriptBytes,
    destination: wallets.btc.address,
    feeRateSatPerVb: feeRate,
    branch: "refund",
    // CLTV compares against the tx's nLockTime, so the spend must carry it.
    locktime: refundHeight,
    network: BTC_NETWORK,
  });

  let signedPsbtHex;
  try {
    signedPsbtHex = await btcWallet.signPsbt(psbtHex, wallets.btc);
  } catch (err) {
    // SPEC §11.2: some Unisat builds refuse P2WSH inputs with a custom script
    // ("Unknown inputs not allowed"), and no hardware wallet will ever accept
    // one. That must not be the end of the road — these are the user's coins
    // and the refund branch needs only their key, so hand them the PSBT.
    showPsbt({
      title: "Sign this refund elsewhere",
      note:
        `Your wallet refused to sign. This PSBT spends ${fundingTxid.slice(0, 12)}…:${vout} ` +
        `(${out.value} sats) back to ${wallets.btc.address}. nLockTime ${refundHeight} — do not let ` +
        `the signer change it.`,
      psbtHex,
    });
    console.error(
      "[recover] wallet refused to sign the refund PSBT.\n" +
        "Sign this PSBT with any wallet that supports custom P2WSH scripts (e.g. Sparrow):\n" +
        `PSBT (hex): ${psbtHex}\n` +
        `HTLC address:  ${btcAddr}\n` +
        `witness script: ${toHex(btcScript.scriptBytes)}\n` +
        `outpoint:       ${fundingTxid}:${vout}  (${out.value} sat)\n` +
        `nLockTime:      ${refundHeight}  (must be set, nSequence < 0xffffffff)\n` +
        `destination:    ${wallets.btc.address}`,
      err,
    );
    throw new Error(
      "Your BTC wallet refused to sign the refund — most wallets will not sign a custom " +
        "P2WSH script, and no hardware wallet can. The unsigned PSBT is shown below: sign it " +
        "in Sparrow, Electrum or bitcoin-cli and broadcast. Your coins are recoverable.",
    );
  }

  const { rawTxHex, txid } = finalizeHTLCSpend({
    signedPsbtHex,
    witnessScript: btcScript.scriptBytes,
    branch: "refund",
  });

  const broadcastTxid = (await btcWallet.pushTx(rawTxHex)) || txid;
  upsertSavedSwap({
    swap_id: swapId,
    phase: "refunded",
    refund_txid: broadcastTxid,
    // The signed transaction, kept until the refund is buried.
    //
    // pushTx succeeding means "accepted for relay", not "settled". An evicted
    // or reorged refund leaves the BTC locked with the refund branch still
    // open — recoverable, but only by someone who can produce the transaction
    // again. Storing just the txid meant re-deriving the script and asking the
    // wallet to sign a second time, through a UI that had already marked the
    // swap terminal and would not offer it.
    //
    // Nothing secret: it is a fully signed spend of the taker's own HTLC,
    // already broadcast to the Bitcoin network.
    refund_raw_hex: rawTxHex,
    refund_confirmed: false,
    error: null,
  });
  return broadcastTxid;
}

/** Resume a saved multi-swap session after refresh / timeout / crash. */
async function resumeSavedSwap(swapId) {
  if (state.running) throw new Error("another swap is in progress");
  const session = getSavedSwap(swapId);
  if (!session) throw new Error("session not found");
  // Same reason as in runSwap: the note describes one specific transaction.
  stallNote = "";
  // Finished first: a completed swap has had its preimage wiped by design, so
  // the missing-secret error below would be wrong as well as alarming. A
  // refunded swap is equally finished — resuming it re-notified the maker,
  // rewound the phase and re-offered a recovery on a spent outpoint.
  // A refund that was broadcast but never confirmed is not finished. It can be
  // evicted or reorged, and then the BTC sits in the HTLC with the refund
  // branch still open — so the one useful thing to offer is sending the same
  // signed transaction again. Saying "Already refunded" and stopping is how
  // that money stays locked.
  if (session.phase === "refunded" && !session.refund_confirmed && session.refund_raw_hex) {
    const confs = await fetchBtcConfirmations(session.refund_txid).catch(() => null);
    if (confs && confs > 0) {
      upsertSavedSwap({ swap_id: swapId, refund_confirmed: true });
      showToast(`Refund confirmed (${confs} confirmation${confs === 1 ? "" : "s"})`, "ok");
      return;
    }
    el.progressTitle.textContent = "Rebroadcasting refund";
    try {
      const txid = await rebroadcastRawTx(session.refund_raw_hex);
      showToast(`Refund rebroadcast — ${shortHex(txid || session.refund_txid)}`, "ok");
    } catch (err) {
      // Already-in-mempool and already-in-chain both come back as errors and
      // both mean the refund is fine. Do not alarm on either.
      const m = String(err?.message || err);
      if (/already|txn-already|duplicate/i.test(m)) {
        showToast("Refund is already in the mempool — nothing to do", "ok");
      } else {
        showToast(`Could not rebroadcast: ${m}`, "error");
      }
    }
    return;
  }
  if (session.phase === "done" || session.phase === "refunded") {
    showToast(session.phase === "refunded" ? "Already refunded" : "Already complete", "ok");
    return;
  }
  if (!session.preimage_hex) throw new Error("session missing preimage — cannot resume");

  // Demo-ness is a property of the SESSION's maker, never of the global flag.
  // Keying off `DEMO` meant a stale `mm_demo` in localStorage would skip
  // on-chain verification — and mark a real swap "done" — on resume.
  const isDemo = session.maker_url.startsWith("demo:");

  state.running = true;
  state.activeSessionId = swapId;
  state.swapId = swapId;
  state.mmApi = session.maker_url;
  state.offer = session.offer;
  state.accept = session.accept;
  state.preimage = fromHex(session.preimage_hex);
  showProgress();
  el.progressDone.classList.add("hidden");

  const details = detailsFromSession(session);
  el.progressTitle.textContent = "Resuming…";
  if (session.offer) {
    setProgressSummary({
      amountBtc: session.offer.amount_btc,
      amountFbc: session.offer.amount_fbc,
      makerName: session.maker_name || "maker",
      swapId,
    });
  } else {
    setProgressSummary({ text: swapId });
  }

  try {
    if (!session.accept || !session.offer) {
      throw new Error("session incomplete (missing offer/accept)");
    }

    // Reconnect wallets for claim / optional fund
    await ensureWallets(isDemo);

    if (
      !isDemo &&
      wallets.fbc?.pubkey &&
      session.offer.alice_fbc_pubkey &&
      wallets.fbc.pubkey.toLowerCase() !== session.offer.alice_fbc_pubkey.toLowerCase()
    ) {
      showToast("Warning: FBC wallet pubkey differs from swap", "error");
    }

    // Policy check only while there is still a decision to make. Once BTC is
    // funded the HTLC exists on chain and the only question left is how to get
    // the coins back out — refusing to rebuild its script because the offer
    // would not be acceptable *today* strands them behind an error message.
    //
    // The case that motivates it: offers written before the timelock ordering
    // was corrected fail checkTimelocks forever, so resume threw here instead
    // of reaching the funded-recovery branch immediately below.
    // Either field means coins may already be on chain. `btc_funding_txid` is
    // written the instant the wallet returns a txid — before the vout is
    // resolved and therefore before `funded_btc` exists — and that gap is
    // minutes wide, because resolving a vout waits on an indexer. Keying
    // recovery on `funded_btc` alone left exactly that window validating the
    // offer as though nothing had been sent.
    const alreadyCommitted = !!(session.funded_btc || session.btc_funding_txid);
    const { btc } = alreadyCommitted
      ? htlcParamsForRecovery(session.offer, session.accept)
      : htlcsFromOfferAccept(session.offer, session.accept);
    const btcScript = buildHTLCScript(btc);
    const btcAddr =
      session.btc_htlc_address || btcHTLCAddress(btcScript, BTC_NETWORK);

    // Already past funding — never send BTC again on resume.
    //
    // Either field, not just `funded_btc`. The txid is saved the moment the
    // wallet returns it; `funded_btc` only exists once the vout has been
    // resolved, which waits on an indexer and can take minutes. A crash in
    // between left a session holding a real on-chain funding transaction that
    // this branch did not recognise — so it fell through to the fund path
    // below, was tip-checked as though nothing had been sent, and an offer
    // that had since expired was refused outright.
    //
    // fundAndWaitAndClaim resumes from a saved txid rather than sending again
    // (see `priorTxid`), so routing the vout-less case here is what recovers
    // it instead of stranding it.
    if (session.funded_btc || session.btc_funding_txid) {
      if (session.phase === "claimable" && session.funded_fbc) {
        renderSteps("claim", details);
      } else {
        renderSteps("btc_confs", details);
      }
      await fundAndWaitAndClaim({
        swap_id: swapId,
        makerUrl: session.maker_url,
        makerName: session.maker_name || session.maker_url,
        offer: session.offer,
        accept: session.accept,
        preimageHex: session.preimage_hex,
        btcAddr,
        btcScript,
        isDemo,
        details,
        alreadyFunded: session.funded_btc,
      });
      return;
    }

    // Need to fund BTC (session never got a funding tx). This path spends real
    // money, so it gets the same tip-checked timelock validation as a fresh
    // swap — the offer may have been sitting in localStorage for days, and its
    // heights are absolute, so what was safe when accepted may be expired now.
    if (!isDemo) {
      let tips;
      try {
        const [btcTip, fbcTip] = await Promise.all([fetchBtcTip(), fetchFbcTip()]);
        tips = { btcTip, fbcTip };
      } catch (err) {
        throw new Error(
          `Cannot verify this swap's timelocks against the chain (${err.message}). Not funding.`,
        );
      }
      const v = checkTimelocks(session.offer, tips);
      if (!v.ok) {
        throw new Error(
          `Refusing to fund this saved swap: ${v.reason}. ` +
            `Start a new swap instead — this one's timelocks are no longer safe.`,
        );
      }
    }

    renderSteps("fund", details);
    await fundAndWaitAndClaim({
      swap_id: swapId,
      makerUrl: session.maker_url,
      makerName: session.maker_name || session.maker_url,
      offer: session.offer,
      accept: session.accept,
      preimageHex: session.preimage_hex,
      btcAddr,
      btcScript,
      isDemo,
      details,
      alreadyFunded: null,
    });
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    upsertSavedSwap({ swap_id: swapId, error: msg, phase: getSavedSwap(swapId)?.phase || "failed" });
    el.progressTitle.textContent = msg || "Failed";
    showToast(msg || "Failed", "error");
    state.running = false;
    el.progressAction.classList.remove("hidden");
    el.progressActionBtn.textContent = "Retry resume";
    el.progressActionBtn.onclick = () => {
      el.progressActionBtn.onclick = null;
      resumeSavedSwap(swapId).catch((e) => showToast(e.message || "Failed", "error"));
    };
  }
}

// ── Events ────────────────────────────────────────────────────────────────

el.swapBtn.addEventListener("click", async () => {
  if (!selected?.quote || state.running) return;
  // Start from a clean slate: a leftover id from the last swap would make the
  // catch below record this swap's failure against that older record.
  state.swapId = null;
  state.activeSessionId = null;
  state.running = true;
  showProgress();
  el.swapBtn.disabled = true;
  try {
    await runSwap();
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : String(err);
    const sid = state.activeSessionId || state.swapId;
    if (sid) {
      upsertSavedSwap({
        swap_id: sid,
        error: msg,
        phase: getSavedSwap(sid)?.funded_btc ? "waiting_maker" : getSavedSwap(sid)?.phase || "failed",
      });
    }
    el.progressTitle.textContent = msg || "Failed";
    showToast(msg || "Failed", "error");
    state.running = false;
    el.progressAction.classList.remove("hidden");
    el.progressActionBtn.textContent = sid ? "Resume" : "Back";
    el.progressActionBtn.onclick = () => {
      el.progressActionBtn.onclick = null;
      if (sid) {
        resumeSavedSwap(sid).catch((e) => showToast(e.message || "Failed", "error"));
      } else {
        showSwapCard();
      }
    };
  }
});

el.resetBtn.addEventListener("click", () => {
  // Does NOT wipe localStorage sessions — only leaves the progress UI.
  // swapId is cleared too: the error handler attributes failures to it, so a
  // stale value writes the next swap's error onto the previous swap's record.
  state.running = false;
  state.activeSessionId = null;
  state.swapId = null;
  if (pendingClick) pendingClick("swap closed");
  showSwapCard();
  renderSessions();
});
el.doneResetBtn.addEventListener("click", () => {
  state.running = false;
  state.activeSessionId = null;
  state.swapId = null;
  showSwapCard();
  renderSessions();
});
el.refreshQuotes.addEventListener("click", () => refreshQuotes());

let debounce;
/*
 * Long enough to sit through a pause mid-number. Typing "500" then "000" left
 * a gap wider than the old 320ms, so a quote fired for 500 FBC and its
 * correction pass wrote a BTC amount for the wrong target while the rest of
 * the digits were still arriving.
 *
 * The staleness guard in refreshQuotes is what makes that correct rather than
 * merely unlikely; this is what stops it being annoying.
 */
const QUOTE_DEBOUNCE_MS = 650;

function scheduleQuote() {
  clearTimeout(debounce);
  debounce = setTimeout(refreshQuotes, QUOTE_DEBOUNCE_MS);
}

el.amountIn.addEventListener("input", () => {
  // A keystroke the sanitiser undoes is not an edit. Returning here is what
  // keeps a stray space from taking the sticky role away from FBC.
  if (!fieldChanged(el.amountIn, BTC_DECIMALS)) return;
  lastEdited = "btc";
  // Typing BTC hands the sticky role back to BTC: the FBC figure is now
  // whatever this much BTC happens to buy.
  fbcTarget = null;
  setReceiveHint(null, null);
  estimateFromBtc();
  scheduleQuote();
});

el.amountOut.addEventListener("input", () => {
  if (!fieldChanged(el.amountOut, FBC_DECIMALS)) return;
  lastEdited = "fbc";
  const v = Number(el.amountOut.value);
  fbcTarget = v > 0 ? v : null;
  estimateFromFbc();
  scheduleQuote();
});

// ── Mobile nav ────────────────────────────────────────────────────────────
// Lives here rather than in an inline <script> so the page's CSP can keep
// script-src at 'self' with no 'unsafe-inline'.

(() => {
  const btn = document.getElementById("menuToggle");
  const nav = document.getElementById("mobileNav");
  if (!btn || !nav) return;
  btn.addEventListener("click", () => {
    nav.classList.toggle("open");
    document.body.classList.toggle("nav-open", nav.classList.contains("open"));
  });
  nav.addEventListener("click", (e) => {
    if (e.target.tagName === "A") {
      nav.classList.remove("open");
      document.body.classList.remove("nav-open");
    }
  });
})();

// ── Boot ──────────────────────────────────────────────────────────────────

(async () => {
  // Sweep finished swaps' secrets on load, not only when something else writes:
  // a tab that never starts a swap should still not sit on old preimages.
  // Guarded like readSwapsDb: storage can be blocked or full, and losing the
  // sweep must not take the whole page down with it.
  try {
    const bootDb = readSwapsDb();
    if (Object.keys(bootDb.swaps).length) writeSwapsDb(bootDb);
  } catch (err) {
    console.warn("[sessions] boot sweep failed:", err);
  }
  renderSessions();
  if (params.get("api") && !PINNED_MAKER) {
    showToast("Ignoring ?api= — pin must be an https maker origin", "error");
  }
  if (DEMO && !PINNED_MAKER) {
    // force demo directory only
    directory = [{ name: "Demo maker", url: "demo://local" }];
  } else {
    await loadDirectory();
  }
  await refreshQuotes();

  // Market data is independent of quoting: it must not delay the swap card,
  // and a registry outage must not stop anyone swapping. Fired and forgotten.
  refreshMarket().catch(() => {});
  setInterval(() => refreshMarket().catch(() => {}), MARKET_REFRESH_MS);

  // Deep-link: ?resume=s_…
  const resumeId = params.get("resume");
  if (resumeId && getSavedSwap(resumeId)) {
    showToast("Resuming saved swap…", "ok");
    resumeSavedSwap(resumeId).catch((e) => showToast(e.message || "Resume failed", "error"));
  } else {
    const open = listSavedSwaps({ includeDone: false });
    if (open.length === 1 && open[0].phase !== "done" && open[0].phase !== "refunded") {
      showToast(`1 open swap — use Resume under Sessions`, "ok");
    } else if (open.length > 1) {
      showToast(`${open.length} open swaps saved in this browser`, "ok");
    }
  }
})();

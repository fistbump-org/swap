// Chain monitoring helpers: confirmation polling and refund-height
// countdowns. Pure glue around Blockstream (BTC) and the Fistbump
// explorer API (FBC). Callers wire the return values into UI — this
// module never touches the DOM itself.
//
// Polling strategy: start fast (5s) while the tx is young, back off
// to 20s once confirmations are accumulating and the user is just
// waiting out time. Each pollTx returns a stopper so the caller can
// cancel when the user navigates away or the swap advances.

const BTC_API = "https://blockstream.info/api";
const FBC_API = "https://explorer.fistbump.org/api";

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
      fetch(`${BTC_API}/tx/${txid}/status`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${BTC_API}/blocks/tip/height`).then((r) => (r.ok ? r.text() : null)),
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
    const [txData, tipData] = await Promise.all([
      fetch(`${FBC_API}/tx/${txid}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`${FBC_API}/blocks?limit=1`).then((r) => (r.ok ? r.json() : null)),
    ]);
    const tipH = Array.isArray(tipData) && tipData[0] ? Number(tipData[0].height) : null;
    const blockH = txData?.block_height ?? txData?.height ?? null;
    let confirmations = 0;
    if (blockH != null && Number.isFinite(tipH)) {
      confirmations = Math.max(0, tipH - Number(blockH) + 1);
    }
    onUpdate({ confirmations, tip: tipH, confirmed: blockH != null });
  });
}

/** Poll a chain's tip height on an interval. Used for refund countdowns. */
export function pollBtcTip(onUpdate) {
  return startPoller(async () => {
    const res = await fetch(`${BTC_API}/blocks/tip/height`);
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

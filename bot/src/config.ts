import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") {
    throw new Error(`missing required env ${name}`);
  }
  return v;
}

function envOpt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not a number`);
  return n;
}

/**
 * Minimal .env reader.
 *
 * Values are taken verbatim after the first `=`, with only surrounding quotes
 * removed — no inline-comment stripping, because a `#` is perfectly legal
 * inside an RPC password and silently truncating one produces an auth failure
 * that looks like a network problem. A likely-unintentional trailing comment
 * is warned about instead of guessed at.
 */
/** `$(cmd)`, backticks, or `${VAR}` — none of which .env expands. */
const LOOKS_UNEXPANDED = /^\$\(|^`|\$\{/;

function loadDotEnv() {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      console.warn(`[config] ignoring malformed .env key: ${k.slice(0, 40)}`);
      continue;
    }
    let v = t.slice(i + 1).trim();
    const quoted =
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2);
    if (quoted) {
      v = v.slice(1, -1);
    } else if (/\s#/.test(v)) {
      console.warn(
        `[config] ${k} contains " #" — kept verbatim as part of the value. ` +
          `Quote it if the # is meant literally, or move the comment to its own line.`,
      );
    }
    // `.env` is not shell. A value like `$(openssl rand -hex 16)` or `${HOME}`
    // is stored verbatim, so a "secret" generated that way is really the
    // constant string everyone who made the same mistake also has.
    if (LOOKS_UNEXPANDED.test(v)) {
      console.warn(
        `[config] ${k} looks like unexpanded shell syntax: ${v.slice(0, 40)}\n` +
          `         .env values are literal — run the command and paste its OUTPUT.`,
      );
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadDotEnv();

function resolveRpcPassword(): string {
  const direct = envOpt("FBD_RPC_PASSWORD");
  if (direct) return direct;
  const cookie = envOpt("FBD_RPC_COOKIE");
  if (cookie && existsSync(cookie)) {
    return readFileSync(cookie, "utf8").trim();
  }
  // Common cookie locations (standalone fbd vs Fistbump.app)
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    resolve(home, ".fistbump", "fbd-data", ".cookie"),
    resolve(home, ".fbd", ".cookie"),
    resolve(home, "Library", "Application Support", "fbd", ".cookie"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8").trim();
  }
  return "";
}

// Read before the object literal so the burial depths below can default to
// them without the object having to reference itself.
const btcConfTarget = envInt("BTC_CONF_TARGET", 6);
const fbcConfTarget = envInt("FBC_CONF_TARGET", 12);

export const config = {
  port: envInt("PORT", 8787),
  host: envOpt("HOST", "127.0.0.1"),
  corsOrigins: envOpt(
    "CORS_ORIGINS",
    "https://swap.fistbump.org,http://127.0.0.1:8766,http://localhost:8766",
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  /**
   * Target USD price per 1 FBC (paid in BTC). Default 0.01 → $0.01/FBC.
   * Set to 0 to disable USD peg and use MID_FBC_PER_BTC instead.
   */
  fbcUsdPrice: Number(envOpt("FBC_USD_PRICE", "0.01")) || 0,
  /** coinbase | kraken | fixed (use BTC_USD) */
  btcUsdSource: envOpt("BTC_USD_SOURCE", "coinbase"),
  /** When BTC_USD_SOURCE=fixed, use this BTC/USD (no network). */
  btcUsdFixed: Number(envOpt("BTC_USD", "0")) || 0,
  /** Cache BTC/USD for this many ms (default 60s). */
  priceCacheMs: envInt("PRICE_CACHE_MS", 60_000),
  /** Fallback / non-peg mid (FBC per BTC) if FBC_USD_PRICE=0. */
  midFbcPerBtc: envInt("MID_FBC_PER_BTC", 42_000),
  spreadBps: envInt("SPREAD_BPS", 50),
  maxFbc: envInt("MAX_FBC", 100_000),
  /**
   * Absolute floor on swap size. This is only a floor: the size that actually
   * matters is the one at which a claim still nets more than dust after fees,
   * which moves with the fee market and is computed per quote (see
   * `minClaimableSats` in btc-wallet.ts). At ~139 vB for the claim tx, a
   * 10,000 sat HTLC stops being claimable above ~68 sat/vB.
   */
  minBtcSat: envInt("MIN_BTC_SAT", 10_000),
  /**
   * Headroom multiplier on the fee-derived minimum swap size. The quote is
   * only valid for QUOTE_TTL_MS, but the claim happens hours later at whatever
   * the fee market is then, so the minimum we quote leaves room for the rate
   * to rise before the HTLC becomes unclaimable.
   */
  minBtcFeeHeadroom: Number(envOpt("MIN_BTC_FEE_HEADROOM", "4")) || 4,
  minFbcDd: 1_000_000,
  quoteTtlMs: envInt("QUOTE_TTL_MS", 120_000),
  /**
   * How long an `accepted` swap reserves its FBC against our inventory.
   *
   * It has to reserve at all, or N concurrent accepts each see the whole
   * wallet and we promise FBC we do not have. It has to expire, or a taker
   * exhausts the book for free by accepting quotes and never funding. An
   * expired reservation is not a promise withdrawn — inventory is re-checked
   * immediately before the FBC HTLC is broadcast.
   */
  acceptReserveMs: envInt("ACCEPT_RESERVE_MS", 30 * 60_000),
  /**
   * How many accepted-but-unfunded swaps may hold reservations at once.
   *
   * Accepting costs a taker nothing on chain, yet reserves inventory for
   * `acceptReserveMs` and writes a permanent record. Unbounded, that lets
   * anyone hold the entire book by re-accepting on a timer, and grow mm.json
   * while doing it — which is fsynced on every accept and read whole at boot.
   *
   * This is a denial bound, not a theft bound: nothing here puts funds at
   * risk, and the cap trades "a griefer can lock the book" for "a griefer can
   * fill the queue". The second is strictly better because it self-heals in
   * `acceptReserveMs` and costs nothing to wait out.
   *
   * 12 is well above any honest concurrency this maker has seen — a busy hour
   * has been a handful of swaps — and low enough that filling it is visible in
   * the logs rather than silent.
   */
  maxUnfundedSwaps: envInt("MAX_UNFUNDED_SWAPS", 12),
  /**
   * SPEC §4.2: T1 (our counterparty's BTC refund) MUST open at least Δ AFTER
   * T2 (our own FBC refund). The taker funds first and holds the preimage, so
   * their refund has to be the last one available — otherwise they refund the
   * BTC and still claim our FBC, taking both legs.
   *
   * Do not "improve" these by giving the FBC leg the longer window. That is
   * the inverted ordering v1 shipped with and it is a total-loss bug for us.
   */
  btcRefundHours: envInt("BTC_REFUND_HOURS", 48),
  fbcRefundHours: envInt("FBC_REFUND_HOURS", 24),
  /** Δ floor in hours (SPEC §4.2). Offers below this are rejected. */
  minDeltaHours: envInt("MIN_DELTA_HOURS", 12),
  /**
   * Minimum FBC blocks between the tip and T2 (SPEC §4.3, and MIN_BLOCKS_TO_REFUND_FBC
   * in web/core). Must match the taker's rule or we fund swaps they cannot claim.
   */
  minFbcBlocksToRefund: envInt("MIN_FBC_BLOCKS_TO_REFUND", 60),
  /** Reject reference heights drifting further than this from our own tip (SPEC §4.3). */
  maxRefStalenessBtc: envInt("MAX_REF_STALENESS_BTC", 10),
  maxRefStalenessFbc: envInt("MAX_REF_STALENESS_FBC", 20),
  btcConfTarget,
  fbcConfTarget,
  /**
   * Burial depth before a swap is declared terminal and dropped from the
   * active set.
   *
   * A swap declared done at 1 confirmation leaves the active set forever, so a
   * 1-block reorg that evicts our claim is never noticed and never re-broadcast
   * — the taker refunds at T1 and we have already given up the FBC. Terminal
   * has to mean "deep enough that we will not have to act again".
   */
  claimBurialConfs: envInt("BTC_CLAIM_BURIAL_CONFS", btcConfTarget),
  refundBurialConfs: envInt("FBC_REFUND_BURIAL_CONFS", fbcConfTarget),
  /**
   * How far past T1 we keep trying to land a BTC claim before giving up.
   *
   * Past T1 the taker can refund at any moment, but our claim stays valid
   * until they actually do, so we keep bumping. The window bounds how long a
   * claim that can never confirm keeps us polling bitcoind every tick.
   */
  claimGiveUpBlocks: envInt("BTC_CLAIM_GIVE_UP_BLOCKS", 12),
  /** Fee rate (bumps/kvB) for our own FBC HTLC refund spends. */
  fbcFeeRate: envInt("FBC_FEE_RATE", 1_000),

  fbdRpcUrl: envOpt("FBD_RPC_URL", "http://127.0.0.1:32869"),
  fbdRpcPassword: resolveRpcPassword(),
  fbdWallet: envOpt("FBD_WALLET", "mm"),
  fbdWalletPassphrase: envOpt("FBD_WALLET_PASSPHRASE", ""),
  fbdNetwork: envOpt("FBD_NETWORK", "main") as "main" | "testnet" | "regtest",

  /**
   * Optional explicit WIF. Prefer omitting this and using Bitcoin Core wallet
   * (BTC_RPC_* + optional BTC_CLAIM_ADDRESS) so keys live on your node.
   */
  btcWif: envOpt("BTC_WIF", ""),
  btcNetwork: envOpt("BTC_NETWORK", "main") as "main" | "testnet" | "regtest",
  /** Claim destination; if empty and using Core, bot creates one via getnewaddress. */
  btcClaimAddress: envOpt("BTC_CLAIM_ADDRESS", ""),
  btcWalletPassphrase: envOpt("BTC_WALLET_PASSPHRASE", ""),

  /**
   * Bitcoin Core JSON-RPC — required for all BTC chain data, broadcast,
   * and claim-key loading. No public explorer/Esplora fallback.
   * Aliases: BTC_RPC_*.
   */
  bitcoinRpcUrl: envOpt("BITCOIN_RPC_URL", "") || envOpt("BTC_RPC_URL", ""),
  bitcoinRpcUser: envOpt("BITCOIN_RPC_USER", "") || envOpt("BTC_RPC_USER", ""),
  bitcoinRpcPassword:
    envOpt("BITCOIN_RPC_PASSWORD", "") || envOpt("BTC_RPC_PASSWORD", ""),
  bitcoinRpcCookie:
    envOpt("BITCOIN_RPC_COOKIE", "") || envOpt("BTC_RPC_COOKIE", ""),
  bitcoinRpcWallet:
    envOpt("BITCOIN_RPC_WALLET", "") || envOpt("BTC_RPC_WALLET", ""),

  /**
   * Set only when this bot sits behind a reverse proxy you control (Caddy,
   * Apache). Off by default: trusting X-Forwarded-For from anyone lets a
   * caller pick their own rate-limit bucket.
   */
  trustProxy: envOpt("TRUST_PROXY", "0") === "1",
  /** Per-IP token buckets. Writes touch upstream RPCs and disk, so they cost more. */
  rateLimitReadBurst: envInt("RATE_LIMIT_READ_BURST", 60),
  rateLimitReadPerSec: envInt("RATE_LIMIT_READ_PER_SEC", 5),
  rateLimitWriteBurst: envInt("RATE_LIMIT_WRITE_BURST", 10),
  rateLimitWritePerSec: envInt("RATE_LIMIT_WRITE_PER_SEC", 1),

  dataDir: resolve(process.cwd(), envOpt("DATA_DIR", "./data")),

  /**
   * Operator dashboard. Off unless a port is set.
   *
   * Bound to loopback by default: it shows wallet balances and sets the sell
   * price, so it must never share the public API's listener. An operator who
   * wants it from another machine points MM_ADMIN_BIND at a private-network
   * address (NetBird/Tailscale) or tunnels over SSH.
   */
  adminPort: envInt("MM_ADMIN_PORT", 0),
  adminBind: envOpt("MM_ADMIN_BIND", "127.0.0.1"),
  adminToken: envOpt("MM_ADMIN_TOKEN", ""),
  /**
   * Satoshis the dashboard will never let the operator withdraw.
   *
   * The BTC wallet pays claim fees. Emptying it does not cost the balance, it
   * costs every HTLC the bot then cannot claim — which is orders of magnitude
   * more. This is the floor; the live reserve also scales with swaps in flight.
   */
  btcWithdrawReserveSat: envInt("BTC_WITHDRAW_RESERVE_SAT", 20_000),

  btcBlockSeconds: 600,
  fbcBlockSeconds: 120,

  /** Public base URL of this bot (required to appear in the UI directory). */
  publicUrl: envOpt("PUBLIC_URL", ""),
  makerName: envOpt("MAKER_NAME", ""),
  registryUrl: envOpt("REGISTRY_URL", "https://swap.fistbump.org/api").replace(
    /\/+$/,
    "",
  ),
  announce: envOpt("ANNOUNCE", "1") !== "0",
  announceIntervalSec: envInt("ANNOUNCE_INTERVAL_SEC", 30),
  /**
   * Proof that we control PUBLIC_URL. We publish sha256(token) at /health and
   * send the token itself when announcing; the registry checks they agree, so
   * a stranger who reads our /health still cannot claim our URL.
   */
  announceToken: envOpt("ANNOUNCE_TOKEN", ""),
};

export type Config = typeof config;

/**
 * Refuse to start with a timelock configuration that would let takers steal.
 *
 * This is deliberately fatal rather than a warning: a maker running with the
 * inverted ordering loses its whole inventory to the first taker who notices,
 * and the failure is silent until it happens.
 */
function assertSafeTimelocks(c: Config): void {
  // Checked before the Δ comparison below, which it parameterises: at
  // MIN_DELTA_HOURS = 0 the guard accepts T1 == T2, and at a negative value it
  // accepts exactly the inverted ordering it exists to prevent. The floor is
  // SPEC §4.2's Δ and there is no configuration in which zero is meaningful.
  if (!Number.isFinite(c.minDeltaHours) || c.minDeltaHours <= 0) {
    throw new Error(
      `MIN_DELTA_HOURS must be positive (got ${c.minDeltaHours}); it is the Δ ` +
        `between the taker's BTC refund and ours, see SPEC §4.2`,
    );
  }
  const btcSeconds = c.btcRefundHours * 3600;
  const fbcSeconds = c.fbcRefundHours * 3600;
  const deltaHours = (btcSeconds - fbcSeconds) / 3600;
  if (deltaHours < c.minDeltaHours) {
    throw new Error(
      `unsafe timelock config: BTC_REFUND_HOURS (${c.btcRefundHours}) must exceed ` +
        `FBC_REFUND_HOURS (${c.fbcRefundHours}) by at least MIN_DELTA_HOURS ` +
        `(${c.minDeltaHours}); Δ is currently ${deltaHours}h. The taker funds BTC first ` +
        `and holds the preimage, so their refund must open last — see SPEC §4.2.`,
    );
  }
  if (c.fbcRefundHours <= 0 || c.btcRefundHours <= 0) {
    throw new Error("BTC_REFUND_HOURS and FBC_REFUND_HOURS must be positive");
  }
  if (c.spreadBps < 0 || c.spreadBps >= 10_000) {
    throw new Error(`SPREAD_BPS out of range: ${c.spreadBps}`);
  }
  if (!(c.maxFbc > 0) || !(c.minBtcSat > 0)) {
    throw new Error("MAX_FBC and MIN_BTC_SAT must be positive");
  }
  if (!(c.btcConfTarget >= 1) || !(c.fbcConfTarget >= 1)) {
    throw new Error("BTC_CONF_TARGET and FBC_CONF_TARGET must be at least 1");
  }
  // A burial depth of 0 would make a swap terminal before its spend is in a
  // block at all; 1 makes any reorg silent. Both defeat the point of waiting.
  if (!(c.claimBurialConfs >= 2) || !(c.refundBurialConfs >= 2)) {
    throw new Error(
      "BTC_CLAIM_BURIAL_CONFS and FBC_REFUND_BURIAL_CONFS must be at least 2 — " +
        "a swap declared terminal at one confirmation cannot survive a reorg",
    );
  }
  if (!(c.acceptReserveMs > 0) || !(c.minBtcFeeHeadroom >= 1)) {
    throw new Error("ACCEPT_RESERVE_MS must be positive and MIN_BTC_FEE_HEADROOM at least 1");
  }
}

function assertSecrets(c: Config): void {
  // Refuse rather than warn for this one: an announce token that is really a
  // shared constant defeats the credential entirely, and the failure is
  // silent — the bot lists successfully and looks perfectly healthy.
  if (c.announceToken && LOOKS_UNEXPANDED.test(c.announceToken)) {
    throw new Error(
      `ANNOUNCE_TOKEN is unexpanded shell syntax (${c.announceToken.slice(0, 32)}). ` +
        `.env values are literal — run "openssl rand -hex 16" and paste the output.`,
    );
  }
  if (c.announce && c.publicUrl && c.announceToken && c.announceToken.length < 16) {
    throw new Error("ANNOUNCE_TOKEN must be at least 16 characters");
  }
}

assertSafeTimelocks(config);
assertSecrets(config);

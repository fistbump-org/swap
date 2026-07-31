import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { config } from "./config.js";
import { publicError } from "./errors.js";
import type { MarketMaker } from "./mm.js";
import { isSide, type Side } from "./roles.js";
import type { FundedBtc, OfferBlob } from "./store.js";

/** Nothing this API accepts is anywhere near this large. */
const MAX_BODY_BYTES = 32 * 1024;
/**
 * Offers are persisted for the life of the swap, so they get a tighter cap
 * than the general one. What actually bounds the stored record is that
 * `acceptOffer` rebuilds the blob from named fields — this just stops us
 * parsing 32KB of JSON to throw most of it away.
 */
const MAX_OFFER_BYTES = 4 * 1024;
const BODY_TIMEOUT_MS = 10_000;

/**
 * A body we refused to read. Carried as a type rather than a message so the
 * handler can tell it apart from a validation error and close the connection
 * once the response is out.
 */
class BodyRejected extends Error {}

/**
 * The amount half of a quote request, split out so `parseQuoteAmountSat` takes
 * the narrow type. It has no business seeing `side`, and keeping them apart
 * means the amount tests do not have to construct a side they do not exercise.
 */
interface QuoteAmount {
  /** Whole BTC. Historical, and ambiguous against `Quote.amount_btc` (sats). */
  amount_btc?: number;
  /** Satoshis. Preferred: it cannot be confused with the response field. */
  amount_sat?: number;
  /** Legacy alias for `amount_btc`, same units. */
  amount_in?: number;
}

interface QuoteRequest extends QuoteAmount {
  /**
   * Required. It used to be optional, which meant an absent side silently
   * meant buy — fine while buy was the only side, and a trap the moment it is
   * not. A caller that does not say what it wants gets an error, not a guess.
   */
  side: Side;
}

/**
 * Resolve the requested side, or refuse.
 *
 * Exported so it can be tested without standing up a server: this is the
 * boundary where an arbitrary string becomes a `Side`, and the type system
 * stops helping on the other side of it.
 */
export function parseSide(raw: unknown): Side {
  if (typeof raw !== "string" || raw === "") {
    throw new Error("side is required (buy_fbc or sell_fbc)");
  }
  if (!isSide(raw)) {
    throw new Error(`unsupported side ${JSON.stringify(raw)}`);
  }
  return raw;
}

/**
 * A quote request in BTC this large is a units mistake, not an order.
 *
 * 1,000 BTC is tens of millions of dollars against an inventory capped at
 * MAX_FBC, so no honest caller sends it. What makes the guard worth having is
 * the *diagnosis*: without it, sats in the BTC field sail past every check and
 * die at the inventory cap with "exceeds max inventory quote", which sends the
 * integrator looking at liquidity instead of at their own units.
 */
const IMPLAUSIBLE_BTC = 1000;

/**
 * Resolve a quote request to satoshis.
 *
 * The wire keeps accepting BTC because the frontend and any deployed maker
 * client already send it; `amount_sat` is the unambiguous spelling for new
 * integrations. This is the only place the conversion happens — inside the
 * bot, every amount is sats.
 */
export function parseQuoteAmountSat(body: QuoteAmount): number {
  if (typeof body.amount_sat === "number") {
    if (!Number.isFinite(body.amount_sat) || body.amount_sat <= 0) {
      throw new Error("amount must be positive");
    }
    if (!Number.isInteger(body.amount_sat)) {
      throw new Error("amount_sat must be a whole number of satoshis");
    }
    return body.amount_sat;
  }
  const btc = typeof body.amount_btc === "number" ? body.amount_btc : body.amount_in;
  if (typeof btc !== "number" || !Number.isFinite(btc) || btc <= 0) {
    throw new Error("amount must be positive");
  }
  if (btc >= IMPLAUSIBLE_BTC) {
    throw new Error(
      `amount_btc is whole BTC, not satoshis — ${btc} BTC is implausible; ` +
        "use amount_sat for satoshis",
    );
  }
  return Math.round(btc * 1e8);
}

/**
 * Read a request body with a hard byte cap and a timeout.
 *
 * The unbounded version buffered whatever an unauthenticated caller chose to
 * send, on every POST handler, with no read deadline — a single slow request
 * could hold a socket open indefinitely and a large one could exhaust memory.
 *
 * On rejection the request is only *paused*, never destroyed here: destroying
 * it tears down the socket, and the 400 the handler then writes goes nowhere,
 * so an oversized chunked upload got no response at all. The handler responds
 * first and closes afterwards.
 */
function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyRejected("request body too large"));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.pause();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new BodyRejected("request body timed out")));
    }, BODY_TIMEOUT_MS);

    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        finish(() => reject(new BodyRejected("request body too large")));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", (err) => finish(() => reject(err)));
  });
}

/**
 * Per-IP token bucket.
 *
 * Every endpoint here is unauthenticated, and `/v1/quote` in particular fans
 * out to a price feed, bitcoind and fbd on each call. Cheap to abuse, so it
 * gets a budget.
 */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(
    private capacity: number,
    private refillPerSec: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, last: now };
    b.tokens = Math.min(
      this.capacity,
      b.tokens + ((now - b.last) / 1000) * this.refillPerSec,
    );
    b.last = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }

  /** Drop idle buckets so the map can't grow without bound. */
  prune() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, b] of this.buckets) if (b.last < cutoff) this.buckets.delete(k);
  }
}

function isLoopback(addr: string): boolean {
  return addr === "::1" || addr === "::ffff:127.0.0.1" || addr.startsWith("127.");
}

let warnedAboutProxy = false;

/**
 * The key a request is rate-limited under.
 *
 * A forwarding header is only meaningful from a proxy we run, so it is trusted
 * when TRUST_PROXY is set — or when the peer is loopback, which nothing off-box
 * can be. That second case is the shipped deployment: the Caddyfile reverse
 * proxies to 127.0.0.1, and with TRUST_PROXY off every client on the internet
 * shared the single "127.0.0.1" bucket. 5 req/s across the whole world starves
 * the maker, including takers delivering funded_btc, and it fails silently —
 * so it also gets logged the first time we see it.
 */
function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  return clientIpFor(req.socket.remoteAddress || "", Array.isArray(xff) ? xff[0] : xff);
}

/**
 * The rate-limit key, split out from the request so it can be tested directly.
 * See clientIp for why the rightmost X-Forwarded-For entry is the right one.
 */
export function clientIpFor(peer: string, first: string | undefined): string {

  if (first && !config.trustProxy && isLoopback(peer) && !warnedAboutProxy) {
    warnedAboutProxy = true;
    console.warn(
      "[api] X-Forwarded-For arriving from a loopback peer with TRUST_PROXY unset. " +
        "Treating the loopback proxy as trusted so rate limits apply per client " +
        "rather than to everyone at once — set TRUST_PROXY=1 to make this explicit, " +
        "or bind the bot directly if there is no proxy in front of it.",
    );
  }

  if (first && (config.trustProxy || isLoopback(peer))) {
    // The RIGHTMOST entry, not the leftmost.
    //
    // X-Forwarded-For grows left to right: each proxy appends the peer it saw.
    // So the last entry is the one OUR proxy wrote, and everything left of it
    // was supplied by the client and is worth nothing. Taking `[0]` let any
    // caller choose its own rate-limit bucket by sending a header — verified
    // against the live bot: twelve requests with a rotating forged value got
    // eleven 200s, while the same burst without the header got eleven 429s.
    //
    // Rightmost is also correct when the proxy REPLACES the header instead of
    // appending (`header_up X-Forwarded-For {remote_host}`), because then
    // there is exactly one entry. That belt-and-braces config is worth having,
    // but this must not depend on it.
    //
    // Only one proxy hop is assumed. Behind two, the rightmost is the inner
    // proxy and this needs to count back by the number of trusted hops.
    const hops = first.split(",");
    return hops[hops.length - 1]!.trim();
  }
  return peer || "unknown";
}

function send(res: ServerResponse, status: number, body: unknown, origin: string | undefined) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
  if (origin && config.corsOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse, origin?: string) {
  send(res, 404, { error: "not found" }, origin);
}


export function startApi(mm: MarketMaker) {
  // Reads are cheap; anything that costs us an upstream call or a disk write
  // gets a much tighter budget.
  const readLimiter = new RateLimiter(config.rateLimitReadBurst, config.rateLimitReadPerSec);
  const writeLimiter = new RateLimiter(config.rateLimitWriteBurst, config.rateLimitWritePerSec);
  const pruneTimer = setInterval(() => {
    readLimiter.prune();
    writeLimiter.prune();
  }, 60_000);
  pruneTimer.unref();

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      send(res, 204, {}, origin);
      return;
    }

    const ip = clientIp(req);
    const isWrite = req.method === "POST";

    // Requiring a JSON content type forces browsers to preflight any
    // cross-origin POST, so a hostile page cannot silently drive a bot bound
    // to localhost. Non-browser clients are unaffected.
    if (isWrite) {
      const ct = String(req.headers["content-type"] ?? "").split(";")[0]!.trim();
      if (ct !== "application/json") {
        send(res, 415, { error: "Content-Type: application/json required" }, origin);
        req.resume();
        return;
      }
      if (origin && !config.corsOrigins.includes(origin)) {
        send(res, 403, { error: "origin not allowed" }, origin);
        req.resume();
        return;
      }
    }
    if (!(isWrite ? writeLimiter : readLimiter).allow(ip)) {
      res.setHeader("Retry-After", "5");
      send(res, 429, { error: "rate limited" }, origin);
      req.resume();
      return;
    }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && path === "/health") {
        send(res, 200, { ok: true, ...mm.status() }, origin);
        return;
      }

      if (req.method === "GET" && path === "/v1/status") {
        send(res, 200, mm.status(), origin);
        return;
      }

      // Settled swaps, for anyone building price history that does not depend
      // on trusting this maker. Paged by `since` (a settled_at timestamp)
      // rather than an offset, because an offset shifts under a concurrent
      // write and a poller that skips a row loses that trade permanently.
      if (req.method === "GET" && path === "/v1/trades") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const trades = mm.listTrades({
          since: Number.isFinite(since) && since > 0 ? since : 0,
          limit: Number.isFinite(limit) ? limit : 100,
        });
        send(
          res,
          200,
          {
            trades,
            // The high-water mark to pass back as `since`. Taken from the last
            // row rather than "now": a swap that settles while this response is
            // in flight must not be skipped.
            next_since: trades.length ? trades[trades.length - 1]!.settled_at : since,
          },
          origin,
        );
        return;
      }

      // Separate route rather than a flag on /v1/trades. That feed is paged by
      // a cursor over immutable settled rows, and mixing mutable ones into it
      // would either replay them forever or advance the cursor past a row that
      // changed behind it. This one is a plain snapshot with no cursor at all.
      if (req.method === "GET" && path === "/v1/trades/pending") {
        const limit = Number(url.searchParams.get("limit") ?? 50);
        send(
          res,
          200,
          { pending: mm.listSettling({ limit: Number.isFinite(limit) ? limit : 50 }) },
          origin,
        );
        return;
      }

      if (req.method === "POST" && path === "/v1/quote") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as Partial<QuoteRequest>;
        // Side first, before any amount parsing. A sell-shaped request carries
        // its size in whole FBC, so parsing amounts first answers "side not
        // supported" with "amount must be positive" — a units error wearing a
        // side error's clothes, which is exactly how the old code behaved.
        const side = parseSide(body.side);
        const quote = await mm.getQuote(side, parseQuoteAmountSat(body));
        send(res, 200, quote, origin);
        return;
      }

      if (req.method === "POST" && path === "/v1/swaps") {
        const raw = await readBody(req, MAX_OFFER_BYTES);
        const body = JSON.parse(raw || "{}") as {
          quote_id?: string;
          offer?: OfferBlob;
        };
        if (!body.quote_id || !body.offer) {
          send(res, 400, { error: "quote_id and offer required" }, origin);
          return;
        }
        const result = await mm.acceptOffer(body.quote_id, body.offer);
        send(res, 200, result, origin);
        return;
      }

      // Swap ids go straight into an object lookup, so they are matched against
      // the shape we generate. `__proto__` or `constructor` in this position
      // would otherwise resolve to something on Object.prototype rather than
      // missing.
      //
      // 16-32 hex, not 32: ids are `s_` + randomId(16) now, but stores written
      // before that carry `s_` + the first 16 chars of an offer_id. Requiring
      // the current width made every pre-existing swap unreachable over the
      // API — including a taker trying to poll or fund one.
      const fundedMatch = path.match(/^\/v1\/swaps\/(s_[0-9a-f]{16,32})\/funded_btc$/);
      if (req.method === "POST" && fundedMatch) {
        const swapId = fundedMatch[1]!;
        const raw = await readBody(req);
        const funded = JSON.parse(raw || "{}") as FundedBtc;
        const swap = await mm.submitFundedBtc(swapId, funded);
        send(res, 200, swap, origin);
        return;
      }

      const swapMatch = path.match(/^\/v1\/swaps\/(s_[0-9a-f]{16,32})$/);
      if (req.method === "GET" && swapMatch) {
        const swap = mm.getSwapPublic(swapMatch[1]!);
        send(res, 200, swap, origin);
        return;
      }

      // Drain before responding: an unread body on a keep-alive connection
      // costs us the socket at best, and is a framing hazard at worst.
      if (isWrite) req.resume();
      notFound(res, origin);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Log the detail; return only what a counterparty legitimately needs.
      // Raw internal errors leak node topology, RPC wiring and balances.
      console.error("[api]", message);
      if (err instanceof BodyRejected) {
        send(
          res,
          /too large/.test(message) ? 413 : 408,
          { error: publicError(message) },
          origin,
        );
        // The rest of the body is still on its way and we will not be reading
        // it, so the connection has to go — but only once the response is out.
        res.once("finish", () => req.destroy());
        return;
      }
      send(res, 400, { error: publicError(message) }, origin);
    }
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[api] port ${config.port} already in use — stop the other process ` +
          `(lsof -i :${config.port}) or set PORT= in .env`,
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(config.port, config.host, () => {
    console.log(`[api] listening on http://${config.host}:${config.port}`);
  });

  return server;
}

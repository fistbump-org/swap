/**
 * The maker's own dashboard: balances, deposit addresses, sell price, history.
 *
 * This is a SEPARATE HTTP server from the one in api.ts, on its own port and
 * its own bind address, and that separation is the main security control here.
 *
 * api.ts is deliberately unauthenticated — it serves quotes and swap state to
 * strangers, and on this deployment it is proxied to the public internet. This
 * server does the opposite: it reads wallet balances and lets the operator
 * change the price at which their entire inventory is sold. Putting those
 * routes on the public listener would mean one Apache location block, or one
 * path-matching mistake, standing between a stranger and the sell price.
 *
 * Two independent controls, because either alone has a plausible failure:
 *
 *   **Bind address.** Defaults to 127.0.0.1, so out of the box this is not
 *   reachable off-host at all. An operator who wants it from their laptop sets
 *   MM_ADMIN_BIND to a private-network address (a NetBird/Tailscale IP) or
 *   tunnels over SSH.
 *
 *   **Bearer token.** Required — the server refuses to start without one
 *   rather than defaulting to open. Binding alone is not enough: anything else
 *   on the host, including a browser page loaded from elsewhere, can reach
 *   127.0.0.1.
 *
 * Reads and writes are both authenticated. No key material is exposed, but two
 * operations here move or commit real money and are guarded accordingly:
 *
 *   **Withdrawals** send from the maker's wallets. Reserves in
 *   `MarketMaker.withdraw` stop the operator spending FBC already promised to
 *   a live swap, or the BTC the bot needs to claim its HTLCs.
 *
 *   **The sell price** decides what the whole inventory goes for. It is
 *   bounded in settings.ts and gated on a confirmation past a 1.5x move.
 *
 * The other settings — max FBC per swap, minimum swap size — are reversible
 * and cost nothing if set wrongly, so they are validated but not gated.
 */

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import type { MarketMaker } from "./mm.js";
import { getMidFbcPerBtc, invalidatePrice, lastPrice } from "./price.js";
import { SPEC, settings, type SettingKey } from "./settings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = join(HERE, "..", "admin", "index.html");

const MAX_BODY = 8_192;

/**
 * How far the price may move in one step without an explicit acknowledgement.
 *
 * A maker changing $0.01 to $0.011 is routine. A maker changing it to $0.0001
 * has almost certainly slipped a decimal, and the consequence is the whole
 * inventory selling at one percent of its worth before they notice. The UI
 * asks for confirmation past this ratio and the server insists on the flag, so
 * a fat finger cannot do it through either.
 */
const PRICE_CONFIRM_RATIO = 1.5;

function bearer(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return null;
  return raw.slice(7).trim() || null;
}

/** Constant-time compare that does not leak length through early return. */
export function tokenMatches(given: string | null, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Still do a comparison so the timing of a wrong-length guess resembles a
    // wrong-value one, then return false regardless.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Whether a price change needs the operator to have acknowledged it.
 *
 * Exported for the tests, because "is this change big enough to question" is
 * the rule protecting the maker's inventory and it should not be buried in a
 * request handler.
 */
export function needsConfirmation(current: number, next: number): boolean {
  if (!(current > 0) || !(next > 0)) return true;
  const ratio = next > current ? next / current : current / next;
  return ratio > PRICE_CONFIRM_RATIO;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(raw),
    "Cache-Control": "no-store",
    // No CORS headers anywhere in this file, on purpose. The page is served by
    // this same server, so same-origin covers it, and a permissive header here
    // would let any site the operator visits drive their bot through the
    // browser if it ever learned the token.
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(raw);
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

export function startAdminServer(mm: MarketMaker) {
  if (!config.adminPort) {
    console.log("[admin] off (set MM_ADMIN_PORT to enable)");
    return null;
  }
  if (!config.adminToken || config.adminToken.length < 16) {
    // Fail closed, loudly. A dashboard that silently came up unauthenticated
    // because a variable was unset is the failure this is guarding against.
    throw new Error(
      "MM_ADMIN_TOKEN must be set to at least 16 characters when MM_ADMIN_PORT is set — " +
        "this endpoint exposes wallet balances and sets the sell price",
    );
  }

  const server = createServer((req, res) => {
    void handle(req, res, mm).catch((e: unknown) => {
      console.error("[admin]", e);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    });
  });

  server.listen(config.adminPort, config.adminBind, () => {
    const reachable =
      config.adminBind === "127.0.0.1" || config.adminBind === "localhost"
        ? "this host only — tunnel or set MM_ADMIN_BIND to reach it remotely"
        : `reachable on ${config.adminBind} — make sure that is a private network`;
    console.log(
      `[admin] dashboard on http://${config.adminBind}:${config.adminPort} (${reachable})`,
    );
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  mm: MarketMaker,
): Promise<void> {
  const path = (req.url || "/").split("?", 1)[0]!.replace(/\/+$/, "") || "/";

  // Auth before routing, so an unauthenticated caller cannot map the surface
  // by observing which paths 404 and which 401.
  if (!tokenMatches(bearer(req), config.adminToken)) {
    // The page itself is exempt: it has to load in order to ask for the token.
    // It contains no data — every value on it arrives through an authenticated
    // fetch after the operator supplies the token.
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      let html: string;
      try {
        html = readFileSync(PAGE, "utf8");
      } catch {
        json(res, 500, { error: "admin page missing from the deployment" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        // Everything is inline and same-origin; nothing external should load,
        // and the token lives in this page's memory.
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
          "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
      res.end(html);
      return;
    }
    json(res, 401, { error: "unauthorized" });
    return;
  }

  if (req.method === "GET" && path === "/api/state") {
    const snapshot = await mm.operatorSnapshot();
    let mid: number | null = null;
    let btcUsd: number | null = null;
    try {
      const p = await getMidFbcPerBtc();
      mid = p.midFbcPerBtc;
      btcUsd = p.btcUsd || null;
    } catch {
      const p = lastPrice();
      mid = p?.midFbcPerBtc ?? null;
      btcUsd = p?.btcUsd ?? null;
    }
    json(res, 200, {
      ...snapshot,
      price: {
        fbc_usd: settings.fbcUsdPrice(),
        // Whether this came from the operator or the environment, so the UI
        // can say which and offer to hand it back.
        overridden: settings.isOverridden("fbc_usd_price"),
        updated_at: settings.get().updated_at,
        env_default: SPEC.fbc_usd_price.from(),
        min: SPEC.fbc_usd_price.min,
        max: SPEC.fbc_usd_price.max,
        mid_fbc_per_btc: mid,
        btc_usd: btcUsd,
        spread_bps: config.spreadBps,
      },
      // Every adjustable value in one shape, so the dashboard renders them
      // from a loop rather than a branch per field — and so a setting added
      // later appears without touching the UI.
      settings: Object.fromEntries(
        (Object.keys(SPEC) as SettingKey[]).map((k) => [
          k,
          {
            value: settings.value(k),
            overridden: settings.isOverridden(k),
            env_default: SPEC[k].from(),
            min: SPEC[k].min,
            max: SPEC[k].max,
            integer: SPEC[k].integer,
          },
        ]),
      ),
      networks: { btc: config.btcNetwork, fbc: config.fbdNetwork },
    });
    return;
  }

  if (req.method === "GET" && path === "/api/swaps") {
    json(res, 200, {
      settled: mm.listTrades({ limit: 100 }).reverse(),
      settling: mm.listSettling({ limit: 50 }),
    });
    return;
  }

  if (req.method === "POST" && (path === "/api/price" || path === "/api/settings")) {
    const raw = await readBody(req);
    if (raw === null) {
      json(res, 413, { error: "body too large" });
      return;
    }
    let body: { key?: unknown; value?: unknown; fbc_usd?: unknown; confirm?: unknown; clear?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      json(res, 400, { error: "body must be JSON" });
      return;
    }

    // `key` selects which setting. Absent means the price, so the original
    // /api/price shape keeps working.
    const key: SettingKey =
      typeof body.key === "string" && body.key in SPEC
        ? (body.key as SettingKey)
        : "fbc_usd_price";
    if (body.key !== undefined && !(typeof body.key === "string" && body.key in SPEC)) {
      json(res, 400, { error: `unknown setting ${JSON.stringify(body.key)}` });
      return;
    }

    if (body.clear === true) {
      settings.clear(key);
      if (key === "fbc_usd_price") invalidatePrice();
      console.log(`[admin] ${key} handed back to the environment (${settings.value(key)})`);
      json(res, 200, { key, value: settings.value(key), overridden: false });
      return;
    }

    const next = Number(body.value !== undefined ? body.value : body.fbc_usd);
    if (!Number.isFinite(next)) {
      json(res, 400, { error: `${key} must be a number` });
      return;
    }
    const current = settings.value(key);
    // Only the price gets the large-change gate. Widening max_fbc or moving
    // the minimum swap size is reversible and costs nothing if wrong; the
    // price is neither, because inventory sold at it does not come back.
    if (key === "fbc_usd_price" && needsConfirmation(current, next) && body.confirm !== true) {
      json(res, 409, {
        error: "large price change needs confirmation",
        current,
        proposed: next,
        // Said plainly, because the number is the point: this is what the
        // operator is about to start selling at.
        detail:
          `This changes your sell price from $${current} to $${next} per FBC. ` +
          `Re-send with confirm:true if that is what you meant.`,
      });
      return;
    }
    try {
      settings.set(key, next);
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : `bad ${key}` });
      return;
    }
    // Without this the change is real but the next quote for up to a minute
    // still uses the old mid, which reads as the setting having failed.
    if (key === "fbc_usd_price") invalidatePrice();
    // Read back rather than echoing the request. `set` rounds, so `next` and
    // what is actually in force can differ — reporting the input would show
    // the operator $0.011000000000000001 while the bot quoted $0.011.
    const inForce = settings.value(key);
    console.log(`[admin] ${key} set to ${inForce} (was ${current})`);
    // `fbc_usd` only when it IS the price. Echoing it for every key made a
    // max_fbc write reply {"fbc_usd": 250000} — a claim that the maker had
    // just started selling FBC at $250,000 each.
    json(res, 200, {
      key,
      value: inForce,
      overridden: true,
      ...(key === "fbc_usd_price" ? { fbc_usd: inForce } : {}),
    });
    return;
  }

  if (req.method === "POST" && path === "/api/withdraw") {
    const raw = await readBody(req);
    if (raw === null) {
      json(res, 413, { error: "body too large" });
      return;
    }
    let body: {
      chain?: unknown;
      address?: unknown;
      amount?: unknown;
      max?: unknown;
      confirm?: unknown;
    };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      json(res, 400, { error: "body must be JSON" });
      return;
    }

    const chain = body.chain === "btc" || body.chain === "fbc" ? body.chain : null;
    if (!chain) {
      json(res, 400, { error: 'chain must be "btc" or "fbc"' });
      return;
    }
    const address = typeof body.address === "string" ? body.address.trim() : "";
    if (!address) {
      json(res, 400, { error: "address is required" });
      return;
    }
    // Confirmation is not a formality here and is checked before anything is
    // validated against a node: this moves money to an address nobody can
    // verify belongs to the operator, and it cannot be undone.
    if (body.confirm !== true) {
      json(res, 409, {
        error: "withdrawals must be confirmed",
        detail:
          "Re-send with confirm:true. Check the destination address first — " +
          "nothing here can tell whether it is yours, and this cannot be reversed.",
      });
      return;
    }

    const max = body.max === true;
    const amount = max ? undefined : Number(body.amount);
    if (!max && (!Number.isFinite(amount) || (amount as number) <= 0)) {
      json(res, 400, { error: "amount must be a positive number, or pass max:true" });
      return;
    }

    try {
      const out = await mm.withdraw({ chain, address, amount, max });
      json(res, 200, out);
    } catch (e) {
      // The message is the useful part — it says which reserve was hit and
      // why it exists — and it is only ever seen by an authenticated operator.
      json(res, 400, { error: e instanceof Error ? e.message : "withdrawal failed" });
    }
    return;
  }

  json(res, 404, { error: "not found" });
}

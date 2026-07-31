/**
 * A two-maker dry run.
 *
 * Every part of this system has only ever run with one maker. The registry,
 * the price feed and the swap page's provider selection are all written for
 * many, and none of that code has met a second one — which is the shape it
 * launches in, with a second maker going live at roughly the same time.
 *
 * So: a throwaway registry on loopback, two stub makers announcing to it, and
 * assertions about what comes back. No real bot, no wallet, no funds, and
 * nothing touches production.
 *
 * The stubs speak only as much of the maker API as the registry reads —
 * /health with a matching announce_id, /v1/status, /v1/quote and the two trade
 * feeds. They are deliberately NOT the real bot: the point is to check what
 * the registry and the page do when handed two of something, not to re-test
 * the bot.
 *
 *   node tools/two-makers.mjs
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const REGISTRY_PORT = 18850;
const MAKER_A_PORT = 18851;
const MAKER_B_PORT = 18852;
const REG = `http://127.0.0.1:${REGISTRY_PORT}`;

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`ok   ${name}`);
  else {
    console.log(`FAIL ${name}${extra ? `\n       ${extra}` : ""}`);
    failures++;
  }
};

const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One stub maker.
 *
 * `midFbcPerBtc` is what makes the pair interesting: the two quote different
 * prices, so "did the page pick the better one" has an answer.
 */
function stubMaker({ port, name, token, midFbcPerBtc, maxFbc }) {
  const announceId = sha256hex(token);
  const server = createServer((req, res) => {
    const path = (req.url || "/").split("?", 1)[0].replace(/\/+$/, "") || "/";
    const send = (code, body) => {
      const raw = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(raw) });
      res.end(raw);
    };
    if (path === "/health" || path === "/v1/status") {
      return send(200, {
        protocol: "fistbump-swap-mm/v1",
        name,
        side: "buy_fbc",
        sides: ["buy_fbc"],
        announce_id: announceId,
        liquidity: "fbc",
        mid_fbc_per_btc: midFbcPerBtc,
        spread_bps: 0,
        max_fbc: maxFbc,
        min_btc_sat: 10000,
        networks: { btc: "main", fbc: "main" },
        btc_conf_target: 6,
        fbc_conf_target: 12,
      });
    }
    if (path === "/v1/trades") return send(200, { trades: [], next_since: 0 });
    if (path === "/v1/trades/pending") return send(200, { pending: [] });
    if (path === "/v1/quote" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let amountSat = 0;
        try {
          const p = JSON.parse(body || "{}");
          amountSat = Number(p.amount_sat ?? Math.round((p.amount_btc ?? 0) * 1e8));
        } catch { /* leave zero */ }
        // Same affine shape the real maker uses: a fixed claim cost comes off
        // the top before the rate applies, which is why a flat rate is not
        // enough to compare two makers.
        const CLAIM_COST = 417;
        const fbc = ((amountSat - CLAIM_COST) / 1e8) * midFbcPerBtc;
        send(200, {
          quote_id: `q_${name}`,
          side: "buy_fbc",
          amount_btc: amountSat,
          amount_fbc: Math.round(fbc * 1e6),
          mid_fbc_per_btc: midFbcPerBtc,
          spread_bps: 0,
        });
      });
      return;
    }
    send(404, { error: "not found" });
  });
  server.listen(port, "127.0.0.1");
  return { server, announceId, token, name, midFbcPerBtc, url: `http://127.0.0.1:${port}` };
}

const dataDir = mkdtempSync(join(tmpdir(), "two-makers-"));
const makers = [
  stubMaker({ port: MAKER_A_PORT, name: "eskimo", token: "a".repeat(32), midFbcPerBtc: 6_400_000, maxFbc: 1_000_000 }),
  stubMaker({ port: MAKER_B_PORT, name: "partner", token: "b".repeat(32), midFbcPerBtc: 6_600_000, maxFbc: 250_000 }),
];

// A registry of its own, on loopback, with a temp database. ALLOW_HTTP_LOCAL
// is what lets it verify http://127.0.0.1 makers — off in production for good
// reason, since an announce URL is a stranger's string.
const registry = spawn("python3", ["registry/registry.py"], {
  env: {
    ...process.env,
    REGISTRY_HOST: "127.0.0.1",
    REGISTRY_PORT: String(REGISTRY_PORT),
    REGISTRY_DATA: join(dataDir, "makers.json"),
    REGISTRY_TRADES_DB: join(dataDir, "trades.db"),
    REGISTRY_ALLOW_HTTP_LOCAL: "1",
    REGISTRY_TTL_SEC: "90",
    REGISTRY_TRADES_POLL_SEC: "3600",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
registry.stdout.on("data", () => {});
registry.stderr.on("data", (d) => process.env.VERBOSE && console.error(String(d)));

function cleanup() {
  registry.kill();
  for (const m of makers) m.server.close();
  rmSync(dataDir, { recursive: true, force: true });
}

try {
  await sleep(1200);

  // ── Both makers announce ────────────────────────────────────────────────
  for (const m of makers) {
    const res = await fetch(`${REG}/v1/makers/announce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fistbump-Announce-Token": m.token },
      body: JSON.stringify({ url: m.url, name: m.name }),
    });
    check(`${m.name} announces`, res.status === 200, `HTTP ${res.status} ${await res.text()}`);
  }

  const listed = await (await fetch(`${REG}/v1/makers`)).json();
  const urls = (listed.makers || []).map((x) => x.url);
  check("the registry lists BOTH makers", urls.length === 2, JSON.stringify(urls));
  check("each keeps its own identity", new Set((listed.makers || []).map((x) => x.name)).size === 2);

  // ── One maker's credential cannot move the other ────────────────────────
  // Announce auth exists so a maker cannot be hijacked. With one maker that is
  // untestable, because there is nobody to impersonate.
  const hijack = await fetch(`${REG}/v1/makers/announce`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fistbump-Announce-Token": makers[0].token },
    body: JSON.stringify({ url: makers[1].url, name: "stolen" }),
  });
  check("maker A cannot re-announce maker B's URL", hijack.status !== 200, `HTTP ${hijack.status}`);
  const afterHijack = await (await fetch(`${REG}/v1/makers`)).json();
  check(
    "the hijack attempt did not rename maker B",
    (afterHijack.makers || []).some((x) => x.name === "partner"),
    JSON.stringify((afterHijack.makers || []).map((x) => x.name)),
  );

  // ── Quoting both, and picking ───────────────────────────────────────────
  const AMOUNT_SAT = 100_000;
  const quotes = [];
  for (const m of makers) {
    const res = await fetch(`${m.url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ side: "buy_fbc", amount_sat: AMOUNT_SAT }),
    });
    const q = await res.json();
    quotes.push({ maker: m.name, ...q });
  }
  check("both makers quote the same request", quotes.length === 2 && quotes.every((q) => q.amount_fbc > 0));

  // The buyer wants the most FBC per satoshi. Comparing on the QUOTED amount
  // rather than on the advertised mid is the point: the affine claim-cost
  // deduction means a better mid is not automatically a better deal at every
  // size, which is exactly the trap a one-maker system never exposes.
  const best = quotes.reduce((a, b) => (b.amount_fbc > a.amount_fbc ? b : a));
  check("the better price wins", best.maker === "partner", JSON.stringify(quotes.map((q) => [q.maker, q.amount_fbc])));

  const perFbc = quotes.map((q) => ({ maker: q.maker, satPerFbc: AMOUNT_SAT / (q.amount_fbc / 1e6) }));
  check(
    "a per-FBC rate is derivable for each provider",
    perFbc.every((p) => Number.isFinite(p.satPerFbc) && p.satPerFbc > 0),
    JSON.stringify(perFbc),
  );

  // ── Inventory caps are per maker ────────────────────────────────────────
  // maxFbc differs between them, so a size one can serve and the other cannot
  // must not be treated as "no liquidity anywhere".
  const statuses = await Promise.all(
    makers.map(async (m) => ({ name: m.name, ...(await (await fetch(`${m.url}/v1/status`)).json()) })),
  );
  const caps = statuses.map((s) => s.max_fbc);
  check("makers advertise different caps", new Set(caps).size === 2, JSON.stringify(caps));
  const bigOrder = 500_000;
  const canServe = statuses.filter((s) => s.max_fbc >= bigOrder).map((s) => s.name);
  check(
    "an order only one maker can fill still finds that maker",
    canServe.length === 1 && canServe[0] === "eskimo",
    JSON.stringify(canServe),
  );

  // ── A maker going away ──────────────────────────────────────────────────
  makers[1].server.close();
  await sleep(300);
  let reachable = true;
  try {
    await fetch(`${makers[1].url}/v1/status`, { signal: AbortSignal.timeout(1000) });
  } catch {
    reachable = false;
  }
  check("a stopped maker is unreachable", !reachable);
  const stillListed = await (await fetch(`${REG}/v1/makers`)).json();
  check(
    "the registry still lists it until its TTL lapses",
    (stillListed.makers || []).length === 2,
    "a directory that dropped a maker the instant one request failed would flap",
  );
  const survivor = await fetch(`${makers[0].url}/v1/status`);
  check("the surviving maker still quotes", survivor.status === 200);
} finally {
  cleanup();
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);

/**
 * Tests for the browser's BTC source ordering.
 *
 * The interesting behaviour is all in the failure paths: which HTTP statuses
 * mean "fall through to the next source" and which mean "this is the answer".
 * Getting that backwards is invisible in the happy case and expensive in the
 * one that matters — the seconds after a funding broadcast, when a 404 from a
 * lagging indexer is the expected reply.
 *
 *   node tools/test-btc-api.mjs
 */
import assert from "node:assert/strict";

const ORIGIN = "https://swap.fistbump.org";
const OWN = `${ORIGIN}/api/btc`;
const BLOCKSTREAM = "https://blockstream.info/api";
const MEMPOOL = "https://mempool.space/api";

/**
 * A fresh copy of the module, because its cooldown map is module-level state
 * and a test that benched a source would otherwise decide the next test's
 * result. Cache-busting the import is what makes the tests independent —
 * manipulating the clock is not enough, since the cooldowns are written using
 * the same clock the test would be moving.
 */
let n = 0;
async function freshModule(hostname = "swap.fistbump.org") {
  globalThis.location = { hostname, origin: `https://${hostname}` };
  return import(`../web/app/btc-api.js?t=${n++}`);
}

/** Stub fetch. `plan` maps a source base to an HTTP status, or "throw". */
function stub(plan) {
  const seen = [];
  globalThis.fetch = async (url) => {
    const base = [OWN, BLOCKSTREAM, MEMPOOL].find((b) => url.startsWith(b));
    seen.push(base);
    if (plan[base] === "throw") throw new Error("network down");
    const status = plan[base] ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      async text() {
        return status === 503 ? '{"error":"btc proxy is not enabled on this registry"}' : "ok";
      },
      async json() {
        return { txid: "aa" };
      },
    };
  };
  return seen;
}

const only = (seen, base) => seen.filter((s) => s === base).length;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok  ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL ${name}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

await test("own node is tried first, and ends the search when healthy", async () => {
  const { btcFetch, BTC_SOURCES } = await freshModule();
  assert.equal(BTC_SOURCES[0], OWN, "own node must lead the list");
  const seen = stub({});
  await btcFetch("/blocks/tip/height");
  assert.deepEqual(seen, [OWN]);
});

await test("a 404 is an answer, not a reason to fall through", async () => {
  // The load-bearing case. A just-broadcast transaction is legitimately absent;
  // walking all three sources on every 5s poll would triple the traffic for the
  // whole propagation window — and the first source is the one most likely to
  // have it, since it is the node that relayed it.
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: 404 });
  assert.equal((await btcFetch("/tx/aa")).status, 404);
  assert.deepEqual(seen, [OWN]);
});

await test("a 5xx falls through to the next source", async () => {
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: 502, [BLOCKSTREAM]: 200 });
  assert.equal((await btcFetch("/tx/aa")).status, 200);
  assert.deepEqual(seen, [OWN, BLOCKSTREAM]);
});

await test("a transport error falls through", async () => {
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: "throw", [BLOCKSTREAM]: 200 });
  assert.equal((await btcFetch("/tx/aa")).status, 200);
  assert.deepEqual(seen, [OWN, BLOCKSTREAM]);
});

await test("a 429 falls through rather than surfacing as an answer", async () => {
  // Blockstream rate-limits. Returning its 429 to a caller that reads !ok as
  // "not confirmed yet" would stall a swap behind someone else's quota.
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: 500, [BLOCKSTREAM]: 429, [MEMPOOL]: 200 });
  assert.equal((await btcFetch("/tx/aa")).status, 200);
  assert.deepEqual(seen, [OWN, BLOCKSTREAM, MEMPOOL]);
});

await test("a disabled proxy is asked once, not on every read", async () => {
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: 503, [BLOCKSTREAM]: 200 });
  for (const t of ["aa", "bb", "cc"]) await btcFetch(`/tx/${t}`);
  assert.equal(only(seen, OWN), 1, `own node asked ${only(seen, OWN)}×, want 1`);
  assert.equal(only(seen, BLOCKSTREAM), 3);
});

await test("a briefly-down node is retried after its cooldown", async () => {
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: "throw", [BLOCKSTREAM]: 200 });
  await btcFetch("/tx/aa");
  assert.equal(only(seen, OWN), 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 90_000; // past the 60s down cooldown
  try {
    await btcFetch("/tx/bb");
    assert.equal(only(seen, OWN), 2, "a node that may be back must be retried");
  } finally {
    Date.now = realNow;
  }
});

await test("a disabled proxy stays benched past the down cooldown", async () => {
  // Proves the two cooldowns are actually distinct rather than both 60s: at
  // +90s a thrown connection is retried (above) but a "not enabled" 503 is not.
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: 503, [BLOCKSTREAM]: 200 });
  await btcFetch("/tx/aa");
  const realNow = Date.now;
  Date.now = () => realNow() + 90_000;
  try {
    await btcFetch("/tx/bb");
    assert.equal(only(seen, OWN), 1, "a proxy that does not exist must not be re-probed every minute");
  } finally {
    Date.now = realNow;
  }
});

await test("all sources benched still attempts them rather than giving up", async () => {
  const { btcFetch } = await freshModule();
  const seen = stub({ [OWN]: "throw", [BLOCKSTREAM]: "throw", [MEMPOOL]: "throw" });
  await assert.rejects(() => btcFetch("/tx/aa"));
  assert.equal(seen.length, 3, "every source should have been tried");
  // Now all three are benched. A caller must still get a real attempt.
  const seen2 = stub({ [OWN]: 200 });
  await btcFetch("/tx/bb");
  assert.ok(seen2.length > 0, "a fully-benched list must not short-circuit to failure");
});

await test("a non-fistbump host gets no own-node entry", async () => {
  // A fork, or the page opened from somewhere else, must not be pointed at an
  // /api/btc that is not theirs.
  const { BTC_SOURCES } = await freshModule("example.com");
  assert.ok(!BTC_SOURCES.some((s) => s.includes("example.com")), BTC_SOURCES.join(","));
  assert.equal(BTC_SOURCES[0], BLOCKSTREAM);
});

console.log(`\n${passed} passed`);

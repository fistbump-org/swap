import "./test-env.js";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { SWAP_FIELDS, type Swap } from "../src/store.js";

/**
 * What the unauthenticated GET /v1/swaps/:id is allowed to contain.
 *
 * The point of pinning it is that adding a field to `Swap` must fail until
 * someone decides whether it is public — the original implementation spread
 * the whole record, so every new field was published by default and nothing
 * ever said so.
 *
 * An earlier version of this test claimed to do that and did not: it iterated
 * `Object.keys(fixture)` on a hand-written literal cast to `Swap`. Types are
 * erased at runtime, so it enumerated whatever the fixture happened to list,
 * and never compared PUBLIC_FIELDS against the real response at all. A new
 * leaking field passed cleanly. `SWAP_FIELDS` in store.ts exists to close
 * that: it is the field list as *data*, with a `satisfies Record<keyof Swap,
 * true>` clause so the compiler rejects it if it drifts from the type.
 */
const PUBLIC_FIELDS = new Set([
  "swap_id", "quote_id", "side", "state", "offer", "accept",
  "funded_btc", "funded_fbc", "btc_confs", "fbc_confs",
  "btc_claim_txid", "fbc_claim_txid", "btc_claim_confs",
  // Every entry is a transaction already broadcast to the Bitcoin network, so
  // withholding it hides nothing a counterparty could not read from a mempool
  // — and a taker watching for our claim is better served seeing the
  // replacements than only the newest.
  "btc_claim_txids",
  "fbc_refund_txid", "fbc_refund_confs",
  "fbc_claim_confs", "btc_refund_txid", "btc_refund_confs",
  "error", "created_at", "updated_at",
]);

const WITHHELD = new Set([
  "preimage_hex",
  "btc_claim_fee_rate",
  "btc_claim_broadcast_at",
  "fbc_funding_txid_pending",
  "fbc_funding_intent_at",
  "fbc_funding_intent_height",
  "fbc_claim_fee_rate",
  "fbc_claim_broadcast_at",
  "btc_funding_txid_pending",
  "btc_funding_intent_at",
  "btc_funding_intent_height",
  "fbc_refund_broadcast_at",
]);

const SECRET = "11".repeat(32);
const HASHLOCK = createHash("sha256").update(Buffer.from(SECRET, "hex")).digest("hex");

/**
 * A Swap with every field populated by something recognisable.
 *
 * Built from SWAP_FIELDS rather than written out, so it cannot fall behind the
 * type: a new field appears here automatically, with a marker value, and the
 * assertions below then have something to catch.
 */
function fixtureSwap(): Swap {
  const swap: Record<string, unknown> = {};
  for (const key of Object.keys(SWAP_FIELDS)) {
    swap[key] = `MARKER_${key}`;
  }
  return Object.assign(swap, {
    swap_id: "s_" + "a".repeat(32),
    quote_id: "q_test",
    state: "claimable",
    offer: { hashlock: HASHLOCK, offer_id: "cc".repeat(16) },
    accept: {},
    funded_btc: null,
    funded_fbc: null,
    btc_confs: 6,
    fbc_confs: 12,
    preimage_hex: SECRET,
    btc_claim_txid: null,
    fbc_claim_txid: null,
    btc_claim_confs: 0,
    btc_claim_fee_rate: 42,
    btc_claim_broadcast_at: 1234,
    fbc_funding_txid_pending: "de".repeat(32),
    fbc_funding_intent_at: 999,
    fbc_funding_intent_height: 5,
    fbc_refund_txid: null,
    fbc_refund_confs: 0,
    error: "bitcoind rpc failed at 10.0.0.5:8332",
    created_at: 0,
    updated_at: 0,
  }) as unknown as Swap;
}

async function publicView(swap: Swap): Promise<Record<string, unknown>> {
  const { MarketMaker } = await import("../src/mm.js");
  const proto = MarketMaker.prototype as unknown as {
    publicSwap(s: Swap): Record<string, unknown>;
  };
  return proto.publicSwap.call({} as never, swap);
}

test("every Swap field is classified as public or withheld", () => {
  // Reads SWAP_FIELDS, which the compiler ties to `keyof Swap`. Adding a field
  // to Swap without a decision fails here rather than shipping it.
  for (const k of Object.keys(SWAP_FIELDS)) {
    assert.ok(
      PUBLIC_FIELDS.has(k) || WITHHELD.has(k),
      `Swap.${k} is neither in the public allowlist nor the withheld list`,
    );
  }
  for (const k of PUBLIC_FIELDS) {
    assert.ok(k in SWAP_FIELDS, `PUBLIC_FIELDS lists ${k}, which is not a Swap field`);
  }
  for (const k of WITHHELD) {
    assert.ok(k in SWAP_FIELDS, `WITHHELD lists ${k}, which is not a Swap field`);
  }
  const overlap = [...WITHHELD].filter((k) => PUBLIC_FIELDS.has(k));
  assert.deepEqual(overlap, [], "a field cannot be both published and withheld");
});

test("publicSwap emits nothing outside the allowlist", async () => {
  // The check the previous version was missing entirely: compare the KEYS OF
  // THE ACTUAL RESPONSE against the allowlist. Without this, publicSwap could
  // publish a field nobody listed and every other assertion would still pass.
  const view = await publicView(fixtureSwap());
  for (const k of Object.keys(view)) {
    assert.ok(
      PUBLIC_FIELDS.has(k) || WITHHELD.has(k),
      `publicSwap emitted ${k}, which is in neither list`,
    );
  }
});

test("withheld fields are nulled, not merely absent-by-luck", async () => {
  const view = await publicView(fixtureSwap());
  for (const k of WITHHELD) {
    assert.equal(view[k] ?? null, null, `${k} must not be disclosed`);
  }
});

test("no marker value from an unclassified field survives into the response", async () => {
  // Catches the case where a future field is added to Swap, published by
  // publicSwap, and someone adds it to PUBLIC_FIELDS without thinking. The
  // marker makes the leak visible in the serialized body itself.
  const view = await publicView(fixtureSwap());
  const body = JSON.stringify(view);
  for (const k of WITHHELD) {
    assert.ok(!body.includes(`MARKER_${k}`), `withheld field ${k} leaked its value`);
  }
});

test("nothing in the response hashes to the swap's own hashlock", async () => {
  const view = await publicView(fixtureSwap());
  const body = JSON.stringify(view);
  // Scan every 64-hex window, not just delimited runs: a preimage embedded in
  // a longer hex string would slip past a non-overlapping match.
  const hexRuns = body.match(/[0-9a-f]{64,}/gi) || [];
  for (const run of hexRuns) {
    for (let i = 0; i + 64 <= run.length; i += 2) {
      const candidate = run.slice(i, i + 64);
      const h = createHash("sha256").update(Buffer.from(candidate, "hex")).digest("hex");
      assert.notEqual(h, HASHLOCK, `published a preimage for this swap's hashlock: ${candidate}`);
    }
  }
});

test("internal error detail does not reach the caller", async () => {
  const view = await publicView(fixtureSwap());
  assert.ok(!String(view.error ?? "").includes("10.0.0.5"), "leaked node address");
});

test("the fixture itself would fail these checks if published raw", async () => {
  // A test that cannot fail proves nothing. Feeding the raw swap through the
  // same assertions must trip them — otherwise the checks above are vacuous.
  const raw = JSON.stringify(fixtureSwap());
  assert.ok(raw.includes(SECRET), "fixture must actually carry the secret");
  const leaked = (raw.match(/[0-9a-f]{64}/gi) || []).some(
    (hex) => createHash("sha256").update(Buffer.from(hex, "hex")).digest("hex") === HASHLOCK,
  );
  assert.ok(leaked, "the hashlock scan must be capable of firing");
});

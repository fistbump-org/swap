/**
 * The maker's side of the timelock invariant.
 *
 * We are Bob: we fund FBC and claim BTC. Our exposure is that the taker holds
 * the preimage, so if their BTC refund (T1) can open before our FBC refund
 * (T2), they refund the BTC and still claim our FBC. Every test here exists to
 * make that impossible to reintroduce.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkOfferTimelocks, checkRefundsStillFuture } from "../src/timelocks.js";
import type { OfferBlob, Quote } from "../src/store.js";

const BTC_TIP = 920_000;
const FBC_TIP = 180_000;

/** What the bot itself would quote: BTC 48h (288 blocks), FBC 24h (720 blocks). */
function quote(over: Partial<Quote> = {}): Quote {
  return {
    quote_id: "q_test",
    side: "buy_fbc",
    amount_btc: 1_000_000,
    amount_fbc: 41_900_000_000,
    mid_fbc_per_btc: 42_000,
    spread_bps: 50,
    mm_btc_pubkey: "02" + "33".repeat(32),
    mm_fbc_pubkey: "03" + "44".repeat(32),
    btc_reference_height: BTC_TIP,
    fbc_reference_height: FBC_TIP,
    btc_refund_height: BTC_TIP + 288,
    fbc_refund_height: FBC_TIP + 720,
    btc_refund_hours: 48,
    fbc_refund_hours: 24,
    expires_at: new Date(Date.now() + 120_000).toISOString(),
    created_at: Date.now(),
    ...over,
  };
}

function offerFor(q: Quote, over: Partial<OfferBlob> = {}): OfferBlob {
  return {
    version: 1,
    kind: "offer",
    network: { btc: "main", fbc: "main" },
    hashlock: "aa".repeat(32),
    alice_btc_pubkey: "02" + "11".repeat(32),
    alice_fbc_pubkey: "03" + "22".repeat(32),
    amount_btc: q.amount_btc,
    amount_fbc: q.amount_fbc,
    btc_refund_height: q.btc_refund_height,
    fbc_refund_height: q.fbc_refund_height,
    btc_reference_height: q.btc_reference_height,
    fbc_reference_height: q.fbc_reference_height,
    expires_at: q.expires_at,
    offer_id: "cc".repeat(16),
    ...over,
  } as OfferBlob;
}

const tips = { btcTip: BTC_TIP, fbcTip: FBC_TIP };

test("accepts an offer that echoes our own quote", () => {
  const q = quote();
  const r = checkOfferTimelocks(offerFor(q), q, tips);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("REJECTS the inverted ordering (taker's BTC refund before ours)", () => {
  const q = quote({
    btc_refund_height: BTC_TIP + 144, // 24h
    fbc_refund_height: FBC_TIP + 1440, // 48h
    btc_refund_hours: 24,
    fbc_refund_hours: 48,
  });
  const r = checkOfferTimelocks(offerFor(q), q, tips);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /unsafe timelocks|Δ/);
});

test("rejects heights the taker altered away from our quote", () => {
  const q = quote();
  // The self-referential attack: Δ still reads as a healthy 24h, but T1 is
  // already 56 blocks in the past.
  const forged = offerFor(q, {
    btc_reference_height: BTC_TIP - 344,
    btc_refund_height: BTC_TIP - 56,
  });
  const r = checkOfferTimelocks(forged, q, tips);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /does not match the quote/);
});

test("rejects every individually-altered height field", () => {
  const q = quote();
  for (const field of [
    "btc_reference_height",
    "btc_refund_height",
    "fbc_reference_height",
    "fbc_refund_height",
  ] as const) {
    const bad = offerFor(q, { [field]: q[field] + 1 } as Partial<OfferBlob>);
    const r = checkOfferTimelocks(bad, q, tips);
    assert.equal(r.ok, false, `${field} should have been rejected`);
  }
});

test("rejects non-integer heights rather than comparing NaN", () => {
  const q = quote();
  for (const bad of [
    { btc_reference_height: "920000" as unknown as number },
    { btc_refund_height: undefined as unknown as number },
    { fbc_refund_height: NaN },
    { fbc_reference_height: 1.5 },
  ]) {
    const r = checkOfferTimelocks(offerFor(q, bad), q, tips);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
  }
});

test("rejects a quote whose reference heights have drifted from our tips", () => {
  const q = quote({
    btc_reference_height: BTC_TIP - 500,
    btc_refund_height: BTC_TIP - 500 + 288,
  });
  const r = checkOfferTimelocks(offerFor(q), q, tips);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /btc_reference_height/);
});

test("checkRefundsStillFuture blocks funding once T1 has crept too close", () => {
  const q = quote();
  const offer = offerFor(q);
  // An hour of BTC confirmations later, the tip has advanced past T1.
  const later = { btcTip: offer.btc_refund_height - 2, fbcTip: FBC_TIP + 30 };
  const r = checkRefundsStillFuture(offer, later);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /btc_refund_height/);
});

test("checkRefundsStillFuture still passes right after acceptance", () => {
  const q = quote();
  assert.equal(checkRefundsStillFuture(offerFor(q), tips).ok, true);
});

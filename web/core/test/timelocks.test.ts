// Timelock-ordering tests.
//
// These exist because the ordering was enforced BACKWARDS for the whole of v1
// (SPEC.md §11.6): the code required T2 > T1, which hands Alice the window
// [T1, T2) in which she can refund her BTC and still claim the FBC. The
// direction of this inequality is the single security-critical invariant in
// the protocol, so it is tested in both directions and at the boundary.
//
// Naming: T1 = Alice's BTC refund height, T2 = Bob's FBC refund height.
// Required: T1 - T2 >= DELTA (in wall-clock seconds), i.e. Alice refunds LAST.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkTimelocks, htlcsFromOfferAccept } from "../src/offer.js";
import { MIN_DELTA_SECONDS } from "../src/offer.js";
import type { AcceptBlob, OfferBlob } from "../src/types.js";

const BTC_TIP = 860_000;
const FBC_TIP = 709_000;

/** 288 BTC blocks = 48h; 720 FBC blocks = 24h; Δ = 24h. The SPEC §4.2 default. */
function goodOffer(over: Partial<OfferBlob> = {}): OfferBlob {
  return {
    version: 1,
    kind: "offer",
    network: { btc: "main", fbc: "main" },
    hashlock: "aa".repeat(32),
    alice_btc_pubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    alice_fbc_pubkey: "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5",
    amount_btc: 1_000_000,
    amount_fbc: 41_900_000_000,
    btc_reference_height: BTC_TIP,
    btc_refund_height: BTC_TIP + 288,
    fbc_reference_height: FBC_TIP,
    fbc_refund_height: FBC_TIP + 720,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    offer_id: "cc".repeat(16),
    ...over,
  } as OfferBlob;
}

function accept(offer: OfferBlob): AcceptBlob {
  return {
    version: 1,
    kind: "accept",
    offer_id: offer.offer_id,
    bob_btc_pubkey: "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
    bob_fbc_pubkey: "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13",
  } as AcceptBlob;
}

const observed = { btcTip: BTC_TIP, fbcTip: FBC_TIP };

test("accepts the SPEC §4.2 default ordering (BTC 48h, FBC 24h)", () => {
  const r = checkTimelocks(goodOffer(), observed);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
});

test("REJECTS the inverted ordering that v1 used to require (BTC 24h, FBC 48h)", () => {
  // This is the exact shape the old code accepted and the new code must not.
  const bad = goodOffer({
    btc_refund_height: BTC_TIP + 144, // 24h
    fbc_refund_height: FBC_TIP + 1440, // 48h
  });
  const r = checkTimelocks(bad, observed);
  assert.equal(r.ok, false);
  // Match the ordering message specifically. Both heights here are also fine
  // against the observed tips, so a rejection carrying any other reason would
  // mean the ordering rule is not what caught it.
  assert.match((r as { reason: string }).reason, /must fall at least .* after the FBC refund/);
});

test("rejects Δ below the 12h floor even when the ordering is correct", () => {
  // BTC 24h05m, FBC 24h → correct direction, but only 5 minutes of buffer.
  const thin = goodOffer({
    btc_refund_height: BTC_TIP + 145,
    fbc_refund_height: FBC_TIP + 720,
  });
  const r = checkTimelocks(thin, observed);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /Δ/);
});

test("Δ boundary: exactly MIN_DELTA_SECONDS passes, one block under fails", () => {
  // FBC at 24h; BTC set so that Δ lands exactly on the floor.
  const fbcSeconds = 720 * 120;
  const btcBlocks = (fbcSeconds + MIN_DELTA_SECONDS) / 600;
  assert.ok(Number.isInteger(btcBlocks), "test fixture should land on a whole block");

  const exact = goodOffer({
    btc_refund_height: BTC_TIP + btcBlocks,
    fbc_refund_height: FBC_TIP + 720,
  });
  assert.equal(checkTimelocks(exact, observed).ok, true);

  const under = goodOffer({
    btc_refund_height: BTC_TIP + btcBlocks - 1,
    fbc_refund_height: FBC_TIP + 720,
  });
  const r = checkTimelocks(under, observed);
  assert.equal(r.ok, false);
  // One block under the floor is a Δ failure and nothing else; without this the
  // boundary would still "hold" if some unrelated rule started rejecting both
  // sides of it.
  assert.match((r as { reason: string }).reason, /must fall at least .* after the FBC refund/);
});

test("rejects a T1 in the past by catching the stale reference height it hides behind", () => {
  // The self-referential attack: reference heights are attacker-supplied, so the
  // relative Δ reads as a healthy 48h/24h while T1 sits 56 blocks behind the tip.
  const forged = goodOffer({
    btc_reference_height: BTC_TIP - 344,
    btc_refund_height: BTC_TIP - 56,
    fbc_reference_height: FBC_TIP,
    fbc_refund_height: FBC_TIP + 720,
  });
  // Relative check alone is satisfied...
  assert.equal(checkTimelocks(forged).ok, true, "fixture must pass the relative-only check");
  // ...but not once real tips are supplied.
  const r = checkTimelocks(forged, observed);
  assert.equal(r.ok, false);
  // Pin WHICH rule rejects it. Putting T1 in the past requires dragging
  // btc_reference_height back with it (otherwise Δ collapses and layer 1 fires),
  // so this fixture is stopped by the staleness rule, NOT by the absolute
  // "btc_refund_height is nearly live" rule the old test name advertised.
  // The old assertion matched either message, so deleting either rule left the
  // test green — the surviving one fired and still matched. Only deleting both
  // was detected, which is the least useful moment to find out.
  assert.match(
    (r as { reason: string }).reason,
    /btc_reference_height \d+ is \d+ blocks behind the observed tip/,
  );
});

// The absolute floor on the FBC side is the one an offer can trip on its own,
// and nothing else in `checkTimelocks` constrains it: Δ bounds T2 from ABOVE
// (a later T2 shrinks Δ), so without this floor a maker could quote a T2 an
// hour out and the taker would accept it, then reveal the preimage into a live
// refund branch and lose the leg. Its BTC counterpart cannot be reached the
// same way — see the note below.
test("rejects a T2 inside the 60-block claim floor even with a fresh reference height", () => {
  const tooSoon = goodOffer({ fbc_refund_height: FBC_TIP + 30 }); // 1h out
  // Nothing relative is wrong with it: Δ is 47h and T2 is above its reference.
  assert.equal(checkTimelocks(tooSoon).ok, true, "fixture must pass the relative-only check");
  const r = checkTimelocks(tooSoon, observed);
  assert.equal(r.ok, false);
  assert.match(
    (r as { reason: string }).reason,
    /fbc_refund_height \d+ is already live or nearly live/,
  );
});

test("the 60-block FBC floor is exact: 59 fails, 60 passes", () => {
  assert.equal(checkTimelocks(goodOffer({ fbc_refund_height: FBC_TIP + 59 }), observed).ok, false);
  assert.equal(checkTimelocks(goodOffer({ fbc_refund_height: FBC_TIP + 60 }), observed).ok, true);
});

// NOTE on the BTC absolute floor (`MIN_BLOCKS_TO_REFUND_BTC`, 12 blocks): no
// offer can be built that trips it and nothing else, so there is deliberately
// no test claiming to cover it. Reaching it needs |btc_ref − btcTip| ≤ 10 and
// Δ ≥ 12h, and Δ ≥ 12h already forces T1 ≥ btc_ref + 73 ≥ btcTip + 63, which is
// far above btcTip + 12. It becomes reachable only if MAX_REF_STALENESS_BTC is
// ever raised past ~61 blocks. Writing a "T1 already live" test today would
// produce one that passes on the staleness message instead — which is exactly
// how the test above got its misleading name.

test("rejects reference heights that run ahead of the observed tip", () => {
  const ahead = goodOffer({
    btc_reference_height: BTC_TIP + 500,
    btc_refund_height: BTC_TIP + 500 + 288,
  });
  const r = checkTimelocks(ahead, observed);
  assert.equal(r.ok, false);
  // A reference height in the future is not "merely stale": it is how you make
  // a refund height look far away. The message must name that, or this test
  // would also pass on a Δ rejection.
  assert.match(
    (r as { reason: string }).reason,
    /btc_reference_height \d+ is \d+ blocks ahead of the observed tip/,
  );
});

test("rejects refund heights absurdly far in the future", () => {
  const forever = goodOffer({ btc_refund_height: BTC_TIP + 200_000 });
  const r = checkTimelocks(forever, observed);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /too far|days/i);
});

test("rejects non-integer and missing heights instead of computing NaN", () => {
  // `NaN <= x` is false, so a NaN silently skipped the old check entirely.
  //
  // Every fixture here is otherwise a *valid* offer, and the reason is matched,
  // so each case can only pass by way of the height-type guard. The fractional
  // case used to be `fbc_refund_height: 1.5` — an absolute height below its own
  // reference, which layer 1 rejects as "refund below reference" all on its own.
  // It would have kept passing with the type guard deleted.
  for (const bad of [
    { btc_reference_height: "860000" as unknown as number },
    { btc_refund_height: undefined as unknown as number },
    { fbc_refund_height: FBC_TIP + 720.5 },
    { fbc_reference_height: NaN },
  ]) {
    const r = checkTimelocks(goodOffer(bad), observed);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(bad)}`);
    assert.match(
      (r as { reason: string }).reason,
      /is not a valid block height/,
      `wrong rejection reason for ${JSON.stringify(bad)}`,
    );
  }
});

test("htlcsFromOfferAccept refuses to build scripts for an inverted offer", () => {
  const bad = goodOffer({
    btc_refund_height: BTC_TIP + 144,
    fbc_refund_height: FBC_TIP + 1440,
  });
  // No tips passed: the point is that even the relative-only path refuses to
  // hand back scripts for an inverted offer. `/Δ|refund/i` matched almost every
  // rejection message in this module, including ones that have nothing to do
  // with the ordering.
  assert.throws(
    () => htlcsFromOfferAccept(bad, accept(bad)),
    /must fall at least .* after the FBC refund/,
  );
  // And with tips, where the absolute layer also runs.
  assert.throws(
    () => htlcsFromOfferAccept(bad, accept(bad), observed),
    /must fall at least .* after the FBC refund/,
  );
});

test("htlcsFromOfferAccept assigns each leg the right locktime and roles", () => {
  const offer = goodOffer();
  const acc = accept(offer);
  const { btc, fbc } = htlcsFromOfferAccept(offer, acc, observed);

  assert.equal(btc.locktime, offer.btc_refund_height, "BTC leg carries T1");
  assert.equal(fbc.locktime, offer.fbc_refund_height, "FBC leg carries T2");

  const hex = (b: Uint8Array) =>
    Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  // Alice knows the preimage: she claims FBC and refunds BTC.
  assert.equal(hex(btc.refundPubkey), offer.alice_btc_pubkey);
  assert.equal(hex(fbc.claimPubkey), offer.alice_fbc_pubkey);
  // Bob claims BTC with the revealed preimage and refunds FBC.
  assert.equal(hex(btc.claimPubkey), acc.bob_btc_pubkey);
  assert.equal(hex(fbc.refundPubkey), acc.bob_fbc_pubkey);
});

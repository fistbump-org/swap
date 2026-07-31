/**
 * Role assignment per market side.
 *
 * Roughly half of every serious bug found in this codebase came from "who is
 * Alice here" going wrong at a boundary, so the mapping is pinned rather than
 * left to be re-derived at each call site.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LONGER_TIMELOCK_CHAIN,
  makerCarriesFirstMoverRisk,
  rolesFor,
  type Side, makerActionLabel} from "../src/roles.js";

const SIDES: Side[] = ["buy_fbc", "sell_fbc"];

test("buy_fbc: the taker is Alice, the maker supplies FBC", () => {
  const r = rolesFor("buy_fbc");
  assert.equal(r.aliceIs, "taker");
  assert.equal(r.bobIs, "maker");
  assert.equal(r.makerFunds, "fbc");
  assert.equal(r.makerClaims, "btc");
  assert.equal(r.makerHoldsPreimage, false);
  assert.equal(r.makerFundsFirst, false);
});

test("sell_fbc: the maker is Alice, and therefore moves first and holds the secret", () => {
  const r = rolesFor("sell_fbc");
  assert.equal(r.aliceIs, "maker");
  assert.equal(r.bobIs, "taker");
  assert.equal(r.makerFunds, "btc");
  assert.equal(r.makerClaims, "fbc");
  assert.equal(r.makerHoldsPreimage, true);
  assert.equal(r.makerFundsFirst, true);
});

test("Alice and Bob are always different parties", () => {
  for (const side of SIDES) {
    const r = rolesFor(side);
    assert.notEqual(r.aliceIs, r.bobIs, `${side}: one party cannot be both`);
  }
});

test("the maker never funds and claims the same chain", () => {
  // Funding and claiming the same chain would mean it is not a swap.
  for (const side of SIDES) {
    const r = rolesFor(side);
    assert.notEqual(r.makerFunds, r.makerClaims, side);
  }
});

test("whoever is Alice holds the preimage and funds first", () => {
  // This is the property the timelock ordering depends on. If it ever stops
  // holding, LONGER_TIMELOCK_CHAIN is wrong and every quote is unsafe.
  for (const side of SIDES) {
    const r = rolesFor(side);
    const makerIsAlice = r.aliceIs === "maker";
    assert.equal(
      r.makerHoldsPreimage,
      makerIsAlice,
      `${side}: the preimage holder must be Alice`,
    );
    assert.equal(
      r.makerFundsFirst,
      makerIsAlice,
      `${side}: the first funder must be Alice`,
    );
  }
});

test("Alice always funds BTC, which is why BTC always carries the longer lock", () => {
  for (const side of SIDES) {
    const r = rolesFor(side);
    const aliceFunds = r.aliceIs === "maker" ? r.makerFunds : r.makerClaims;
    assert.equal(aliceFunds, "btc", `${side}: SPEC defines Alice as holding BTC`);
  }
  assert.equal(LONGER_TIMELOCK_CHAIN, "btc");
});

test("only the sell side exposes this maker to first-mover risk", () => {
  assert.equal(makerCarriesFirstMoverRisk("buy_fbc"), false);
  assert.equal(makerCarriesFirstMoverRisk("sell_fbc"), true);
});

test("the maker's label is the inverse of the taker's side", () => {
  // Side is taker-relative: buy_fbc means the TAKER bought. On the maker's own
  // dashboard that read as though the maker had bought its own inventory.
  assert.equal(makerActionLabel("buy_fbc"), "sold FBC");
  assert.equal(makerActionLabel("sell_fbc"), "bought FBC");
});

test("every side has a maker label", () => {
  // So adding a third side cannot leave a row on the dashboard blank.
  for (const side of SIDES) {
    assert.match(makerActionLabel(side), /^(sold|bought) FBC$/, side);
  }
});

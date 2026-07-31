/**
 * Whether an on-chain output pays what a swap promised.
 *
 * This check used to be a boolean derived from a helper that returned
 * `undefined` for "wrong" and `null` for "could not read", collapsed with
 * `!== undefined`. So a node that reported no value at all passed as if the
 * amount had been confirmed — a check that succeeds when it could not run.
 *
 * It also carried a second branch accepting `Math.round(value * 1e6) ===
 * expected`, meant to cope with fbd reporting whole FBC. fbd reports bumps
 * (verified against the live node: a 639.2658 FBC output reads as 639265800),
 * so the branch never fired for its intended purpose — and it made a value one
 * millionth of the right size pass as correct.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkAmount } from "../src/mm.js";

const EXPECTED = 636_557_050; // the real stranded swap's FBC leg, in bumps

test("the exact amount matches", () => {
  assert.equal(checkAmount(EXPECTED, EXPECTED), "match");
});

test("a different amount is a mismatch, in either direction", () => {
  assert.equal(checkAmount(EXPECTED - 1, EXPECTED), "mismatch");
  assert.equal(checkAmount(EXPECTED + 1, EXPECTED), "mismatch");
  assert.equal(checkAmount(1, EXPECTED), "mismatch");
});

test("an amount one millionth of the expected is a MISMATCH, not a match", () => {
  // The bug: 636.55705 bumps is dust — a millionth of what was promised — and
  // the old `* 1e6` reconciliation accepted it as correct. Harmless while both
  // call sites inspect our own funding; a hole against a counterparty's.
  assert.equal(checkAmount(EXPECTED / 1e6, EXPECTED), "mismatch");
  assert.equal(checkAmount(636.55705, 636_557_050), "mismatch");
});

test("an unreadable value is its own answer, never a pass", () => {
  // The other half. These must not be indistinguishable from "match".
  for (const v of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      checkAmount(v as number | null, EXPECTED),
      "unreadable",
      `${String(v)} must read as unreadable`,
    );
  }
});

test("zero is a mismatch, not unreadable", () => {
  // An output that genuinely pays nothing is a readable, wrong answer. Treating
  // it as unverifiable would route it into the tolerant branch.
  assert.equal(checkAmount(0, EXPECTED), "mismatch");
});

test("the three outcomes are distinct", () => {
  const seen = new Set([
    checkAmount(EXPECTED, EXPECTED),
    checkAmount(EXPECTED + 1, EXPECTED),
    checkAmount(null, EXPECTED),
  ]);
  assert.equal(seen.size, 3, "match, mismatch and unreadable must not collapse");
});

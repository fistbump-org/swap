/**
 * Quote request units.
 *
 * `amount_btc` means whole BTC on the request and satoshis on the response —
 * one identifier, two units, one round-trip. Both existing call sites convert
 * correctly, so this has never mis-priced anything; what it does is turn a
 * caller's units mistake into "exceeds max inventory quote", which points at
 * liquidity instead of at the units. These tests pin the conversion and the
 * diagnosis so neither can drift back.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseQuoteAmountSat, parseSide } from "../src/api.js";
import { publicError } from "../src/errors.js";

test("amount_btc is interpreted as whole BTC", () => {
  assert.equal(parseQuoteAmountSat({ amount_btc: 0.0001 }), 10_000);
  assert.equal(parseQuoteAmountSat({ amount_btc: 0.15 }), 15_000_000);
  assert.equal(parseQuoteAmountSat({ amount_btc: 1 }), 100_000_000);
});

test("amount_sat is taken as satoshis, unconverted", () => {
  assert.equal(parseQuoteAmountSat({ amount_sat: 10_000 }), 10_000);
  assert.equal(parseQuoteAmountSat({ amount_sat: 15_000_000 }), 15_000_000);
});

test("amount_sat wins when both are sent", () => {
  // Disagreeing fields mean the caller is confused; the unambiguous one is the
  // one to believe.
  assert.equal(parseQuoteAmountSat({ amount_sat: 10_000, amount_btc: 5 }), 10_000);
});

test("amount_in remains a BTC-denominated alias", () => {
  assert.equal(parseQuoteAmountSat({ amount_in: 0.0001 }), 10_000);
});

test("satoshis in the BTC field are rejected with a units message", () => {
  // The exact bug: 10000 meaning sats, read as 10000 BTC. Before the guard
  // this priced out to ~64 billion FBC and failed at the inventory cap.
  assert.throws(
    () => parseQuoteAmountSat({ amount_btc: 10_000 }),
    (err: Error) => {
      assert.match(err.message, /whole BTC, not satoshis/);
      assert.match(err.message, /amount_sat/, "must name the right field to use");
      return true;
    },
  );
});

test("the units message survives public error filtering", () => {
  // A diagnostic nobody can read is not a diagnostic. It echoes only the
  // number the caller sent, so there is nothing to withhold.
  let message = "";
  try {
    parseQuoteAmountSat({ amount_btc: 10_000 });
  } catch (err) {
    message = (err as Error).message;
  }
  assert.equal(publicError(message), message);
});

test("real quote sizes stay under the implausibility guard", () => {
  // The guard must never reject a size the bot would actually quote. The
  // inventory cap tops out far below this, but a maker raising MAX_FBC should
  // hit the cap, not a units error.
  for (const btc of [0.0001, 0.001, 0.15, 1, 10, 999]) {
    assert.equal(parseQuoteAmountSat({ amount_btc: btc }), Math.round(btc * 1e8));
  }
});

test("non-positive and non-finite amounts are refused in both units", () => {
  for (const body of [
    { amount_btc: 0 },
    { amount_btc: -1 },
    { amount_btc: Number.NaN },
    { amount_btc: Number.POSITIVE_INFINITY },
    { amount_sat: 0 },
    { amount_sat: -10_000 },
    { amount_sat: Number.NaN },
    {},
  ]) {
    assert.throws(() => parseQuoteAmountSat(body), /amount must be positive/, JSON.stringify(body));
  }
});

test("fractional satoshis are refused rather than silently rounded", () => {
  // Rounding here would quote an amount the caller did not ask for, and the
  // offer must match the quote exactly or acceptOffer rejects it.
  assert.throws(
    () => parseQuoteAmountSat({ amount_sat: 10_000.5 }),
    /whole number of satoshis/,
  );
});

// ── Side ─────────────────────────────────────────────────────────────────

test("a known side parses to itself", () => {
  assert.equal(parseSide("buy_fbc"), "buy_fbc");
  // sell_fbc parses at the boundary even though the maker refuses to quote it.
  // Those are different layers: the wire knows the side exists, getQuote
  // decides whether this maker serves it, and conflating them produces
  // "unsupported side" for a typo and "side is required" for a real side.
  assert.equal(parseSide("sell_fbc"), "sell_fbc");
});

test("an absent side is refused rather than defaulted to buy", () => {
  // The whole point of the change. It used to be optional, so silence meant
  // buy — harmless with one side, a wrong-chain spend with two.
  for (const raw of [undefined, null, "", 0, false]) {
    assert.throws(() => parseSide(raw), /side is required/, JSON.stringify(raw));
  }
});

test("a side we do not know is refused, and named back", () => {
  for (const raw of ["buy", "BUY_FBC", "sell", "buy_fbc ", "fbc", 123, {}, ["buy_fbc"]]) {
    assert.throws(() => parseSide(raw), /unsupported side|side is required/, JSON.stringify(raw));
  }
  // Case and whitespace are not normalised on purpose: a caller sending
  // "BUY_FBC" has a bug, and quietly accepting it hides it.
  assert.throws(() => parseSide("BUY_FBC"), /unsupported side/);
});

test("both side messages survive public error filtering", () => {
  // The test that catches a forgotten errors.ts edit. Without the allowlist
  // entries these 400s collapse to "request could not be processed", and an
  // integrator cannot tell a side problem from a units problem — which is the
  // failure mode the units guard was added to fix in the first place.
  for (const raw of [undefined, "nonsense"]) {
    let message = "";
    try {
      parseSide(raw);
    } catch (err) {
      message = (err as Error).message;
    }
    assert.notEqual(message, "");
    assert.equal(publicError(message), message, `filtered away: ${message}`);
  }
});

test("side and amount are parsed independently", () => {
  // A sell-shaped request carries its size in whole FBC, so a request with a
  // valid side and no BTC amount must fail on the amount, and a request with a
  // valid amount and no side must fail on the side. Parsing them in the wrong
  // order reports one as the other.
  assert.throws(() => parseSide(undefined), /side is required/);
  assert.equal(parseQuoteAmountSat({ amount_sat: 10_000 }), 10_000);
});

// ── Funding recovery must match the amount, not just the address ──────────
//
// An HTLC address is public from the moment it is quoted. During recovery from
// a lost funding response, the search used to take the first output paying
// that address — so a taker sending dust to their own swap's address won the
// search, was persisted as our funding, and only then failed the amount check.
// The swap was abandoned with the maker's real HTLC never found and no
// outpoint recorded to refund it at T2.

test("recovery ignores a wrong-value payment to the HTLC address", async () => {
  const { setFbdClientForTests, findFbcPaymentToAddress } = await import("../src/chain.js");
  const ADDR = "fb1qhtlc";
  const REAL = 615_147_384;
  setFbdClientForTests({
    async getTxByAddress() {
      return ["dd".repeat(32), "ee".repeat(32)];
    },
    async getTransaction(txid: string) {
      // The dust comes first, exactly as an attacker would arrange.
      if (txid === "dd".repeat(32)) return { vout: [{ address: ADDR, value: 1 }] };
      return { vout: [{ address: ADDR, value: REAL }] };
    },
    async getRawMempool() {
      return [];
    },
  } as never);
  try {
    const hit = await findFbcPaymentToAddress(ADDR, null, REAL);
    assert.equal(hit?.txid, "ee".repeat(32), "must skip the dust and find the real funding");
    assert.equal(hit?.value, REAL);
  } finally {
    setFbdClientForTests(null);
  }
});

test("recovery finds nothing rather than adopting a wrong amount", async () => {
  const { setFbdClientForTests, findFbcPaymentToAddress } = await import("../src/chain.js");
  const ADDR = "fb1qhtlc";
  setFbdClientForTests({
    async getTxByAddress() {
      return ["dd".repeat(32)];
    },
    async getTransaction() {
      return { vout: [{ address: ADDR, value: 1 }] };
    },
    async getRawMempool() {
      return [];
    },
    async getBlockCount() {
      return 0;
    },
  } as never);
  try {
    // Better to report nothing found — the caller then funds, which is safe —
    // than to bind the swap to someone else's dust.
    assert.equal(await findFbcPaymentToAddress(ADDR, null, 615_147_384), null);
  } finally {
    setFbdClientForTests(null);
  }
});

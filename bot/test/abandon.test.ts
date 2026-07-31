/**
 * `abandon()` decides whether a swap that has gone wrong may be declared
 * `failed`, which drops it from the active set and stops the refund watchdog
 * from ever spending it again.
 *
 * That decision turns on ONE question: are our own coins on chain? Getting it
 * wrong in the safe direction keeps a dead swap being polled forever. Getting
 * it wrong in the unsafe direction strands real funds silently — there is no
 * error, the swap simply stops being worked.
 *
 * Which chain holds our coins depends on the side, so this is exactly the
 * "who is Alice here" question that roles.ts exists to answer. The guard read
 * only the FBC fields until sell_fbc was added, which was correct for buy and
 * would have stranded every abandoned sell swap's BTC.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { rolesFor, type Side } from "../src/roles.js";
import type { Swap } from "../src/store.js";

/**
 * The predicate under test, mirrored from mm.ts:abandon.
 *
 * Mirrored rather than imported because `abandon` is a private method that
 * also writes state and logs. What is asserted here is the DECISION; the
 * mirroring is kept honest by `the mirror matches the real guard` below.
 */
function ourFundsAtRisk(swap: Swap): boolean {
  const ourChain = rolesFor(swap.side).makerFunds;
  return ourChain === "fbc"
    ? Boolean(swap.funded_fbc || swap.fbc_funding_txid_pending || swap.fbc_funding_intent_at)
    : Boolean(swap.funded_btc || swap.btc_funding_txid_pending || swap.btc_funding_intent_at);
}

function swap(side: Side, over: Partial<Swap> = {}): Swap {
  return {
    side,
    funded_btc: null,
    funded_fbc: null,
    fbc_funding_txid_pending: null,
    fbc_funding_intent_at: null,
    btc_funding_txid_pending: null,
    btc_funding_intent_at: null,
    ...over,
  } as unknown as Swap;
}

const FUNDED = { funding_txid: "aa".repeat(32), funding_vout: 0, funding_amount: 1 } as never;

test("buy_fbc: our FBC on chain blocks abandonment", () => {
  assert.equal(ourFundsAtRisk(swap("buy_fbc", { funded_fbc: FUNDED })), true);
  assert.equal(ourFundsAtRisk(swap("buy_fbc", { fbc_funding_txid_pending: "bb".repeat(32) })), true);
  // Written before the funding RPC, so it is the only trace a lost response
  // leaves. Ignoring it is how coins end up on chain with nothing tracking them.
  assert.equal(ourFundsAtRisk(swap("buy_fbc", { fbc_funding_intent_at: 1 })), true);
});

test("buy_fbc: the taker's BTC is not ours, and must not block abandonment", () => {
  // funded_btc on the buy side is the counterparty's submission. Treating it
  // as ours-at-risk would keep every failed buy swap active forever, polling
  // an outpoint we have no key for.
  assert.equal(ourFundsAtRisk(swap("buy_fbc", { funded_btc: FUNDED })), false);
});

test("sell_fbc: our BTC on chain blocks abandonment", () => {
  // The case the original guard got wrong. Every one of these would have been
  // declared `failed`, dropped from listActiveSwaps, and left unrefundable.
  assert.equal(ourFundsAtRisk(swap("sell_fbc", { funded_btc: FUNDED })), true);
  assert.equal(ourFundsAtRisk(swap("sell_fbc", { btc_funding_txid_pending: "cc".repeat(32) })), true);
  assert.equal(ourFundsAtRisk(swap("sell_fbc", { btc_funding_intent_at: 1 })), true);
});

test("sell_fbc: the taker's FBC is not ours, and must not block abandonment", () => {
  assert.equal(ourFundsAtRisk(swap("sell_fbc", { funded_fbc: FUNDED })), false);
});

test("a swap with nothing on chain is safe to abandon on either side", () => {
  for (const side of ["buy_fbc", "sell_fbc"] as Side[]) {
    assert.equal(ourFundsAtRisk(swap(side)), false, side);
  }
});

test("the guard consults the chain roles.ts says we fund", () => {
  // If makerFunds ever stops matching what abandon() reads, this whole file is
  // asserting the wrong thing. Tie them together explicitly.
  assert.equal(rolesFor("buy_fbc").makerFunds, "fbc");
  assert.equal(rolesFor("sell_fbc").makerFunds, "btc");
});

test("the mirror matches the real guard in mm.ts", async () => {
  // A mirrored predicate silently drifts. Read the source and assert the
  // shape it still has, so a change to abandon() that this file does not
  // follow fails here rather than passing against a stale copy.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/mm.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("private abandon("), src.indexOf("private abandon(") + 1400);
  assert.match(body, /rolesFor\(swap\.side\)\.makerFunds/, "abandon must derive the chain from roles");
  for (const field of [
    "funded_fbc",
    "fbc_funding_txid_pending",
    "fbc_funding_intent_at",
    "funded_btc",
    "btc_funding_txid_pending",
    "btc_funding_intent_at",
  ]) {
    assert.ok(body.includes(field), `abandon no longer consults ${field}`);
  }
});

/**
 * Exhaustive routing tests for the swap state machine.
 *
 * Both fund-losing bugs found in review were predicate bugs, not action bugs:
 * a state missing from one set, and a condition that shadowed the branch below
 * it. Neither is visible when reading a single branch, so this enumerates the
 * whole cross-product and asserts the invariants that actually matter.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { config } from "../src/config.js";
import { planSwap, FBC_REFUND_MARGIN_BLOCKS, type SwapAction } from "../src/plan.js";
import type { Swap, SwapState } from "../src/store.js";

const T2 = 180_720;
const T1 = 920_288;

const ALL_STATES: SwapState[] = [
  "accepted",
  "waiting_btc_confs",
  "funding_fbc",
  "waiting_fbc_confs",
  "claimable",
  "claiming_btc",
  "done",
  "failed",
  "refunding_fbc",
  "refunded",
];

function swap(over: Partial<Swap> = {}): Swap {
  return {
    swap_id: "s_test",
    quote_id: "q_test",
    side: "buy_fbc",
    state: "accepted",
    offer: {
      version: 1,
      kind: "offer",
      network: { btc: "main", fbc: "main" },
      hashlock: "aa".repeat(32),
      alice_btc_pubkey: "02" + "11".repeat(32),
      alice_fbc_pubkey: "03" + "22".repeat(32),
      amount_btc: 1_000_000,
      amount_fbc: 41_900_000_000,
      btc_refund_height: T1,
      fbc_refund_height: T2,
      btc_reference_height: 920_000,
      fbc_reference_height: 180_000,
      expires_at: new Date().toISOString(),
      offer_id: "cc".repeat(16),
    },
    accept: {
      version: 1,
      kind: "accept",
      offer_id: "cc".repeat(16),
      bob_btc_pubkey: "02" + "33".repeat(32),
      bob_fbc_pubkey: "03" + "44".repeat(32),
    },
    funded_btc: null,
    funded_fbc: null,
    btc_confs: 0,
    fbc_confs: 0,
    preimage_hex: null,
    btc_claim_txid: null,
    btc_claim_txids: [],
    fbc_claim_txid: null,
    btc_claim_confs: 0,
    btc_claim_fee_rate: null,
    btc_claim_broadcast_at: null,
    fbc_funding_txid_pending: null,
    fbc_funding_intent_at: null,
    fbc_funding_intent_height: null,
    fbc_refund_txid: null,
    fbc_refund_confs: 0,
    fbc_refund_broadcast_at: null,
    fbc_claim_confs: 0,
    fbc_claim_fee_rate: null,
    fbc_claim_broadcast_at: null,
    btc_funding_txid_pending: null,
    btc_funding_intent_at: null,
    btc_funding_intent_height: null,
    btc_refund_txid: null,
    btc_refund_confs: 0,
    error: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

const FUNDED_BTC: Swap["funded_btc"] = {
  version: 1,
  kind: "funded_btc",
  offer_id: "cc".repeat(16),
  funding_txid: "ab".repeat(32),
  funding_vout: 0,
  funding_amount: 1_000_000,
  witness_script_hex: "00",
};

const FUNDED_FBC: Swap["funded_fbc"] = {
  version: 1,
  kind: "funded_fbc",
  offer_id: "cc".repeat(16),
  funding_txid: "cd".repeat(32),
  funding_vout: 0,
  funding_amount: 41_900_000_000,
  witness_script_hex: "00",
  htlc_address: "fb1qtest",
};

const before = { btcTip: 900_000, fbcTip: T2 - 100 };
const afterT2 = { btcTip: 900_000, fbcTip: T2 + FBC_REFUND_MARGIN_BLOCKS };

// ── The two bugs that motivated this file ────────────────────────────────

test("REGRESSION: the preimage watch survives into refunding_fbc", () => {
  // Our refund is in flight and the taker's claim is racing it (SPEC §6.1).
  // If their claim wins, our only remaining value is the preimage it reveals.
  const s = swap({
    state: "refunding_fbc",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    fbc_refund_txid: "ef".repeat(32),
  });
  assert.ok(
    planSwap(s, afterT2, true).includes("watch_preimage"),
    "must keep watching for the preimage until the refund confirms",
  );
});

test("REGRESSION: a broadcast refund is tracked, not re-triggered forever", () => {
  const s = swap({
    state: "refunding_fbc",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    fbc_refund_txid: "ef".repeat(32),
  });
  const plan = planSwap(s, afterT2, true);
  assert.ok(plan.includes("track_refund"), "must reach the confirmation tracker");
  assert.ok(!plan.includes("refund_fbc"), "must not re-broadcast an existing refund");
});

// ── Invariants over the whole state space ────────────────────────────────

/**
 * Every shape the system can actually reach.
 *
 * `funded_fbc` without `funded_btc` is excluded: we only ever fund the FBC leg
 * from the branch that requires a confirmed BTC funding, so it cannot occur.
 * The exclusion is asserted separately below rather than assumed.
 */
function everyShape(): Swap[] {
  const out: Swap[] = [];
  for (const state of ALL_STATES) {
    for (const fb of [null, FUNDED_BTC]) {
      for (const ff of fb ? [null, FUNDED_FBC] : [null]) {
        for (const preimage of [null, "11".repeat(32)]) {
          for (const claimTxid of [null, "aa".repeat(32)]) {
            for (const refundTxid of [null, "bb".repeat(32)]) {
              for (const fbcClaimTxid of [null, "cc".repeat(32)]) {
                out.push(
                  swap({
                    state,
                    funded_btc: fb,
                    funded_fbc: ff,
                    preimage_hex: preimage,
                    btc_claim_txid: claimTxid,
                    fbc_refund_txid: refundTxid,
                    fbc_claim_txid: fbcClaimTxid,
                  }),
                );
              }
            }
          }
        }
      }
    }
  }
  return out;
}

test("no state ever plans to claim and refund in the same tick", () => {
  // Spending our own HTLC two ways at once is the one thing that must be
  // impossible regardless of how we got into a state.
  for (const s of everyShape()) {
    for (const tips of [before, afterT2]) {
      const plan = planSwap(s, tips, true);
      assert.ok(
        !(plan.includes("refund_fbc") && plan.includes("track_claim")),
        `refund_fbc + track_claim together for ${describe(s)}`,
      );
    }
  }
});

test("never refunds an HTLC the taker has already spent", () => {
  for (const s of everyShape()) {
    if (!s.preimage_hex && !s.fbc_claim_txid) continue;
    for (const tips of [before, afterT2]) {
      assert.ok(
        !planSwap(s, tips, true).includes("refund_fbc"),
        `planned a refund despite a known claim for ${describe(s)}`,
      );
    }
  }
});

test("never refunds before T2 plus the SPEC §6.1 margin", () => {
  for (const s of everyShape()) {
    const justShort = { btcTip: 900_000, fbcTip: T2 + FBC_REFUND_MARGIN_BLOCKS - 1 };
    assert.ok(
      !planSwap(s, justShort, true).includes("refund_fbc"),
      `refunded early for ${describe(s)}`,
    );
  }
});

test("terminal states plan nothing", () => {
  for (const s of everyShape()) {
    if (!["done", "failed", "refunded"].includes(s.state)) continue;
    for (const tips of [before, afterT2]) {
      assert.deepEqual(planSwap(s, tips, true), [], `terminal state acted: ${describe(s)}`);
    }
  }
});

test("every non-terminal shape with funds at stake plans something", () => {
  // A swap holding our FBC that plans no action is stuck money.
  for (const s of everyShape()) {
    if (["done", "failed", "refunded"].includes(s.state)) continue;
    if (!s.funded_fbc) continue;
    // Once the taker has claimed and we have claimed back, tracking ends.
    if (s.btc_claim_txid && s.state !== "claiming_btc") continue;
    const plan = planSwap(s, afterT2, true);
    assert.ok(plan.length > 0, `no action planned while holding FBC: ${describe(s)}`);
  }
});

test("we never plan to act on FBC we funded without a BTC leg", () => {
  // This shape should be unreachable — fundFbc is only called from the branch
  // gated on a confirmed funded_btc. If a corrupted store ever produced it,
  // the safe behaviour is to refund our own coins, never to keep waiting.
  const impossible = swap({
    state: "claimable",
    funded_btc: null,
    funded_fbc: FUNDED_FBC,
  });
  const plan = planSwap(impossible, afterT2, true);
  assert.ok(
    plan.includes("refund_fbc") || plan.includes("watch_preimage"),
    "a swap holding FBC must always have a way out",
  );
});

test("an unfunded accept expires only once its refund window is not future", () => {
  const s = swap({ state: "accepted" });
  assert.deepEqual(planSwap(s, before, true), []);
  assert.deepEqual(planSwap(s, before, false), ["expire_unfunded"]);
});

test("watch_preimage is never planned once we hold a claim txid", () => {
  for (const s of everyShape()) {
    if (!s.btc_claim_txid) continue;
    for (const tips of [before, afterT2]) {
      assert.ok(
        !planSwap(s, tips, true).includes("watch_preimage"),
        `re-watched after claiming for ${describe(s)}`,
      );
    }
  }
});

// ── The claim has to have an exit ────────────────────────────────────────

test("an unconfirmed claim well past T1 stops being retried forever", () => {
  const s = swap({
    state: "claiming_btc",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    preimage_hex: "11".repeat(32),
    btc_claim_txid: "aa".repeat(32),
    fbc_claim_txid: "cc".repeat(32),
  });
  const atT1 = { btcTip: T1, fbcTip: T2 };
  assert.deepEqual(planSwap(s, atT1, false), ["track_claim"], "T1 alone is not death");

  const wellPast = { btcTip: T1 + config.claimGiveUpBlocks, fbcTip: T2 };
  assert.deepEqual(planSwap(s, wellPast, false), ["abandon_claim"]);
});

test("a claim that already confirmed is never abandoned, however late", () => {
  // It is on its way to `done` and only needs burying. Abandoning here would
  // terminally fail a swap we actually won.
  const s = swap({
    state: "claiming_btc",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    preimage_hex: "11".repeat(32),
    btc_claim_txid: "aa".repeat(32),
    btc_claim_confs: 1,
  });
  const wellPast = { btcTip: T1 + config.claimGiveUpBlocks * 10, fbcTip: T2 };
  assert.deepEqual(planSwap(s, wellPast, false), ["track_claim"]);
});

test("abandon_claim never coexists with a refund", () => {
  for (const s of everyShape()) {
    const wellPast = {
      btcTip: T1 + config.claimGiveUpBlocks,
      fbcTip: T2 + FBC_REFUND_MARGIN_BLOCKS,
    };
    const plan = planSwap(s, wellPast, false);
    assert.ok(
      !(plan.includes("abandon_claim") && plan.includes("refund_fbc")),
      `abandon_claim + refund_fbc together for ${describe(s)}`,
    );
  }
});

test("the happy path routes in the expected order", () => {
  const funding = swap({ state: "waiting_btc_confs", funded_btc: FUNDED_BTC });
  assert.deepEqual(planSwap(funding, before, true), ["poll_btc_confs"]);

  const waitingFbc = swap({
    state: "waiting_fbc_confs",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
  });
  assert.deepEqual(planSwap(waitingFbc, before, true), ["poll_fbc_confs", "watch_preimage"]);

  const claimable = swap({
    state: "claimable",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
  });
  assert.deepEqual(planSwap(claimable, before, true), ["watch_preimage"]);

  const claiming = swap({
    state: "claiming_btc",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    preimage_hex: "11".repeat(32),
    btc_claim_txid: "aa".repeat(32),
  });
  assert.deepEqual(planSwap(claiming, before, true), ["track_claim"]);
});

function describe(s: Swap): string {
  return [
    s.state,
    s.funded_btc ? "btc" : "-",
    s.funded_fbc ? "fbc" : "-",
    s.preimage_hex ? "pre" : "-",
    s.btc_claim_txid ? "claim" : "-",
    s.fbc_refund_txid ? "refund" : "-",
    s.fbc_claim_txid ? "fbcclaim" : "-",
  ].join("/");
}

const _unused: SwapAction[] = [];
void _unused;

// ── Side dispatch ────────────────────────────────────────────────────────
//
// Everything above this line is a NEGATIVE invariant — "never claims and
// refunds together", "never refunds early", "never refunds a spent HTLC" — and
// every one of them is satisfied by planning nothing at all. A planner that
// returned [] unconditionally would pass the entire suite above.
//
// So the fail-closed behaviour needs asserting from both directions: that an
// unroutable swap plans nothing, AND that the shape used to prove it would
// genuinely have demanded action otherwise. Without the second half this test
// could pass because the fixture was inert.

/** A swap that unambiguously needs refund_fbc: funded, past T2, nothing claimed. */
function needsRefund(over: Partial<Swap> = {}): Swap {
  return swap({
    state: "claimable",
    funded_btc: FUNDED_BTC,
    funded_fbc: FUNDED_FBC,
    btc_confs: 6,
    fbc_confs: 12,
    preimage_hex: null,
    btc_claim_txid: null,
    fbc_claim_txid: null,
    fbc_refund_txid: null,
    ...over,
  });
}

test("the control: this shape really does demand a refund on buy_fbc", () => {
  const plan = planSwap(needsRefund(), afterT2, false);
  assert.ok(
    plan.includes("refund_fbc"),
    `control shape planned ${JSON.stringify(plan)} — the dispatch tests below would be vacuous`,
  );
});

test("an unknown side plans nothing, even holding refundable funds", () => {
  const rogue = needsRefund();
  // What a record written before `side` existed looks like if reindex() were
  // ever removed or bypassed.
  delete (rogue as Partial<Swap>).side;
  assert.deepEqual(planSwap(rogue, afterT2, false), []);
});

test("a side we do not recognise plans nothing", () => {
  const rogue = needsRefund({ side: "buy_btc_somehow" as unknown as Swap["side"] });
  assert.deepEqual(planSwap(rogue, afterT2, false), []);
});

test("sell_fbc plans nothing until its routing is written", () => {
  // Distinct from the unknown-side case on purpose. If someone wires sell_fbc
  // quoting without wiring its routing, this is what stops a sell swap being
  // driven through buy logic — spending the wrong chain's coins.
  assert.deepEqual(planSwap(needsRefund({ side: "sell_fbc" }), afterT2, false), []);
});

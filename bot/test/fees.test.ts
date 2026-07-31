/**
 * The claim fee arithmetic, checked against the transaction it actually builds.
 *
 * The failure this protects against is not "fees were slightly wrong": with a
 * flat 500 sat/vB cap and no affordability check, a minimum-size 10,000 sat
 * swap became structurally unclaimable above ~68 sat/vB. `claimHtlc` refused to
 * build the transaction, so every attempt threw, the claim never went out, and
 * the taker refunded at T1 having already taken our FBC. The two sizing
 * functions and the builder must therefore agree to the satoshi — a helper that
 * says "affordable" for a fee the builder rejects is worse than no helper.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import * as btcSigner from "@scure/btc-signer";

import {
  BtcClaimWallet,
  DUST_SATS,
  TYPICAL_HTLC_SCRIPT_BYTES,
  claimVbytes,
  maxAffordableClaimFeeRate,
  minClaimableSats,
} from "../src/btc-wallet.js";
import { fromHex, toHex } from "../src/hex.js";
import { buildHtlcScript } from "../src/htlc.js";
import { NETWORKS } from "../src/networks.js";

const wallet = new BtcClaimWallet(
  btcSigner.WIF(NETWORKS.main).encode(new Uint8Array(32).fill(7)),
  { network: "main" },
);

const SCRIPT = buildHtlcScript({
  hashlock: new Uint8Array(32).fill(0x11),
  claimPubkey: fromHex(wallet.pubkeyHex),
  refundPubkey: Uint8Array.from([0x02, ...new Uint8Array(32).fill(0x22)]),
  locktime: 920_288,
});

/** Build a claim, returning true if the builder accepted the fee rate. */
function claimable(amountSats: number, feeRateSatPerVb: number): boolean {
  try {
    wallet.claimHtlc({
      fundingTxid: "ab".repeat(32),
      fundingVout: 0,
      fundingAmountSats: amountSats,
      witnessScriptHex: toHex(SCRIPT),
      preimageHex: "cd".repeat(32),
      feeRateSatPerVb,
    });
    return true;
  } catch {
    return false;
  }
}

test("the quoted script size is an upper bound on a real HTLC script", () => {
  // minClaimableSats has to size a quote before any script exists, so it uses
  // this constant. Under-estimating quotes swaps we cannot claim, so the bound
  // must hold — and it must not drift so far above reality that the minimum
  // becomes nonsense.
  assert.ok(
    SCRIPT.length <= TYPICAL_HTLC_SCRIPT_BYTES,
    `real script is ${SCRIPT.length} bytes, bound says ${TYPICAL_HTLC_SCRIPT_BYTES}`,
  );
  assert.ok(TYPICAL_HTLC_SCRIPT_BYTES - SCRIPT.length <= 2);
});

test("maxAffordableClaimFeeRate is exactly the highest rate the builder accepts", () => {
  for (const amount of [10_000, 25_000, 100_000, 5_000_000]) {
    const rate = maxAffordableClaimFeeRate(amount, SCRIPT.length);
    assert.ok(rate >= 1, `${amount} sat should be claimable at some rate`);
    assert.ok(claimable(amount, rate), `builder rejected ${rate} sat/vB for ${amount} sat`);
    assert.ok(
      !claimable(amount, rate + 1),
      `builder accepted ${rate + 1} sat/vB for ${amount} sat — the cap is too low`,
    );
  }
});

test("a 10,000 sat swap is unclaimable in a busy fee market, and we know it", () => {
  // The exact case from review: the old code capped at MAX_CLAIM_FEE_RATE=500
  // and asked for the estimate, so at 100 sat/vB it built nothing at all.
  const affordable = maxAffordableClaimFeeRate(10_000, SCRIPT.length);
  assert.ok(affordable < 100, `expected ~68 sat/vB, got ${affordable}`);
  assert.ok(!claimable(10_000, 100), "100 sat/vB must not be buildable at this size");
  assert.ok(claimable(10_000, affordable), "the capped rate must still claim");
});

test("minClaimableSats is the smallest amount claimable at a given rate", () => {
  for (const rate of [1, 3, 20, 68, 200, 500]) {
    const min = minClaimableSats(rate, SCRIPT.length);
    assert.ok(claimable(min, rate), `${min} sat should claim at ${rate} sat/vB`);
    assert.ok(!claimable(min - 1, rate), `${min - 1} sat must not claim at ${rate} sat/vB`);
  }
});

test("minClaimableSats leaves more than dust, not exactly dust", () => {
  const rate = 20;
  const min = minClaimableSats(rate, SCRIPT.length);
  const fee = Math.ceil(claimVbytes(SCRIPT.length) * rate);
  assert.ok(min - fee > DUST_SATS, "a claim that nets dust is not worth making");
});

test("nothing is claimable below the dust floor at any rate", () => {
  assert.equal(maxAffordableClaimFeeRate(DUST_SATS, SCRIPT.length), 0);
  assert.equal(maxAffordableClaimFeeRate(0, SCRIPT.length), 0);
});

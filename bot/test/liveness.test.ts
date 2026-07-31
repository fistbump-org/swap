import "./test-env.js";

import assert from "node:assert/strict";
import { test } from "node:test";

import { bitcoindVerifyFunding } from "../src/bitcoind.js";

/**
 * Every bug this file pins had the same shape: a call that cannot distinguish
 * "no" from "could not ask", feeding a decision where those lead opposite ways.
 * Giving up on a swap is the one decision that must never be reached from an
 * inconclusive input, because it drops the swap from the active set for good.
 */

test("verifyFunding marks RPC failures distinguishably from a spent outpoint", async () => {
  // No bitcoind configured in the test env, so the call fails at the RPC layer.
  const r = await bitcoindVerifyFunding({
    txid: "ab".repeat(32),
    vout: 0,
    address: "bc1qtest",
    amountSats: 10_000,
  });
  assert.equal(r.ok, false);
  const reason = (r as { reason: string }).reason;
  assert.ok(
    reason.startsWith("RPC_UNAVAILABLE"),
    `an unreachable node must be tagged RPC_UNAVAILABLE, got: ${reason}`,
  );
  // The give-up path keys off this exact phrase to mean "the taker may have
  // refunded". An RPC failure must not match it.
  assert.ok(
    !/is not in the UTXO set/i.test(reason),
    "an RPC failure must not read as a missing UTXO",
  );
});

test("verifyFunding rejects malformed inputs before touching the network", async () => {
  for (const bad of [
    { txid: "nothex", vout: 0 },
    { txid: "ab".repeat(32), vout: -1 },
    { txid: "ab".repeat(32), vout: 1.5 },
  ]) {
    const r = await bitcoindVerifyFunding({
      ...bad,
      address: "bc1qtest",
      amountSats: 10_000,
    });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} should be rejected`);
    assert.ok(
      !(r as { reason: string }).reason.startsWith("RPC_UNAVAILABLE"),
      "a malformed argument is our bug, not the node's",
    );
  }
});

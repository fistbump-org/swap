/**
 * A preimage is whatever hashes to the hashlock — any length.
 *
 * The HTLC script is `OP_IF OP_SHA256 <hashlock> OP_EQUALVERIFY <pk>
 * OP_CHECKSIG OP_ELSE …` with NO `OP_SIZE 32 OP_EQUALVERIFY`. So the script
 * commits to the hash and nothing else, and a secret of any length unlocks it.
 *
 * On buy_fbc the TAKER generates the secret and sends us only its hash
 * (roles.ts: the taker is Alice). The detector used to require exactly 64 hex
 * characters at witness[1], so a taker who chose a 31-byte secret could:
 *
 *   1. fund BTC honestly, so our funding check passes
 *   2. wait for us to fund the FBC leg
 *   3. claim the FBC, revealing a 31-byte preimage we could not see
 *   4. refund their own BTC at T1
 *
 * We lose the whole FBC leg for the price of their fees, repeatable to
 * MAX_FBC. Matching by hash instead of by length is what closes it.
 */

import "./test-env.js";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { findPreimageInWitness } from "../src/chain.js";

const hashOf = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SIG = "30".repeat(71);
const SCRIPT = "63".repeat(114);

/** A claim witness as it appears on chain: [sig, preimage, 0x01, script]. */
const claimWitness = (preimage: Buffer) => [SIG, preimage.toString("hex"), "01", SCRIPT];

test("a 32-byte preimage is found", () => {
  const s = Buffer.alloc(32, 7);
  assert.equal(findPreimageInWitness(claimWitness(s), hashOf(s)), s.toString("hex"));
});

test("a 31-byte preimage is found — this is the attack", () => {
  // The exact case that used to be invisible.
  const s = Buffer.alloc(31, 7);
  assert.equal(findPreimageInWitness(claimWitness(s), hashOf(s)), s.toString("hex"));
});

test("preimages of every plausible length are found", () => {
  for (const len of [1, 2, 16, 31, 32, 33, 64, 79, 80]) {
    const s = Buffer.alloc(len, 0xab);
    assert.equal(
      findPreimageInWitness(claimWitness(s), hashOf(s)),
      s.toString("hex"),
      `${len} bytes must be detected`,
    );
  }
});

test("position does not matter, only the hash", () => {
  // Never trust the index. A spend could order its witness differently, and
  // hashing is what identifies the secret regardless.
  const s = Buffer.alloc(31, 3);
  const h = hashOf(s);
  assert.equal(findPreimageInWitness([SIG, "01", s.toString("hex"), SCRIPT], h), s.toString("hex"));
  assert.equal(findPreimageInWitness([s.toString("hex"), SIG, "01", SCRIPT], h), s.toString("hex"));
});

test("a witness with no matching element yields nothing", () => {
  // A refund spend: real signature and script, no secret. Must not invent one.
  const other = hashOf(Buffer.alloc(32, 9));
  assert.equal(findPreimageInWitness([SIG, "", SCRIPT], other), null);
  assert.equal(findPreimageInWitness(claimWitness(Buffer.alloc(32, 1)), other), null);
});

test("junk elements are skipped rather than throwing", () => {
  const s = Buffer.alloc(31, 5);
  const w = ["zz", "0", "", SIG, s.toString("hex"), SCRIPT];
  assert.equal(findPreimageInWitness(w, hashOf(s)), s.toString("hex"));
});

test("nothing beyond the 80-byte push limit is considered", () => {
  // An element larger than the standard push limit could not have been in a
  // spend that relayed, so treating it as a candidate only widens the surface.
  const big = Buffer.alloc(81, 1);
  assert.equal(findPreimageInWitness([SIG, big.toString("hex"), SCRIPT], hashOf(big)), null);
});

test("the old length rule would have missed the attack", () => {
  // Pins why this file exists: the previous gate, applied to the same witness.
  const s = Buffer.alloc(31, 7);
  const hex = s.toString("hex");
  assert.equal(/^[0-9a-f]{64}$/i.test(hex), false, "62 hex chars — the old regex missed it");
  assert.equal(findPreimageInWitness(claimWitness(s), hashOf(s)), hex, "the new check finds it");
});

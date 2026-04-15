import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHTLCScript,
  parseHTLCScript,
  btcHTLCAddress,
  fbcHTLCAddress,
  toHex,
  fromHex,
} from "../src/index.js";

// These fixtures must match the expectations in the fbd repository's
// `Tests/ScriptTests/HTLCTests.swift` so the two implementations agree
// byte-for-byte. If you change one, change the other in the same commit.
// https://github.com/fistbump-org/fbd

const HASHLOCK = new Uint8Array(32).fill(0xab);
const CLAIM_PK = Uint8Array.from([0x02, ...Array(32).fill(0x11)]);
const REFUND_PK = Uint8Array.from([0x03, ...Array(32).fill(0x22)]);
const LOCKTIME = 860_144;

test("HTLC script byte layout matches fbd reference", () => {
  const { scriptBytes } = buildHTLCScript({
    hashlock: HASHLOCK,
    claimPubkey: CLAIM_PK,
    refundPubkey: REFUND_PK,
    locktime: LOCKTIME,
  });

  const expected: number[] = [];
  expected.push(0x63); // OP_IF
  expected.push(0xa8); // OP_SHA256
  expected.push(0x20);
  expected.push(...HASHLOCK);
  expected.push(0x88); // OP_EQUALVERIFY
  expected.push(0x21);
  expected.push(...CLAIM_PK);
  expected.push(0xac); // OP_CHECKSIG
  expected.push(0x67); // OP_ELSE
  // ScriptNum.encode(860_144): 860144 == 0x0D_1F_F0, little-endian 3 bytes,
  // high bit of last byte (0x0D) is clear so no extra sign-pad byte.
  expected.push(0x03, 0xf0, 0x1f, 0x0d);
  expected.push(0xb1); // OP_CLTV
  expected.push(0x75); // OP_DROP
  expected.push(0x21);
  expected.push(...REFUND_PK);
  expected.push(0xac); // OP_CHECKSIG
  expected.push(0x68); // OP_ENDIF

  assert.deepEqual(Array.from(scriptBytes), expected);
});

test("parseHTLCScript round-trips buildHTLCScript", () => {
  const { scriptBytes } = buildHTLCScript({
    hashlock: HASHLOCK,
    claimPubkey: CLAIM_PK,
    refundPubkey: REFUND_PK,
    locktime: LOCKTIME,
  });
  const parsed = parseHTLCScript(scriptBytes);
  assert.ok(parsed, "parseHTLCScript must accept a script produced by buildHTLCScript");
  assert.deepEqual(Array.from(parsed!.hashlock), Array.from(HASHLOCK));
  assert.deepEqual(Array.from(parsed!.claimPubkey), Array.from(CLAIM_PK));
  assert.deepEqual(Array.from(parsed!.refundPubkey), Array.from(REFUND_PK));
  assert.equal(parsed!.locktime, LOCKTIME);
});

test("parseHTLCScript rejects non-HTLC scripts", () => {
  assert.equal(parseHTLCScript(new Uint8Array(0)), null);
  assert.equal(parseHTLCScript(Uint8Array.of(0x76, 0xa9, 0x14)), null);
  // A plausible-looking but malformed script (wrong last op):
  const { scriptBytes } = buildHTLCScript({
    hashlock: HASHLOCK,
    claimPubkey: CLAIM_PK,
    refundPubkey: REFUND_PK,
    locktime: LOCKTIME,
  });
  const broken = new Uint8Array(scriptBytes);
  broken[broken.length - 1] = 0x00; // was 0x68 OP_ENDIF
  assert.equal(parseHTLCScript(broken), null);
});

test("addresses differ between BTC and FBC for the same script", () => {
  const script = buildHTLCScript({
    hashlock: HASHLOCK,
    claimPubkey: CLAIM_PK,
    refundPubkey: REFUND_PK,
    locktime: LOCKTIME,
  });
  const btc = btcHTLCAddress(script, "main");
  const fbc = fbcHTLCAddress(script, "main");
  assert.ok(btc.startsWith("bc1q"), `BTC address should be bc1q…, got ${btc}`);
  assert.ok(fbc.startsWith("fb1q"), `FBC address should be fb1q…, got ${fbc}`);
  assert.notEqual(btc, fbc, "BTC and FBC addresses must differ (different hash functions)");
});

test("hex round-trips", () => {
  const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
  assert.equal(toHex(bytes), "0001feff");
  assert.deepEqual(Array.from(fromHex("0001feff")), Array.from(bytes));
});

test("buildHTLCScript rejects invalid inputs", () => {
  assert.throws(() =>
    buildHTLCScript({
      hashlock: new Uint8Array(31), // wrong length
      claimPubkey: CLAIM_PK,
      refundPubkey: REFUND_PK,
      locktime: LOCKTIME,
    }),
  );
  assert.throws(() =>
    buildHTLCScript({
      hashlock: HASHLOCK,
      claimPubkey: CLAIM_PK,
      refundPubkey: REFUND_PK,
      locktime: 0,
    }),
  );
  assert.throws(() =>
    buildHTLCScript({
      hashlock: HASHLOCK,
      claimPubkey: CLAIM_PK,
      refundPubkey: REFUND_PK,
      locktime: 500_000_000,
    }),
  );
});

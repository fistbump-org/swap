import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildHTLCScript,
  parseHTLCScript,
  btcHTLCAddress,
  fbcHTLCAddress,
  isCompressedPubkey,
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

// The two commitments are the only thing distinguishing the chains, and they
// are computed one line apart from the same input, so transposing them is a
// one-character edit that no structural test notices: the script bytes stay
// identical, both addresses stay well-formed, and they still differ from each
// other. What it actually does is send each side's funds to the other chain's
// address — unspendable on both. Pinning the digests is the only check that
// catches it, so these two vectors are load-bearing.
const BTC_COMMITMENT = "97ac5797ef89d7293fd5a2a61b6784921425442ecd8086bc7f58e9c7e4513fe4";
const FBC_COMMITMENT = "ad017151dd0febea6f6d7fc6cdb76ca73f08852ccfcba322e24ef12b7f0679c3";

test("BTC commits with SHA-256 and FBC with SHA3-256, not the reverse", () => {
  const script = buildHTLCScript({
    hashlock: HASHLOCK,
    claimPubkey: CLAIM_PK,
    refundPubkey: REFUND_PK,
    locktime: LOCKTIME,
  });
  assert.equal(toHex(script.btcCommitment), BTC_COMMITMENT, "btcCommitment must be SHA-256");
  assert.equal(toHex(script.fbcCommitment), FBC_COMMITMENT, "fbcCommitment must be SHA3-256");
});

/**
 * Rebuild the canonical HTLC with an arbitrary locktime push, so the parser can
 * be fed encodings `buildHTLCScript` would never emit.
 */
function scriptWithLocktimePush(push: number[], over: { claimPrefix?: number } = {}): Uint8Array {
  const claim = Uint8Array.from(CLAIM_PK);
  if (over.claimPrefix !== undefined) claim[0] = over.claimPrefix;
  return Uint8Array.from([
    0x63, 0xa8, 0x20, ...HASHLOCK, 0x88, 0x21, ...claim, 0xac,
    0x67, push.length, ...push, 0xb1, 0x75, 0x21, ...REFUND_PK, 0xac, 0x68,
  ]);
}

/** The locktime push (opcode + bytes) sits between OP_ELSE and OP_CLTV. */
function locktimePushOf(scriptBytes: Uint8Array): number[] {
  const elseAt = 3 + 32 + 1 + 1 + 33 + 1; // OP_IF..OP_CHECKSIG, then OP_ELSE
  assert.equal(scriptBytes[elseAt], 0x67, "fixture offset must land on OP_ELSE");
  const len = scriptBytes[elseAt + 1]!;
  return Array.from(scriptBytes.slice(elseAt + 1, elseAt + 2 + len));
}

test("locktime ScriptNum encoding is minimal and survives a build/parse round-trip", () => {
  // Every boundary where the encoded width changes, plus both sides of each
  // sign-pad. A regression in either direction — a missing 0x00 pad, an extra
  // one, or a byte-order flip — moves at least one of these.
  const vectors: Array<[number, number[]]> = [
    [1, [0x01, 0x01]],
    [127, [0x01, 0x7f]],
    [128, [0x02, 0x80, 0x00]], // sign pad required
    [255, [0x02, 0xff, 0x00]],
    [256, [0x02, 0x00, 0x01]],
    [32_767, [0x02, 0xff, 0x7f]],
    [32_768, [0x03, 0x00, 0x80, 0x00]],
    [860_144, [0x03, 0xf0, 0x1f, 0x0d]],
    [8_388_607, [0x03, 0xff, 0xff, 0x7f]],
    [8_388_608, [0x04, 0x00, 0x00, 0x80, 0x00]],
    [499_999_999, [0x04, 0xff, 0x64, 0xcd, 0x1d]], // largest height CLTV accepts
  ];
  for (const [locktime, push] of vectors) {
    const { scriptBytes } = buildHTLCScript({
      hashlock: HASHLOCK,
      claimPubkey: CLAIM_PK,
      refundPubkey: REFUND_PK,
      locktime,
    });
    assert.deepEqual(locktimePushOf(scriptBytes), push, `encoding of locktime ${locktime}`);
    assert.equal(parseHTLCScript(scriptBytes)?.locktime, locktime, `decoding of ${locktime}`);
  }
});

test("parseHTLCScript rejects a 5-byte locktime instead of wrapping it into a live height", () => {
  // 0x01_00_03_0d_40 = 4_295_167_296: past the uint32 nLockTime field, so this
  // refund branch can never be spent by anyone. The old decoder did
  // `byte << 32`, which JS evaluates as `byte << 0`, folding the top byte into
  // the low one and reporting 200_001 — a height already long in the past, i.e.
  // a refund the caller believes is available right now.
  const wrapped = scriptWithLocktimePush([0x40, 0x0d, 0x03, 0x00, 0x01]);
  assert.equal(parseHTLCScript(wrapped), null);
});

test("parseHTLCScript rejects non-minimal ScriptNum locktimes", () => {
  // A padded encoding is a consensus failure (MINIMALDATA) in the interpreter,
  // so accepting it certifies a branch no node will let anyone spend.
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0xf0, 0x1f, 0x0d, 0x00])), null);
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0x01, 0x00])), null);
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0x00])), null);
  // Negative operands are never valid for CLTV.
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0xf0, 0x1f, 0x8d])), null);
  // ...but a 0x00 that IS carrying the sign bit stays valid.
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0x80, 0x00]))?.locktime, 128);
});

test("compressed-pubkey prefixes are enforced on build and parse", () => {
  // An 04/06/07 prefix leaves the script shape intact but the branch dead: no
  // signature can satisfy an OP_CHECKSIG against a key that doesn't decode.
  assert.equal(parseHTLCScript(scriptWithLocktimePush([0xf0, 0x1f, 0x0d], { claimPrefix: 0x04 })), null);
  assert.throws(() =>
    buildHTLCScript({
      hashlock: HASHLOCK,
      claimPubkey: Uint8Array.from([0x04, ...Array(32).fill(0x11)]),
      refundPubkey: REFUND_PK,
      locktime: LOCKTIME,
    }),
  );
});

test("isCompressedPubkey requires an 02/03 prefix and a point on secp256k1", () => {
  // G and 2G — real curve points.
  assert.equal(
    isCompressedPubkey(fromHex("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798")),
    true,
  );
  assert.equal(
    isCompressedPubkey(fromHex("02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")),
    true,
  );
  // Right length and right prefix, but x has no square root on the curve.
  assert.equal(isCompressedPubkey(fromHex("02" + "11".repeat(32))), false);
  assert.equal(isCompressedPubkey(fromHex("04" + "11".repeat(32))), false);
  assert.equal(isCompressedPubkey(new Uint8Array(33)), false);
  assert.equal(isCompressedPubkey(new Uint8Array(32)), false);
});

test("hex round-trips", () => {
  const bytes = new Uint8Array([0x00, 0x01, 0xfe, 0xff]);
  assert.equal(toHex(bytes), "0001feff");
  assert.deepEqual(Array.from(fromHex("0001feff")), Array.from(bytes));
  assert.deepEqual(Array.from(fromHex("0001FEFF")), Array.from(bytes), "uppercase decodes");
  assert.deepEqual(Array.from(fromHex("")), []);
});

test("fromHex rejects everything a strict decoder would", () => {
  // parseInt used to accept all of these and produce bytes fbd disagrees with.
  for (const bad of ["0x12", "-1", "+1", " 12", "12 ", "1 2", "zz", "g0", "abc", "\n12", "1 2"]) {
    assert.throws(() => fromHex(bad), `fromHex(${JSON.stringify(bad)}) must throw`);
  }
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

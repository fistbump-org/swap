// Blob-decoding tests.
//
// `decodeBlob` is the only place attacker-chosen bytes become typed objects.
// Until now it checked `version` and `kind` and then cast, which meant the
// TypeScript interfaces were a comment: a blob could declare `kind: "offer"`
// and carry an `undefined` pubkey, a negative amount, or a 4000-character
// hashlock, and the first thing to notice would be a helper deep inside the
// funding flow — if anything noticed at all. Every field is tampered with
// below, one at a time, because a validator that misses one field is a
// validator that gives false confidence about all of them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { base64urlnopad } from "@scure/base";

import { decodeBlob, encodeBlob } from "../src/offer.js";
import type { AcceptBlob, FundedBtcBlob, FundedFbcBlob, OfferBlob } from "../src/types.js";

// Real secp256k1 points (G, 2G, 3G, 4G). Curve validity is part of what is
// being tested, so these cannot be the repeated-byte placeholders used in
// script.test.ts.
const ALICE_BTC_PK = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const ALICE_FBC_PK = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const BOB_BTC_PK = "02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const BOB_FBC_PK = "02e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13";

const OFFER_ID = "cc".repeat(16);
const TXID = "dd".repeat(32);
const SCRIPT_HEX = "63a820" + "ab".repeat(32) + "8821" + ALICE_BTC_PK.slice(2);

function offer(): OfferBlob {
  return {
    version: 1,
    kind: "offer",
    network: { btc: "main", fbc: "main" },
    hashlock: "ab".repeat(32),
    alice_btc_pubkey: ALICE_BTC_PK,
    alice_fbc_pubkey: ALICE_FBC_PK,
    amount_btc: 1_000_000,
    amount_fbc: 41_900_000_000,
    btc_refund_height: 860_288,
    fbc_refund_height: 709_720,
    btc_reference_height: 860_000,
    fbc_reference_height: 709_000,
    expires_at: "2026-07-28T12:00:00Z",
    offer_id: OFFER_ID,
  };
}

function accept(): AcceptBlob {
  return {
    version: 1,
    kind: "accept",
    offer_id: OFFER_ID,
    bob_btc_pubkey: BOB_BTC_PK,
    bob_fbc_pubkey: BOB_FBC_PK,
  };
}

function fundedBtc(): FundedBtcBlob {
  return {
    version: 1,
    kind: "funded_btc",
    offer_id: OFFER_ID,
    funding_txid: TXID,
    funding_vout: 0,
    funding_amount: 1_000_000,
    witness_script_hex: SCRIPT_HEX,
  };
}

function fundedFbc(): FundedFbcBlob {
  return {
    version: 1,
    kind: "funded_fbc",
    offer_id: OFFER_ID,
    funding_txid: TXID,
    funding_vout: 1,
    funding_amount: 41_900_000_000,
    witness_script_hex: SCRIPT_HEX,
    htlc_address: "fb1qexample",
  };
}

/** Envelope arbitrary JSON, bypassing `encodeBlob`'s type constraints. */
function envelope(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return "fistbump-swap:v1:" + base64urlnopad.encode(bytes);
}

/** Assert every listed field mutation is rejected by `decodeBlob`. */
function rejectsEach(base: object, mutations: Record<string, unknown[]>): void {
  for (const [field, values] of Object.entries(mutations)) {
    for (const value of values) {
      const tampered = { ...base, [field]: value };
      assert.throws(
        () => decodeBlob(envelope(tampered)),
        new RegExp(field.split(".")[0]!),
        `${field} = ${JSON.stringify(value)} must be rejected`,
      );
    }
  }
}

test("well-formed blobs of every kind round-trip through encode/decode", () => {
  for (const blob of [offer(), accept(), fundedBtc(), fundedFbc()]) {
    assert.deepEqual(decodeBlob(encodeBlob(blob)), blob);
  }
});

test("funded_fbc htlc_address stays optional", () => {
  const { htlc_address, ...without } = fundedFbc();
  assert.equal(htlc_address, "fb1qexample");
  assert.deepEqual(decodeBlob(envelope(without)), without);
  assert.throws(() => decodeBlob(envelope({ ...without, htlc_address: 42 })), /htlc_address/);
});

test("unknown extra fields are tolerated (MM_API.md extensions)", () => {
  const extended = { ...offer(), maker_note: "hello", quote_id: "q_123" };
  assert.equal((decodeBlob(envelope(extended)) as OfferBlob).offer_id, OFFER_ID);
});

test("offer blobs are validated field by field", () => {
  rejectsEach(offer(), {
    network: [undefined, null, "main", {}, { btc: "main" }, { btc: "bitcoin", fbc: "main" }],
    hashlock: [undefined, null, 42, "", "ab".repeat(31), "ab".repeat(33), "zz".repeat(32)],
    alice_btc_pubkey: [undefined, "", ALICE_BTC_PK.slice(2), "02" + "11".repeat(32)],
    alice_fbc_pubkey: [undefined, "04" + ALICE_FBC_PK.slice(2), "03".repeat(33)],
    amount_btc: [undefined, "1000", -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2],
    amount_fbc: [undefined, null, -41_900_000_000],
    btc_refund_height: [undefined, 0, -1, "860288", 500_000_000],
    fbc_refund_height: [undefined, 1.5],
    btc_reference_height: [undefined, null],
    fbc_reference_height: [undefined, Infinity],
    expires_at: [undefined, 42, "not a date"],
    offer_id: [undefined, "cc".repeat(15), "gg".repeat(16)],
  });
});

test("an off-curve pubkey is rejected even though it is 33 bytes with an 02 prefix", () => {
  // This is the shape that used to sail through every check in the library and
  // leave one HTLC branch permanently unspendable.
  const bad = { ...offer(), alice_btc_pubkey: "02" + "11".repeat(32) };
  assert.throws(() => decodeBlob(envelope(bad)), /compressed secp256k1 pubkey/);
});

test("accept blobs are validated field by field", () => {
  rejectsEach(accept(), {
    offer_id: [undefined, "", "cc".repeat(17)],
    bob_btc_pubkey: [undefined, null, "02" + "11".repeat(32)],
    bob_fbc_pubkey: [undefined, 33, BOB_FBC_PK + "00"],
  });
});

test("funded blobs are validated field by field", () => {
  for (const base of [fundedBtc(), fundedFbc()]) {
    rejectsEach(base, {
      offer_id: [undefined, "cc".repeat(32)],
      funding_txid: [undefined, "", "dd".repeat(31), "xx".repeat(32)],
      funding_vout: [undefined, -1, 1.5, "0", null],
      funding_amount: [undefined, -1, "1000000"],
      witness_script_hex: [undefined, "", "abc", "0x63a8", 63],
    });
  }
});

test("envelope and version framing is still enforced", () => {
  assert.throws(() => decodeBlob("not-a-blob"), /missing prefix/);
  assert.throws(() => decodeBlob("fistbump-swap:v1:" + base64urlnopad.encode(new TextEncoder().encode("{"))), /valid JSON/);
  assert.throws(() => decodeBlob(envelope([1, 2, 3])), /not an object/);
  assert.throws(() => decodeBlob(envelope({ version: 2, kind: "offer" })), /unsupported blob version/);
  assert.throws(() => decodeBlob(envelope({ version: 1, kind: "quote" })), /unknown blob kind/);
});

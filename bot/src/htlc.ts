/**
 * HTLC script + address helpers — byte-compatible with swap-core / fbd Script.htlc.
 */

import { sha256 } from "@noble/hashes/sha256";
import { sha3_256 } from "@noble/hashes/sha3";
import { bech32 } from "@scure/base";

import { bytesEqual, fromHex, toHex } from "./hex.js";
import type { AcceptBlob, FundedBtc, OfferBlob } from "./store.js";

const OP_0 = 0x00;
const OP_IF = 0x63;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_EQUALVERIFY = 0x88;
const OP_SHA256 = 0xa8;
const OP_CHECKSIG = 0xac;
const OP_CLTV = 0xb1;

function pushBytes(data: Uint8Array): Uint8Array {
  const len = data.length;
  if (len === 0) return Uint8Array.of(OP_0);
  if (len <= 0x4b) {
    const out = new Uint8Array(1 + len);
    out[0] = len;
    out.set(data, 1);
    return out;
  }
  if (len <= 0xff) {
    const out = new Uint8Array(2 + len);
    out[0] = 0x4c;
    out[1] = len;
    out.set(data, 2);
    return out;
  }
  throw new Error("push too large");
}

function encodeScriptNum(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 1 || value >= 500_000_000) {
    throw new Error(`locktime out of range: ${value}`);
  }
  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.push(v & 0xff);
    v >>>= 8;
  }
  if ((bytes[bytes.length - 1]! & 0x80) !== 0) bytes.push(0x00);
  return Uint8Array.from(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

export function buildHtlcScript(params: {
  hashlock: Uint8Array;
  claimPubkey: Uint8Array;
  refundPubkey: Uint8Array;
  locktime: number;
}): Uint8Array {
  const { hashlock, claimPubkey, refundPubkey, locktime } = params;
  if (hashlock.length !== 32) throw new Error("hashlock must be 32 bytes");
  if (claimPubkey.length !== 33) throw new Error("claimPubkey must be 33 bytes");
  if (refundPubkey.length !== 33) throw new Error("refundPubkey must be 33 bytes");
  return concat(
    Uint8Array.of(OP_IF),
    Uint8Array.of(OP_SHA256),
    pushBytes(hashlock),
    Uint8Array.of(OP_EQUALVERIFY),
    pushBytes(claimPubkey),
    Uint8Array.of(OP_CHECKSIG),
    Uint8Array.of(OP_ELSE),
    pushBytes(encodeScriptNum(locktime)),
    Uint8Array.of(OP_CLTV),
    Uint8Array.of(OP_DROP),
    pushBytes(refundPubkey),
    Uint8Array.of(OP_CHECKSIG),
    Uint8Array.of(OP_ENDIF),
  );
}

function encodeP2wsh(hrp: string, program: Uint8Array): string {
  return bech32.encode(hrp, [0, ...bech32.toWords(program)]);
}

export function btcP2wshAddress(
  script: Uint8Array,
  network: "main" | "testnet" | "regtest",
): string {
  const hrp = network === "main" ? "bc" : network === "testnet" ? "tb" : "bcrt";
  return encodeP2wsh(hrp, sha256(script));
}

export function fbcP2wshAddress(
  script: Uint8Array,
  network: "main" | "testnet" | "regtest",
): string {
  const hrp = network === "main" ? "fb" : network === "testnet" ? "ft" : "fr";
  return encodeP2wsh(hrp, sha3_256(script));
}

export function htlcsFromOfferAccept(offer: OfferBlob, accept: AcceptBlob) {
  if (offer.offer_id.toLowerCase() !== accept.offer_id.toLowerCase()) {
    throw new Error("offer_id mismatch");
  }
  const hashlock = fromHex(offer.hashlock);
  return {
    btc: buildHtlcScript({
      hashlock,
      claimPubkey: fromHex(accept.bob_btc_pubkey),
      refundPubkey: fromHex(offer.alice_btc_pubkey),
      locktime: offer.btc_refund_height,
    }),
    fbc: buildHtlcScript({
      hashlock,
      claimPubkey: fromHex(offer.alice_fbc_pubkey),
      refundPubkey: fromHex(accept.bob_fbc_pubkey),
      locktime: offer.fbc_refund_height,
    }),
  };
}

export function verifyFundedBtc(
  offer: OfferBlob,
  accept: AcceptBlob,
  funded: FundedBtc,
): { ok: true } | { ok: false; reason: string } {
  // Case-insensitive: the stored offer is normalised to lowercase hex, and a
  // taker who sent us uppercase should not have their own funding rejected.
  if ((funded.offer_id ?? "").toLowerCase() !== offer.offer_id.toLowerCase()) {
    return { ok: false, reason: "offer_id mismatch" };
  }
  if (funded.funding_amount !== offer.amount_btc) {
    return { ok: false, reason: "amount mismatch" };
  }
  const { btc } = htlcsFromOfferAccept(offer, accept);
  const actual = fromHex(funded.witness_script_hex);
  if (!bytesEqual(btc, actual)) {
    return { ok: false, reason: "witness script mismatch" };
  }
  return { ok: true };
}

export function randomId(bytes = 16): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

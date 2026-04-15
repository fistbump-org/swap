// Offer / accept / funded blob encoding.
//
// Blobs are copy-pasted between counterparties as single-line envelopes:
//
//   fistbump-swap:v1:<base64url(utf8(canonical_json))>
//
// Canonical JSON here means: no whitespace, string keys in insertion order
// (v1 is deliberately schema-locked so order doesn't need enforcing).

import { base64urlnopad } from "@scure/base";

import { fromHex, toHex } from "./hex.js";
import { buildHTLCScript, parseHTLCScript } from "./script.js";
import type {
  AcceptBlob,
  FundedBtcBlob,
  FundedFbcBlob,
  HTLCParams,
  OfferBlob,
  SwapBlob,
} from "./types.js";

const ENVELOPE_PREFIX = "fistbump-swap:v1:";

export function encodeBlob(blob: SwapBlob): string {
  const json = JSON.stringify(blob);
  const bytes = new TextEncoder().encode(json);
  return ENVELOPE_PREFIX + base64urlnopad.encode(bytes);
}

export function decodeBlob(envelope: string): SwapBlob {
  const trimmed = envelope.trim();
  if (!trimmed.startsWith(ENVELOPE_PREFIX)) {
    throw new Error("not a fistbump-swap blob (missing prefix)");
  }
  const payload = trimmed.slice(ENVELOPE_PREFIX.length);
  const bytes = base64urlnopad.decode(payload);
  const json = new TextDecoder().decode(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("blob payload is not valid JSON");
  }
  return validateBlob(parsed);
}

function validateBlob(x: unknown): SwapBlob {
  if (!x || typeof x !== "object") throw new Error("blob is not an object");
  const obj = x as Record<string, unknown>;
  if (obj.version !== 1) throw new Error(`unsupported blob version: ${obj.version}`);
  switch (obj.kind) {
    case "offer":
      return obj as unknown as OfferBlob;
    case "accept":
      return obj as unknown as AcceptBlob;
    case "funded_btc":
      return obj as unknown as FundedBtcBlob;
    case "funded_fbc":
      return obj as unknown as FundedFbcBlob;
    default:
      throw new Error(`unknown blob kind: ${obj.kind}`);
  }
}

/**
 * Given an OFFER and an ACCEPT, reconstruct the HTLC parameters for both
 * legs of the swap. Returns `{ btc, fbc }` where each side's script commits
 * to the right pubkeys for that chain's claim/refund roles.
 *
 * Convention (§2, §3): Alice has BTC, wants FBC. Therefore:
 *   - BTC leg: Bob claims with preimage, Alice refunds after T1.
 *   - FBC leg: Alice claims with preimage, Bob refunds after T2.
 */
export function htlcsFromOfferAccept(
  offer: OfferBlob,
  accept: AcceptBlob,
): { btc: HTLCParams; fbc: HTLCParams } {
  if (offer.offer_id !== accept.offer_id) {
    throw new Error("accept.offer_id does not match offer.offer_id");
  }
  const hashlock = fromHex(offer.hashlock);
  return {
    btc: {
      hashlock,
      claimPubkey: fromHex(accept.bob_btc_pubkey),
      refundPubkey: fromHex(offer.alice_btc_pubkey),
      locktime: offer.btc_refund_height,
    },
    fbc: {
      hashlock,
      claimPubkey: fromHex(offer.alice_fbc_pubkey),
      refundPubkey: fromHex(accept.bob_fbc_pubkey),
      locktime: offer.fbc_refund_height,
    },
  };
}

/**
 * Independently verify a FUNDED_BTC blob: reconstruct the expected script
 * from offer+accept and compare byte-for-byte.
 */
export function verifyFundedBtc(
  offer: OfferBlob,
  accept: AcceptBlob,
  funded: FundedBtcBlob,
): { ok: true } | { ok: false; reason: string } {
  if (funded.offer_id !== offer.offer_id) {
    return { ok: false, reason: "offer_id mismatch" };
  }
  if (funded.funding_amount !== offer.amount_btc) {
    return { ok: false, reason: "funded amount_btc does not match offer" };
  }
  const { btc } = htlcsFromOfferAccept(offer, accept);
  const expected = buildHTLCScript(btc);
  const actual = fromHex(funded.witness_script_hex);
  if (!bytesEqual(expected.scriptBytes, actual)) {
    return { ok: false, reason: "witness script does not match reconstructed HTLC" };
  }
  const parsed = parseHTLCScript(actual);
  if (!parsed) {
    return { ok: false, reason: "witness script is not a canonical HTLC" };
  }
  return { ok: true };
}

/** Mirror of `verifyFundedBtc` for the FBC leg. */
export function verifyFundedFbc(
  offer: OfferBlob,
  accept: AcceptBlob,
  funded: FundedFbcBlob,
): { ok: true } | { ok: false; reason: string } {
  if (funded.offer_id !== offer.offer_id) {
    return { ok: false, reason: "offer_id mismatch" };
  }
  if (funded.funding_amount !== offer.amount_fbc) {
    return { ok: false, reason: "funded amount_fbc does not match offer" };
  }
  const { fbc } = htlcsFromOfferAccept(offer, accept);
  const expected = buildHTLCScript(fbc);
  const actual = fromHex(funded.witness_script_hex);
  if (!bytesEqual(expected.scriptBytes, actual)) {
    return { ok: false, reason: "witness script does not match reconstructed HTLC" };
  }
  return { ok: true };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Generate a 16-byte random offer_id, formatted as 32 lowercase hex chars. */
export function generateOfferId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

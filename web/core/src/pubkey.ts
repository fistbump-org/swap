// Compressed secp256k1 pubkey validation.
//
// A 33-byte length check is not a validity check. `04…`-prefixed keys, keys
// whose X coordinate has no square root on the curve, and keys at infinity all
// pass a length test and then serialise into a perfectly well-formed HTLC. The
// branch guarded by such a key is dead — no signature can ever satisfy its
// OP_CHECKSIG — so whichever side funded against it has burned that leg while
// every length-only check in the protocol reports the swap as sound. Both
// counterparties supply two keys each, so all four are attacker-controlled.
//
// The curve arithmetic comes from @scure/btc-signer's `validatePubkey`, which
// is already a dependency for PSBT construction (see btc.ts); no new package.

import { PubT, validatePubkey } from "@scure/btc-signer/utils.js";

/** True only for a 33-byte 02/03-prefixed key that decompresses to a curve point. */
export function isCompressedPubkey(key: Uint8Array): boolean {
  if (!(key instanceof Uint8Array) || key.length !== 33) return false;
  // `validatePubkey` accepts uncompressed (65-byte, 04-prefixed) and hybrid
  // forms too. The HTLC script template commits to a 33-byte push, so anything
  // else would change the script bytes and break the cross-chain commitment.
  if (key[0] !== 0x02 && key[0] !== 0x03) return false;
  try {
    validatePubkey(key, PubT.ecdsa);
    return true;
  } catch {
    return false;
  }
}

// HTLC witness-script construction. The resulting bytes are IDENTICAL on
// FBC and BTC — both chains inherit the same Bitcoin-style script opcodes
// (OP_IF/ELSE/ENDIF, OP_SHA256, OP_CLTV, OP_CHECKSIG). The two chains only
// differ in how they commit to the script in a P2WSH output:
//
//   - BTC: SHA-256(script)
//   - FBC: SHA3-256(script)
//
// That commitment difference is handled in `address.ts`, not here.

import { sha256 } from "@noble/hashes/sha256";
import { sha3_256 } from "@noble/hashes/sha3";

import type { HTLCParams, HTLCScript } from "./types.js";

const OP_0 = 0x00;
const OP_IF = 0x63;
const OP_ELSE = 0x67;
const OP_ENDIF = 0x68;
const OP_DROP = 0x75;
const OP_EQUALVERIFY = 0x88;
const OP_SHA256 = 0xa8;
const OP_CHECKSIG = 0xac;
const OP_CLTV = 0xb1;

/** Encode a byte string as a minimal script push. */
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
    out[0] = 0x4c; // OP_PUSHDATA1
    out[1] = len;
    out.set(data, 2);
    return out;
  }
  if (len <= 0xffff) {
    const out = new Uint8Array(3 + len);
    out[0] = 0x4d; // OP_PUSHDATA2
    out[1] = len & 0xff;
    out[2] = (len >> 8) & 0xff;
    out.set(data, 3);
    return out;
  }
  throw new Error("push too large");
}

/**
 * Encode a non-negative integer in Bitcoin CScriptNum minimal form:
 * little-endian, sign bit in MSB of the last byte. Used for the locktime
 * push in the refund branch. Matches fbd's `ScriptNum.encode` for values
 * in the valid CLTV range.
 */
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
  // If the MSB of the last byte is set, push a 0x00 to avoid being
  // interpreted as negative. For our CLTV range (value >= 1) this only
  // affects values like 128, 32768, etc.
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

function assertLengths(p: HTLCParams): void {
  if (p.hashlock.length !== 32) throw new Error("hashlock must be 32 bytes");
  if (p.claimPubkey.length !== 33) throw new Error("claimPubkey must be 33 bytes (compressed)");
  if (p.refundPubkey.length !== 33) throw new Error("refundPubkey must be 33 bytes (compressed)");
}

/**
 * Build the canonical HTLC witness script from parameters.
 *
 * Layout:
 * ```
 * OP_IF
 *   OP_SHA256 <hashlock> OP_EQUALVERIFY <claimPubkey> OP_CHECKSIG
 * OP_ELSE
 *   <locktime> OP_CLTV OP_DROP <refundPubkey> OP_CHECKSIG
 * OP_ENDIF
 * ```
 *
 * The returned script is byte-for-byte identical to what fbd's
 * `Script.htlc(...)` produces, so counterparties independently building
 * the script from the same parameters will always arrive at the same P2WSH
 * commitment.
 */
export function buildHTLCScript(params: HTLCParams): HTLCScript {
  assertLengths(params);
  const scriptBytes = concat(
    Uint8Array.of(OP_IF),
    Uint8Array.of(OP_SHA256),
    pushBytes(params.hashlock),
    Uint8Array.of(OP_EQUALVERIFY),
    pushBytes(params.claimPubkey),
    Uint8Array.of(OP_CHECKSIG),
    Uint8Array.of(OP_ELSE),
    pushBytes(encodeScriptNum(params.locktime)),
    Uint8Array.of(OP_CLTV),
    Uint8Array.of(OP_DROP),
    pushBytes(params.refundPubkey),
    Uint8Array.of(OP_CHECKSIG),
    Uint8Array.of(OP_ENDIF),
  );
  return {
    params,
    scriptBytes,
    fbcCommitment: sha3_256(scriptBytes),
    btcCommitment: sha256(scriptBytes),
  };
}

/**
 * Parse a witness script back into HTLC parameters. Returns null if the
 * script does not match the canonical template exactly.
 *
 * This is the symmetric check to `buildHTLCScript` — counterparties
 * receiving a script hex in a FUNDED_* blob MUST re-build from the OFFER
 * parameters and compare bytes, and MAY additionally call this to confirm
 * the script shape before inspecting any on-chain output.
 */
export function parseHTLCScript(scriptBytes: Uint8Array): HTLCParams | null {
  // Expected byte layout:
  //   63 a8 20 <32h> 88 21 <33p> ac 67 <N ltbytes> b1 75 21 <33p> ac 68
  // Minimum len: 1+1+1+32+1+1+33+1+1+1+1+1+1+1+33+1+1 = 111 (locktime push size 1)
  // For a 4-byte locktime push it's 114. Clamp to [111, 120].
  if (scriptBytes.length < 111 || scriptBytes.length > 120) return null;

  let i = 0;
  const at = (b: number) => scriptBytes[i++] === b;

  if (!at(OP_IF)) return null;
  if (!at(OP_SHA256)) return null;
  if (scriptBytes[i] !== 0x20) return null;
  i += 1;
  const hashlock = scriptBytes.slice(i, i + 32);
  i += 32;
  if (!at(OP_EQUALVERIFY)) return null;
  if (scriptBytes[i] !== 0x21) return null;
  i += 1;
  const claimPubkey = scriptBytes.slice(i, i + 33);
  i += 33;
  if (!at(OP_CHECKSIG)) return null;
  if (!at(OP_ELSE)) return null;

  // Locktime push: 1-byte length prefix (2..5 bytes), then N bytes.
  const ltLen = scriptBytes[i];
  if (ltLen === undefined || ltLen < 1 || ltLen > 5) return null;
  i += 1;
  const ltBytes = scriptBytes.slice(i, i + ltLen);
  i += ltLen;

  if (!at(OP_CLTV)) return null;
  if (!at(OP_DROP)) return null;
  if (scriptBytes[i] !== 0x21) return null;
  i += 1;
  const refundPubkey = scriptBytes.slice(i, i + 33);
  i += 33;
  if (!at(OP_CHECKSIG)) return null;
  if (!at(OP_ENDIF)) return null;
  if (i !== scriptBytes.length) return null;

  // Decode ScriptNum. Negative values would have bit 0x80 set on the last
  // byte; we reject them to stay in the CLTV-valid range (1..< 5×10^8).
  if ((ltBytes[ltBytes.length - 1]! & 0x80) !== 0) return null;
  let locktime = 0;
  for (let k = 0; k < ltBytes.length; k++) {
    locktime |= ltBytes[k]! << (8 * k);
  }
  if (locktime < 1 || locktime >= 500_000_000) return null;

  return { hashlock, claimPubkey, refundPubkey, locktime };
}

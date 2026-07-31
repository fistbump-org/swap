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
function pushBytes(data) {
    const len = data.length;
    if (len === 0)
        return Uint8Array.of(OP_0);
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
function encodeScriptNum(value) {
    if (!Number.isInteger(value) || value < 1 || value >= 500_000_000) {
        throw new Error(`locktime out of range: ${value}`);
    }
    const bytes = [];
    let v = value;
    while (v > 0) {
        bytes.push(v & 0xff);
        v >>>= 8;
    }
    // If the MSB of the last byte is set, push a 0x00 to avoid being
    // interpreted as negative. For our CLTV range (value >= 1) this only
    // affects values like 128, 32768, etc.
    if ((bytes[bytes.length - 1] & 0x80) !== 0)
        bytes.push(0x00);
    return Uint8Array.from(bytes);
}
function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let i = 0;
    for (const p of parts) {
        out.set(p, i);
        i += p.length;
    }
    return out;
}
/**
 * Decode a Bitcoin CScriptNum push into a non-negative integer, or null if the
 * bytes are anything other than the minimal encoding `encodeScriptNum` emits.
 *
 * Two traps live here, both of which turn a permanently unspendable refund
 * branch into one this library reports as valid and already expired:
 *
 *  - `<<` is a 32-bit signed operator and JS reduces the shift count mod 32,
 *    so `byte << 32` is `byte << 0`: on a 5-byte push the top byte folded back
 *    into the low byte. `[40 0d 03 00 01]` is 4_295_167_296 — beyond the uint32
 *    nLockTime field, so nothing can ever spend it — but the old shift loop
 *    decoded it as 200_001. Hence plain arithmetic, which is exact well past
 *    the 39-bit ceiling of a 5-byte ScriptNum.
 *  - Non-minimal encodings are a consensus failure in the script interpreter
 *    (MINIMALDATA), so accepting them here certifies a branch no node will let
 *    anyone spend. A trailing 0x00 is legal only when it exists to keep the
 *    sign bit of the byte below it clear.
 */
function decodeScriptNum(bytes) {
    if (bytes.length < 1 || bytes.length > 5)
        return null;
    const top = bytes[bytes.length - 1];
    // Negative operands are never valid for CLTV.
    if ((top & 0x80) !== 0)
        return null;
    if (top === 0x00 && (bytes.length === 1 || (bytes[bytes.length - 2] & 0x80) === 0)) {
        return null;
    }
    let value = 0;
    for (let k = 0; k < bytes.length; k++)
        value += bytes[k] * 2 ** (8 * k);
    return value;
}
function isCompressedPrefix(key) {
    return key.length === 33 && (key[0] === 0x02 || key[0] === 0x03);
}
// Structural checks only — this function's contract is byte-exactness with
// fbd's `Script.htlc`, and the pinned vectors below it depend on staying a pure
// encoder. Curve validity is asserted one level up, in `htlcsFromOfferAccept`,
// which is where every counterparty-supplied key actually enters the protocol
// (both from `decodeBlob` and, in the Auto UI, from a maker's HTTP response).
function assertParams(p) {
    if (p.hashlock.length !== 32)
        throw new Error("hashlock must be 32 bytes");
    if (!isCompressedPrefix(p.claimPubkey)) {
        throw new Error("claimPubkey must be 33 bytes with an 02/03 prefix (compressed)");
    }
    if (!isCompressedPrefix(p.refundPubkey)) {
        throw new Error("refundPubkey must be 33 bytes with an 02/03 prefix (compressed)");
    }
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
export function buildHTLCScript(params) {
    assertParams(params);
    const scriptBytes = concat(Uint8Array.of(OP_IF), Uint8Array.of(OP_SHA256), pushBytes(params.hashlock), Uint8Array.of(OP_EQUALVERIFY), pushBytes(params.claimPubkey), Uint8Array.of(OP_CHECKSIG), Uint8Array.of(OP_ELSE), pushBytes(encodeScriptNum(params.locktime)), Uint8Array.of(OP_CLTV), Uint8Array.of(OP_DROP), pushBytes(params.refundPubkey), Uint8Array.of(OP_CHECKSIG), Uint8Array.of(OP_ENDIF));
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
export function parseHTLCScript(scriptBytes) {
    // Expected byte layout:
    //   63 a8 20 <32h> 88 21 <33p> ac 67 <N ltbytes> b1 75 21 <33p> ac 68
    // Minimum len: 1+1+1+32+1+1+33+1+1+1+1+1+1+1+33+1+1 = 111 (locktime push size 1)
    // For a 4-byte locktime push it's 114. Clamp to [111, 120].
    if (scriptBytes.length < 111 || scriptBytes.length > 120)
        return null;
    let i = 0;
    const at = (b) => scriptBytes[i++] === b;
    if (!at(OP_IF))
        return null;
    if (!at(OP_SHA256))
        return null;
    if (scriptBytes[i] !== 0x20)
        return null;
    i += 1;
    const hashlock = scriptBytes.slice(i, i + 32);
    i += 32;
    if (!at(OP_EQUALVERIFY))
        return null;
    if (scriptBytes[i] !== 0x21)
        return null;
    i += 1;
    const claimPubkey = scriptBytes.slice(i, i + 33);
    i += 33;
    if (!at(OP_CHECKSIG))
        return null;
    if (!at(OP_ELSE))
        return null;
    // Locktime push: a direct-push opcode (0x01..0x05), then that many bytes.
    const ltLen = scriptBytes[i];
    if (ltLen === undefined || ltLen < 1 || ltLen > 5)
        return null;
    i += 1;
    const ltBytes = scriptBytes.slice(i, i + ltLen);
    i += ltLen;
    if (!at(OP_CLTV))
        return null;
    if (!at(OP_DROP))
        return null;
    if (scriptBytes[i] !== 0x21)
        return null;
    i += 1;
    const refundPubkey = scriptBytes.slice(i, i + 33);
    i += 33;
    if (!at(OP_CHECKSIG))
        return null;
    if (!at(OP_ENDIF))
        return null;
    if (i !== scriptBytes.length)
        return null;
    // Pubkeys must at least be structurally compressed — a wrong prefix means
    // the branch can never produce a valid signature. See `assertParams`.
    if (!isCompressedPrefix(claimPubkey) || !isCompressedPrefix(refundPubkey))
        return null;
    const locktime = decodeScriptNum(ltBytes);
    if (locktime === null || locktime < 1 || locktime >= 500_000_000)
        return null;
    return { hashlock, claimPubkey, refundPubkey, locktime };
}
//# sourceMappingURL=script.js.map
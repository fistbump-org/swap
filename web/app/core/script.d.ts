import type { HTLCParams, HTLCScript } from "./types.js";
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
export declare function buildHTLCScript(params: HTLCParams): HTLCScript;
/**
 * Parse a witness script back into HTLC parameters. Returns null if the
 * script does not match the canonical template exactly.
 *
 * This is the symmetric check to `buildHTLCScript` — counterparties
 * receiving a script hex in a FUNDED_* blob MUST re-build from the OFFER
 * parameters and compare bytes, and MAY additionally call this to confirm
 * the script shape before inspecting any on-chain output.
 */
export declare function parseHTLCScript(scriptBytes: Uint8Array): HTLCParams | null;
//# sourceMappingURL=script.d.ts.map
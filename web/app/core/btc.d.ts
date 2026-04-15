import type { BtcNetwork } from "./types.js";
/**
 * Construct an unsigned PSBT that spends the HTLC output at
 * `fundingTxid:fundingVout`, sending the value (minus fee) to
 * `destination`. The caller feeds this PSBT into `window.unisat.signPsbt`
 * (or equivalent) with `autoFinalized: false`, then passes the result
 * back to `finalizeHTLCSpend`.
 *
 * Network note: the PSBT carries P2WSH witness commitments that commit
 * to `SHA-256(witnessScript)` regardless of the actual chain — which is
 * the Bitcoin convention. FBC uses SHA-3-256 at the same position and
 * is handled by the wallet extension on the other side, not here.
 */
export declare function buildHTLCSpendPsbt(params: {
    fundingTxid: string;
    fundingVout: number;
    fundingAmountSats: number;
    witnessScript: Uint8Array;
    destination: string;
    feeRateSatPerVb: number;
    branch: "claim" | "refund";
    locktime?: number;
    network: BtcNetwork;
}): {
    psbtHex: string;
};
/**
 * Sign an HTLC spend PSBT entirely in-browser with a WIF-encoded private
 * key, returning the raw final tx ready for broadcast. Used when no
 * browser wallet extension will sign a P2WSH input with a custom script
 * (e.g. Unisat's "Unknown inputs not allowed" refusal).
 *
 * The private key is used in-memory, not persisted. @scure/btc-signer
 * produces a standard ECDSA signature over the BIP143 sighash; we wrap
 * it with the branch-specific witness stack and extract the final tx.
 */
export declare function signAndFinalizeWithWIF(params: {
    psbtHex: string;
    witnessScript: Uint8Array;
    branch: "claim" | "refund";
    preimage?: Uint8Array;
    wif: string;
    network: BtcNetwork;
}): {
    rawTxHex: string;
    txid: string;
};
/**
 * After the wallet returns a signed PSBT, extract the signature and
 * assemble the branch-specific witness stack. Returns the raw final tx
 * ready for `window.unisat.pushTx` or any broadcast endpoint.
 */
export declare function finalizeHTLCSpend(params: {
    signedPsbtHex: string;
    witnessScript: Uint8Array;
    branch: "claim" | "refund";
    preimage?: Uint8Array;
}): {
    rawTxHex: string;
    txid: string;
};
//# sourceMappingURL=btc.d.ts.map
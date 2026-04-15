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
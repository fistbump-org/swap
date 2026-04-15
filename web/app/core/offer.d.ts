import type { AcceptBlob, FundedBtcBlob, FundedFbcBlob, HTLCParams, OfferBlob, SwapBlob } from "./types.js";
export declare function encodeBlob(blob: SwapBlob): string;
export declare function decodeBlob(envelope: string): SwapBlob;
/**
 * Given an OFFER and an ACCEPT, reconstruct the HTLC parameters for both
 * legs of the swap. Returns `{ btc, fbc }` where each side's script commits
 * to the right pubkeys for that chain's claim/refund roles.
 *
 * Convention (§2, §3): Alice has BTC, wants FBC. Therefore:
 *   - BTC leg: Bob claims with preimage, Alice refunds after T1.
 *   - FBC leg: Alice claims with preimage, Bob refunds after T2.
 */
export declare function htlcsFromOfferAccept(offer: OfferBlob, accept: AcceptBlob): {
    btc: HTLCParams;
    fbc: HTLCParams;
};
/**
 * Independently verify a FUNDED_BTC blob: reconstruct the expected script
 * from offer+accept and compare byte-for-byte.
 */
export declare function verifyFundedBtc(offer: OfferBlob, accept: AcceptBlob, funded: FundedBtcBlob): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Mirror of `verifyFundedBtc` for the FBC leg. */
export declare function verifyFundedFbc(offer: OfferBlob, accept: AcceptBlob, funded: FundedFbcBlob): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Generate a 16-byte random offer_id, formatted as 32 lowercase hex chars. */
export declare function generateOfferId(): string;
//# sourceMappingURL=offer.d.ts.map
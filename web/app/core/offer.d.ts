import type { AcceptBlob, FundedBtcBlob, FundedFbcBlob, HTLCParams, OfferBlob, SwapBlob } from "./types.js";
/**
 * Minimum wall-clock buffer between the two refund deadlines (SPEC §4.2).
 *
 * The invariant is `T1 - T2 >= MIN_DELTA_SECONDS`, where T1 is Alice's BTC
 * refund and T2 is Bob's FBC refund. Alice funds first and is the only party
 * who knows `s`, so her refund must be the LAST thing that becomes possible.
 *
 * Getting this backwards — requiring T2 > T1, as every v1 implementation did
 * until 2026-07-28 — opens the window [T1, T2) in which Alice can refund her
 * BTC and still claim the FBC, taking both legs. See SPEC §9.1.
 */
export declare const MIN_DELTA_SECONDS: number;
/**
 * Latest FBC height at which it is still safe to reveal the preimage.
 *
 * Past this, Bob's refund branch is close enough that a claim may lose the race
 * — and a losing claim still publishes `s` while Bob's BTC leg is live, so he
 * takes both. Callers MUST check this immediately before signing a claim, not
 * only when the offer was accepted.
 */
export declare function fbcClaimDeadline(offer: OfferBlob): number;
/** SPEC §6.1: broadcast the claim at least this far before T2. */
export declare const CLAIM_SAFETY_BLOCKS_FBC = 6;
export type ObservedTips = {
    btcTip?: number | null;
    fbcTip?: number | null;
};
export type Check = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Validate an offer's four height fields.
 *
 * Two independent layers, both required:
 *
 *  1. Relative — the wall-clock Δ between the two refund deadlines, measured
 *     against each chain's own reference height.
 *  2. Absolute — every height compared against a tip this side observed for
 *     itself.
 *
 * Layer 1 alone is circular and cannot be trusted: the counterparty supplies
 * both the refund height and the reference height it is measured against, so
 * they can hold Δ at a healthy-looking 24h while placing T1 in the past. Pass
 * `observed` whenever tips are available — which is always, for the party
 * about to lock funds.
 */
export declare function checkTimelocks(offer: OfferBlob, observed?: ObservedTips): Check;
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
 *
 * Pass `observed` tips whenever you have them. Without them only the relative
 * Δ check runs, which an adversarial counterparty can satisfy while placing a
 * refund height in the past — see `checkTimelocks`.
 */
export declare function htlcsFromOfferAccept(offer: OfferBlob, accept: AcceptBlob, observed?: ObservedTips): {
    btc: HTLCParams;
    fbc: HTLCParams;
};
/**
 * Rebuild both legs' HTLC parameters WITHOUT applying timelock policy.
 *
 * Policy governs whether it is safe to *enter* a swap. Recovery is different:
 * coins already sit in an HTLC, and the only way to move them is to reconstruct
 * the exact script that locked them. Refusing to do that because the offer no
 * longer satisfies current policy would strand real funds — which is precisely
 * what happened to every in-flight swap when the Δ ordering was corrected, as
 * those offers can never satisfy the new rule.
 *
 * Structural validation (matching offer ids, well-formed on-curve pubkeys) is
 * still enforced, because a script built from malformed keys is unspendable
 * anyway. Use this only to refund or to display an existing swap — never to
 * decide whether to fund one.
 */
export declare function htlcParamsForRecovery(offer: OfferBlob, accept: AcceptBlob): {
    btc: HTLCParams;
    fbc: HTLCParams;
};
/**
 * Independently verify a FUNDED_BTC blob: reconstruct the expected script
 * from offer+accept and compare byte-for-byte.
 */
export declare function verifyFundedBtc(offer: OfferBlob, accept: AcceptBlob, funded: FundedBtcBlob, observed?: ObservedTips): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Mirror of `verifyFundedBtc` for the FBC leg.
 *
 * NOTE: this proves the blob is internally consistent with the offer. It says
 * nothing about the chain. The caller MUST separately confirm that
 * `funding_txid:funding_vout` exists on FBC, pays `htlc_address` for
 * `funding_amount`, and has enough confirmations — never trust a counterparty's
 * self-reported confirmation count.
 */
export declare function verifyFundedFbc(offer: OfferBlob, accept: AcceptBlob, funded: FundedFbcBlob, observed?: ObservedTips): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** Generate a 16-byte random offer_id, formatted as 32 lowercase hex chars. */
export declare function generateOfferId(): string;
//# sourceMappingURL=offer.d.ts.map
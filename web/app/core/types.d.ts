export type BtcNetwork = "main" | "testnet" | "regtest";
export type FbcNetwork = "main" | "testnet" | "regtest" | "simnet";
/** Parameters that fully determine an HTLC script. Identical on both chains. */
export interface HTLCParams {
    /** 32-byte SHA-256 of the preimage. */
    hashlock: Uint8Array;
    /** 33-byte compressed secp256k1 pubkey. The side that reveals `s` claims. */
    claimPubkey: Uint8Array;
    /** 33-byte compressed secp256k1 pubkey. The side that waits for the timelock refunds. */
    refundPubkey: Uint8Array;
    /** Absolute block height at which the refund path becomes valid. */
    locktime: number;
}
/** A parsed HTLC, including its P2WSH commitment on both chains. */
export interface HTLCScript {
    params: HTLCParams;
    /** Raw witness script bytes. Identical on FBC and BTC. */
    scriptBytes: Uint8Array;
    /** 32-byte SHA3-256 commitment for FBC P2WSH. */
    fbcCommitment: Uint8Array;
    /** 32-byte SHA-256 commitment for BTC P2WSH. */
    btcCommitment: Uint8Array;
}
/** v1 offer blob. See SPEC.md §5.1. */
export interface OfferBlob {
    version: 1;
    kind: "offer";
    network: {
        btc: BtcNetwork;
        fbc: FbcNetwork;
    };
    /** 64 hex chars. */
    hashlock: string;
    /** 66 hex chars, compressed. */
    alice_btc_pubkey: string;
    /** 66 hex chars, compressed. */
    alice_fbc_pubkey: string;
    /** BTC sats. */
    amount_btc: number;
    /** FBC bumps (10^6 bumps = 1 FBC). */
    amount_fbc: number;
    btc_refund_height: number;
    fbc_refund_height: number;
    btc_reference_height: number;
    fbc_reference_height: number;
    /** RFC 3339 timestamp. */
    expires_at: string;
    /** 32 hex chars (16 random bytes). */
    offer_id: string;
}
/** v1 accept blob. See SPEC.md §5.2. */
export interface AcceptBlob {
    version: 1;
    kind: "accept";
    offer_id: string;
    bob_btc_pubkey: string;
    bob_fbc_pubkey: string;
}
/** v1 funded-BTC blob. See SPEC.md §5.3. */
export interface FundedBtcBlob {
    version: 1;
    kind: "funded_btc";
    offer_id: string;
    funding_txid: string;
    funding_vout: number;
    funding_amount: number;
    witness_script_hex: string;
}
/** v1 funded-FBC blob. See SPEC.md §5.4. */
export interface FundedFbcBlob {
    version: 1;
    kind: "funded_fbc";
    offer_id: string;
    funding_txid: string;
    funding_vout: number;
    funding_amount: number;
    witness_script_hex: string;
}
export type SwapBlob = OfferBlob | AcceptBlob | FundedBtcBlob | FundedFbcBlob;
//# sourceMappingURL=types.d.ts.map
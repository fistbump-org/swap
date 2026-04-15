// Bech32 P2WSH address encoding for FBC and BTC.
//
// BTC uses the segwit v0 format defined by BIP 173/350:
//   <hrp>1<version><hash_5bit><checksum>
// FBC uses the same format but with different HRPs and commits to the
// script via SHA3-256 (not SHA-256). The 5-bit conversion and bech32
// checksum are identical.
import { bech32 } from "@scure/base";
const BTC_HRP = {
    main: "bc",
    testnet: "tb",
    regtest: "bcrt",
};
const FBC_HRP = {
    main: "fb",
    testnet: "ft",
    regtest: "fr",
    simnet: "fs",
};
/** Encode a 32-byte script commitment as a v0 P2WSH bech32 address. */
function encodeP2WSH(hrp, witnessProgram) {
    if (witnessProgram.length !== 32) {
        throw new Error("P2WSH program must be 32 bytes");
    }
    const words = [0, ...bech32.toWords(witnessProgram)];
    return bech32.encode(hrp, words);
}
export function btcHTLCAddress(script, network) {
    return encodeP2WSH(BTC_HRP[network], script.btcCommitment);
}
export function fbcHTLCAddress(script, network) {
    return encodeP2WSH(FBC_HRP[network], script.fbcCommitment);
}
//# sourceMappingURL=address.js.map
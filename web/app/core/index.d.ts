export { buildHTLCScript, parseHTLCScript } from "./script.js";
export { btcHTLCAddress, fbcHTLCAddress } from "./address.js";
export { generatePreimage, hashlockOf } from "./preimage.js";
export { encodeBlob, decodeBlob, htlcsFromOfferAccept, verifyFundedBtc, verifyFundedFbc, generateOfferId, } from "./offer.js";
export { toHex, fromHex } from "./hex.js";
export { buildHTLCSpendPsbt, finalizeHTLCSpend, signAndFinalizeWithWIF } from "./btc.js";
export type { BtcNetwork, FbcNetwork, HTLCParams, HTLCScript, OfferBlob, AcceptBlob, FundedBtcBlob, FundedFbcBlob, SwapBlob, } from "./types.js";
//# sourceMappingURL=index.d.ts.map
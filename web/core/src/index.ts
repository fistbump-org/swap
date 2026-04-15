// Public API for @fistbump/swap-core.
//
// This library is pure — it constructs scripts, addresses, and blobs but
// never signs, holds keys, or custodies funds. Signing is always delegated
// to the user's wallet:
//
//   - FBC: `window.fistbump.{getPublicKey,fundHtlc,signHtlcSpend}` from the
//          Fistbump wallet extension.
//   - BTC: any BIP-174 PSBT-signing wallet (Unisat, Xverse, OKX). The app
//          layer is responsible for wiring these; this library just
//          produces the HTLC scripts, addresses, and blob formats.
//
// See SPEC.md for the protocol.

export { buildHTLCScript, parseHTLCScript } from "./script.js";
export { btcHTLCAddress, fbcHTLCAddress } from "./address.js";
export { generatePreimage, hashlockOf } from "./preimage.js";
export {
  encodeBlob,
  decodeBlob,
  htlcsFromOfferAccept,
  verifyFundedBtc,
  verifyFundedFbc,
  generateOfferId,
} from "./offer.js";
export { toHex, fromHex } from "./hex.js";

export type {
  BtcNetwork,
  FbcNetwork,
  HTLCParams,
  HTLCScript,
  OfferBlob,
  AcceptBlob,
  FundedBtcBlob,
  FundedFbcBlob,
  SwapBlob,
} from "./types.js";

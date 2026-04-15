// BTC-side HTLC spend helpers.
//
// Builds PSBTs for claiming and refunding HTLC outputs on Bitcoin. Pure —
// never touches keys. The frontend delegates the actual signature to a
// BIP-174 wallet (Unisat, Xverse, OKX) via `signPsbt`, and then calls
// `finalizeHTLCSpend` here to assemble the custom witness stack.
//
// Why manual finalization instead of letting the wallet finalize for us:
// BIP-174 finalizers expect standard script templates (P2PKH, P2WPKH,
// P2WSH multisig). They don't know which branch of our HTLC `OP_IF` to
// select, so they leave the input unsignable or refuse to finalize. We
// take the raw ECDSA signature the wallet produces and construct:
//
//   Claim  : [sig, preimage, 0x01, witness_script]
//   Refund : [sig, empty,         witness_script]
//
// See SPEC.md §3.4 for the exact witness layout.
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
const NETWORKS = {
    main: btc.NETWORK,
    testnet: btc.TEST_NETWORK,
    // @scure/btc-signer exports only mainnet/testnet presets; regtest shares
    // testnet's address format (bech32 HRP `bcrt` vs `tb`) but we just use
    // testnet constants for tx construction — the HRP matters only at
    // address encode/decode time, which we don't touch here.
    regtest: btc.TEST_NETWORK,
};
/**
 * Rough witness size estimate used for fee calculation. Claim path
 * carries an extra 32-byte preimage push; both paths include ~72 bytes of
 * signature and ~103 bytes of witness script.
 */
function estimateWitnessVbytes(branch) {
    const witnessBytes = branch === "claim" ? 210 : 180;
    // Witness bytes are discounted 4x in vbyte accounting.
    return Math.ceil(witnessBytes / 4);
}
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
export function buildHTLCSpendPsbt(params) {
    const { fundingTxid, fundingVout, fundingAmountSats, witnessScript, destination, feeRateSatPerVb, branch, locktime, network, } = params;
    if (branch === "refund" && (locktime === undefined || locktime < 1)) {
        throw new Error("refund branch requires locktime");
    }
    const net = NETWORKS[network];
    // P2WSH scriptPubKey for the funding output = OP_0 <sha256(witnessScript)>.
    const p2wsh = btc.p2wsh({ type: "unknown", script: witnessScript }, net);
    // Fee estimate:
    //   base tx ≈ 10 (header) + 41 (input) + 31 (P2WPKH output) = 82 bytes
    //   plus witness contribution (discounted).
    const baseVbytes = 82;
    const witnessVbytes = estimateWitnessVbytes(branch);
    const fee = Math.ceil((baseVbytes + witnessVbytes) * feeRateSatPerVb);
    if (fundingAmountSats <= fee + 546) {
        // 546 sat is the standard BTC dust threshold for segwit outputs.
        throw new Error("funding amount too small to cover fee + dust");
    }
    const sendValue = BigInt(fundingAmountSats - fee);
    const tx = new btc.Transaction({
        lockTime: branch === "refund" ? locktime : 0,
    });
    tx.addInput({
        txid: fundingTxid,
        index: fundingVout,
        witnessUtxo: {
            amount: BigInt(fundingAmountSats),
            script: p2wsh.script,
        },
        witnessScript,
        sequence: branch === "refund" ? 0xffff_fffe : 0xffff_ffff,
        sighashType: btc.SigHash.ALL,
    });
    tx.addOutputAddress(destination, sendValue, net);
    return { psbtHex: hex.encode(tx.toPSBT()) };
}
/**
 * After the wallet returns a signed PSBT, extract the signature and
 * assemble the branch-specific witness stack. Returns the raw final tx
 * ready for `window.unisat.pushTx` or any broadcast endpoint.
 */
export function finalizeHTLCSpend(params) {
    const { signedPsbtHex, witnessScript, branch, preimage } = params;
    if (branch === "claim" && (!preimage || preimage.length !== 32)) {
        throw new Error("claim branch requires a 32-byte preimage");
    }
    const tx = btc.Transaction.fromPSBT(hex.decode(signedPsbtHex));
    const input = tx.getInput(0);
    const partial = input.partialSig;
    if (!partial || partial.length === 0) {
        throw new Error("signed PSBT contains no partialSig — did the wallet sign?");
    }
    // A correctly-signed HTLC claim/refund will have exactly one partialSig
    // under the signing pubkey. If more than one appears (multi-sig path),
    // reject — HTLCs in this protocol are single-sig per branch.
    if (partial.length !== 1) {
        throw new Error(`expected 1 partialSig, got ${partial.length}`);
    }
    const sig = partial[0][1];
    // Build the custom witness stack.
    //   Claim : [sig, preimage, 0x01, witness_script]
    //   Refund: [sig, empty,          witness_script]
    const witnessStack = branch === "claim"
        ? [sig, preimage, Uint8Array.of(0x01), witnessScript]
        : [sig, new Uint8Array(0), witnessScript];
    tx.updateInput(0, { finalScriptWitness: witnessStack });
    // Clear PSBT-only fields so the extracted tx is clean.
    tx.finalize();
    const rawTxHex = hex.encode(tx.extract());
    return { rawTxHex, txid: tx.id };
}
//# sourceMappingURL=btc.js.map
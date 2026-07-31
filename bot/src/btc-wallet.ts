import { secp256k1 } from "@noble/curves/secp256k1";
import { hex } from "@scure/base";
import * as btc from "@scure/btc-signer";

import {
  bitcoindBroadcast,
  bitcoindConfirmations,
  bitcoindConfirmationsStrict,
  bitcoindFeeRate,
  bitcoindInMempool,
  bitcoindTip,
  bitcoindVerifyFunding,
  bitcoindSpendableSats,
  useBitcoind,
} from "./bitcoind.js";
import { config } from "./config.js";
import { fromHex, toHex } from "./hex.js";
import { NETWORKS } from "./networks.js";

export class BtcClaimWallet {
  readonly privateKey: Uint8Array;
  readonly pubkeyHex: string;
  readonly address: string;
  readonly source: "wif" | "bitcoind";
  private readonly net: typeof btc.NETWORK;

  constructor(
    wif: string,
    opts: { address?: string; source?: "wif" | "bitcoind"; network?: typeof config.btcNetwork } = {},
  ) {
    const network = opts.network || config.btcNetwork;
    this.net = NETWORKS[network];
    this.source = opts.source || "wif";
    this.privateKey = btc.WIF(this.net).decode(wif);
    const pub = secp256k1.getPublicKey(this.privateKey, true);
    this.pubkeyHex = toHex(pub);

    if (opts.address) {
      this.address = opts.address;
    } else {
      const p2wpkh = btc.p2wpkh(pub, this.net);
      this.address = p2wpkh.address!;
    }
  }

  /**
   * Prefer Bitcoin Core wallet (same model as fbd): load claim key via RPC.
   * Fallback: BTC_WIF in env.
   */
  static async create(): Promise<BtcClaimWallet> {
    if (useBitcoind()) {
      const { bitcoindLoadClaimKey } = await import("./bitcoind.js");
      try {
        const k = await bitcoindLoadClaimKey();
        return new BtcClaimWallet(k.wif, {
          address: k.address,
          source: "bitcoind",
        });
      } catch (err) {
        if (config.btcWif) {
          console.warn(
            "[btc] Core wallet key load failed, falling back to BTC_WIF:",
            err instanceof Error ? err.message : err,
          );
          return new BtcClaimWallet(config.btcWif, {
            address: config.btcClaimAddress || undefined,
            source: "wif",
          });
        }
        throw err;
      }
    }
    if (!config.btcWif) {
      throw new Error(
        "Set BTC_RPC_URL (+ wallet) to use Bitcoin Core for claims, or set BTC_WIF",
      );
    }
    return new BtcClaimWallet(config.btcWif, {
      address: config.btcClaimAddress || undefined,
      source: "wif",
    });
  }

  /**
   * Build, sign, and extract a claim tx spending the BTC HTLC.
   * Witness: [sig, preimage, 0x01, witnessScript]
   * Still signed with BTC_WIF — Core is only for chain/broadcast.
   */
  claimHtlc(params: {
    fundingTxid: string;
    fundingVout: number;
    fundingAmountSats: number;
    witnessScriptHex: string;
    preimageHex: string;
    feeRateSatPerVb: number;
  }): { rawTxHex: string; txid: string } {
    const witnessScript = fromHex(params.witnessScriptHex);
    const preimage = fromHex(params.preimageHex);
    // Any length the script accepts. The HTLC commits to sha256(preimage) with
    // no OP_SIZE check, so refusing a 31-byte secret here would leave coins
    // unclaimable that the chain would happily have released. 80 bytes is the
    // standard push limit — beyond it the spend could not relay.
    if (preimage.length < 1 || preimage.length > 80) {
      throw new Error(`preimage must be 1..80 bytes, got ${preimage.length}`);
    }

    if (!Number.isInteger(params.fundingVout) || params.fundingVout < 0) {
      throw new Error("fundingVout must be a non-negative integer");
    }
    if (!Number.isInteger(params.fundingAmountSats) || params.fundingAmountSats <= 0) {
      throw new Error("fundingAmountSats must be a positive integer");
    }

    const p2wsh = btc.p2wsh({ type: "unknown", script: witnessScript }, this.net);

    const vbytes = claimVbytes(witnessScript.length);
    const fee = Math.ceil(vbytes * params.feeRateSatPerVb);

    if (params.fundingAmountSats <= fee + DUST_SATS) {
      throw new Error(
        `BTC HTLC too small for fee + dust: ${params.fundingAmountSats} sat ` +
          `vs ${fee} sat fee at ${params.feeRateSatPerVb} sat/vB`,
      );
    }
    const sendValue = BigInt(params.fundingAmountSats - fee);

    const tx = new btc.Transaction({
      lockTime: 0,
      allowUnknownInputs: true,
      allowUnknownOutputs: true,
    });
    tx.addInput({
      txid: params.fundingTxid,
      index: params.fundingVout,
      witnessUtxo: {
        amount: BigInt(params.fundingAmountSats),
        script: p2wsh.script,
      },
      witnessScript,
      sequence: 0xffff_fffd,
      sighashType: btc.SigHash.ALL,
    });
    tx.addOutputAddress(this.address, sendValue, this.net);
    tx.signIdx(this.privateKey, 0);

    const input = tx.getInput(0);
    const partial = input.partialSig;
    if (!partial || partial.length !== 1) {
      throw new Error("BTC claim sign failed");
    }
    const sig = partial[0]![1];
    const witnessStack: Uint8Array[] = [
      sig,
      preimage,
      Uint8Array.of(0x01),
      witnessScript,
    ];
    tx.updateInput(0, { finalScriptWitness: witnessStack });
    return { rawTxHex: hex.encode(tx.extract()), txid: tx.id };
  }
}

export const DUST_SATS = 546;

/**
 * Upper bound on the BTC HTLC witness script length, in bytes.
 *
 * OP_IF OP_SHA256 <32> OP_EQUALVERIFY <33> OP_CHECKSIG OP_ELSE <locktime>
 * OP_CLTV OP_DROP <33> OP_CHECKSIG OP_ENDIF: 110 bytes plus the minimally
 * encoded locktime push, which is 4 at today's heights and 5 above 8,388,607.
 * Deliberately the larger figure — this only sizes the minimum we quote, where
 * over-estimating costs a taker a few hundred satoshis of headroom and
 * under-estimating quotes a swap we cannot claim. Every real claim measures the
 * script it is actually spending.
 */
export const TYPICAL_HTLC_SCRIPT_BYTES = 115;

/**
 * Virtual size of a claim: one P2WSH input spent through the hashlock branch,
 * one P2WPKH output.
 *
 * Sized from the actual witness rather than a fixed 210 wu, which drifts with
 * the locktime push and the DER signature length:
 *   non-witness = 4 version + 1 in-count + 36 outpoint + 1 empty scriptSig
 *               + 4 sequence + 1 out-count + 8 value + 1 len + 22 script
 *               + 4 locktime = 82
 *   witness     = 2 marker/flag + item-count + each item's length prefix
 */
export function claimVbytes(witnessScriptLen: number): number {
  const NON_WITNESS_VBYTES = 82;
  const SIG_MAX = 72; // DER, low-S, incl. sighash byte
  const witnessItems = [SIG_MAX, 32, 1, witnessScriptLen];
  const witnessWeight =
    2 + 1 + witnessItems.reduce((n, len) => n + varIntLen(len) + len, 0);
  return NON_WITNESS_VBYTES + Math.ceil(witnessWeight / 4);
}

/**
 * Highest fee rate at which claiming this HTLC still leaves more than dust.
 *
 * Once the taker has revealed the preimage our FBC is already gone, so any
 * claim that nets more than dust beats not claiming at all — a flat
 * MAX_CLAIM_FEE_RATE made a minimum-size swap structurally unclaimable in a
 * busy fee market, and clamping to the flat cap alone would just build a tx
 * `claimHtlc` refuses to sign. Returns 0 when nothing is left to claim.
 */
export function maxAffordableClaimFeeRate(
  amountSats: number,
  witnessScriptLen: number,
): number {
  const spendable = amountSats - DUST_SATS - 1;
  if (spendable <= 0) return 0;
  return Math.floor(spendable / claimVbytes(witnessScriptLen));
}

/** Smallest HTLC still worth claiming at a given fee rate (nets > dust). */
export function minClaimableSats(
  feeRateSatPerVb: number,
  witnessScriptLen = TYPICAL_HTLC_SCRIPT_BYTES,
): number {
  return Math.ceil(claimVbytes(witnessScriptLen) * feeRateSatPerVb) + DUST_SATS + 1;
}

function varIntLen(n: number): number {
  return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5;
}

function requireBitcoind(what: string): void {
  if (!useBitcoind()) {
    throw new Error(
      `${what}: Bitcoin Core RPC required (set BTC_RPC_URL). ` +
        `Explorer/Esplora is not used for chain data.`,
    );
  }
}

export async function broadcastBtc(rawTxHex: string): Promise<string> {
  requireBitcoind("broadcastBtc");
  return bitcoindBroadcast(rawTxHex);
}

export async function fetchBtcFeeRate(): Promise<number> {
  requireBitcoind("fetchBtcFeeRate");
  return bitcoindFeeRate();
}

export async function fetchBtcTip(): Promise<number> {
  requireBitcoind("fetchBtcTip");
  return bitcoindTip();
}

export async function btcConfirmations(txid: string): Promise<number> {
  requireBitcoind("btcConfirmations");
  return bitcoindConfirmations(txid);
}

/** Confirmations, or null when the node could not answer. See bitcoind.ts. */
export async function btcConfirmationsStrict(txid: string): Promise<number | null> {
  requireBitcoind("btcConfirmationsStrict");
  return bitcoindConfirmationsStrict(txid);
}

/** true / false / null when the node could not tell us. */
export async function btcInMempool(txid: string): Promise<boolean | null> {
  requireBitcoind("btcInMempool");
  return bitcoindInMempool(txid);
}

/**
 * Spendable BTC in **sats**. See bitcoind.ts for why `mine.trusted` and why
 * this throws rather than returning 0 when the node is unreachable.
 */
export async function btcSpendableSats(): Promise<number> {
  requireBitcoind("btcSpendableSats");
  return bitcoindSpendableSats();
}

/** Verify funded BTC HTLC exists on-chain at the given outpoint. */
export async function verifyBtcFundingOnChain(params: {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  requireBitcoind("verifyBtcFundingOnChain");
  return bitcoindVerifyFunding(params);
}

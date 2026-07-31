#!/usr/bin/env node
/**
 * Build an unsigned refund transaction for a BTC HTLC.
 *
 * Last-resort recovery. The browser UIs can only refund a swap they still have
 * a saved session for; this works from nothing but the witness script and the
 * funding outpoint, both of which are recoverable from the chain or from a
 * counterparty's blob. Use it when the session is gone, the preimage was lost,
 * or the counterparty vanished.
 *
 * It never sees a private key. It emits a PSBT for you to sign in any wallet
 * that supports custom P2WSH scripts (Sparrow, Electrum, bitcoin-cli), because
 * the refund branch needs only your signature and an expired timelock.
 *
 * Usage:
 *   node tools/refund-htlc.mjs \
 *     --script <witness_script_hex> \
 *     --txid <funding_txid> --vout <n> \
 *     --to <your_address> \
 *     [--fee-rate <sat/vB>] [--network main|testnet|regtest] [--yes]
 *
 * Everything else — amount, locktime, the HTLC address — is derived and then
 * checked against the chain, so a typo fails loudly rather than producing a
 * transaction that quietly pays the wrong place.
 */

import {
  buildHTLCScript,
  parseHTLCScript,
  btcHTLCAddress,
  buildHTLCSpendPsbt,
} from "../web/core/dist/index.js";
import { fromHex, toHex } from "../web/core/dist/hex.js";

const ESPLORA = {
  main: "https://blockstream.info/api",
  testnet: "https://blockstream.info/testnet/api",
  regtest: process.env.ESPLORA_URL || "http://127.0.0.1:3002",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) die(`--${name} needs a value`);
  return v;
}
const flag = (name) => process.argv.includes(`--${name}`);

function die(msg) {
  console.error(`\nerror: ${msg}\n`);
  process.exit(1);
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const network = arg("network", "main");
if (!ESPLORA[network]) die(`unknown network ${network}`);
const api = ESPLORA[network];

const scriptHex = arg("script") ?? die("--script is required");
const txid = arg("txid") ?? die("--txid is required");
const vout = Number(arg("vout", "0"));
const destination = arg("to") ?? die("--to is required (where the refund pays)");

if (!/^[0-9a-fA-F]+$/.test(scriptHex)) die("--script must be hex");
if (!/^[0-9a-f]{64}$/i.test(txid)) die("--txid must be a 32-byte hex hash");
if (!Number.isInteger(vout) || vout < 0) die("--vout must be a non-negative integer");

// ---- 1. The script must be a real HTLC, and must round-trip ---------------
const witnessScript = fromHex(scriptHex);
const parsed = parseHTLCScript(witnessScript);
if (!parsed) die("that script is not a canonical Fistbump HTLC");
const rebuilt = buildHTLCScript(parsed);
if (toHex(rebuilt.scriptBytes) !== toHex(witnessScript)) {
  die("script does not round-trip through the canonical builder — refusing to use it");
}
const htlcAddress = btcHTLCAddress(rebuilt, network);

console.log("HTLC");
console.log(`  address        ${htlcAddress}`);
console.log(`  hashlock       ${toHex(parsed.hashlock)}`);
console.log(`  claim pubkey   ${toHex(parsed.claimPubkey)}   (counterparty)`);
console.log(`  refund pubkey  ${toHex(parsed.refundPubkey)}   (you must hold this key)`);
console.log(`  refund height  ${parsed.locktime}`);

// ---- 2. The outpoint must actually pay it, and still be unspent -----------
const tx = await (await get(`${api}/tx/${txid}`)).json();
const out = tx.vout?.[vout];
if (!out) die(`transaction has no output ${vout}`);
if (out.scriptpubkey_address !== htlcAddress) {
  die(
    `outpoint pays ${out.scriptpubkey_address}, not the HTLC address ${htlcAddress}.\n` +
      `       Either the script or the outpoint is wrong — do not proceed.`,
  );
}
const amountSats = Number(out.value);

const spend = await (await get(`${api}/tx/${txid}/outspend/${vout}`)).json();
if (spend.spent) {
  die(`that outpoint was already spent by ${spend.txid} — nothing left to refund`);
}

// ---- 3. The timelock must have expired ------------------------------------
const tip = Number(await (await get(`${api}/blocks/tip/height`)).text());
const blocksToGo = parsed.locktime - tip;

console.log("\nFunding");
console.log(`  outpoint       ${txid}:${vout}`);
console.log(`  amount         ${amountSats} sats`);
console.log(`  confirmed      height ${tx.status?.block_height ?? "(unconfirmed)"}`);
console.log(`  unspent        yes`);
console.log(`\nChain tip        ${tip}`);

if (blocksToGo > 0) {
  const hours = ((blocksToGo * 10) / 60).toFixed(1);
  console.log(
    `\nNOT SPENDABLE YET: the refund branch opens at ${parsed.locktime}, ` +
      `${blocksToGo} block${blocksToGo === 1 ? "" : "s"} away (~${hours}h).`,
  );
  console.log("A transaction built now is valid but will not relay until then.");
  if (!flag("yes")) {
    console.log("Re-run with --yes to build it anyway and hold it until the height lands.\n");
    process.exit(2);
  }
}

// ---- 4. Fees, and whether this is worth doing at all ----------------------
let feeRate = Number(arg("fee-rate", "0"));
if (!feeRate) {
  try {
    const est = await (await get(`${api}/fee-estimates`)).json();
    feeRate = Math.max(1, Math.ceil(Number(est["6"]) || 2));
  } catch {
    feeRate = 5;
  }
}

// One P2WSH input spent through the refund branch, one output. Witness is
// [sig, <empty>, script] — no preimage, so it is smaller than a claim.
const SIG_MAX = 72;
const nonWitness = 82;
const varInt = (n) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);
const witnessWeight =
  2 + 1 + [SIG_MAX, 0, witnessScript.length].reduce((n, l) => n + varInt(l) + l, 0);
const vbytes = nonWitness + Math.ceil(witnessWeight / 4);
// ---- 5. Build the PSBT, then report what it ACTUALLY pays -----------------
const { psbtHex } = buildHTLCSpendPsbt({
  fundingTxid: txid,
  fundingVout: vout,
  fundingAmountSats: amountSats,
  witnessScript,
  destination,
  feeRateSatPerVb: feeRate,
  branch: "refund",
  // CLTV is checked against the transaction's nLockTime, so the spend has to
  // carry it, and nSequence must be below 0xffffffff for that to be enforced.
  locktime: parsed.locktime,
  network,
});

// Read the figures back out of the transaction we just built rather than
// printing a parallel estimate. The two disagreed by a few sats when this was
// written, and a recovery tool that displays a number its own artifact does
// not contain is worse than one that displays nothing.
const built = decodeUnsignedTx(psbtHex);
if (built.txid !== txid || built.vout !== vout) {
  die("built PSBT does not spend the outpoint we verified — refusing to emit it");
}
if (built.locktime !== parsed.locktime) {
  die(`built PSBT has nLockTime ${built.locktime}, expected ${parsed.locktime}`);
}
if (built.sequence >= 0xffffffff) {
  die("built PSBT has nSequence 0xffffffff, which disables CLTV — refusing to emit it");
}
const receive = built.value;
const fee = amountSats - receive;

console.log(`\nFee`);
console.log(`  rate requested ${feeRate} sat/vB`);
console.log(`  size           ~${vbytes} vB`);
console.log(`  fee            ${fee} sats  (${(fee / vbytes).toFixed(2)} sat/vB actual)`);
console.log(`  you receive    ${receive} sats -> ${destination}`);
console.log(`  nLockTime      ${built.locktime}`);
console.log(`  nSequence      0x${built.sequence.toString(16)}`);

if (receive <= 546) {
  die(
    `after fees this pays ${receive} sats, at or below the dust limit.\n` +
      `       Wait for a cheaper fee market or pass a lower --fee-rate.`,
  );
}

console.log(`\nUnsigned PSBT (hex) — sign with the key for ${toHex(parsed.refundPubkey)}:\n`);
console.log(psbtHex);
console.log(
  `\nNext:\n` +
    `  1. Import into Sparrow (Tools -> Load Transaction -> From Text) or\n` +
    `     bitcoin-cli walletprocesspsbt "<base64>"  (convert hex->base64 first).\n` +
    `  2. Sign. Do NOT let the wallet change nLockTime (${parsed.locktime}) or nSequence.\n` +
    `  3. Broadcast once the chain reaches height ${parsed.locktime}.\n`,
);

/**
 * Minimal decode of the unsigned transaction inside a PSBT.
 *
 * Only enough to check the fields that decide whether this spend is valid and
 * pays the right place: outpoint, sequence, output value, locktime. Deliberately
 * independent of the builder so a bug there cannot hide behind its own output.
 */
function decodeUnsignedTx(psbtHexStr) {
  const b = Buffer.from(psbtHexStr, "hex");
  if (b.subarray(0, 5).toString("hex") !== "70736274ff") {
    throw new Error("not a PSBT");
  }
  // Global map: key 0x00 is the unsigned tx.
  let p = 5;
  const readVarInt = () => {
    const n = b[p];
    if (n < 0xfd) { p += 1; return n; }
    if (n === 0xfd) { const v = b.readUInt16LE(p + 1); p += 3; return v; }
    if (n === 0xfe) { const v = b.readUInt32LE(p + 1); p += 5; return v; }
    const v = Number(b.readBigUInt64LE(p + 1)); p += 9; return v;
  };
  let tx = null;
  for (;;) {
    const keyLen = readVarInt();
    if (keyLen === 0) break;
    const keyType = b[p];
    p += keyLen;
    const valLen = readVarInt();
    const val = b.subarray(p, p + valLen);
    p += valLen;
    if (keyType === 0x00) tx = val;
  }
  if (!tx) throw new Error("PSBT has no unsigned transaction");

  let q = 4; // version
  const txVarInt = () => {
    const n = tx[q];
    if (n < 0xfd) { q += 1; return n; }
    if (n === 0xfd) { const v = tx.readUInt16LE(q + 1); q += 3; return v; }
    if (n === 0xfe) { const v = tx.readUInt32LE(q + 1); q += 5; return v; }
    const v = Number(tx.readBigUInt64LE(q + 1)); q += 9; return v;
  };
  const nIn = txVarInt();
  if (nIn !== 1) throw new Error(`expected 1 input, found ${nIn}`);
  const txidLe = tx.subarray(q, q + 32); q += 32;
  const voutN = tx.readUInt32LE(q); q += 4;
  const scriptLen = txVarInt(); q += scriptLen;
  const sequence = tx.readUInt32LE(q); q += 4;
  const nOut = txVarInt();
  if (nOut !== 1) throw new Error(`expected 1 output, found ${nOut}`);
  const value = Number(tx.readBigUInt64LE(q)); q += 8;
  const spkLen = txVarInt(); q += spkLen;
  const locktime = tx.readUInt32LE(q);

  return {
    txid: Buffer.from(txidLe).reverse().toString("hex"),
    vout: voutN,
    sequence,
    value,
    locktime,
  };
}

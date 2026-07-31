// HTLC refund signer.
//
// Takes a PSBT that spends an HTLC through its refund branch, checks it against
// the chain, has a wallet sign it, assembles the witness stack by hand, and
// broadcasts.
//
// The witness assembly is the part no generic wallet does. A refund spend needs
// [signature, <empty>, witness_script] — the empty element is what selects the
// OP_ELSE branch. Wallet "finalize" routines do not recognise the script and
// either refuse or overwrite the witness with just the script, which fails at
// OP_IF with SCRIPT_ERR_UNBALANCED_CONDITIONAL. So the wallet is asked for a
// signature only, and finalizeHTLCSpend builds the rest.
//
// This signed and broadcast a real mainnet refund on 2026-07-29 (tx
// f7046f7442f8c589ae748e6fc847160e4101950dec65befa7793dda2558920a5), so the
// path is exercised rather than theoretical.
//
// Everything is checked before the signature is requested, because a signature
// over the wrong transaction is the one mistake that cannot be undone by
// closing the tab.

import {
  parseHTLCScript,
  buildHTLCScript,
  btcHTLCAddress,
  finalizeHTLCSpend,
  signAndFinalizeWithWIF,
  toHex,
} from "./bundle.js";
import { decodePsbt, scriptToAddress } from "./psbt.js";

const $ = (id) => document.getElementById(id);
const fromHex = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));

const SEQUENCE_FINAL = 0xffffffff;

/** State carried between the check step and the sign step. */
let checked = null;

function b64ToHex(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  let out = "";
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

/** Accept either spelling; the tool emits both and wallets disagree on which. */
function normalisePsbt(raw) {
  const s = raw.trim().replace(/\s+/g, "");
  if (/^70736274ff[0-9a-f]*$/i.test(s)) return s.toLowerCase();
  if (/^cHNidP/.test(s)) return b64ToHex(s);
  throw new Error("Not a PSBT — expected hex starting 70736274ff, or base64 starting cHNidP");
}

/**
 * Everything interpolated into the summary is hex, bech32, or a number, so
 * today none of it can carry markup. That is an argument that has to be re-made
 * every time the template is edited, which is how these things rot — so escape
 * instead and stop having to think about it.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function row(label, value, state) {
  const cls = state ? ` class="${state}"` : "";
  return `<tr><th>${esc(label)}</th><td${cls}>${value}</td></tr>`;
}

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = `status ${kind || ""}`;
  el.hidden = !msg;
}

// ---- Step 1: decode and check ------------------------------------------

async function check() {
  setStatus("", "");
  $("result").hidden = true;
  $("signBox").hidden = true;
  const problems = [];

  let psbtHex, decoded;
  try {
    psbtHex = normalisePsbt($("psbt").value);
    decoded = decodePsbt(fromHex(psbtHex));
  } catch (err) {
    setStatus(err.message, "bad");
    return;
  }

  const { tx } = decoded;
  const input = decoded.inputs[0];
  if (tx.vin.length !== 1) problems.push(`Expected exactly 1 input, found ${tx.vin.length}`);
  if (!input?.witnessUtxo) problems.push("Input has no witness UTXO — cannot verify what it spends");
  if (!input?.witnessScript) problems.push("Input has no witness script — nothing to spend through");
  if (input?.finalWitness) problems.push("This PSBT is already finalized");

  // The witness script must be a real HTLC, and must be THE script that locks
  // the coin being spent. Rebuilding it and comparing P2WSH addresses proves
  // both at once: a script that hashes to the funding output cannot be a
  // different script that merely looks similar.
  let parsed = null;
  let htlcAddress = null;
  if (input?.witnessScript) {
    parsed = parseHTLCScript(input.witnessScript);
    if (!parsed) {
      problems.push("Witness script does not parse as an HTLC");
    } else {
      htlcAddress = btcHTLCAddress(buildHTLCScript(parsed), "main");
      const fundingAddress = input.witnessUtxo
        ? scriptToAddress(input.witnessUtxo.script)
        : null;
      if (fundingAddress && htlcAddress !== fundingAddress) {
        problems.push(
          `Witness script does not lock this coin (script → ${htlcAddress}, coin → ${fundingAddress})`,
        );
      }
    }
  }

  // CLTV is enforced against BOTH fields. nSequence 0xffffffff disables
  // locktime entirely and the script rejects the spend; nLockTime below the
  // script's value fails OP_CHECKLOCKTIMEVERIFY.
  const seq = tx.vin[0]?.sequence;
  if (seq === SEQUENCE_FINAL) {
    problems.push("nSequence is 0xffffffff, which disables nLockTime — CLTV will reject this");
  }
  if (parsed && tx.locktime < parsed.locktime) {
    problems.push(`nLockTime ${tx.locktime} is below the script's ${parsed.locktime}`);
  }

  const inSats = input?.witnessUtxo?.amount ?? 0;
  const outSats = tx.vout.reduce((n, o) => n + o.value, 0);
  const fee = inSats - outSats;
  if (fee < 0) problems.push("Outputs exceed the input — this cannot be valid");

  // ~110 vB for a single-input HTLC refund with one P2WPKH output.
  const feeRate = fee > 0 ? (fee / 110).toFixed(2) : "0";

  // Chain checks. Failure to reach a node is reported, never treated as "fine".
  let tip = null;
  let spent = null;
  const txid = tx.vin[0]?.txid;
  try {
    tip = Number(await (await fetch("https://blockstream.info/api/blocks/tip/height")).text());
  } catch { /* reported below */ }
  try {
    const r = await fetch(`https://blockstream.info/api/tx/${txid}/outspend/${tx.vin[0].vout}`);
    spent = (await r.json()).spent;
  } catch { /* reported below */ }

  if (spent === true) problems.push("This output has already been spent");
  if (tip !== null && tip < tx.locktime) {
    problems.push(`Too early — tip is ${tip}, this cannot relay until ${tx.locktime}`);
  }

  const dest = tx.vout.map((o) => scriptToAddress(o.script) || toHex(o.script));

  $("summary").innerHTML = `
    <table>
      ${row("Spends", `<code>${esc(txid)}:${esc(tx.vin[0].vout)}</code>`)}
      ${row("From", `<code>${esc(input?.witnessUtxo ? scriptToAddress(input.witnessUtxo.script) : "?")}</code>`)}
      ${row("Amount in", `${esc(inSats.toLocaleString())} sats`)}
      ${row("Pays to", dest.map((d) => `<code class="dest">${esc(d)}</code>`).join("<br>"))}
      ${row("You receive", `<strong>${esc(outSats.toLocaleString())} sats</strong>`)}
      ${row("Fee", `${esc(fee.toLocaleString())} sats (~${esc(feeRate)} sat/vB)`)}
      ${row("nLockTime", esc(tx.locktime), tip !== null && tip >= tx.locktime ? "ok" : "warn")}
      ${row("nSequence", `0x${esc((seq >>> 0).toString(16))}`, seq === SEQUENCE_FINAL ? "bad" : "ok")}
      ${row("Chain tip", tip === null ? '<span class="warn">could not reach node</span>' : esc(tip))}
      ${row("Output spent?", spent === null ? '<span class="warn">could not check</span>' : spent ? '<span class="bad">YES</span>' : '<span class="ok">no</span>')}
      ${row("Refund key", parsed ? `<code>${esc(toHex(parsed.refundPubkey))}</code>` : "—")}
    </table>`;
  $("result").hidden = false;

  if (problems.length) {
    setStatus("Not safe to sign:\n• " + problems.join("\n• "), "bad");
    return;
  }
  if (tip === null || spent === null) {
    setStatus(
      "Checks passed, but the chain could not be reached — confirm the tip and that the output is unspent before broadcasting.",
      "warn",
    );
  } else {
    setStatus("All checks passed. Confirm the destination above is yours, then sign.", "ok");
  }

  checked = { psbtHex, witnessScript: input.witnessScript, refundPubkey: toHex(parsed.refundPubkey) };
  $("signBox").hidden = false;
  $("expectedKey").textContent = checked.refundPubkey;
}

// ---- Step 2: sign ------------------------------------------------------

async function signWithUnisat() {
  if (!checked) return;
  if (!window.unisat) {
    throw new Error(
      "window.unisat is not present. If this page is open as a file://, Unisat does not " +
        "inject there — run ./serve.command and use the http://127.0.0.1 address instead.",
    );
  }
  const accounts = await window.unisat.requestAccounts();
  const pubkey = (await window.unisat.getPublicKey()).toLowerCase();

  // The refund branch commits to one specific key. A signature from any other
  // account is valid-looking and completely useless, so this is checked before
  // the wallet is asked rather than after the spend fails. The library refuses
  // a wrong key too, but with an unreadable byte-array error.
  if (pubkey !== checked.refundPubkey.toLowerCase()) {
    throw new Error(
      `Wrong Unisat account.\nConnected: ${pubkey}\nNeeded:    ${checked.refundPubkey}\n\n` +
        "Switch accounts in Unisat and try again.",
    );
  }

  const signed = await window.unisat.signPsbt(checked.psbtHex, {
    autoFinalized: false,
    toSignInputs: [
      {
        index: 0,
        address: accounts[0],
        publicKey: pubkey,
        sighashTypes: [1],
        // The HTLC branch is signed with a plain ECDSA key. A taproot-tweaked
        // signature verifies against a different key and the script rejects it.
        disableTweakSigner: true,
      },
    ],
  });
  return finalizeHTLCSpend({
    signedPsbtHex: signed,
    witnessScript: checked.witnessScript,
    branch: "refund",
  });
}

function signWithWif() {
  const wif = $("wif").value.trim();
  if (!wif) throw new Error("Enter a WIF private key");
  return signAndFinalizeWithWIF({
    psbtHex: checked.psbtHex,
    witnessScript: checked.witnessScript,
    branch: "refund",
    wif,
    network: "main",
  });
}

async function doSign(fn) {
  setStatus("Signing…", "");
  try {
    const { rawTxHex, txid } = await fn();
    $("rawtx").value = rawTxHex;
    $("txidOut").textContent = txid;
    $("broadcastBox").hidden = false;
    // The WIF has done its job; leaving it in a form field serves no purpose.
    $("wif").value = "";
    setStatus("Signed. Nothing has been sent yet — review, then broadcast.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "bad");
  }
}

// ---- Step 3: broadcast -------------------------------------------------

async function broadcast() {
  const raw = $("rawtx").value.trim();
  if (!raw) return;
  setStatus("Broadcasting…", "");
  const errors = [];

  // Unisat first when present, then public endpoints. Any one succeeding means
  // the transaction is out; the rest are only there so a single unreachable
  // service is not the end of the attempt.
  if (window.unisat) {
    try {
      const txid = await window.unisat.pushTx(raw);
      return done(txid);
    } catch (err) { errors.push(`Unisat: ${err.message || err}`); }
  }
  for (const url of [
    "https://blockstream.info/api/tx",
    "https://mempool.space/api/tx",
  ]) {
    try {
      const res = await fetch(url, { method: "POST", body: raw });
      const text = (await res.text()).trim();
      if (res.ok && /^[0-9a-f]{64}$/i.test(text)) return done(text);
      errors.push(`${new URL(url).host}: ${text.slice(0, 200)}`);
    } catch (err) { errors.push(`${new URL(url).host}: ${err.message || err}`); }
  }
  setStatus(
    "Could not broadcast:\n• " + errors.join("\n• ") +
      "\n\nThe signed hex above is still valid — you can push it from anywhere.",
    "bad",
  );
}

function done(txid) {
  $("sentBox").hidden = false;
  $("sentTxid").textContent = txid;
  $("sentLink").href = `https://mempool.space/tx/${txid}`;
  setStatus("Broadcast. It should appear in the mempool within seconds.", "ok");
}

$("checkBtn").addEventListener("click", () => check().catch((e) => setStatus(e.message, "bad")));
$("unisatBtn").addEventListener("click", () => doSign(signWithUnisat));
$("wifBtn").addEventListener("click", () => doSign(signWithWif));
$("broadcastBtn").addEventListener("click", () => broadcast());
$("copyRaw").addEventListener("click", () => navigator.clipboard.writeText($("rawtx").value));

$("walletNote").textContent = window.unisat
  ? "Unisat detected."
  : "Unisat not detected on this page. If you opened this as a file://, run ./serve.command instead — extensions do not inject into file:// pages.";

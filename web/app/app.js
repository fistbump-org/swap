// Fistbump swap frontend. Pure client-side — no backend, no custody.
//
// Delegates all signing to the user's wallets:
//   - FBC side: window.fistbump (Fistbump browser extension)
//   - BTC side: window.unisat (Unisat / compatible BIP-174 wallet)
//
// This file exists to:
//   1. Walk the user through the protocol step-by-step.
//   2. Construct HTLC scripts + addresses via @fistbump/swap-core.
//   3. Encode/decode offer and accept blobs.
//   4. Invoke wallet APIs for signing and broadcast.
//
// All cryptographic work happens in the core library and in the wallets.

import {
  buildHTLCScript,
  parseHTLCScript,
  btcHTLCAddress,
  fbcHTLCAddress,
  generatePreimage,
  hashlockOf,
  generateOfferId,
  encodeBlob,
  decodeBlob,
  htlcsFromOfferAccept,
  verifyFundedBtc,
  verifyFundedFbc,
  toHex,
  fromHex,
  buildHTLCSpendPsbt,
  finalizeHTLCSpend,
  signAndFinalizeWithWIF,
} from "./core/index.js";

// Network config. Hard-coded to mainnet for production; individual users can
// override via a `?network=testnet` query string for ad-hoc testing.
const params = new URLSearchParams(location.search);
const BTC_NETWORK = params.get("btc") || "main";
const FBC_NETWORK = params.get("fbc") || "main";

// Block time heuristics for converting refund-window hours → block heights.
// These match SPEC.md §4.2 defaults.
const BTC_BLOCK_SECONDS = 600;
const FBC_BLOCK_SECONDS = 120;

// Session state for the Alice role.
const alice = {
  btc: null,
  fbc: null,
  preimage: null,
  hashlock: null,
  offerId: null,
  offer: null,
  accept: null,
  btcScript: null,
  fbcScript: null,
  btcFundedTxid: null,
  btcFundedVout: null,
};

// Session state for the Bob role.
const bob = {
  fbc: null,
  btc: null,
  offer: null,
  accept: null,
  btcScript: null,
  fbcScript: null,
  fbcFundedTxid: null,
  fbcFundedVout: null,
};

// ---- Role switch ----

const roleAlice = document.getElementById("role-alice");
const roleBob = document.getElementById("role-bob");
const flowAlice = document.getElementById("flow-alice");
const flowBob = document.getElementById("flow-bob");

function selectRole(name) {
  const isAlice = name === "alice";
  roleAlice.setAttribute("aria-selected", String(isAlice));
  roleBob.setAttribute("aria-selected", String(!isAlice));
  flowAlice.classList.toggle("hidden", !isAlice);
  flowBob.classList.toggle("hidden", isAlice);
}
roleAlice.addEventListener("click", () => selectRole("alice"));
roleBob.addEventListener("click", () => selectRole("bob"));

// ---- Wallet connection helpers ----

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("connected", "error");
  if (kind) el.classList.add(kind);
}

async function connectFistbump() {
  if (!window.fistbump || !window.fistbump.isFistbump) {
    throw new Error(
      "Fistbump wallet extension not found. Install the Fistbump desktop wallet.",
    );
  }
  const conn = await window.fistbump.connect();
  const { pubkey } = await window.fistbump.getPublicKey();
  return { address: conn.address, pubkey };
}

async function connectUnisat() {
  if (!window.unisat) {
    throw new Error(
      "Unisat wallet not found. Install Unisat, Xverse, or another BIP-174 wallet.",
    );
  }
  const accounts = await window.unisat.requestAccounts();
  if (!accounts || !accounts[0]) throw new Error("No Bitcoin account available");
  const pubkey = await window.unisat.getPublicKey();
  return { address: accounts[0], pubkey };
}

// ---- Alice: wallet connect ----

document.getElementById("btc-connect").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-status");
  try {
    setStatus(statusEl, "connecting…", null);
    alice.btc = await connectUnisat();
    setStatus(statusEl, alice.btc.address, "connected");
    updateAliceBuildOfferEnabled();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

document.getElementById("fbc-connect").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-status");
  try {
    setStatus(statusEl, "connecting…", null);
    alice.fbc = await connectFistbump();
    setStatus(statusEl, alice.fbc.address, "connected");
    updateAliceBuildOfferEnabled();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

// ---- Alice: offer building ----

const amountBtcInput = document.getElementById("amount-btc");
const amountFbcInput = document.getElementById("amount-fbc");
const btcHoursInput = document.getElementById("btc-hours");
const fbcHoursInput = document.getElementById("fbc-hours");
const timelockNote = document.getElementById("timelock-note");
const buildOfferBtn = document.getElementById("build-offer");

function updateTimelockNote() {
  const btcH = Number(btcHoursInput.value);
  const fbcH = Number(fbcHoursInput.value);
  if (fbcH - btcH < 12) {
    timelockNote.textContent =
      `FBC window must exceed BTC window by at least 12 hours. Currently ${fbcH - btcH} hrs.`;
    timelockNote.classList.remove("ok");
    timelockNote.classList.add("error");
  } else {
    timelockNote.textContent = `Your funds refund ${btcH}h after broadcast; their FBC refund is ${fbcH}h.`;
    timelockNote.classList.remove("error");
    timelockNote.classList.add("ok");
  }
}
[btcHoursInput, fbcHoursInput].forEach((el) =>
  el.addEventListener("input", () => {
    updateTimelockNote();
    updateAliceBuildOfferEnabled();
  }),
);
[amountBtcInput, amountFbcInput].forEach((el) =>
  el.addEventListener("input", updateAliceBuildOfferEnabled),
);
updateTimelockNote();

function updateAliceBuildOfferEnabled() {
  const amtBtc = Number(amountBtcInput.value);
  const amtFbc = Number(amountFbcInput.value);
  const btcH = Number(btcHoursInput.value);
  const fbcH = Number(fbcHoursInput.value);
  const valid =
    alice.btc &&
    alice.fbc &&
    amtBtc > 0 &&
    amtFbc > 0 &&
    btcH >= 1 &&
    fbcH >= 2 &&
    fbcH - btcH >= 12;
  buildOfferBtn.disabled = !valid;
}

async function fetchBtcTipHeight() {
  const base =
    BTC_NETWORK === "testnet"
      ? "https://mempool.space/testnet/api"
      : BTC_NETWORK === "regtest"
        ? (() => {
            throw new Error("regtest BTC tip requires a local explorer");
          })()
        : "https://mempool.space/api";
  const res = await fetch(`${base}/blocks/tip/height`);
  if (!res.ok) throw new Error(`mempool.space tip fetch failed: ${res.status}`);
  const n = Number(await res.text());
  if (!Number.isInteger(n) || n < 0) throw new Error("invalid tip height");
  return n;
}

async function fetchBtcFeeRate() {
  // mempool.space recommended fee rate in sat/vB. Falls back to 20 if
  // the service is unreachable — conservative for mainnet, wasteful for
  // testnet but claim/refund timing matters more than fee efficiency.
  try {
    const base =
      BTC_NETWORK === "testnet"
        ? "https://mempool.space/testnet/api"
        : BTC_NETWORK === "main"
          ? "https://mempool.space/api"
          : null;
    if (!base) return 20;
    const res = await fetch(`${base}/v1/fees/recommended`);
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    // Use halfHourFee so we clear within ~3 blocks; claim txs are
    // time-sensitive, refund txs are not, but the same default is fine.
    const rate = Number(j.halfHourFee);
    return rate > 0 && isFinite(rate) ? rate : 20;
  } catch {
    return 20;
  }
}

async function fetchFbcTipHeight() {
  try {
    if (window.fistbump && typeof window.fistbump.getTipHeight === "function") {
      const r = await window.fistbump.getTipHeight();
      if (typeof r === "number") return r;
    }
  } catch {
    /* fall through */
  }
  try {
    const base =
      FBC_NETWORK === "main"
        ? "https://explorer.fistbump.org/api"
        : FBC_NETWORK === "testnet"
          ? "https://explorer.testnet.fistbump.org/api"
          : null;
    if (base) {
      // Explorer exposes the latest blocks via /api/blocks?limit=N ordered
      // by height descending. Take the first and read its height.
      const res = await fetch(`${base}/blocks?limit=1`);
      if (res.ok) {
        const blocks = await res.json();
        const h = Array.isArray(blocks) && blocks[0] && Number(blocks[0].height);
        if (Number.isInteger(h) && h > 0) return h;
      }
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    "could not fetch FBC tip height — run with ?fbc=regtest for local testing",
  );
}

buildOfferBtn.addEventListener("click", async () => {
  buildOfferBtn.disabled = true;
  try {
    const amtBtcSats = Math.round(Number(amountBtcInput.value) * 1e8);
    const amtFbcBumps = Math.round(Number(amountFbcInput.value) * 1e6);
    const btcH = Number(btcHoursInput.value);
    const fbcH = Number(fbcHoursInput.value);

    const [btcTip, fbcTip] = await Promise.all([
      fetchBtcTipHeight().catch((e) => {
        throw new Error(`BTC tip: ${e.message}`);
      }),
      fetchFbcTipHeight().catch((e) => {
        throw new Error(`FBC tip: ${e.message}`);
      }),
    ]);

    alice.preimage = generatePreimage();
    alice.hashlock = hashlockOf(alice.preimage);
    alice.offerId = generateOfferId();

    const offer = {
      version: 1,
      kind: "offer",
      network: { btc: BTC_NETWORK, fbc: FBC_NETWORK },
      hashlock: toHex(alice.hashlock),
      alice_btc_pubkey: alice.btc.pubkey,
      alice_fbc_pubkey: alice.fbc.pubkey,
      amount_btc: amtBtcSats,
      amount_fbc: amtFbcBumps,
      btc_refund_height: btcTip + Math.ceil((btcH * 3600) / BTC_BLOCK_SECONDS),
      fbc_refund_height: fbcTip + Math.ceil((fbcH * 3600) / FBC_BLOCK_SECONDS),
      btc_reference_height: btcTip,
      fbc_reference_height: fbcTip,
      expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
      offer_id: alice.offerId,
    };
    alice.offer = offer;

    const envelope = encodeBlob(offer);
    document.getElementById("offer-blob").value = envelope;
    document.getElementById("offer-json").textContent = JSON.stringify(offer, null, 2);
    document.getElementById("process-accept").disabled = false;
  } catch (err) {
    alert(`Could not build offer: ${err.message}`);
  } finally {
    updateAliceBuildOfferEnabled();
  }
});

document.getElementById("copy-offer").addEventListener("click", () => {
  const v = document.getElementById("offer-blob").value;
  if (v) navigator.clipboard.writeText(v);
});

// ---- Alice: process accept, fund BTC ----

document.getElementById("process-accept").addEventListener("click", async () => {
  const raw = document.getElementById("accept-blob-in").value.trim();
  const statusEl = document.getElementById("accept-status");
  try {
    const accept = decodeBlob(raw);
    if (accept.kind !== "accept") throw new Error(`expected an accept blob, got ${accept.kind}`);
    if (accept.offer_id !== alice.offerId) throw new Error("offer_id mismatch");
    alice.accept = accept;

    const { btc, fbc } = htlcsFromOfferAccept(alice.offer, accept);
    alice.btcScript = buildHTLCScript(btc);
    alice.fbcScript = buildHTLCScript(fbc);

    const btcAddr = btcHTLCAddress(alice.btcScript, BTC_NETWORK);
    renderSummary(document.getElementById("btc-fund-summary"), [
      { label: "Fund amount", text: `${alice.offer.amount_btc.toLocaleString()} sat` },
      { label: "HTLC address", mono: btcAddr },
      {
        label: "Refund at block",
        text: alice.offer.btc_refund_height.toLocaleString(),
      },
      { label: "Hashlock", mono: `${alice.offer.hashlock.slice(0, 24)}…` },
    ]);
    document.getElementById("fund-btc").disabled = false;

    statusEl.textContent = "Accept verified. Review and fund when ready.";
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("fund-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-fund-status");
  try {
    if (!window.unisat) throw new Error("BTC wallet not connected");
    const addr = btcHTLCAddress(alice.btcScript, BTC_NETWORK);
    const txid = await window.unisat.sendBitcoin(addr, alice.offer.amount_btc);
    alice.btcFundedTxid = txid;
    alice.btcFundedVout = 0;
    const fundedBlob = encodeBlob({
      version: 1,
      kind: "funded_btc",
      offer_id: alice.offerId,
      funding_txid: txid,
      funding_vout: 0,
      funding_amount: alice.offer.amount_btc,
      witness_script_hex: toHex(alice.btcScript.scriptBytes),
    });
    await navigator.clipboard.writeText(fundedBlob);
    statusEl.textContent =
      `Funded. txid=${txid.slice(0, 12)}… funded_btc blob copied to clipboard — send it to your counterparty.`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
    document.getElementById("claim-fbc").disabled = false;
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Alice: claim FBC ----

// ---- Alice: refund BTC after T1 if counterparty never claimed ----

document.getElementById("refund-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("refund-btc-status");
  try {
    if (!alice.btcFundedTxid || !alice.btcScript) {
      throw new Error("you haven't funded BTC in this session");
    }
    if (!confirm(
      "Refund is only valid after the BTC refund height. " +
      "If you already claimed FBC in step 6, DO NOT refund — " +
      "the swap has already completed. Continue?"
    )) return;

    const witnessScript = alice.btcScript.scriptBytes;
    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: alice.btcFundedTxid,
      fundingVout: alice.btcFundedVout,
      fundingAmountSats: alice.offer.amount_btc,
      witnessScript,
      destination: alice.btc.address,
      feeRateSatPerVb: feeRate,
      branch: "refund",
      locktime: alice.offer.btc_refund_height,
      network: BTC_NETWORK,
    });

    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [
        {
          index: 0,
          address: alice.btc.address,
          publicKey: alice.btc.pubkey,
          sighashTypes: [1],
          disableTweakSigner: true,
        },
      ],
    });

    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript,
      branch: "refund",
    });

    const broadcastTxid = await window.unisat.pushTx(rawTxHex);
    statusEl.textContent = `BTC refund broadcast. txid=${(broadcastTxid || txid).slice(0, 12)}…`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("claim-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("claim-status");
  try {
    const raw = document.getElementById("funded-fbc-in").value.trim();
    const funded = decodeBlob(raw);
    if (funded.kind !== "funded_fbc") throw new Error("not a funded_fbc blob");
    const v = verifyFundedFbc(alice.offer, alice.accept, funded);
    if (!v.ok) throw new Error(`funded_fbc verification failed: ${v.reason}`);

    const res = await window.fistbump.signHtlcSpend({
      fundingTxid: funded.funding_txid,
      fundingVout: funded.funding_vout,
      fundingAmount: funded.funding_amount,
      witnessScriptHex: funded.witness_script_hex,
      branch: "claim",
      preimageHex: toHex(alice.preimage),
      destinationAddress: alice.fbc.address,
      feeRate: 1000,
    });
    statusEl.textContent =
      `Claim broadcast. txid=${res.txid.slice(0, 12)}… Counterparty can now claim BTC.`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: wallet connect ----

document.getElementById("fbc-connect-bob").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-status-bob");
  try {
    setStatus(statusEl, "connecting…", null);
    bob.fbc = await connectFistbump();
    setStatus(statusEl, bob.fbc.address, "connected");
    updateBobButtons();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});
document.getElementById("btc-connect-bob").addEventListener("click", async () => {
  const statusEl = document.getElementById("btc-status-bob");
  try {
    setStatus(statusEl, "connecting…", null);
    bob.btc = await connectUnisat();
    setStatus(statusEl, bob.btc.address, "connected");
    updateBobButtons();
  } catch (err) {
    setStatus(statusEl, err.message, "error");
  }
});

function updateBobButtons() {
  document.getElementById("process-offer").disabled = !(bob.fbc && bob.btc);
}

// ---- Bob: read offer, send accept ----

document.getElementById("process-offer").addEventListener("click", async () => {
  try {
    const raw = document.getElementById("offer-blob-in").value.trim();
    const offer = decodeBlob(raw);
    if (offer.kind !== "offer") throw new Error("not an offer blob");
    bob.offer = offer;

    const summary = document.getElementById("offer-summary");
    renderSummary(summary, [
      { label: "They send", text: `${offer.amount_btc.toLocaleString()} sat BTC` },
      { label: "You send", text: `${(offer.amount_fbc / 1e6).toLocaleString()} FBC` },
      { label: "BTC refund after", text: `block ${offer.btc_refund_height.toLocaleString()}` },
      { label: "FBC refund after", text: `block ${offer.fbc_refund_height.toLocaleString()}` },
      { label: "Hashlock", mono: `${offer.hashlock.slice(0, 24)}…` },
    ]);
    summary.classList.remove("hidden");

    const accept = {
      version: 1,
      kind: "accept",
      offer_id: offer.offer_id,
      bob_btc_pubkey: bob.btc.pubkey,
      bob_fbc_pubkey: bob.fbc.pubkey,
    };
    bob.accept = accept;
    document.getElementById("accept-blob").value = encodeBlob(accept);
    document.getElementById("fund-fbc").disabled = false;
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById("copy-accept").addEventListener("click", () => {
  const v = document.getElementById("accept-blob").value;
  if (v) navigator.clipboard.writeText(v);
});

// ---- Bob: verify counterparty BTC funding, fund FBC ----

document.getElementById("fund-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("fbc-fund-status");
  try {
    const raw = document.getElementById("funded-btc-in").value.trim();
    if (!raw) throw new Error("paste the counterparty's funded_btc blob first");
    const funded = decodeBlob(raw);
    if (funded.kind !== "funded_btc") throw new Error("not a funded_btc blob");
    const v = verifyFundedBtc(bob.offer, bob.accept, funded);
    if (!v.ok) throw new Error(`funded_btc verification failed: ${v.reason}`);
    // Keep the verified funded_btc around — Bob needs its txid, vout,
    // amount, and script to build the claim PSBT in step 5.
    bob.btcFunded = funded;

    const { fbc } = htlcsFromOfferAccept(bob.offer, bob.accept);
    bob.fbcScript = buildHTLCScript(fbc);
    void fbcHTLCAddress(bob.fbcScript, FBC_NETWORK);

    const res = await window.fistbump.fundHtlc({
      witnessScriptHex: toHex(bob.fbcScript.scriptBytes),
      amount: bob.offer.amount_fbc / 1e6,
      memo: `atomic swap ${bob.offer.offer_id.slice(0, 8)}`,
    });
    bob.fbcFundedTxid = res.txid;
    bob.fbcFundedVout = res.vout;

    const fundedFbcBlob = encodeBlob({
      version: 1,
      kind: "funded_fbc",
      offer_id: bob.offer.offer_id,
      funding_txid: res.txid,
      funding_vout: res.vout,
      funding_amount: bob.offer.amount_fbc,
      witness_script_hex: toHex(bob.fbcScript.scriptBytes),
    });
    await navigator.clipboard.writeText(fundedFbcBlob);
    statusEl.textContent =
      `FBC HTLC funded. txid=${res.txid.slice(0, 12)}… funded_fbc blob copied to clipboard.`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");

    document.getElementById("claim-btc").disabled = false;
    document.getElementById("refund-fbc").disabled = false;
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: claim BTC with revealed preimage ----

document.getElementById("claim-btc").addEventListener("click", async () => {
  const statusEl = document.getElementById("claim-btc-status");
  try {
    if (!bob.btcFunded) throw new Error("no verified funded_btc in this session");
    if (!bob.btc) {
      throw new Error(
        "connect Unisat first (step 1 above) — claim needs your BTC wallet to sign",
      );
    }
    const preimageHex = document.getElementById("preimage-in").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
      throw new Error("preimage must be 64 hex chars (32 bytes)");
    }
    const preimage = fromHex(preimageHex);

    // Pull the hashlock straight from the witness script so we don't depend
    // on bob.offer (which is null in resume mode). The script is the ground
    // truth anyway — if the preimage doesn't hash to what the script commits
    // to, nothing we try on-chain will work.
    const witnessScript = fromHex(bob.btcFunded.witness_script_hex);
    const parsed = parseHTLCScript(witnessScript);
    if (!parsed) throw new Error("witness script is not a valid HTLC");
    const computed = toHex(hashlockOf(preimage));
    const expectedHashlock = toHex(parsed.hashlock);
    if (computed !== expectedHashlock) {
      throw new Error(
        `preimage does not match the HTLC's hashlock. ` +
        `SHA256(preimage) = ${computed.slice(0, 16)}… ` +
        `but the HTLC commits to ${expectedHashlock.slice(0, 16)}…. ` +
        `(Hint: the 64-char hex from the "Unknown inputs not allowed" error ` +
        `was a txid, not a preimage. The preimage comes from Alice's FBC ` +
        `claim tx witness stack, item [1].)`,
      );
    }
    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: bob.btcFunded.funding_txid,
      fundingVout: bob.btcFunded.funding_vout,
      fundingAmountSats: bob.btcFunded.funding_amount,
      witnessScript,
      destination: bob.btc.address,
      feeRateSatPerVb: feeRate,
      branch: "claim",
      network: BTC_NETWORK,
    });

    // Unisat refuses to sign inputs it can't classify unless we explicitly
    // list both the address and the public key it should sign with — P2WSH
    // with a custom HTLC script doesn't match any of its known templates.
    // Unisat classifies inputs by output template. P2WSH with custom script
    // falls into "other" which it refuses by default. The rescue is
    // toSignInputs with explicit pubkey AND disableTweakSigner=true (the
    // tweak signer path is for Taproot; forcing it off tells Unisat to
    // produce a plain ECDSA signature, which is what CHECKSIG expects).
    const signedPsbtHex = await window.unisat.signPsbt(psbtHex, {
      autoFinalized: false,
      toSignInputs: [
        {
          index: 0,
          address: bob.btc.address,
          publicKey: bob.btc.pubkey,
          sighashTypes: [1],
          disableTweakSigner: true,
        },
      ],
    });

    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript,
      branch: "claim",
      preimage,
    });

    const broadcastTxid = await window.unisat.pushTx(rawTxHex);
    statusEl.textContent = `BTC claim broadcast. txid=${(broadcastTxid || txid).slice(0, 12)}…`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: export PSBT for external signing (Sparrow etc.) ----

document.getElementById("export-psbt").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  const out = document.getElementById("unsigned-psbt");
  try {
    if (!bob.btcFunded) throw new Error("no verified funded_btc in this session");
    const preimageHex = document.getElementById("preimage-in").value.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(preimageHex)) {
      throw new Error("enter the preimage first (64 hex chars)");
    }
    const preimage = fromHex(preimageHex);
    const witnessScript = fromHex(bob.btcFunded.witness_script_hex);
    const parsed = parseHTLCScript(witnessScript);
    if (!parsed) throw new Error("witness script is not a valid HTLC");
    if (toHex(hashlockOf(preimage)) !== toHex(parsed.hashlock)) {
      throw new Error("preimage does not hash to the HTLC's hashlock");
    }
    // Destination: if Bob's Unisat is connected, use that address; otherwise
    // ask inline. Signer can change it in Sparrow anyway before signing.
    const dest = bob.btc?.address
      || prompt("Destination BTC address for your claimed funds:")?.trim();
    if (!dest) throw new Error("destination address required");

    const feeRate = await fetchBtcFeeRate();
    const { psbtHex } = buildHTLCSpendPsbt({
      fundingTxid: bob.btcFunded.funding_txid,
      fundingVout: bob.btcFunded.funding_vout,
      fundingAmountSats: bob.btcFunded.funding_amount,
      witnessScript,
      destination: dest,
      feeRateSatPerVb: feeRate,
      branch: "claim",
      network: BTC_NETWORK,
    });
    out.value = psbtHex;
    // Stash for finalize step so we don't re-derive.
    bob.externalPreimage = preimage;
    bob.externalWitnessScript = witnessScript;
    statusEl.textContent = "PSBT ready. Sign in Sparrow, then paste the signed PSBT below.";
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("sign-with-wif").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  const wifInput = document.getElementById("wif-in");
  try {
    if (!bob.externalWitnessScript || !bob.externalPreimage) {
      throw new Error("click Export PSBT first");
    }
    const psbtHex = document.getElementById("unsigned-psbt").value.trim();
    if (!psbtHex) throw new Error("click Export PSBT first");
    const wif = wifInput.value.trim();
    if (!wif) throw new Error("paste your WIF private key");

    const { rawTxHex, txid } = signAndFinalizeWithWIF({
      psbtHex,
      witnessScript: bob.externalWitnessScript,
      branch: "claim",
      preimage: bob.externalPreimage,
      wif,
      network: BTC_NETWORK,
    });
    // Discard the WIF from the DOM immediately; we don't need it again.
    wifInput.value = "";

    const base =
      BTC_NETWORK === "testnet"
        ? "https://mempool.space/testnet/api"
        : BTC_NETWORK === "main"
          ? "https://mempool.space/api"
          : null;
    if (!base) throw new Error("regtest broadcast must use a local node");
    const res = await fetch(`${base}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected: ${body}`);
    statusEl.textContent = `BTC claim broadcast. txid=${(body || txid).slice(0, 12)}…`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

document.getElementById("finalize-external").addEventListener("click", async () => {
  const statusEl = document.getElementById("external-status");
  try {
    if (!bob.externalWitnessScript || !bob.externalPreimage) {
      throw new Error("click Export PSBT first");
    }
    const signedPsbtHex = document.getElementById("signed-psbt-in").value.trim();
    if (!signedPsbtHex) throw new Error("paste the signed PSBT first");
    const { rawTxHex, txid } = finalizeHTLCSpend({
      signedPsbtHex,
      witnessScript: bob.externalWitnessScript,
      branch: "claim",
      preimage: bob.externalPreimage,
    });
    // Broadcast via mempool.space since Unisat may not cooperate.
    const base =
      BTC_NETWORK === "testnet"
        ? "https://mempool.space/testnet/api"
        : BTC_NETWORK === "main"
          ? "https://mempool.space/api"
          : null;
    if (!base) throw new Error("regtest broadcast must use a local node");
    const res = await fetch(`${base}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    const body = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected: ${body}`);
    statusEl.textContent = `BTC claim broadcast. txid=${(body || txid).slice(0, 12)}…`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Bob: refund FBC if counterparty never claimed ----

document.getElementById("refund-fbc").addEventListener("click", async () => {
  const statusEl = document.getElementById("refund-fbc-status");
  try {
    if (!bob.fbcFundedTxid || !bob.fbcScript) {
      throw new Error("you haven't funded FBC in this session");
    }
    if (!confirm(
      "Refund is only valid after the FBC refund height. " +
      "Continue?"
    )) return;

    const res = await window.fistbump.signHtlcSpend({
      fundingTxid: bob.fbcFundedTxid,
      fundingVout: bob.fbcFundedVout,
      fundingAmount: bob.offer.amount_fbc,
      witnessScriptHex: toHex(bob.fbcScript.scriptBytes),
      branch: "refund",
      destinationAddress: bob.fbc.address,
      feeRate: 1000,
    });
    statusEl.textContent = `FBC refund broadcast. txid=${res.txid.slice(0, 12)}…`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.classList.remove("ok");
    statusEl.classList.add("error");
  }
});

// ---- Detail card renderer (DOM-safe, no innerHTML) ----
// Matches the .detail-card / .detail-row pattern used by web/ and docs/.

function renderSummary(container, rows) {
  container.replaceChildren();
  for (const row of rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "detail-row";

    const label = document.createElement("span");
    label.className = "detail-label";
    label.textContent = row.label;
    rowEl.appendChild(label);

    const value = document.createElement("span");
    value.className = "detail-value";
    if (row.mono) {
      const code = document.createElement("code");
      code.textContent = row.mono;
      value.appendChild(code);
    } else {
      value.textContent = row.text;
    }
    rowEl.appendChild(value);
    container.appendChild(rowEl);
  }
}

updateAliceBuildOfferEnabled();
updateBobButtons();

// ---- Dev resume ----
//
// Add `?resume=bob-claim-btc&funded=<base64url>&preimage=<hex>` to the URL
// to skip straight to Bob's step 5 with state preloaded, so iterating on
// the BTC claim signing path doesn't require redoing the full swap each
// time. `funded` is the `funded_btc` envelope Alice sent you; `preimage`
// is the hex string.
(async function maybeResume() {
  const mode = params.get("resume");
  if (!mode) return;
  try {
    if (mode === "bob-claim-btc") {
      selectRole("bob");
      // Pop a banner at the top of the Bob flow.
      const banner = document.createElement("div");
      banner.className = "field-note warn";
      banner.style.cssText =
        "border:1px solid var(--fb-accent-dim);padding:12px;border-radius:var(--fb-radius);margin-bottom:16px;";
      banner.textContent =
        "Resume mode: connect Unisat, then paste the preimage and click Claim my BTC. " +
        "Other steps are skipped.";
      flowBob.querySelector(".container").prepend(banner);

      // Need Unisat connected to sign. Wallet-connect stays manual.
      const fundedParam = params.get("funded");
      if (!fundedParam) throw new Error("resume=bob-claim-btc requires ?funded=<blob>");
      const envelope = fundedParam.startsWith("fistbump-swap:")
        ? fundedParam
        : `fistbump-swap:v1:${fundedParam}`;
      const funded = decodeBlob(envelope);
      if (funded.kind !== "funded_btc") {
        throw new Error("?funded= must be a funded_btc envelope");
      }
      bob.btcFunded = funded;

      const preimageParam = params.get("preimage");
      if (preimageParam && /^[0-9a-f]{64}$/i.test(preimageParam)) {
        document.getElementById("preimage-in").value = preimageParam.toLowerCase();
      }
      document.getElementById("claim-btc").disabled = false;
    }
  } catch (err) {
    console.error("resume failed:", err);
    alert("Resume failed: " + err.message);
  }
})();

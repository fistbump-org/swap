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
      const res = await fetch(`${base}/tip`);
      if (res.ok) {
        const j = await res.json();
        if (typeof j.height === "number") return j.height;
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

    const { fbc } = htlcsFromOfferAccept(bob.offer, bob.accept);
    bob.fbcScript = buildHTLCScript(fbc);
    // Compute the FBC P2WSH address for display, even though the wallet
    // computes its own commitment. Shows the user the real on-chain target.
    void fbcHTLCAddress(bob.fbcScript, FBC_NETWORK);

    const res = await window.fistbump.fundHtlc({
      witnessScriptHex: toHex(bob.fbcScript.scriptBytes),
      amount: bob.offer.amount_fbc / 1e6,
      memo: `atomic swap ${bob.offer.offer_id.slice(0, 8)}`,
    });
    statusEl.textContent =
      `FBC HTLC funded. txid=${res.txid.slice(0, 12)}… funded_fbc blob copied to clipboard.`;
    statusEl.classList.remove("error");
    statusEl.classList.add("ok");

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

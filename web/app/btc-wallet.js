// BTC wallet adapters.
//
// Three providers expose broadly the same capabilities under incompatible
// shapes. This normalises them so the swap flows can ask for what they need
// without caring who is answering.
//
// A caveat that matters more here than in most integrations: **funding a swap
// and spending one are different problems**. Funding is an ordinary payment to
// a P2WSH address and every wallet does it. Spending is a custom P2WSH input
// whose witness script is a one-off HTLC, and wallets routinely refuse those —
// Unisat returns "Unknown inputs not allowed" on some builds (SPEC §11.2), and
// hardware wallets refuse by design because they cannot attribute a script
// containing a counterparty's raw pubkey.
//
// So `signPsbt` here is allowed to fail, and every caller must be able to fall
// back to handing the user the unsigned PSBT. That fallback is the actual
// support story; these adapters are a convenience on top of it.

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   connect: () => Promise<{ address: string, pubkey: string }>,
 *   signPsbt: (psbtHex: string, opts: { address: string, pubkey: string }) => Promise<string>,
 *   pushTx: (rawTxHex: string) => Promise<string>,
 *   sendBitcoin: (address: string, amountSats: number, opts?: { feeRate?: number }) => Promise<string>,
 * }} BtcWallet
 */

/**
 * `feeRate` is sat/vB and is a request, not a guarantee — a wallet that does
 * not accept one picks its own default, and the caller has to cope either way.
 *
 * It is passed at all because a swap has a confirmation target the wallet
 * cannot know. A funding transaction is not an ordinary payment that can
 * confirm whenever: the maker will not release the FBC side until it has 6
 * confirmations, and the refund timelock is counting down the whole time. A
 * wallet default aimed at "sometime today" turns a swap into a stall — one
 * mainnet funding went out at 1.0 sat/vB against a 1.14 sat/vB six-block
 * estimate and sat unconfirmed for the best part of an hour.
 */

/** Unisat, and OKX which mirrors its interface under a different global. */
function unisatLike(provider, id, label) {
  return {
    id,
    label,
    async connect() {
      const accounts = await provider.requestAccounts();
      if (!accounts?.[0]) throw new Error(`${label}: no account returned`);
      const pubkey = await provider.getPublicKey();
      return { address: accounts[0], pubkey };
    },
    async signPsbt(psbtHex, { address, pubkey }) {
      return provider.signPsbt(psbtHex, {
        autoFinalized: false,
        toSignInputs: [
          {
            index: 0,
            address,
            publicKey: pubkey,
            sighashTypes: [1],
            // The HTLC branch is signed with a plain ECDSA key, not a
            // taproot-tweaked one; tweaking produces a signature the script
            // cannot verify.
            disableTweakSigner: true,
          },
        ],
      });
    },
    pushTx: (rawTxHex) => provider.pushTx(rawTxHex),
    // Unisat and OKX both take {feeRate} in sat/vB as a third argument. Older
    // builds ignore an option they do not know rather than rejecting, so this
    // is safe to pass unconditionally — but a rate of 0 or NaN would be obeyed
    // by a build that does read it, so only send a positive finite number.
    sendBitcoin: (address, amountSats, { feeRate } = {}) =>
      Number.isFinite(feeRate) && feeRate > 0
        ? provider.sendBitcoin(address, amountSats, { feeRate })
        : provider.sendBitcoin(address, amountSats),
  };
}

/**
 * Xverse, via the sats-connect provider it injects.
 *
 * Its request/response shape is entirely different from Unisat's: a single
 * `request(method, params)` returning `{status, result}`. Marked UNVERIFIED
 * because it has not been exercised against a real Xverse build — if it is
 * wrong, the PSBT panel is what saves the user, which is why that path is not
 * optional.
 */
function xverse(provider) {
  const call = async (method, params) => {
    const res = await provider.request(method, params);
    if (res?.status === "error" || res?.error) {
      throw new Error(res?.error?.message || `Xverse rejected ${method}`);
    }
    return res?.result ?? res;
  };
  return {
    id: "xverse",
    label: "Xverse",
    async connect() {
      const r = await call("getAccounts", {
        purposes: ["payment"],
        message: "Connect to Fistbump Swap",
      });
      const acct = Array.isArray(r) ? r.find((a) => a.purpose === "payment") || r[0] : r;
      if (!acct?.address) throw new Error("Xverse: no payment account");
      return { address: acct.address, pubkey: acct.publicKey };
    },
    async signPsbt(psbtHex, { address }) {
      const r = await call("signPsbt", {
        psbt: hexToBase64(psbtHex),
        signInputs: { [address]: [0] },
        broadcast: false,
      });
      const signed = r?.psbt ?? r;
      if (typeof signed !== "string") throw new Error("Xverse returned no PSBT");
      // sats-connect speaks base64; the rest of this codebase speaks hex.
      return /^[0-9a-fA-F]+$/.test(signed) ? signed : base64ToHex(signed);
    },
    async pushTx(rawTxHex) {
      const r = await call("sendRawTransaction", { rawTx: rawTxHex });
      return r?.txid ?? r;
    },
    // sats-connect's sendTransfer has no fee-rate parameter — Xverse prompts
    // the user for it in its own UI. The option is accepted and dropped rather
    // than being a different signature, so callers stay uniform; the caller
    // shows the recommended rate on screen for exactly this case.
    async sendBitcoin(address, amountSats) {
      const r = await call("sendTransfer", {
        recipients: [{ address, amount: amountSats }],
      });
      return r?.txid ?? r;
    },
  };
}

/** Every provider currently present in the page, best-supported first. */
export function detectBtcWallets() {
  const out = [];
  if (typeof window !== "undefined") {
    if (window.unisat) out.push(unisatLike(window.unisat, "unisat", "Unisat"));
    if (window.okxwallet?.bitcoin) {
      out.push(unisatLike(window.okxwallet.bitcoin, "okx", "OKX Wallet"));
    }
    const xv = window.XverseProviders?.BitcoinProvider || window.BitcoinProvider;
    if (xv?.request) out.push(xverse(xv));
  }
  return out;
}

/**
 * Pick a wallet: the one the user chose before if it is still present,
 * otherwise the first detected. Returns null when nothing is installed, which
 * callers must treat as "offer the PSBT path", not as a hard failure.
 */
export function selectBtcWallet(preferredId) {
  const found = detectBtcWallets();
  if (!found.length) return null;
  return found.find((w) => w.id === preferredId) || found[0];
}

export function hexToBase64(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function base64ToHex(b64) {
  const bin = atob(b64);
  let hex = "";
  for (let i = 0; i < bin.length; i++) {
    hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return hex;
}

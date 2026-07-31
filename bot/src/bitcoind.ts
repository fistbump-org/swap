/**
 * Bitcoin Core JSON-RPC: chain queries, broadcast, and claim-key load
 * from a named wallet (same idea as fbd wallet for FBC).
 */

import { readFileSync, existsSync } from "node:fs";

import { config } from "./config.js";
import { networkParams } from "./networks.js";

function rpcAuthHeader(): string | null {
  if (config.bitcoinRpcCookie && existsSync(config.bitcoinRpcCookie)) {
    const raw = readFileSync(config.bitcoinRpcCookie, "utf8").trim();
    // Core cookie is typically "username:password"
    return "Basic " + Buffer.from(raw, "utf8").toString("base64");
  }
  if (config.bitcoinRpcUser || config.bitcoinRpcPassword) {
    const u = config.bitcoinRpcUser || "__cookie__";
    const p = config.bitcoinRpcPassword;
    return "Basic " + Buffer.from(`${u}:${p}`, "utf8").toString("base64");
  }
  // Credentials may be embedded in URL: http://user:pass@host:8332
  try {
    const u = new URL(config.bitcoinRpcUrl);
    if (u.username || u.password) {
      const token = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      return "Basic " + Buffer.from(token, "utf8").toString("base64");
    }
  } catch {
    /* ignore */
  }
  return null;
}

function rpcEndpoint(): string {
  const u = new URL(config.bitcoinRpcUrl);
  // strip userinfo from fetch URL (auth goes in header)
  u.username = "";
  u.password = "";
  // Multi-wallet: http://host:8332/wallet/mywallet
  // (Core requires this path for wallet-scoped RPCs)
  if (config.bitcoinRpcWallet) {
    const name = config.bitcoinRpcWallet;
    // If user already put /wallet/ in the URL, leave it.
    if (!u.pathname.includes("/wallet/")) {
      u.pathname = `/wallet/${encodeURIComponent(name)}`;
    }
  }
  return u.toString().replace(/\/+$/, "");
}

export function useBitcoind(): boolean {
  return Boolean(config.bitcoinRpcUrl);
}

export async function bitcoindCall<T = unknown>(
  method: string,
  params: unknown[] = [],
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const auth = rpcAuthHeader();
  if (auth) headers.Authorization = auth;

  const res = await fetch(rpcEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "1.0",
      id: "fistbump-mm",
      method,
      params,
    }),
  });
  const text = await res.text();
  let parsed: {
    result?: T;
    error?: { code: number; message: string } | null;
  };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`bitcoind non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (res.status === 401) {
    throw new Error(
      "bitcoind auth failed (401). Set BITCOIN_RPC_USER/PASSWORD or BITCOIN_RPC_COOKIE.",
    );
  }
  if (parsed.error) {
    throw new Error(
      `bitcoind ${method}: ${parsed.error.message} (${parsed.error.code})`,
    );
  }
  return parsed.result as T;
}

export async function bitcoindTip(): Promise<number> {
  return bitcoindCall<number>("getblockcount");
}

/** sat/vB from estimatesmartfee (targets ~3 blocks). */
export async function bitcoindFeeRate(): Promise<number> {
  const FLOOR = 3;
  const CEILING = 500;
  try {
    const r = await bitcoindCall<{ feerate?: number; errors?: string[] }>(
      "estimatesmartfee",
      [3],
    );
    // feerate is BTC/kvB
    if (r.feerate && r.feerate > 0) {
      const satPerVb = Math.ceil((r.feerate * 1e8) / 1000);
      return Math.min(Math.max(satPerVb, FLOOR), CEILING);
    }
  } catch {
    /* fall through */
  }
  return 20;
}

export async function bitcoindBroadcast(rawTxHex: string): Promise<string> {
  return bitcoindCall<string>("sendrawtransaction", [rawTxHex]);
}

/**
 * Is this tx sitting in our node's mempool?
 *
 * `getrawtransaction` returning 0 confirmations cannot tell "waiting to be
 * mined" from "never heard of it", and the difference decides whether a claim
 * is still alive. `null` means the node could not tell us — never treat that
 * as "gone".
 */
export async function bitcoindInMempool(txid: string): Promise<boolean | null> {
  try {
    await bitcoindCall("getmempoolentry", [txid]);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not in mempool|-5\)/i.test(msg)) return false;
    return null;
  }
}

/**
 * Confirmation count, or null when the node could not answer.
 *
 * `bitcoindConfirmations` collapses an RPC failure to 0, which is fine for
 * "have we waited long enough" but catastrophic for "did our spend land":
 * there, 0 and "could not ask" lead to opposite decisions, and one of them is
 * declaring a swap we actually won to be lost.
 */
export async function bitcoindConfirmationsStrict(txid: string): Promise<number | null> {
  try {
    const tx = await bitcoindCall<{ confirmations?: number }>("getrawtransaction", [txid, true]);
    const n = Number(tx.confirmations);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "No such mempool or blockchain transaction" is a real answer: the tx is
    // not known at all, which for our own broadcast means it did not stick.
    if (/No such mempool or blockchain transaction|not found/i.test(msg)) return 0;
    return null;
  }
}

export async function bitcoindConfirmations(txid: string): Promise<number> {
  try {
    const tx = await bitcoindCall<{
      confirmations?: number;
    }>("getrawtransaction", [txid, true]);
    return Math.max(0, Number(tx.confirmations) || 0);
  } catch {
    return 0;
  }
}

/**
 * Verify a funding outpoint really exists, pays what it claims, and is still
 * spendable by us.
 *
 * The unspent check is the important part. `getrawtransaction` happily returns
 * a transaction whose outputs were spent long ago, so verifying with it alone
 * lets a taker re-present an outpoint we already claimed — or one they already
 * refunded — and collect another FBC HTLC for it.
 */
export async function bitcoindVerifyFunding(params: {
  txid: string;
  vout: number;
  address: string;
  amountSats: number;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!/^[0-9a-f]{64}$/i.test(params.txid)) {
    return { ok: false, reason: "funding_txid is not a 32-byte hex hash" };
  }
  if (!Number.isInteger(params.vout) || params.vout < 0 || params.vout > 100_000) {
    return { ok: false, reason: `implausible funding_vout ${params.vout}` };
  }

  // gettxout consults the UTXO set: null means "spent or never existed".
  //
  // include_mempool MUST be true, and both halves of that matter:
  //   - the taker posts funded_btc seconds after broadcasting, so with `false`
  //     their still-unconfirmed output is simply absent and every honest swap
  //     is rejected at submission;
  //   - `true` also overlays mempool spends, so an outpoint the taker has
  //     already begun spending disappears — which is the protective direction.
  // Depth is a separate question, answered by the confirmation count before we
  // commit any FBC (see the pre-funding re-check in mm.ts).
  let utxo: {
    value?: number;
    confirmations?: number;
    scriptPubKey?: { address?: string; addresses?: string[] };
  } | null;
  try {
    utxo = await bitcoindCall("gettxout", [params.txid, params.vout, true]);
  } catch (err) {
    // Distinguishable from "spent": the caller must not treat an RPC outage as
    // proof the taker took their money back.
    return {
      ok: false,
      reason: `RPC_UNAVAILABLE gettxout failed: ${err instanceof Error ? err.message : err}`,
    };
  }
  if (!utxo) {
    return {
      ok: false,
      reason:
        `outpoint ${params.txid}:${params.vout} is not in the UTXO set — ` +
        `already spent, or never broadcast`,
    };
  }

  const addr = utxo.scriptPubKey?.address || utxo.scriptPubKey?.addresses?.[0] || "";
  if (addr !== params.address) {
    return { ok: false, reason: `address mismatch: got ${addr}, want ${params.address}` };
  }
  // Core verbose value is BTC (float)
  const sats = Math.round(Number(utxo.value) * 1e8);
  if (sats !== params.amountSats) {
    return {
      ok: false,
      reason: `amount mismatch: got ${sats} sat, want ${params.amountSats}`,
    };
  }
  return { ok: true };
}

/** Guard against pointing a mainnet wallet at a testnet node, or vice versa. */
export async function bitcoindAssertNetwork(expected: "main" | "testnet" | "regtest") {
  const info = await bitcoindCall<{ chain?: string }>("getblockchaininfo");
  const want = expected === "main" ? "main" : expected === "testnet" ? "test" : "regtest";
  if (info.chain !== want) {
    throw new Error(
      `BTC_NETWORK=${expected} but bitcoind reports chain="${info.chain}" (expected "${want}")`,
    );
  }
}

/**
 * Load claim key from Core wallet `BTC_RPC_WALLET` (same idea as fbd wallet).
 * - Prefer BTC_CLAIM_ADDRESS, else reuse saved address, else getnewaddress.
 * - Prefer dumpprivkey; on descriptor wallets use listdescriptors(true)+HD derive.
 * Key is held in bot memory only for signing — not stored in .env.
 */
export async function bitcoindLoadClaimKey(): Promise<{
  wif: string;
  address: string;
  pubkeyHex: string;
}> {
  if (config.btcWalletPassphrase) {
    try {
      await bitcoindCall("walletpassphrase", [
        config.btcWalletPassphrase,
        120,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already unlocked/i.test(msg)) {
        console.warn("[bitcoind] walletpassphrase:", msg);
      }
    }
  }

  const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import(
    "node:fs"
  );
  const { join } = await import("node:path");
  const claimFile = join(config.dataDir, "btc-claim-address");

  let address = config.btcClaimAddress.trim();
  if (!address && existsSync(claimFile)) {
    address = readFileSync(claimFile, "utf8").trim();
  }
  if (!address) {
    try {
      address = await bitcoindCall<string>("getnewaddress", [
        "mm-claim",
        "bech32",
      ]);
    } catch {
      address = await bitcoindCall<string>("getnewaddress", ["mm-claim"]);
    }
    mkdirSync(config.dataDir, { recursive: true });
    writeFileSync(claimFile, address + "\n", { mode: 0o600 });
    console.log(
      `[bitcoind] claim address in wallet ${config.bitcoinRpcWallet || "default"}: ${address}`,
    );
  }

  const info = await bitcoindCall<{
    ismine?: boolean;
    iswatchonly?: boolean;
    pubkey?: string;
    hdkeypath?: string;
  }>("getaddressinfo", [address]);

  if (info.iswatchonly && !info.ismine) {
    throw new Error(
      `BTC address ${address} is watch-only in Core wallet ` +
        `'${config.bitcoinRpcWallet || "default"}'`,
    );
  }
  if (info.ismine === false) {
    throw new Error(
      `BTC address ${address} is not in Core wallet '${config.bitcoinRpcWallet || "default"}'`,
    );
  }

  let wif: string;
  try {
    wif = await bitcoindCall<string>("dumpprivkey", [address]);
  } catch {
    wif = await wifFromDescriptors(address, info.hdkeypath);
  }

  return {
    wif,
    address,
    pubkeyHex: (info.pubkey || "").replace(/^0x/, ""),
  };
}

/** Descriptor-wallet path: listdescriptors(true) + derive child for address. */
async function wifFromDescriptors(
  address: string,
  hdkeypath?: string,
): Promise<string> {
  const { HDKey } = await import("@scure/bip32");
  const btc = await import("@scure/btc-signer");

  if (!hdkeypath) {
    throw new Error(
      `No hdkeypath for ${address}; cannot derive from descriptors`,
    );
  }

  let listed: { descriptors: Array<{ desc: string; active?: boolean }> };
  try {
    listed = await bitcoindCall("listdescriptors", [true]);
  } catch (err) {
    throw new Error(
      `dumpprivkey unsupported and listdescriptors(true) failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }

  // e.g. m/84h/0h/0h/0/19
  const fullPath = hdkeypath
    .replace(/^m\//i, "")
    .replace(/'/g, "h")
    .split("/")
    .filter(Boolean);

  for (const d of listed.descriptors || []) {
    const desc = d.desc || "";
    if (!desc.includes("prv")) continue;
    // Native segwit only (bc1q…)
    if (!/wpkh\(/.test(desc) || /sh\(wpkh/.test(desc)) continue;

    // wpkh([fpr/84h/0h/0h]xprv…/0/*)#cs  OR  wpkh(xprv…/84h/0h/0h/0/*)#cs
    const withOrigin = desc.match(
      /\[([0-9a-fA-F]{8})\/([0-9hH/']+)\]([xt]prv[1-9A-HJ-NP-Za-km-z]+)/,
    );
    const masterStyle = desc.match(
      /([xt]prv[1-9A-HJ-NP-Za-km-z]+)\/([0-9hH/'*\/]+)\)/,
    );

    let xprv: string;
    let rel: string[];

    if (withOrigin) {
      xprv = withOrigin[3]!;
      const origin = withOrigin[2]!
        .replace(/'/g, "h")
        .split("/")
        .filter(Boolean);
      if (
        fullPath.length >= origin.length &&
        fullPath.slice(0, origin.length).every((p, i) => p === origin[i])
      ) {
        rel = fullPath.slice(origin.length);
      } else {
        rel = fullPath.slice(-2);
      }
    } else if (masterStyle) {
      // Master xprv — derive entire address path (common Core format)
      xprv = masterStyle[1]!;
      rel = fullPath;
    } else {
      continue;
    }

    try {
      let key = HDKey.fromExtendedKey(xprv);
      for (const p of rel) {
        const hardened = /[hH]$/.test(p);
        const n = parseInt(p.replace(/[hH']/g, ""), 10);
        if (!Number.isFinite(n)) throw new Error(`bad path ${p}`);
        key = key.deriveChild(hardened ? n + 0x80000000 : n);
      }
      if (!key.privateKey) continue;

      // networkParams, not a main/test ternary: regtest addresses are `bcrt1…`,
      // so under TEST_NETWORK the `derived !== address` check below never
      // matched and key loading failed for every descriptor wallet on regtest.
      const net = networkParams(config.btcNetwork);
      const wif = btc.WIF(net).encode(key.privateKey);
      const { secp256k1 } = await import("@noble/curves/secp256k1");
      const pub = secp256k1.getPublicKey(key.privateKey, true);
      const derived = btc.p2wpkh(pub, net).address;
      if (derived !== address) continue;
      return wif;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Could not derive privkey for ${address} from listdescriptors. ` +
      `Path=${hdkeypath}. Ensure wallet is unlocked and descriptors include private keys.`,
  );
}

/**
 * Spendable BTC, in **satoshis**, that this wallet could commit to a new HTLC
 * right now.
 *
 * Returns sats, never BTC. Core speaks decimal BTC on every balance RPC, and
 * this codebase speaks sats everywhere inside — that boundary is exactly where
 * a 1e8 error lives, and one has already happened here once, on the quote
 * endpoint. The conversion happens on this line and nowhere else.
 *
 * `mine.trusted` specifically: confirmed coins plus our own unconfirmed
 * change, which is the honest answer to "what could we spend in the next
 * transaction". `untrusted_pending` is inbound money not yet confirmed —
 * counting it would let us promise an HTLC backed by a payment that can still
 * be reorged or replaced. `immature` is coinbase that cannot be spent at all.
 *
 * Throws rather than returning 0 when the node will not answer. A zero balance
 * and an unreachable node are different facts, and only one of them means "do
 * not quote" — the other means "we do not know", which callers must treat as
 * refusing to quote for a different reason and must never read as "broke".
 */
export async function bitcoindSpendableSats(): Promise<number> {
  const balances = await bitcoindCall<{
    mine?: { trusted?: number; untrusted_pending?: number; immature?: number };
  }>("getbalances");
  const trusted = balances?.mine?.trusted;
  if (typeof trusted !== "number" || !Number.isFinite(trusted)) {
    throw new Error(
      "RPC_UNAVAILABLE bitcoind getbalances returned no mine.trusted — " +
        "is BITCOIN_RPC_WALLET set and the wallet loaded?",
    );
  }
  if (trusted < 0) {
    throw new Error(`bitcoind reported a negative balance (${trusted} BTC)`);
  }
  return Math.round(trusted * 1e8);
}

/**
 * Whether bitcoind considers this a valid address ON THE NETWORK IT IS ON.
 *
 * Asked of the node rather than parsed here on purpose. The node is
 * authoritative about its own network, and the failure this prevents —
 * withdrawing mainnet coins to an address that only parses on testnet, or to a
 * bech32 string with a good checksum and the wrong HRP — is unrecoverable.
 * A local bech32 implementation would be a second opinion that can disagree
 * with the thing actually broadcasting the transaction.
 */
export async function bitcoindValidateAddress(address: string): Promise<boolean> {
  const r = await bitcoindCall<{ isvalid?: boolean }>("validateaddress", [address]);
  return r?.isvalid === true;
}

/**
 * Send BTC from the maker's wallet.
 *
 * Takes satoshis and converts once, here, because Core's send RPCs speak
 * decimal BTC and every other amount in this codebase is an integer of base
 * units. `toFixed(8)` rather than division alone: 0.1 + 0.2 arithmetic reaching
 * a wallet RPC as 0.30000000000000004 is rejected by Core, and worse, an amount
 * built by any arithmetic can carry noise into a real payment.
 *
 * `subtractfeefrom` exists so a "send everything" withdrawal is possible at
 * all — without it the wallet must hold the fee on top of the amount, and
 * "send my whole balance" can never be satisfied.
 */
export async function bitcoindSendToAddress(params: {
  address: string;
  sats: number;
  feeRate?: number;
  subtractFeeFromAmount?: boolean;
}): Promise<string> {
  const { address, sats, feeRate, subtractFeeFromAmount } = params;
  if (!Number.isInteger(sats) || sats <= 0) {
    throw new Error(`sats must be a positive integer, got ${sats}`);
  }
  const amountBtc = (sats / 1e8).toFixed(8);
  // Positional, in Core's documented order:
  //   address amount comment comment_to subtractfeefromamount replaceable
  //   conf_target estimate_mode avoid_reuse fee_rate
  // The empty comment slots have to be sent to reach the flags after them.
  return bitcoindCall<string>("sendtoaddress", [
    address,
    amountBtc,
    "", // comment
    "", // comment_to
    subtractFeeFromAmount === true,
    true, // replaceable — a stuck withdrawal must be bumpable
    null, // conf_target, unset when fee_rate is given
    null, // estimate_mode
    false, // avoid_reuse
    feeRate && feeRate > 0 ? feeRate : null, // fee_rate in sat/vB
  ]);
}

import { config } from "./config.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export class FbdClient {
  constructor(
    private url = config.fbdRpcUrl,
    private password = config.fbdRpcPassword,
    private wallet = config.fbdWallet,
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = [], wallet = true): Promise<T> {
    const body: Record<string, unknown> = {
      method,
      params,
      id: 1,
    };
    if (wallet && this.wallet) body.wallet = this.wallet;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "fistbump-mm-bot",
    };
    if (this.password) {
      headers.Authorization =
        "Basic " + Buffer.from(`x:${this.password}`, "utf8").toString("base64");
    }

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `fbd RPC connection failed (${this.url}): ${err instanceof Error ? err.message : err}. Is fbd running?`,
      );
    }
    const text = await res.text();
    if (res.status === 401) {
      throw new Error(
        `fbd RPC auth failed (401). Set FBD_RPC_COOKIE to your datadir .cookie ` +
          `(e.g. ~/.fistbump/fbd-data/.cookie) or FBD_RPC_PASSWORD.`,
      );
    }
    let parsed: { result?: T; error?: { code: number; message: string } | string | null };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`fbd RPC non-JSON (${res.status}): ${text.slice(0, 200)}`);
    }
    if (parsed.error != null && parsed.error !== null) {
      const e = parsed.error;
      const msg =
        typeof e === "string"
          ? e
          : (e as { message?: string }).message || JSON.stringify(e);
      const code = typeof e === "object" && e && "code" in e ? (e as { code: number }).code : "";
      throw new Error(`fbd ${method}: ${msg}${code !== "" ? ` (${code})` : ""}`);
    }
    return parsed.result as T;
  }

  async ensureUnlocked(): Promise<void> {
    if (!config.fbdWalletPassphrase) return;
    try {
      await this.call("walletpassphrase", [
        config.fbdWalletPassphrase,
        3600,
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already unlocked is fine
      if (!/already unlocked|not encrypted/i.test(msg)) throw err;
    }
  }

  async getSwapPubkey(): Promise<{ pubkey: string; address: string }> {
    return this.call("getswappubkey", []);
  }

  /** Spendable balance in whole FBC (not bumps). */
  async getBalanceFbc(): Promise<number> {
    const bal = await this.call<
      number | { spendable?: number; confirmed?: number }
    >("getbalance", []);
    // bumps → FBC
    if (typeof bal === "number") return bal / 1e6;
    if (bal && typeof bal === "object") {
      if (typeof bal.spendable === "number") return bal.spendable / 1e6;
      if (typeof bal.confirmed === "number") return bal.confirmed / 1e6;
    }
    throw new Error("unexpected getbalance response");
  }

  async getBlockCount(): Promise<number> {
    const n = await this.call<number>("getblockcount", [], false);
    return Number(n);
  }

  /** Full tx JSON (needs --index-tx for confirmed). No wallet required. */
  async getTransaction(txid: string): Promise<{
    hash?: string;
    confirmations?: number;
    height?: number;
    inputs?: Array<Record<string, unknown>>;
    outputs?: Array<{
      value?: number;
      n?: number;
      address?: string | { string?: string };
    }>;
  }> {
    return this.call("gettransaction", [txid], false);
  }

  /** Verbose block with full tx objects (fbd default). */
  async getBlock(heightOrHash: number | string): Promise<{
    height?: number;
    hash?: string;
    tx?: Array<{
      hash?: string;
      inputs?: Array<Record<string, unknown>>;
      outputs?: Array<Record<string, unknown>>;
    }>;
  }> {
    return this.call("getblock", [heightOrHash], false);
  }

  async getRawMempool(): Promise<string[]> {
    const r = await this.call<string[] | unknown>("getrawmempool", [], false);
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
  }

  /** Txids touching address (needs --index-address). Optional fast path. */
  async getTxByAddress(address: string): Promise<string[]> {
    const r = await this.call<string[] | unknown>("gettxbyaddress", [address], false);
    if (!Array.isArray(r)) return [];
    return r.filter((x): x is string => typeof x === "string");
  }

  async buildHtlcScript(
    hashlock: string,
    claimPubkey: string,
    refundPubkey: string,
    locktime: number,
  ): Promise<{ script_hex: string; p2wsh_address: string }> {
    return this.call(
      "buildhtlcscript",
      [hashlock, claimPubkey, refundPubkey, locktime],
      false,
    );
  }

  /** Fund HTLC: create → sign → broadcast. Returns txid + amount in bumps. */
  async fundHtlc(
    scriptHex: string,
    amountFbc: number,
  ): Promise<{ txid: string; address: string; amount_bumps: number }> {
    await this.ensureUnlocked();
    const created = await this.call<{
      pstx: string;
      address: string;
      amount_bumps: number;
    }>("createhtlcfund", [scriptHex, amountFbc]);

    const signed = await this.call<{ pstx: string; signatures: number }>(
      "signtx",
      [created.pstx],
    );
    const broadcast = await this.call<{ txid: string }>(
      "broadcasttx",
      [signed.pstx],
      false,
    );
    return {
      txid: broadcast.txid,
      address: created.address,
      amount_bumps: created.amount_bumps,
    };
  }

  async signHtlcSpend(params: {
    fundingTxid: string;
    fundingVout: number;
    fundingAmountBumps: number;
    scriptHex: string;
    branch: "claim" | "refund";
    destination: string;
    feeRate: number;
    preimageHex?: string;
  }): Promise<{ tx_hex: string; txid: string }> {
    await this.ensureUnlocked();
    const args: unknown[] = [
      params.fundingTxid,
      params.fundingVout,
      params.fundingAmountBumps,
      params.scriptHex,
      params.branch,
      params.destination,
      params.feeRate,
    ];
    if (params.branch === "claim") {
      if (!params.preimageHex) throw new Error("claim needs preimage");
      args.push(params.preimageHex);
    }
    return this.call("signhtlcspend", args);
  }

  /**
   * The node's fee estimate in bumps per kvB, or null when it will not say.
   *
   * Returns the relay floor on a quiet chain — measured, it answers 1000 at
   * every confirmation target, because an empty mempool gives an estimator
   * nothing to work with. That is a correct answer, not a broken one, and it is
   * why the configured rate stays a floor rather than being replaced.
   */
  async estimateFee(blocks = 6): Promise<number | null> {
    try {
      const r = await this.call<number>("estimatefee", [blocks], false);
      return Number.isFinite(r) && r > 0 ? r : null;
    } catch {
      return null;
    }
  }

  /** Whether fbd considers this a valid address on its own network. */
  async validateAddress(address: string): Promise<boolean> {
    const r = await this.call<{ isvalid?: boolean }>("validateaddress", [address]);
    return r?.isvalid === true;
  }

  /**
   * Send FBC from the maker's wallet.
   *
   * Takes bumps and converts once, here — fbd's RPC speaks whole FBC and
   * everything else in this codebase counts bumps, and that boundary has
   * already produced unit bugs on the BTC side.
   */
  async sendToAddress(address: string, bumps: number): Promise<string> {
    if (!Number.isInteger(bumps) || bumps <= 0) {
      throw new Error(`bumps must be a positive integer, got ${bumps}`);
    }
    await this.ensureUnlocked();
    return this.call<string>("sendtoaddress", [address, Number((bumps / 1e6).toFixed(6))]);
  }

  async sendRawTransaction(txHex: string): Promise<string> {
    const r = await this.call<string | { txid: string }>(
      "sendrawtransaction",
      [txHex],
      false,
    );
    if (typeof r === "string") return r;
    return r.txid;
  }
}

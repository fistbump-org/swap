import { config } from "./config.js";
import { FbdClient } from "./fbd.js";
import { toHex, fromHex } from "./hex.js";
import { sha256 } from "@noble/hashes/sha256";

type FbdOutput = {
  value?: number;
  n?: number;
  address?: string | { string?: string; version?: number; hash?: string };
  scriptpubkey_address?: string;
};

type FbdTx = {
  hash?: string;
  confirmations?: number;
  height?: number;
  inputs?: Array<Record<string, unknown>>;
  outputs?: FbdOutput[];
  vin?: Array<Record<string, unknown>>;
  vout?: FbdOutput[];
};

/**
 * Test-only override of the fbd client.
 *
 * The preimage routes fan out over three different node calls and only the
 * last one — the block scan — is reachable when the address index is off and
 * the claim has confirmed. That combination cannot be produced against a real
 * node in a unit test, and it is the combination a silent bug hid in for as
 * long as the mempool route kept answering first.
 *
 * Null in production, and nothing in src/ ever sets it.
 */
let fbdOverride: FbdClient | null = null;

export function setFbdClientForTests(client: FbdClient | null): void {
  fbdOverride = client;
}

function fbd(): FbdClient {
  return fbdOverride ?? new FbdClient();
}

function outputAddress(o: FbdOutput): string | null {
  if (typeof o.scriptpubkey_address === "string") return o.scriptpubkey_address;
  if (typeof o.address === "string") return o.address;
  if (o.address && typeof o.address === "object" && typeof o.address.string === "string") {
    return o.address.string;
  }
  return null;
}

function outputsOf(tx: FbdTx): FbdOutput[] {
  return tx.outputs || tx.vout || [];
}

function inputsOf(tx: FbdTx): Array<Record<string, unknown>> {
  return tx.inputs || tx.vin || [];
}

/** Confirmations from fbd only (your node). */
export async function fbcConfirmations(txid: string): Promise<number> {
  const tx = await fbd().getTransaction(txid);
  const conf = Number(tx?.confirmations ?? 0);
  return Number.isFinite(conf) && conf >= 0 ? conf : 0;
}

/** The output of ours inside an FBC funding tx. `value` is fbd's raw figure. */
export type FbcFundingOutput = { vout: number; value: number | null };

export async function resolveFbcFundingOutput(
  txid: string,
  address: string,
): Promise<FbcFundingOutput> {
  const delays = [200, 500, 1000, 2000, 3000, 5000];
  for (let i = 0; i < delays.length; i++) {
    try {
      const tx = await fbd().getTransaction(txid);
      const hit = matchOutput(outputsOf(tx), address);
      // Match on the address only. The old code fell back to vout 0 whenever
      // the tx had a single output, which would happily bind us to an output
      // that pays somewhere else entirely.
      if (hit) return hit;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, delays[i]));
  }
  throw new Error(`could not resolve FBC funding vout for ${txid} → ${address}`);
}

/**
 * The output paying `address`, and — when one is given — paying `expected`.
 *
 * The amount is part of the match, not something the caller checks afterwards.
 * An HTLC address is public the moment it is quoted, so anyone can pay it:
 * during recovery from a lost funding response, a taker who sends dust to
 * their own swap's address would otherwise be the first match. The caller
 * adopts it, persists its txid, only THEN compares the amount, and abandons —
 * with the maker's real funding output never found and no outpoint recorded to
 * refund it at T2.
 *
 * A readable value that is wrong is never returned. A value that cannot be
 * read is returned only if nothing matches exactly, preserving the caller's
 * existing "adopted but unverified" path rather than silently discarding our
 * own coins.
 */
function matchOutput(
  outs: FbdOutput[],
  address: string,
  expected?: number | null,
): FbcFundingOutput | null {
  let unreadable: FbcFundingOutput | null = null;
  for (let i = 0; i < outs.length; i++) {
    if (outputAddress(outs[i]!) !== address) continue;
    const raw = Number(outs[i]!.value);
    const value = Number.isFinite(raw) ? raw : null;
    if (expected == null || value === expected) return { vout: i, value };
    if (value === null && unreadable === null) unreadable = { vout: i, value: null };
  }
  return unreadable;
}

/**
 * How many blocks back a funding search will cover before refusing to answer.
 *
 * Derived from the FBC timelock rather than picked as a round number. This
 * search runs when our own funding RPC broadcast but its response was lost:
 * the coins may be on chain under an outpoint we never recorded, and finding
 * them is what makes the refund possible. Giving up leaves them unrecoverable.
 *
 * The old constant was 200 blocks — about 6.7 hours at 120-second blocks —
 * against a 24-hour refund window. A bot offline for a morning would refuse to
 * look, while roughly seventeen hours of timelock remained and the HTLC was
 * still perfectly refundable. The bound should be "as far back as a swap could
 * still be live", which is exactly the refund window, plus a margin for slow
 * blocks.
 *
 * It is still bounded. An unbounded scan on a node with a long history is its
 * own outage.
 */
const FUNDING_SEARCH_MAX_BLOCKS = Math.ceil(
  (config.fbcRefundHours * 3600) / config.fbcBlockSeconds,
) * 2;

/**
 * Look for a payment we may already have made to an HTLC address.
 *
 * Called before broadcasting an FBC HTLC, because `fundHtlc` can put a
 * transaction on chain and then lose its response — in which case the txid is
 * never recorded and the next tick funds a second HTLC for the same swap,
 * spending inventory we then have to refund twice.
 *
 * Returns null only for "searched and found nothing". If the search itself
 * could not be completed it throws, so the caller can tell the difference —
 * broadcasting because a search failed is exactly the double-funding this is
 * here to prevent.
 */
export async function findFbcPaymentToAddress(
  address: string,
  fromHeight: number | null,
  /**
   * Bumps the output must pay. Required in practice: without it the first
   * stranger's payment to a public HTLC address wins the search.
   */
  expectedBumps?: number | null,
): Promise<{ txid: string; vout: number; value: number | null } | null> {
  const client = fbd();

  // 1) Address index, if this node has one.
  try {
    for (const txid of await client.getTxByAddress(address)) {
      const tx = await client.getTransaction(txid);
      const hit = matchOutput(outputsOf(tx), address, expectedBumps);
      if (hit) return { txid: txid.toLowerCase(), ...hit };
    }
  } catch {
    // --index-address is often off; the mempool and block scans below do not
    // depend on it, so this is not a failed search.
  }

  // 2) Mempool — where a funding tx broadcast seconds ago will be.
  for (const txid of await cachedMempool(client)) {
    try {
      const tx = await client.getTransaction(txid);
      const hit = matchOutput(outputsOf(tx), address, expectedBumps);
      if (hit) return { txid: txid.toLowerCase(), ...hit };
    } catch {
      // A tx that left the mempool between listing and fetching cannot be the
      // one we are looking for — if it had confirmed the block scan finds it.
    }
  }

  // 3) Blocks since the height at which we recorded the intent to fund.
  if (fromHeight == null) return null;
  const tip = await client.getBlockCount();
  const from = Math.max(1, fromHeight);
  if (tip - from > FUNDING_SEARCH_MAX_BLOCKS) {
    throw new Error(
      `cannot search ${tip - from} blocks for an existing payment to ${address}`,
    );
  }
  for (let h = from; h <= tip; h++) {
    const block = await client.getBlock(h);
    for (const tx of block.tx || []) {
      const txid = (tx.hash || "") as string;
      if (!txid) continue;
      const hit = matchOutput(outputsOf(tx as FbdTx), address, expectedBumps);
      if (hit) return { txid: txid.toLowerCase(), ...hit };
    }
  }
  return null;
}

/**
 * Mempool snapshot shared across the swaps in one tick.
 *
 * `findFbcPreimage` runs per swap, and each call used to pull and walk the
 * entire mempool — so N live swaps meant N full mempool fetches every 8s.
 */
let mempoolCache: { txids: string[]; at: number } | null = null;
const MEMPOOL_CACHE_MS = 5_000;

async function cachedMempool(client: FbdClient): Promise<string[]> {
  const now = Date.now();
  if (mempoolCache && now - mempoolCache.at < MEMPOOL_CACHE_MS) {
    return mempoolCache.txids;
  }
  const txids = await client.getRawMempool();
  mempoolCache = { txids, at: now };
  return txids;
}

/** Resume scan cursors so ticks only walk new blocks. */
const scanCursor = new Map<string, number>();

/**
 * Find Alice's FBC claim spend and extract the HTLC preimage.
 *
 * Uses **fbd only** (gettxbyaddress if --index-address, else block/mempool scan).
 * No public explorer.
 *
 * Witness (claim): [sig, preimage, 0x01, witnessScript]
 */
/**
 * The element of a claim witness whose SHA256 is the hashlock.
 *
 * Matched by HASH, never by length or position. The HTLC script is
 * `OP_SHA256 <hashlock> OP_EQUALVERIFY` with no `OP_SIZE 32 OP_EQUALVERIFY`
 * in front of it, so a preimage of ANY length satisfies it — and the taker
 * picks the preimage, handing us only its hash.
 *
 * This used to require exactly 64 hex characters at witness[1]. A taker who
 * chose a 31-byte secret therefore claimed the FBC while we saw nothing: the
 * reveal went undetected, we never claimed their BTC, they refunded it at T1,
 * and our FBC was gone for the price of the fees. That is the whole leg, and
 * it is repeatable up to MAX_FBC.
 *
 * Bounded at 80 bytes because that is the largest element Bitcoin's standard
 * script rules will push, so anything longer cannot have been the preimage of
 * a spend that actually confirmed.
 */
export function findPreimageInWitness(
  witness: readonly string[],
  hashlockHex: string,
): string | null {
  const want = hashlockHex.toLowerCase();
  for (const element of witness) {
    if (typeof element !== "string") continue;
    if (element.length === 0 || element.length % 2 !== 0) continue;
    if (element.length > 160) continue; // 80 bytes, the push limit
    if (!/^[0-9a-f]+$/i.test(element)) continue;
    try {
      if (toHex(sha256(fromHex(element))).toLowerCase() === want) {
        return element.toLowerCase();
      }
    } catch {
      /* not hex we can decode — keep looking */
    }
  }
  return null;
}

export async function findFbcPreimage(
  fundingTxid: string,
  fundingVout: number,
  htlcAddress: string,
  hashlockHex: string,
): Promise<{ preimageHex: string; spendingTxid: string } | null> {
  const client = fbd();
  fundingTxid = fundingTxid.toLowerCase();

  // 1) Fast path if node has --index-address
  try {
    const txids = await client.getTxByAddress(htlcAddress);
    for (const spenderTxid of txids) {
      if (spenderTxid.toLowerCase() === fundingTxid) continue;
      const hit = await extractPreimageFromTx(client, spenderTxid, fundingTxid, fundingVout, hashlockHex);
      if (hit) return hit;
    }
  } catch {
    /* index often disabled */
  }

  // 2) Mempool
  try {
    for (const mtxid of await cachedMempool(client)) {
      const hit = await extractPreimageFromTx(
        client,
        mtxid,
        fundingTxid,
        fundingVout,
        hashlockHex,
      );
      if (hit) return hit;
    }
  } catch {
    /* ignore */
  }

  // 3) Scan blocks from funding height (or last cursor) → tip
  let fundHeight = 0;
  try {
    const fundTx = await client.getTransaction(fundingTxid);
    fundHeight = Number(fundTx.height ?? 0) || 0;
  } catch {
    return null;
  }
  if (!fundHeight) return null;

  const key = `${fundingTxid}:${fundingVout}`;
  const tip = await client.getBlockCount();
  let from = scanCursor.get(key) ?? fundHeight;
  if (from < fundHeight) from = fundHeight;

  // Cap work per tick (~3 min of FBC blocks at 2s… actually 120s blocks → ~50 blocks ok)
  const maxBlocksPerCall = 80;
  const to = Math.min(tip, from + maxBlocksPerCall - 1);

  // Only advance past blocks we actually read. The cursor used to jump to
  // `to + 1` regardless, so one transient getblock failure skipped a block for
  // good — and if that was the block carrying the taker's claim, we never see
  // the preimage, never claim the BTC, and lose both legs.
  let scannedThrough = from - 1;

  for (let h = from; h <= to; h++) {
    try {
      const block = await client.getBlock(h);
      for (const tx of block.tx || []) {
        const spenderTxid = (tx.hash || "") as string;
        if (!spenderTxid) continue;
        const hit = preimageFromInputs({
          inputs: inputsOf(tx as FbdTx),
          fundingTxid,
          fundingVout,
          spenderTxid,
          hashlockHex,
        });
        if (hit) {
          scanCursor.set(key, h);
          return hit;
        }
      }
      scannedThrough = h;
    } catch (err) {
      console.warn(
        `[chain] getblock ${h} failed, will retry this height next tick:`,
        err instanceof Error ? err.message : err,
      );
      break;
    }
  }
  if (scannedThrough >= from) scanCursor.set(key, scannedThrough + 1);

  // If we haven't caught tip yet, return null; next tick continues
  return null;
}

async function extractPreimageFromTx(
  client: FbdClient,
  spenderTxid: string,
  fundingTxid: string,
  fundingVout: number,
  hashlockHex: string,
): Promise<{ preimageHex: string; spendingTxid: string } | null> {
  try {
    const tx = await client.getTransaction(spenderTxid);
    return preimageFromInputs({
      inputs: inputsOf(tx),
      fundingTxid,
      fundingVout,
      spenderTxid,
      hashlockHex,
    });
  } catch {
    return null;
  }
}

/**
 * Named arguments, not positional, and deliberately so.
 *
 * `spenderTxid` and `hashlockHex` are both 64-character hex strings sitting
 * next to each other, so swapping them typechecks perfectly and fails
 * silently: every candidate preimage gets hashed and compared against a
 * transaction id, which never matches. That is exactly what happened at the
 * block-scan call site, and it disabled the only path that finds a preimage
 * after the taker's claim has confirmed and left the mempool.
 *
 * The cost of that bug is the whole FBC leg — no preimage means no BTC claim,
 * so the taker refunds at T1 and keeps the FBC. An object literal makes the
 * mistake a compile error instead of a silent loss.
 */
function preimageFromInputs(args: {
  inputs: Array<Record<string, unknown>>;
  fundingTxid: string;
  fundingVout: number;
  spenderTxid: string;
  hashlockHex: string;
}): { preimageHex: string; spendingTxid: string } | null {
  const { inputs, fundingTxid, fundingVout, spenderTxid, hashlockHex } = args;
  for (const inp of inputs) {
    const prev = inp.prevout as { hash?: string; index?: number } | undefined;
    const inTxid = String(
      inp.txid || inp.prev_txid || inp.previous_txid || prev?.hash || "",
    ).toLowerCase();
    const inVout = Number(
      inp.vout ?? inp.output_index ?? inp.prev_index ?? prev?.index ?? -1,
    );
    if (inTxid === fundingTxid && inVout === fundingVout) {
      const witness = (inp.witness || inp.txinwitness || []) as string[];
      // Claim: [sig, preimage, 0x01, redeemScript]
      if (!Array.isArray(witness) || witness.length < 4) return null;
      const found = findPreimageInWitness(witness, hashlockHex);
      if (found) return { preimageHex: found, spendingTxid: spenderTxid };
    }
  }
  return null;
}

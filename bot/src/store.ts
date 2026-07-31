import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";
import { rolesFor, type Chain, type Side } from "./roles.js";

export type Quote = {
  quote_id: string;
  /**
   * Widening this from the literal `"buy_fbc"` produces no compiler errors on
   * its own — a `"buy_fbc"` literal stays assignable to `Side`. Nothing here
   * forces the real side to be threaded through; `getQuote` taking `side` as
   * its first parameter is what does that.
   */
  side: Side;
  amount_btc: number;
  amount_fbc: number;
  mid_fbc_per_btc: number;
  spread_bps: number;
  mm_btc_pubkey: string;
  mm_fbc_pubkey: string;
  btc_reference_height: number;
  fbc_reference_height: number;
  btc_refund_height: number;
  fbc_refund_height: number;
  btc_refund_hours: number;
  fbc_refund_hours: number;
  expires_at: string;
  created_at: number;
};

export type OfferBlob = {
  version: 1;
  kind: "offer";
  network: { btc: string; fbc: string };
  hashlock: string;
  alice_btc_pubkey: string;
  alice_fbc_pubkey: string;
  amount_btc: number;
  amount_fbc: number;
  btc_refund_height: number;
  fbc_refund_height: number;
  btc_reference_height: number;
  fbc_reference_height: number;
  expires_at: string;
  offer_id: string;
};

export type AcceptBlob = {
  version: 1;
  kind: "accept";
  offer_id: string;
  bob_btc_pubkey: string;
  bob_fbc_pubkey: string;
};

export type FundedBtc = {
  version: 1;
  kind: "funded_btc";
  offer_id: string;
  funding_txid: string;
  funding_vout: number;
  funding_amount: number;
  witness_script_hex: string;
};

export type FundedFbc = {
  version: 1;
  kind: "funded_fbc";
  offer_id: string;
  funding_txid: string;
  funding_vout: number;
  funding_amount: number;
  witness_script_hex: string;
  htlc_address: string;
};

export type SwapState =
  | "accepted"
  | "waiting_btc_confs"
  | "funding_fbc"
  | "waiting_fbc_confs"
  | "claimable"
  | "claiming_btc"
  | "done"
  | "failed"
  | "refunding_fbc"
  | "refunded";

export type Swap = {
  swap_id: string;
  quote_id: string;
  /**
   * Which side of the market this swap is, and therefore which SPEC role this
   * maker plays — see roles.ts. Identity, not state: it is decided at quote
   * time and never changes.
   *
   * Required, never optional. An optional field would let a missing value mean
   * "buy" by default at every read site, which is the exact silent assumption
   * this field exists to delete. Records written before it existed are given a
   * value in `reindex()` instead, where the decision is made once and visibly.
   *
   * Taken from the consumed quote, never from the offer blob — the offer is
   * caller-controlled, and letting a counterparty pick its own protocol role
   * is not a thing to leave available.
   */
  side: Side;
  state: SwapState;
  offer: OfferBlob;
  accept: AcceptBlob;
  funded_btc: FundedBtc | null;
  funded_fbc: FundedFbc | null;
  btc_confs: number;
  fbc_confs: number;
  preimage_hex: string | null;
  btc_claim_txid: string | null;
  /**
   * Every claim transaction we have broadcast for this swap, oldest first.
   *
   * RBF means a stalled claim is replaced at a higher fee, and
   * `btc_claim_txid` only ever held the latest attempt. Miners are not obliged
   * to prefer the replacement: if an earlier version confirms, the bot polls a
   * txid that never will, eventually gives up, and marks failed a swap whose
   * BTC it actually received. Keeping every attempt is what makes the payment
   * findable.
   *
   * All of these are public on chain the moment they are broadcast.
   */
  btc_claim_txids: string[];
  fbc_claim_txid: string | null;
  /**
   * A broadcast claim is not a settled claim. We stay in `claiming_btc` until
   * the tx actually confirms, rebroadcasting at a higher fee if it stalls —
   * otherwise a claim dropped from the mempool goes unnoticed and the taker
   * refunds at T1.
   */
  btc_claim_confs: number;
  btc_claim_fee_rate: number | null;
  btc_claim_broadcast_at: number | null;
  /**
   * Recorded the instant our FBC funding tx is broadcast, before its vout is
   * resolved, so a failure in between cannot make us fund the HTLC twice.
   */
  fbc_funding_txid_pending: string | null;
  /**
   * Written BEFORE the fundhtlc RPC, not after it.
   *
   * `fbc_funding_txid_pending` can only be written once the call returns, so a
   * lost response left no trace at all and the next tick broadcast a second
   * HTLC for the same swap. These two fields are that trace: `_at` says we may
   * already have coins on chain, `_height` bounds the block range a search for
   * them has to cover.
   */
  fbc_funding_intent_at: number | null;
  fbc_funding_intent_height: number | null;
  /** Set once we spend our own FBC HTLC through the refund branch after T2. */
  fbc_refund_txid: string | null;
  fbc_refund_confs: number;
  /**
   * When the refund was broadcast, so a spend that never confirms can be
   * noticed. Without it `track_refund` polls forever and says nothing — the
   * operator's first hint would be noticing the FBC is still gone.
   */
  fbc_refund_broadcast_at: number | null;

  // ── sell_fbc mirrors ───────────────────────────────────────────────────
  //
  // On sell_fbc this maker is Alice: it funds BTC, claims FBC, and refunds
  // BTC. Every field above has a counterpart on the opposite chain, and they
  // are added as their own chain-named fields rather than by renaming the
  // existing ones toward party names (`our_claim_txid`). A party name means
  // something different on each side, which is exactly the ambiguity roles.ts
  // exists to delete; `side` says which pair belongs to us.
  //
  // Declared before the routing that writes them so that the persistence
  // decision — default, publish, withhold — is made once, deliberately, rather
  // than in the middle of writing a spend path.

  /**
   * Burial tracking for our own FBC claim, mirroring `btc_claim_confs`.
   *
   * Distinct from `fbc_claim_txid`, which on buy_fbc records the COUNTERPARTY
   * spending our HTLC and is written from observation. On sell_fbc the same
   * field is written from our own broadcast. Two writers, one field — the
   * reading that holds on both sides is "a spend of the FBC HTLC exists,
   * whoever made it", which is what `plan.ts` relies on.
   */
  fbc_claim_confs: number;
  fbc_claim_fee_rate: number | null;
  fbc_claim_broadcast_at: number | null;

  /**
   * Idempotency trace for our own BTC funding, mirroring the FBC trio above.
   *
   * `_intent_at` is written BEFORE the funding RPC, not after: a lost response
   * otherwise leaves no trace at all and the next tick funds a second HTLC for
   * the same swap. That is not hypothetical — it is the bug the FBC fields
   * were added to fix, and the sell side reintroduces it exactly unless the
   * same trace exists on BTC.
   */
  btc_funding_txid_pending: string | null;
  btc_funding_intent_at: number | null;
  btc_funding_intent_height: number | null;

  /** Set once we spend our own BTC HTLC through the refund branch after T1. */
  btc_refund_txid: string | null;
  btc_refund_confs: number;
  error: string | null;
  created_at: number;
  updated_at: number;
};

/**
 * Every field of `Swap`, as data.
 *
 * `Swap` is a type, and types are erased at runtime, so a test cannot ask what
 * fields a Swap has — it can only ask what fields some particular object has.
 * That is exactly the gap that let the disclosure test pass while proving
 * nothing: it iterated a hand-written fixture and called it the type.
 *
 * The `satisfies` clause is what gives this teeth. Add a field to `Swap`
 * without adding it here and `tsc` fails on this line; the disclosure test
 * then reads this list and fails too if the new field is neither published nor
 * explicitly withheld. Both halves are needed — one catches the omission, the
 * other catches a field being published by accident.
 */
export const SWAP_FIELDS = {
  swap_id: true,
  quote_id: true,
  side: true,
  state: true,
  offer: true,
  accept: true,
  funded_btc: true,
  funded_fbc: true,
  btc_confs: true,
  fbc_confs: true,
  preimage_hex: true,
  btc_claim_txid: true,
  btc_claim_txids: true,
  fbc_claim_txid: true,
  btc_claim_confs: true,
  btc_claim_fee_rate: true,
  btc_claim_broadcast_at: true,
  fbc_funding_txid_pending: true,
  fbc_funding_intent_at: true,
  fbc_funding_intent_height: true,
  fbc_refund_txid: true,
  fbc_refund_confs: true,
  fbc_refund_broadcast_at: true,
  fbc_claim_confs: true,
  fbc_claim_fee_rate: true,
  fbc_claim_broadcast_at: true,
  btc_funding_txid_pending: true,
  btc_funding_intent_at: true,
  btc_funding_intent_height: true,
  btc_refund_txid: true,
  btc_refund_confs: true,
  error: true,
  created_at: true,
  updated_at: true,
} satisfies Record<keyof Swap, true>;

export type SwapField = keyof typeof SWAP_FIELDS;

type Db = {
  quotes: Record<string, Quote>;
  swaps: Record<string, Swap>;
  /** offer_id → swap_id. Lets us detect a replayed offer without trusting it as a key. */
  offerIndex?: Record<string, string>;
  /** "txid:vout" → swap_id. A funding outpoint may back exactly one swap. */
  outpointIndex?: Record<string, string>;
  /** hashlock → swap_id. SPEC §9.4 requires a fresh preimage per swap. */
  hashlockIndex?: Record<string, string>;
};

export class Store {
  private dir: string;
  private path: string;
  private db: Db;

  constructor(dataDir = config.dataDir) {
    mkdirSync(dataDir, { recursive: true });
    this.dir = dataDir;
    this.path = join(dataDir, "mm.json");
    const loaded = this.load();
    this.db = loaded.db;
    this.reindex();
    if (loaded.rewrite) this.save();
  }

  /**
   * Read the database back, tolerating a file we cannot parse.
   *
   * JSON.parse used to run bare in the constructor, and because the store is
   * built during module init the process died at startup — on every restart,
   * permanently — if mm.json was ever truncated or emptied. That is the worst
   * possible time to be dead: live swaps hold our FBC and nobody is left to
   * refund them at T2. So: try the file, then the temp file a save interrupted
   * mid-flight may have left behind, and only then start empty, preserving the
   * unreadable file so an operator can salvage swaps from it by hand.
   */
  private load(): { db: Db; rewrite: boolean } {
    for (const candidate of [this.path, this.path + ".tmp"]) {
      if (!existsSync(candidate)) continue;
      try {
        const text = readFileSync(candidate, "utf8");
        if (!text.trim()) throw new Error("file is empty");
        const parsed = JSON.parse(text) as Db | null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("not a database object");
        }
        parsed.quotes ||= {};
        parsed.swaps ||= {};
        parsed.offerIndex ||= {};
        parsed.outpointIndex ||= {};
        parsed.hashlockIndex ||= {};
        if (candidate !== this.path) {
          console.error(
            `[store] ${this.path} was unreadable; recovered ${Object.keys(parsed.swaps).length} ` +
              `swap(s) from the interrupted write at ${candidate}`,
          );
        }
        return { db: parsed, rewrite: candidate !== this.path };
      } catch (err) {
        console.error(
          `[store] cannot read ${candidate}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (existsSync(this.path)) {
      const aside = `${this.path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      try {
        renameSync(this.path, aside);
        console.error(
          `[store] UNREADABLE DATABASE — moved to ${aside} and starting empty. ` +
            `Any swap still holding FBC is no longer being watched: inspect that ` +
            `file before running further swaps.`,
        );
      } catch (err) {
        // Refuse to start empty over a file we could not move: overwriting it
        // on the next save would destroy the only copy of those swaps.
        throw new Error(
          `mm.json is unreadable and could not be moved aside (${err instanceof Error ? err.message : err}); ` +
            `fix or remove ${this.path} by hand`,
        );
      }
    }

    return {
      db: {
        quotes: {},
        swaps: {},
        offerIndex: {},
        outpointIndex: {},
        hashlockIndex: {},
      },
      rewrite: true,
    };
  }

  /**
   * Bring a store written by an older build up to date: rebuild the uniqueness
   * indexes, and fill in fields added since it was written so nothing has to
   * defend against `undefined` at every read site.
   */
  private reindex() {
    for (const s of Object.values(this.db.swaps)) {
      // Every swap written before `side` existed is a buy_fbc swap — it is the
      // only side the bot has ever served. This must stay here permanently: it
      // runs on every load and is idempotent, but it never reaches disk on its
      // own. `load()` reports rewrite=false for a healthy file, so the
      // constructor does not save, and the on-disk record keeps no `side` key
      // until something else writes the swap. Nobody may later delete this line
      // on the grounds that "the data has been migrated by now" — it has not.
      //
      // Ordering note: without this, `planSwap`'s fail-closed branch catches
      // every pre-existing swap and plans nothing. A swap holding funded FBC
      // would never plan its refund at T2.
      s.side ??= "buy_fbc";
      // The original fields. These have always been in the type, so a record
      // written by this bot always carries them — but "always carries them" is
      // an assumption about history, and the contract above says no read site
      // has to defend against undefined. Defaulting them costs nothing on a
      // healthy record and makes that claim true rather than nearly true.
      s.funded_btc ??= null;
      s.funded_fbc ??= null;
      s.btc_confs ??= 0;
      s.fbc_confs ??= 0;
      s.preimage_hex ??= null;
      s.btc_claim_txid ??= null;
      // Records written before the list existed carry only the last attempt.
      // Seeding from it keeps the "every txid we tried" contract true for them
      // rather than leaving an empty list that reads as "we never broadcast".
      if (!Array.isArray(s.btc_claim_txids)) {
        s.btc_claim_txids = s.btc_claim_txid ? [s.btc_claim_txid] : [];
      }
      s.fbc_claim_txid ??= null;
      s.error ??= null;
      s.btc_claim_confs ??= 0;
      s.btc_claim_fee_rate ??= null;
      s.btc_claim_broadcast_at ??= null;
      s.fbc_funding_txid_pending ??= null;
      s.fbc_funding_intent_at ??= null;
      s.fbc_funding_intent_height ??= null;
      s.fbc_refund_txid ??= null;
      s.fbc_refund_confs ??= 0;
      s.fbc_refund_broadcast_at ??= null;
      // sell_fbc mirrors. Defaulted for every record, including buy swaps that
      // will never use them — a field that is null everywhere is cheaper to
      // reason about than one that is sometimes absent.
      s.fbc_claim_confs ??= 0;
      s.fbc_claim_fee_rate ??= null;
      s.fbc_claim_broadcast_at ??= null;
      s.btc_funding_txid_pending ??= null;
      s.btc_funding_intent_at ??= null;
      s.btc_funding_intent_height ??= null;
      s.btc_refund_txid ??= null;
      s.btc_refund_confs ??= 0;
      this.db.offerIndex![s.offer.offer_id] = s.swap_id;
      this.db.hashlockIndex![s.offer.hashlock.toLowerCase()] = s.swap_id;
      if (s.funded_btc) {
        this.db.outpointIndex![
          outpointKey(s.funded_btc.funding_txid, s.funded_btc.funding_vout)
        ] = s.swap_id;
      }
    }
  }

  /**
   * Write the whole database out, atomically.
   *
   * Every mutation used to call this synchronously, so an unauthenticated
   * caller could make us rewrite the entire store — quotes and swaps — on
   * each request. Swap state still writes through immediately, because losing
   * it costs money; quote churn is coalesced instead (see `saveSoon`).
   *
   * The temp file is fsynced before the rename, and the directory after it.
   * Without the first, a crash can leave a renamed-but-empty mm.json — the
   * rename is atomic with respect to *other readers*, not with respect to
   * power loss, and the data it points at may never have reached the disk.
   */
  private save() {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    const tmp = this.path + ".tmp";
    // 0600. This file holds live swap records including preimages — the secret
    // that unlocks an in-flight HTLC — and it was being created 0644 by
    // default, readable by every account on the host. The mode is set at
    // creation rather than chmod'ed after, so there is no window where it
    // exists world-readable, and so a later `save()` cannot quietly widen it.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(this.db));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    try {
      const dirFd = openSync(this.dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not available on every platform (Windows). The data
      // is already durable; only the rename may lag, and load() falls back to
      // the temp file in exactly that case.
    }
  }

  private pending: NodeJS.Timeout | null = null;

  /**
   * Coalesce a burst of low-value writes into one flush.
   *
   * Only safe for state we can afford to lose on a crash: a dropped quote just
   * means the taker re-quotes. Never use it for anything that has funds behind it.
   */
  private saveSoon() {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      try {
        this.save();
      } catch (err) {
        console.error("[store] deferred save failed:", err);
      }
    }, 1_000);
    this.pending.unref();
  }

  putQuote(q: Quote) {
    this.db.quotes[q.quote_id] = q;
    this.saveSoon();
  }

  getQuote(id: string): Quote | undefined {
    return Object.prototype.hasOwnProperty.call(this.db.quotes, id)
      ? this.db.quotes[id]
      : undefined;
  }

  /**
   * Consume a quote. Returns it only the first time; subsequent calls get
   * undefined, so one quote can back exactly one swap.
   */
  takeQuote(id: string): Quote | undefined {
    const q = this.getQuote(id);
    if (!q) return undefined;
    delete this.db.quotes[id];
    this.saveSoon();
    return q;
  }

  /**
   * Insert a brand-new swap. Throws rather than overwriting.
   *
   * The old code keyed swaps on a truncation of the caller-supplied offer_id
   * and wrote with `db.swaps[id] = s`, so a taker could reset a live swap —
   * wiping funded_fbc and the preimage watch — and make us fund the same HTLC
   * again and again. Creation and mutation are now separate operations.
   */
  addSwap(s: Swap) {
    if (this.db.swaps[s.swap_id]) {
      throw new Error(`swap ${s.swap_id} already exists`);
    }
    const offerId = s.offer.offer_id;
    const hashlock = s.offer.hashlock.toLowerCase();
    if (this.db.offerIndex![offerId]) {
      throw new Error(`offer_id ${offerId} has already been used`);
    }
    if (this.db.hashlockIndex![hashlock]) {
      throw new Error("hashlock has already been used by another swap");
    }
    s.created_at = Date.now();
    s.updated_at = s.created_at;
    this.db.swaps[s.swap_id] = s;
    this.db.offerIndex![offerId] = s.swap_id;
    this.db.hashlockIndex![hashlock] = s.swap_id;
    this.save();
  }

  /** Persist mutations to an existing swap. Never creates. */
  putSwap(s: Swap) {
    if (!this.db.swaps[s.swap_id]) {
      throw new Error(`cannot update unknown swap ${s.swap_id}`);
    }
    s.updated_at = Date.now();
    this.db.swaps[s.swap_id] = s;
    this.save();
  }

  getSwap(id: string): Swap | undefined {
    // hasOwnProperty, not a bare lookup: these maps come back from JSON.parse
    // with Object.prototype attached, so "__proto__"/"constructor"/"toString"
    // as an id would otherwise return an inherited value instead of undefined.
    return Object.prototype.hasOwnProperty.call(this.db.swaps, id)
      ? this.db.swaps[id]
      : undefined;
  }

  getSwapIdByOfferId(offerId: string): string | undefined {
    return Object.prototype.hasOwnProperty.call(this.db.offerIndex!, offerId)
      ? this.db.offerIndex![offerId]
      : undefined;
  }

  /** swap_id currently bound to this funding outpoint, if any. */
  getSwapIdByOutpoint(txid: string, vout: number): string | undefined {
    return this.db.outpointIndex![outpointKey(txid, vout)];
  }

  /**
   * Bind a funding outpoint to a swap. Throws if another swap already claimed
   * it — one on-chain payment must never back two FBC HTLCs.
   */
  bindOutpoint(txid: string, vout: number, swapId: string) {
    const key = outpointKey(txid, vout);
    const owner = this.db.outpointIndex![key];
    if (owner && owner !== swapId) {
      throw new Error(`funding outpoint ${key} is already bound to swap ${owner}`);
    }
    this.db.outpointIndex![key] = swapId;
    this.save();
  }

  listActiveSwaps(): Swap[] {
    return Object.values(this.db.swaps).filter(
      (s) =>
        s.state !== "done" &&
        s.state !== "failed" &&
        s.state !== "refunded",
    );
  }

  /**
   * Swaps that settled, oldest first, for publication as trade history.
   *
   * `done` only — not `refunded`. A refund is a swap that did not happen, and
   * counting it as a trade would report volume nobody traded and a price
   * nobody paid.
   *
   * Ordered by `updated_at`, which for a `done` swap is when it reached burial
   * depth. Callers page with `since` rather than an offset: an offset shifts
   * under a concurrent write, and a poller that misses a row here silently
   * loses a trade forever.
   */
  listSettledSwaps(opts: { since?: number; limit?: number } = {}): Swap[] {
    const since = opts.since ?? 0;
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    return Object.values(this.db.swaps)
      .filter((s) => s.state === "done" && s.updated_at > since)
      .sort((a, b) => a.updated_at - b.updated_at)
      .slice(0, limit);
  }

  /**
   * Swaps that have effectively happened but are not yet buried.
   *
   * `claiming_btc` is the one state worth publishing early. By then the taker
   * has claimed the FBC leg, which put the preimage on a public chain — the
   * swap is economically over and only the burial wait remains. From the
   * taker's side it is finished, so a market feed whose newest row is a day
   * old looks broken at exactly the moment someone has just traded.
   *
   * Deliberately NOT paged by a cursor. These rows are transient: one becomes a
   * settled trade, or (if the claim were somehow lost) vanishes. A cursor over
   * mutable rows either replays them forever or advances past one that changed
   * behind it, and `listSettledSwaps` above is the durable feed that must not
   * be disturbed. Callers take the current snapshot and replace what they held.
   */
  listSettlingSwaps(opts: { limit?: number } = {}): Swap[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    return Object.values(this.db.swaps)
      .filter(
        (s) =>
          s.state === "claiming_btc" &&
          // Both legs must be on chain and the FBC claim broadcast, or there is
          // nothing a consumer could independently check.
          !!s.funded_btc?.funding_txid &&
          !!s.funded_fbc?.funding_txid &&
          !!s.fbc_claim_txid,
      )
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, limit);
  }

  /**
   * FBC (in bumps) promised to live swaps but still sitting in the wallet.
   *
   * Two things this deliberately gets right, both of which were wrong:
   *
   *  - `accepted` swaps DO reserve. The taker holds our accept blob and can
   *    fund the BTC leg at any moment; skipping them let N concurrent accepts
   *    each see the whole balance and oversell it, leaving takers' BTC locked
   *    with no FBC coming. The reservation expires after ACCEPT_RESERVE_MS so
   *    a taker cannot exhaust the book for free by accepting and never
   *    funding — the promise is not withdrawn by that, inventory is simply
   *    re-checked before the HTLC is actually broadcast.
   *
   *  - a swap whose FBC funding tx exists is NOT counted. Those coins have
   *    already left the wallet, so the balance this is subtracted from no
   *    longer contains them; counting them here as well halved effective
   *    inventory for every in-flight swap.
   */
  /**
   * Inventory this maker has promised on `chain` but not yet put on chain.
   *
   * Only counts swaps where WE are the one funding that chain. On buy_fbc we
   * fund FBC and the taker funds BTC; on sell_fbc it is the reverse. Counting
   * every non-terminal swap regardless of side — which is what this did before
   * sell_fbc existed — would have every sell swap reserving FBC it will never
   * spend, shrinking the buy-side book for no reason.
   *
   * A swap already funded on that chain is excluded: the coins have left, so
   * they are no longer a promise, they are a balance change the node already
   * knows about. `_funding_txid_pending` counts as funded for the same reason.
   */
  private committedOnChain(
    chain: Chain,
    opts: { now?: number; excludeSwapId?: string } = {},
  ): number {
    const now = opts.now ?? Date.now();
    let total = 0;
    for (const s of Object.values(this.db.swaps)) {
      if (s.state === "done" || s.state === "failed" || s.state === "refunded") continue;
      if (s.swap_id === opts.excludeSwapId) continue;
      if (rolesFor(s.side).makerFunds !== chain) continue;
      if (chain === "fbc") {
        if (s.funded_fbc || s.fbc_funding_txid_pending) continue;
      } else {
        if (s.funded_btc || s.btc_funding_txid_pending) continue;
      }
      // An accepted swap reserves inventory only for a while. A taker who
      // never funds must not hold the book open forever — but see the note on
      // acceptReserveMs: an expired reservation is not a promise withdrawn,
      // inventory is re-checked before we actually fund.
      if (s.state === "accepted" && now - s.created_at > config.acceptReserveMs) continue;
      total += chain === "fbc" ? s.offer.amount_fbc : s.offer.amount_btc;
    }
    return total;
  }

  /**
   * Swaps that hold an inventory reservation without having committed anything
   * on chain.
   *
   * Accepting an offer costs a taker nothing — the pubkeys are checked for
   * shape, but the hashlock and offer_id can be any unused values, and no coins
   * have moved. Each accept nonetheless reserves its amount for
   * `acceptReserveMs` and writes a permanent record. Without a bound on how
   * many can be open at once, a caller with no funds can hold the whole book
   * by re-accepting on a timer, and grow the database while doing it.
   *
   * Counted rather than capped here; the cap belongs at the accept path, which
   * is where the request can still be refused.
   */
  unfundedReservationCount(now = Date.now()): number {
    let n = 0;
    for (const s of Object.values(this.db.swaps)) {
      if (s.state !== "accepted") continue;
      if (s.funded_btc || s.funded_fbc) continue;
      if (s.fbc_funding_txid_pending || s.btc_funding_txid_pending) continue;
      if (now - s.created_at > config.acceptReserveMs) continue;
      n++;
    }
    return n;
  }

  committedFbcBumps(opts: { now?: number; excludeSwapId?: string } = {}): number {
    return this.committedOnChain("fbc", opts);
  }

  /** The BTC mirror, in sats. Used by the sell side, where we fund BTC. */
  committedBtcSats(opts: { now?: number; excludeSwapId?: string } = {}): number {
    return this.committedOnChain("btc", opts);
  }

  pruneQuotes(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    let changed = false;
    for (const [id, q] of Object.entries(this.db.quotes)) {
      if (q.created_at < cutoff) {
        delete this.db.quotes[id];
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }
}

function outpointKey(txid: string, vout: number): string {
  return `${txid.toLowerCase()}:${vout}`;
}

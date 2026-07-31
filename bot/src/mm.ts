import {
  btcConfirmations,
  btcConfirmationsStrict,
  btcInMempool,
  BtcClaimWallet,
  broadcastBtc,
  claimVbytes,
  fetchBtcFeeRate,
  fetchBtcTip,
  maxAffordableClaimFeeRate,
  minClaimableSats,
  TYPICAL_HTLC_SCRIPT_BYTES,
  verifyBtcFundingOnChain,
} from "./btc-wallet.js";
import {
  fbcConfirmations,
  findFbcPaymentToAddress,
  findFbcPreimage,
  resolveFbcFundingOutput,
} from "./chain.js";
import {
  bitcoindFeeRate,
  bitcoindSendToAddress,
  bitcoindSpendableSats,
  bitcoindValidateAddress,
} from "./bitcoind.js";
import { config } from "./config.js";
import { FbdClient } from "./fbd.js";
import { getMidFbcPerBtc, lastPrice } from "./price.js";
import { settings } from "./settings.js";
import {
  btcP2wshAddress,
  fbcP2wshAddress,
  htlcsFromOfferAccept,
  randomId,
  verifyFundedBtc,
} from "./htlc.js";
import { toHex, fromHex } from "./hex.js";
import { publicError } from "./errors.js";
import { checkOfferTimelocks, checkRefundsStillFuture } from "./timelocks.js";
import { btcConfsSufficient, planSwap, FBC_REFUND_MARGIN_BLOCKS, type Tips } from "./plan.js";
import {
  isSide,
  makerActionLabel,
  rolesFor,
  servesSide,
  SERVED_SIDES,
  type Side,
} from "./roles.js";
import { sha256 } from "@noble/hashes/sha256";
import {
  type AcceptBlob,
  type FundedBtc,
  type OfferBlob,
  type Quote,
  type Swap,
  Store,
} from "./store.js";

export class MarketMaker {
  readonly store = new Store();
  readonly fbd = new FbdClient();
  btc!: BtcClaimWallet;
  private fbcPubkey = "";
  private fbcAddress = "";
  private started = false;
  private ticking = false;
  /**
   * Smallest swap we will quote right now, from the last fee estimate we saw.
   * The configured minimum is only a FLOOR — see `refreshMinBtcSat`. The fee
   * market can raise it, and the operator can raise or lower the floor from
   * the dashboard, but neither can make the bot quote a swap whose HTLC could
   * not pay for its own claim.
   */
  private minBtcSat = settings.minBtcSat();

  async start() {
    if (this.started) return;
    await this.fbd.ensureUnlocked();
    const pk = await this.fbd.getSwapPubkey();
    this.fbcPubkey = pk.pubkey;
    this.fbcAddress = pk.address;
    this.btc = await BtcClaimWallet.create();
    this.started = true;
    console.log(`[mm] FBC swap pubkey ${this.fbcPubkey.slice(0, 16)}… addr ${this.fbcAddress} (fbd wallet ${config.fbdWallet})`);
    console.log(
      `[mm] BTC claim pubkey ${this.btc.pubkeyHex.slice(0, 16)}… addr ${this.btc.address} ` +
        `(source=${this.btc.source}${config.bitcoinRpcWallet ? ` wallet=${config.bitcoinRpcWallet}` : ""})`,
    );
    // /health is announced to the registry long before anyone quotes, so the
    // minimum it advertises has to reflect the fee market from the first
    // heartbeat rather than the configured floor.
    try {
      this.refreshMinBtcSat(await fetchBtcFeeRate());
      console.log(`[mm] minimum swap size ${this.minBtcSat} sat at current fees`);
    } catch (err) {
      console.warn(
        "[mm] fee estimate unavailable at startup, advertising the configured minimum:",
        err instanceof Error ? err.message : err,
      );
    }

    // Background worker. `tick` guards against overlap itself — a tick walks
    // every active swap with several RPCs each and can easily outrun 8s.
    setInterval(() => {
      this.tick().catch((err) =>
        console.error("[mm] tick error", err instanceof Error ? err.message : err),
      );
    }, 8_000);
    // Immediate first tick
    this.tick().catch(() => {});
  }

  /**
   * Public maker metadata.
   *
   * Deliberately excludes our hot-wallet addresses. They were published here
   * and then heartbeated to a public registry, which hands anyone a live view
   * of the maker's balances and an easy way to link every swap we have ever
   * done. Counterparties get the pubkeys they actually need in the quote.
   */
  status() {
    const px = lastPrice();
    return {
      protocol: "fistbump-swap-mm/v1",
      // What a TAKER can ask for here, which is the only reading `Side` has —
      // roles.ts defines buy_fbc as the taker paying BTC. On a record that
      // describes a maker, a bare `side: "buy_fbc"` says the opposite of the
      // truth to anyone who has not read roles.ts: this maker SELLS FBC.
      //
      // `liquidity` below is the maker-relative fact and was always right.
      taker_sides: SERVED_SIDES,
      liquidity: "fbc",
      // Digest of ANNOUNCE_TOKEN. Public by design — it is the commitment the
      // registry checks our announce against, and it proves nothing on its own.
      announce_id: announceId(),
      mid_fbc_per_btc: px?.midFbcPerBtc ?? config.midFbcPerBtc,
      spread_bps: config.spreadBps,
      max_fbc: settings.maxFbc(),
      networks: { btc: config.btcNetwork, fbc: config.fbdNetwork },
      btc_conf_target: config.btcConfTarget,
      fbc_conf_target: config.fbcConfTarget,
      // The fee-derived minimum, not the configured floor: quoting the floor
      // advertises sizes we would then refuse, and worse, sizes whose HTLC
      // could not pay for its own claim.
      min_btc_sat: this.minBtcSat,
    };
  }

  /**
   * Recompute the smallest swap whose BTC HTLC can still be claimed.
   *
   * The claim tx is ~139 vB, so at 100 sat/vB it costs ~13,900 sat — more than
   * a 10,000 sat HTLC holds. Such a swap is not "expensive", it is
   * unclaimable: we would fund the FBC leg, the taker would take it, and we
   * could not spend the BTC at all. The floor therefore has to track the fee
   * market rather than sit in MIN_BTC_SAT, with headroom because the claim
   * happens hours after the quote.
   */
  private refreshMinBtcSat(feeRate: number): number {
    const needed = minClaimableSats(feeRate * config.minBtcFeeHeadroom);
    this.minBtcSat = Math.max(settings.minBtcSat(), needed);
    return this.minBtcSat;
  }

  /**
   * Quote a swap. The argument is **satoshis**, matching `Quote.amount_btc`
   * and every other amount inside the bot.
   *
   * This used to take whole BTC while returning sats under the same
   * `amount_btc` name, so one round-trip carried two units for one identifier.
   * Nothing was mis-priced — both call sites happened to convert correctly —
   * but a caller who guessed wrong got "exceeds max inventory quote", which
   * points at liquidity rather than at units. The wire format still accepts
   * BTC for compatibility; `parseQuoteAmountSat` in api.ts is now the single
   * place that conversion happens.
   *
   * `side` is positionally first, and required, for a reason worth recording:
   * widening `Quote.side` from the `"buy_fbc"` literal to `Side` produces no
   * compiler errors anywhere, because a literal stays assignable to the union.
   * Nothing would have forced the requested side to reach the persisted quote.
   * A required first parameter is what makes that impossible to skip.
   */
  async getQuote(side: Side, amountSat: number): Promise<Quote> {
    // The bot serves one side today. This refusal is what keeps a sell quote
    // from being priced with buy-side inventory and buy-side timelock reasoning
    // before the sell routing exists to honour it.
    if (!servesSide(side)) {
      throw new Error(
        `unsupported side ${JSON.stringify(side)} (this maker serves ${SERVED_SIDES.join(", ")})`,
      );
    }
    if (!Number.isFinite(amountSat) || !(amountSat > 0)) {
      throw new Error("amount must be positive");
    }
    const amount_btc = Math.round(amountSat);
    if (amount_btc < settings.minBtcSat()) {
      throw new Error(`below minimum ${settings.minBtcSat()} sats`);
    }
    // Read the fee market before quoting, so the minimum we enforce is the one
    // that makes the claim possible rather than a constant chosen in 2024.
    const feeRate = await fetchBtcFeeRate();
    const minSat = this.refreshMinBtcSat(feeRate);
    if (amount_btc < minSat) {
      throw new Error(
        `below minimum ${minSat} sats at the current fee rate (${feeRate} sat/vB)`,
      );
    }

    const px = await getMidFbcPerBtc();
    const mid = px.midFbcPerBtc;

    // Cost recovery is a FIXED deduction, not a spread.
    //
    // The only unavoidable cost of running a swap is one BTC claim
    // transaction, and it costs the same whether the swap is $6 or $600. A
    // percentage spread therefore either overcharges large swaps or fails to
    // cover small ones — at a 10,000 sat minimum, breaking even on fees alone
    // would need ~278 bps at today's rates and ~1400 bps in a busy market,
    // which is an absurd markup to quote for what is really a flat ~300 sats.
    //
    // So: convert (what the taker pays) MINUS (what it costs us to claim it),
    // priced with the same headroom the minimum-size check uses, because the
    // claim happens hours later at whatever the fee market is then. The maker
    // nets zero on fees rather than subsidising or profiting.
    // `feeRate` is the same reading used for the minimum-size check above, but
    // charged at 1x, not with that check's headroom multiplier. The headroom
    // exists so we refuse swaps that might become unclaimable later; using it
    // to price would bill the taker four times the expected cost. If fees rise
    // before we claim we absorb the difference, and if they fall we keep it —
    // symmetric, and it averages out.
    const claimCostSats = Math.ceil(claimVbytes(TYPICAL_HTLC_SCRIPT_BYTES) * feeRate);
    const billableSats = amount_btc - claimCostSats;
    if (billableSats <= 0) {
      throw new Error(
        `below minimum: ${amount_btc} sat does not cover the ${claimCostSats} sat claim fee`,
      );
    }

    // The spread stays available on top, defaulting to zero. It is for price
    // drift over the ~90 minutes between quote and settlement, which is a
    // genuinely proportional risk — unlike the fee.
    const mult = 1 + config.spreadBps / 10_000;
    const amount_fbc = Math.round(((billableSats / 1e8) * mid) / mult * 1e6);
    if (amount_fbc < config.minFbcDd) {
      throw new Error("FBC amount below dust floor");
    }
    const fbcWhole = amount_fbc / 1e6;
    if (fbcWhole > settings.maxFbc()) {
      throw new Error(`exceeds max inventory quote (${settings.maxFbc()} FBC)`);
    }

    // Inventory check against what is actually uncommitted. Quoting off the
    // raw wallet balance lets concurrent swaps each see the same coins and
    // oversell them, leaving a taker's BTC locked with no FBC coming.
    try {
      const availableBumps = await this.availableFbcBumps();
      if (availableBumps < amount_fbc) {
        // Deliberately vague — the exact balance is not the public's business.
        throw new Error("insufficient FBC liquidity for this size");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("insufficient")) throw err;
      console.warn("[mm] balance check failed, refusing to quote:", err);
      throw new Error("liquidity check unavailable, try again shortly");
    }

    const [btcTip, fbcTip] = await Promise.all([
      fetchBtcTip(),
      this.fbd.getBlockCount(),
    ]);

    const quote: Quote = {
      quote_id: `q_${randomId(8)}`,
      // The side we were asked for, not a constant. This line is only reachable
      // as a compile error because getQuote takes `side` — widening the type
      // alone left the literal assignable and would have silently persisted
      // "buy_fbc" onto a sell quote.
      side,
      amount_btc,
      amount_fbc,
      mid_fbc_per_btc: Math.round(mid),
      spread_bps: config.spreadBps,
      mm_btc_pubkey: this.btc.pubkeyHex,
      mm_fbc_pubkey: this.fbcPubkey,
      btc_reference_height: btcTip,
      fbc_reference_height: fbcTip,
      btc_refund_height:
        btcTip +
        Math.ceil((config.btcRefundHours * 3600) / config.btcBlockSeconds),
      fbc_refund_height:
        fbcTip +
        Math.ceil((config.fbcRefundHours * 3600) / config.fbcBlockSeconds),
      btc_refund_hours: config.btcRefundHours,
      fbc_refund_hours: config.fbcRefundHours,
      expires_at: new Date(Date.now() + config.quoteTtlMs).toISOString(),
      created_at: Date.now(),
    };
    this.store.putQuote(quote);
    this.store.pruneQuotes(config.quoteTtlMs * 4);
    console.log(
      `[mm] quote mid=${Math.round(mid)} FBC/BTC (btc=$${px.btcUsd.toFixed(0)} fbc=$${px.fbcUsd} via ${px.source}) ` +
        `→ ${amount_btc} sat for ${fbcWhole} FBC ` +
        `(claim cost ${claimCostSats} sat @ ${feeRate} sat/vB recovered)`,
    );
    return quote;
  }

  async acceptOffer(quoteId: string, offer: OfferBlob): Promise<{ swap_id: string; accept: AcceptBlob }> {
    if (!offer || typeof offer !== "object") throw new Error("invalid offer");
    if (offer.kind !== "offer" || offer.version !== 1) throw new Error("invalid offer");
    if (offer.network?.btc !== config.btcNetwork || offer.network?.fbc !== config.fbdNetwork) {
      throw new Error("network mismatch");
    }
    if (!/^[0-9a-f]{32}$/i.test(offer.offer_id ?? "")) {
      throw new Error("offer_id must be 16 bytes of hex (SPEC §5.1)");
    }
    if (!/^[0-9a-f]{64}$/i.test(offer.hashlock ?? "")) throw new Error("bad hashlock");
    if (!/^0[23][0-9a-f]{64}$/i.test(offer.alice_btc_pubkey ?? "")) {
      throw new Error("bad alice_btc_pubkey");
    }
    if (!/^0[23][0-9a-f]{64}$/i.test(offer.alice_fbc_pubkey ?? "")) {
      throw new Error("bad alice_fbc_pubkey");
    }
    const expiresAt = Date.parse(offer.expires_at ?? "");
    if (!Number.isFinite(expiresAt)) {
      throw new Error("invalid offer: expires_at is not a timestamp");
    }

    // An offer_id we have already seen means a replay. Return the swap we
    // already created rather than building a second one — and never overwrite.
    const existingId = this.store.getSwapIdByOfferId(offer.offer_id.toLowerCase());
    if (existingId) {
      const existing = this.store.getSwap(existingId);
      if (existing) {
        if (existing.offer.hashlock.toLowerCase() !== offer.hashlock.toLowerCase()) {
          throw new Error("offer_id already used with a different hashlock");
        }
        return { swap_id: existing.swap_id, accept: existing.accept };
      }
    }

    // Quotes are single-use. Without this one quote could back an unlimited
    // number of swaps, all sharing a single BTC funding outpoint.
    const quote = this.store.takeQuote(quoteId);
    if (!quote) throw new Error("unknown or already-used quote");
    if (Date.parse(quote.expires_at) < Date.now()) throw new Error("quote expired");
    // A quote is the only place `side` comes from, and quotes are the one
    // persisted record `reindex()` does not walk — so a quote written by a
    // build that predates this field survives a restart with `side` undefined
    // and would write that straight into the swap. A swap born without a side
    // is un-actionable forever: it fails closed in planSwap and nothing ever
    // moves its funds. Refuse here, while refusing is still free.
    if (!isSide(quote.side)) {
      throw new Error(`unknown side on quote ${quoteId}`);
    }
    if (offer.amount_btc !== quote.amount_btc || offer.amount_fbc !== quote.amount_fbc) {
      throw new Error("offer amounts do not match quote");
    }

    // Timelocks: must match what we quoted, satisfy the Δ floor in the right
    // direction, and still be in the future against tips we read right now.
    const [btcTip, fbcTip] = await Promise.all([
      fetchBtcTip(),
      this.fbd.getBlockCount(),
    ]);
    const timelocks = checkOfferTimelocks(offer, quote, { btcTip, fbcTip });
    if (!timelocks.ok) throw new Error(timelocks.reason);

    // Don't promise FBC we have already committed elsewhere. This counts
    // outstanding accepts as well as funded swaps, so two takers racing the
    // same coins cannot both be told yes.
    // Everything from here to `addSwap` is one critical section: the check
    // below only means anything if nothing spends the inventory before the
    // reservation exists. See `inventoryLock`.
    return this.withInventoryLock(async () => {
    const available = await this.availableFbcBumps();
    if (available < offer.amount_fbc) {
      throw new Error("insufficient uncommitted FBC liquidity");
    }

    // Accepting costs the taker nothing on chain, so nothing but a cap stops
    // one caller holding every reservation at once. Checked after the
    // liquidity check so an honest taker hitting a full queue is told the
    // queue is full rather than that we are out of coins.
    const inFlight = this.store.unfundedReservationCount();
    if (inFlight >= config.maxUnfundedSwaps) {
      console.warn(
        `[mm] refusing accept: ${inFlight} unfunded swaps already hold reservations ` +
          `(MAX_UNFUNDED_SWAPS=${config.maxUnfundedSwaps})`,
      );
      throw new Error("too many unfunded swaps in flight, try again shortly");
    }

    /**
     * Store a blob we built, not the one we were handed.
     *
     * The offer is persisted for the life of the swap and every accept
     * rewrites the whole database, so an unauthenticated caller must not
     * choose how many bytes that is: anything not named here — extra keys,
     * an over-long expires_at — is dropped rather than kept forever. Every
     * field below has already been validated above or pinned to the quote.
     */
    const canonicalOffer: OfferBlob = {
      version: 1,
      kind: "offer",
      network: { btc: config.btcNetwork, fbc: config.fbdNetwork },
      hashlock: offer.hashlock.toLowerCase(),
      alice_btc_pubkey: offer.alice_btc_pubkey.toLowerCase(),
      alice_fbc_pubkey: offer.alice_fbc_pubkey.toLowerCase(),
      amount_btc: quote.amount_btc,
      amount_fbc: quote.amount_fbc,
      btc_refund_height: quote.btc_refund_height,
      fbc_refund_height: quote.fbc_refund_height,
      btc_reference_height: quote.btc_reference_height,
      fbc_reference_height: quote.fbc_reference_height,
      expires_at: new Date(expiresAt).toISOString(),
      offer_id: offer.offer_id.toLowerCase(),
    };

    const accept: AcceptBlob = {
      version: 1,
      kind: "accept",
      offer_id: canonicalOffer.offer_id,
      bob_btc_pubkey: this.btc.pubkeyHex,
      bob_fbc_pubkey: this.fbcPubkey,
    };

    const swap: Swap = {
      // Never derive the primary key from caller-controlled input.
      swap_id: `s_${randomId(16)}`,
      quote_id: quoteId,
      // From the quote we just consumed — the side we offered — not from the
      // offer blob, which the caller wrote.
      side: quote.side,
      state: "accepted",
      offer: canonicalOffer,
      accept,
      funded_btc: null,
      funded_fbc: null,
      btc_confs: 0,
      fbc_confs: 0,
      preimage_hex: null,
      btc_claim_txid: null,
      btc_claim_txids: [],
      fbc_claim_txid: null,
      btc_claim_confs: 0,
      btc_claim_fee_rate: null,
      btc_claim_broadcast_at: null,
      fbc_funding_txid_pending: null,
      fbc_funding_intent_at: null,
      fbc_funding_intent_height: null,
      fbc_refund_txid: null,
      fbc_refund_confs: 0,
      fbc_refund_broadcast_at: null,
      // sell_fbc mirrors, inert on buy_fbc.
      fbc_claim_confs: 0,
      fbc_claim_fee_rate: null,
      fbc_claim_broadcast_at: null,
      btc_funding_txid_pending: null,
      btc_funding_intent_at: null,
      btc_funding_intent_height: null,
      btc_refund_txid: null,
      btc_refund_confs: 0,
      error: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    this.store.addSwap(swap);
    console.log(`[mm] accepted swap ${swap.swap_id} ${offer.amount_btc} sat → ${offer.amount_fbc} bumps`);
    return { swap_id: swap.swap_id, accept };
    });
  }

  /**
   * Stop working a swap, without ever stranding coins.
   *
   * `failed` is terminal — listActiveSwaps drops it, so nothing will ever look
   * at the swap again. That is only safe while we hold nothing on chain. Once
   * an FBC funding tx exists (even one whose vout we could not resolve), the
   * swap has to stay active so the refund watchdog can still spend it at T2.
   */
  private abandon(swap: Swap, reason: string) {
    swap.error = reason;
    // Which chain holds OUR coins depends on the side: on buy_fbc we fund FBC,
    // on sell_fbc we fund BTC. Asking about the wrong chain marks the swap
    // `failed`, drops it from the active set, and strands whatever we funded —
    // so this reads the role rather than assuming the buy-side answer.
    //
    // `funded_btc` is deliberately consulted only on the sell side. On buy it
    // is the TAKER's submission, and treating their coins as ours-at-risk
    // would keep every failed buy swap active forever.
    const ourChain = rolesFor(swap.side).makerFunds;
    // The `_intent_at` fields count: they are written before the funding RPC
    // precisely because a lost response can leave coins on chain with no txid
    // recorded. Declaring `failed` on that state strands them.
    const ourFundsAtRisk =
      ourChain === "fbc"
        ? Boolean(
            swap.funded_fbc || swap.fbc_funding_txid_pending || swap.fbc_funding_intent_at,
          )
        : Boolean(
            swap.funded_btc || swap.btc_funding_txid_pending || swap.btc_funding_intent_at,
          );
    if (ourFundsAtRisk) {
      console.error(
        `[mm] ${swap.swap_id} ${reason} — keeping the swap active: our ${ourChain.toUpperCase()} is on chain and still needs refunding`,
      );
    } else {
      swap.state = "failed";
      console.error(`[mm] ${swap.swap_id} ${reason}`);
    }
    this.store.putSwap(swap);
  }

  /**
   * Decide whether a BTC claim that is well past T1 and still unconfirmed can
   * ever land, and stop working it if it cannot.
   *
   * `track_claim` on its own has no exit: it re-polls bitcoind every 8s
   * forever, and a swap in `claiming_btc` never leaves the active set. But
   * "past T1" is not the same as "dead" — T1 only means the taker *may* refund,
   * and until they actually do, our claim is still a valid spend of a real
   * outpoint. So this distinguishes the two cases rather than assuming either:
   *
   *  - outpoint still unspent → the taker has not refunded; keep bumping,
   *    because giving up would hand them their BTC back for free;
   *  - outpoint gone and our claim is not in the mempool → somebody else spent
   *    it (their refund). Nothing we broadcast can change that: terminal.
   *
   * The mempool check matters: `gettxout` counts mempool spends, so our own
   * pending claim also makes the outpoint look gone.
   */
  private async abandonClaim(swap: Swap, tips: Tips) {
    if (!swap.funded_btc || !swap.btc_claim_txid) return;

    // Re-read confirmations first. The plan was made from the count we stored
    // on the previous tick, and a claim that confirmed in between would look
    // exactly like a dead one below: its outpoint is spent (by itself) and it
    // is no longer in the mempool (it is in a block).
    // btcConfirmations collapses an RPC failure to 0, which here is the
    // difference between "our claim never landed" and "we could not ask".
    // Everything else in this function refuses to terminate on "could not
    // tell", so this input must too.
    // EVERY attempt, not just the newest — same reason track_claim does it.
    // After an RBF bump a miner may confirm an earlier version, and this is
    // the path that decides a swap is lost. Checking only the latest txid sees
    // an unconfirmed replacement whose outpoint is spent (by its own
    // predecessor) and which is absent from the mempool (it was replaced) —
    // indistinguishable from a claim that never landed. The swap would be
    // marked failed while the BTC was already in our wallet.
    const attempts = swap.btc_claim_txids.length
      ? [...swap.btc_claim_txids].reverse()
      : [swap.btc_claim_txid];
    let confs: number | null = null;
    let confirmedTxid: string | null = null;
    for (const txid of attempts) {
      const c = await btcConfirmationsStrict(txid);
      // "Could not ask" is not "did not land". One unreadable attempt must not
      // be read as zero, so the whole decision defers.
      if (c === null) {
        console.warn(
          `[mm] ${swap.swap_id} cannot read claim confirmations — deferring the give-up decision`,
        );
        return;
      }
      if (c > (confs ?? 0)) {
        confs = c;
        confirmedTxid = txid;
      }
      if (confs === null) confs = c;
    }
    if (confs === null) return;
    swap.btc_claim_confs = confs;
    if (confs >= 1) {
      if (confirmedTxid && confirmedTxid !== swap.btc_claim_txid) {
        console.log(
          `[mm] ${swap.swap_id} an earlier claim confirmed (${confirmedTxid.slice(0, 16)}…) — ` +
            `adopting it instead of giving up`,
        );
        swap.btc_claim_txid = confirmedTxid;
      }
      this.store.putSwap(swap);
      return;
    }

    const { btc } = htlcsFromOfferAccept(swap.offer, swap.accept);
    const stillFunded = await verifyBtcFundingOnChain({
      txid: swap.funded_btc.funding_txid,
      vout: swap.funded_btc.funding_vout,
      address: btcP2wshAddress(btc, config.btcNetwork),
      amountSats: swap.funded_btc.funding_amount,
    });

    if (!stillFunded.ok && stillFunded.reason.startsWith("RPC_UNAVAILABLE")) {
      console.warn(`[mm] ${swap.swap_id} claim liveness check deferred: ${stillFunded.reason}`);
      return;
    }

    // "Not ok" is not the same as "gone". bitcoindVerifyFunding only reaches
    // its address/amount comparisons AFTER gettxout returned a live UTXO, so
    // those two reasons are positive proof the outpoint is still unspent —
    // the case this function exists to keep bumping, not to give up on. Only
    // a missing UTXO means the taker may have refunded.
    const outpointGone =
      !stillFunded.ok && /is not in the UTXO set/i.test(stillFunded.reason);
    if (!stillFunded.ok && !outpointGone) {
      console.error(
        `[mm] ${swap.swap_id} claim liveness check inconclusive (${stillFunded.reason}) — ` +
          `the outpoint is still present, so the claim remains valid; not giving up`,
      );
      return;
    }

    if (stillFunded.ok) {
      const stalledMs = Date.now() - (swap.btc_claim_broadcast_at ?? 0);
      if (stalledMs <= MIN_MS_BETWEEN_BUMPS) return;
      console.error(
        `[mm] ${swap.swap_id} BTC claim unconfirmed ` +
          `${tips.btcTip - swap.offer.btc_refund_height} blocks past T1, but the ` +
          `outpoint is unspent — the taker has not refunded, bumping again`,
      );
      await this.claimBtc(swap.swap_id, tips, { bump: true });
      return;
    }

    const inMempool = await btcInMempool(swap.btc_claim_txid);
    if (inMempool !== false) {
      // true → our own claim is what is spending it. null → the node could not
      // say, and "could not say" is never grounds for declaring a loss.
      return;
    }

    swap.state = "failed";
    swap.error =
      `BTC claim ${swap.btc_claim_txid} never confirmed and the funding outpoint ` +
      `has been spent by a transaction that is not ours, past T1 ` +
      `(${swap.offer.btc_refund_height}) — the taker refunded after taking our FBC`;
    this.store.putSwap(swap);
    console.error(
      `[mm] LOST LEG ${swap.swap_id}: ${swap.error}. Their FBC claim was ` +
        `${swap.fbc_claim_txid ?? "unknown"}; no further action is possible.`,
    );
  }

  /**
   * Spendable FBC (in bumps) minus everything already committed to live swaps.
   *
   * `excludeSwapId` is for the swap that is about to spend: it is already
   * counted as committed, and subtracting its own reservation from the balance
   * it is being compared against would double-charge it.
   */
  private async availableFbcBumps(excludeSwapId?: string): Promise<number> {
    const balanceFbc = await this.fbd.getBalanceFbc();
    return (
      Math.round(balanceFbc * 1e6) - this.store.committedFbcBumps({ excludeSwapId })
    );
  }

  async submitFundedBtc(swapId: string, funded: FundedBtc): Promise<Swap> {
    const swap = this.store.getSwap(swapId);
    if (!swap) throw new Error("unknown swap");
    if (swap.state !== "accepted" && swap.state !== "waiting_btc_confs") {
      throw new Error(`cannot fund in state ${swap.state}`);
    }
    if (funded.kind !== "funded_btc") throw new Error("expected funded_btc");
    if (!/^[0-9a-f]{64}$/i.test(funded.funding_txid ?? "")) {
      throw new Error("funding_txid must be a 32-byte hex hash");
    }
    if (!Number.isInteger(funded.funding_vout) || funded.funding_vout < 0) {
      throw new Error("funding_vout must be a non-negative integer");
    }
    // If this swap already has a funding outpoint, it is the only one we accept.
    if (
      swap.funded_btc &&
      (swap.funded_btc.funding_txid.toLowerCase() !== funded.funding_txid.toLowerCase() ||
        swap.funded_btc.funding_vout !== funded.funding_vout)
    ) {
      throw new Error("swap is already bound to a different funding outpoint");
    }
    // One on-chain payment backs exactly one swap. Without this, N offers
    // sharing a hashlock and pubkeys derive the same HTLC address, so a single
    // funding tx could be presented to every one of them.
    const owner = this.store.getSwapIdByOutpoint(funded.funding_txid, funded.funding_vout);
    if (owner && owner !== swapId) {
      // Deliberately does not name the owning swap. swap_id is the only thing
      // guarding GET /v1/swaps/:id, and funding outpoints are public on chain —
      // echoing the id here would let an observer turn a known outpoint into a
      // readable swap record belonging to someone else.
      console.warn(`[mm] outpoint ${funded.funding_txid}:${funded.funding_vout} already bound to ${owner}`);
      throw new Error("funding outpoint already used by another swap");
    }

    const scriptOk = verifyFundedBtc(swap.offer, swap.accept, funded);
    if (!scriptOk.ok) throw new Error(scriptOk.reason);

    const { btc } = htlcsFromOfferAccept(swap.offer, swap.accept);
    const addr = btcP2wshAddress(btc, config.btcNetwork);
    const chainOk = await verifyBtcFundingOnChain({
      txid: funded.funding_txid,
      vout: funded.funding_vout,
      address: addr,
      amountSats: funded.funding_amount,
    });
    if (!chainOk.ok) throw new Error(chainOk.reason);

    this.store.bindOutpoint(funded.funding_txid, funded.funding_vout, swapId);
    swap.funded_btc = funded;
    swap.state = "waiting_btc_confs";
    swap.btc_confs = await btcConfirmations(funded.funding_txid);
    this.store.putSwap(swap);
    console.log(
      `[mm] funded_btc ${swap.swap_id} ${funded.funding_txid}:${funded.funding_vout} confs=${swap.btc_confs}`,
    );
    return this.publicSwap(swap);
  }

  getSwapPublic(swapId: string): Swap {
    const swap = this.store.getSwap(swapId);
    if (!swap) throw new Error("unknown swap");
    return this.publicSwap(swap);
  }

  /**
   * The view served on the unauthenticated GET /v1/swaps/:id.
   *
   * An explicit allowlist, built field by field — never a spread. The previous
   * version was `{ ...swap, error }`, which is a denylist of exactly one field
   * however its comment described it: every field ever added to `Swap` was
   * published by default.
   *
   * That was survivable only by accident. `preimage_hex` is set from chain data
   * on the buy side, so by the time it exists the taker has already published
   * it — harmless. On a sell swap the maker generates `s` at the start and it
   * is a live secret until the maker's own FBC claim reveals it; serving it
   * would hand the counterparty the maker's BTC leg for free. The shape of the
   * function has to be safe before that side exists, not after.
   */
  /**
   * Settled swaps, as verifiable trade records.
   *
   * Published so the registry can build price history that does not rest on a
   * maker's word. Every field here is either already on a public chain or
   * derivable from one, and the record deliberately carries the outpoints and
   * claim txids a third party needs to check it *without* trusting us:
   *
   *   - each funding output pays the stated amount
   *   - each funding output was spent by the stated claim tx
   *   - both claim witnesses reveal the SAME preimage
   *
   * That last one is the part that matters. The first two only show two
   * transactions happened; a shared preimage is what makes them one atomic
   * swap rather than two unrelated payments a maker chose to report together.
   *
   * `preimage_hex` is NOT included even though it is public by this point. A
   * verifier must read it off the chain, because taking it from us would make
   * the atomicity check circular — we would be supplying the evidence for our
   * own claim.
   *
   * `refunded` swaps are excluded upstream: a refund is a trade that did not
   * happen, and reporting it as volume would invent a price nobody paid.
   */
  listTrades(opts: { since?: number; limit?: number } = {}) {
    return this.store.listSettledSwaps(opts).map((s) => ({
      swap_id: s.swap_id,
      /** What the TAKER did. The name carries the perspective. */
      taker_side: s.side,
      /** What WE did. The inverse — see makerActionLabel. */
      maker_action: makerActionLabel(s.side),
      // When it reached burial depth, not when it was quoted. A trade is real
      // once it cannot be reorged away.
      settled_at: s.updated_at,
      amount_btc_sat: s.offer.amount_btc,
      amount_fbc_bumps: s.offer.amount_fbc,
      btc: {
        funding_txid: s.funded_btc?.funding_txid ?? null,
        funding_vout: s.funded_btc?.funding_vout ?? null,
        claim_txid: s.btc_claim_txid,
      },
      fbc: {
        funding_txid: s.funded_fbc?.funding_txid ?? null,
        funding_vout: s.funded_fbc?.funding_vout ?? null,
        claim_txid: s.fbc_claim_txid,
      },
    }));
  }

  /**
   * In-flight swaps whose FBC leg has already been claimed.
   *
   * Same shape as `listTrades` so a consumer can render both from one code
   * path, plus `settling_since` instead of `settled_at` — the name is different
   * because the meaning is different, and nothing should treat the two as
   * interchangeable.
   *
   * `settling_since` is when the BTC claim was broadcast, which is written once
   * and never again. `updated_at` was the obvious choice and is wrong: the poll
   * bumps it every time it re-reads the confirmation count, so a swap that had
   * been settling for an hour rendered as "17s ago" and reset to "just now"
   * every few seconds.
   *
   * `btc.claim_txid` is included even though it is unconfirmed. That is the
   * point: it is what a consumer watches to learn this became a real trade.
   */
  listSettling(opts: { limit?: number } = {}) {
    return this.store.listSettlingSwaps(opts).map((s) => ({
      swap_id: s.swap_id,
      /** What the TAKER did. The name carries the perspective. */
      taker_side: s.side,
      /** What WE did. The inverse — see makerActionLabel. */
      maker_action: makerActionLabel(s.side),
      settling_since: s.btc_claim_broadcast_at ?? s.updated_at,
      amount_btc_sat: s.offer.amount_btc,
      amount_fbc_bumps: s.offer.amount_fbc,
      btc: {
        funding_txid: s.funded_btc?.funding_txid ?? null,
        funding_vout: s.funded_btc?.funding_vout ?? null,
        claim_txid: s.btc_claim_txid,
      },
      fbc: {
        funding_txid: s.funded_fbc?.funding_txid ?? null,
        funding_vout: s.funded_fbc?.funding_vout ?? null,
        claim_txid: s.fbc_claim_txid,
      },
    }));
  }

  /**
   * Everything the operator's own dashboard needs, in one read.
   *
   * Deliberately NOT reachable from the public API. It carries wallet
   * balances, deposit addresses and the free-inventory figure — the last of
   * which the quote path goes out of its way to keep vague, because knowing
   * exactly how much FBC is unreserved tells a taker precisely how large an
   * order it takes to empty the book.
   *
   * A chain being unreachable yields null for that side rather than throwing
   * the whole snapshot away. A dashboard that shows nothing because one of two
   * nodes is down is worse than one that shows the half it can still see —
   * particularly since "my node is down" is a thing the operator opened this
   * page to find out.
   */
  async operatorSnapshot() {
    const [btcSats, fbcWhole] = await Promise.all([
      bitcoindSpendableSats().catch(() => null),
      this.fbd.getBalanceFbc().catch(() => null),
    ]);
    const availableBumps = await this.availableFbcBumps().catch(() => null);
    const active = this.store.listActiveSwaps();
    return {
      wallets: {
        btc: {
          spendable_sat: btcSats,
          // Where the maker sends BTC to top up. It is the same address the
          // claim wallet spends from, which is the point: BTC arriving here is
          // BTC available to pay claim fees.
          deposit_address: this.btc?.address ?? null,
          wallet: config.bitcoinRpcWallet || null,
        },
        fbc: {
          balance_fbc: fbcWhole,
          deposit_address: this.fbcAddress || null,
          wallet: config.fbdWallet || null,
        },
      },
      inventory: {
        // What a taker could actually buy right now: balance minus what is
        // already promised to live swaps.
        available_fbc: availableBumps === null ? null : availableBumps / 1e6,
        max_fbc_per_swap: settings.maxFbc(),
        min_btc_sat: this.minBtcSat,
      },
      swaps: {
        // Money actually committed on a chain. This is the number that means
        // "something needs to finish", and the only one worth alarming on.
        in_flight: active.filter((s) => s.funded_btc || s.funded_fbc).length,
        // Quotes taken and never funded. They reserve nothing and expire on
        // their own; counting them as in-flight made an abandoned offer from
        // last night look like a live swap.
        awaiting_funding: active.filter((s) => !s.funded_btc && !s.funded_fbc).length,
        settling: this.store.listSettlingSwaps().length,
        settled_all_time: this.store.listSettledSwaps({ limit: 500 }).length,
      },
      limits: {
        // Shown so the dashboard can say WHY a withdrawal is capped rather
        // than only refusing one.
        btc_fee_reserve_sat: this.btcFeeReserveSats(),
      },
    };
  }

  /**
   * Move funds out of the maker's wallets.
   *
   * The dangerous operation on this bot, so what it refuses matters more than
   * what it does. Two reserves, for two different ways a withdrawal loses
   * money that is not the amount withdrawn:
   *
   * **FBC is capped at unreserved inventory, never the raw balance.** Coins
   * promised to a live swap are still sitting in this wallet — that is exactly
   * what `availableFbcBumps` subtracts. Withdrawing against the balance would
   * let the operator spend the FBC that an accepted swap is about to need, and
   * the failure surfaces later as a taker whose BTC is locked in an HTLC while
   * the maker cannot fund the other side.
   *
   * **BTC keeps a fee reserve.** This wallet exists to pay claim fees. Draining
   * it does not lose the balance, it loses every HTLC the bot can then no
   * longer claim — a far larger number. The reserve scales with swaps in
   * flight because each one will need a claim.
   *
   * Both are floors, not advice: the request is refused, not trimmed. Silently
   * sending less than asked is its own kind of surprise.
   */
  /**
   * One withdrawal at a time per chain, and the second caller is told so.
   *
   * The reserve check reads a balance and then sends, with an await in
   * between: two concurrent requests both read the pre-send balance, both
   * pass, and together spend more than either was allowed — on FBC, coins
   * already promised to a live swap.
   *
   * A queue fixes that but can wedge, so I first added a timeout that released
   * the queue while the original send was still in flight. That was worse than
   * the problem: a retry then passes the same reserve check against a balance
   * the first send is about to spend, which is the exact race the lock existed
   * to prevent. Releasing a lock you cannot prove is free is not a fix.
   *
   * So the lock is held until the outcome is known, and a concurrent request
   * is REFUSED immediately rather than queued behind an unknown wait. That
   * keeps the safety property and removes the silent wedge: the operator gets
   * told, in a sentence, why nothing happened.
   *
   * A genuinely stuck RPC still pins its chain until the process restarts.
   * That is deliberate — while a send may or may not have happened, refusing
   * to start another one is the only answer that cannot lose money.
   */
  private withdrawBusy: Record<"btc" | "fbc", boolean> = { btc: false, fbc: false };

  /**
   * One lock over every read-check-commit on inventory.
   *
   * Two operations decide what this maker can still promise, and both do it in
   * two steps: read what is uncommitted, then commit against it. `acceptOffer`
   * checks `availableFbcBumps()` and later calls `store.addSwap`, which is
   * what creates the reservation. `withdraw` checks the same figure and then
   * sends. Interleave those and each sees a balance the other is about to
   * spend.
   *
   * The failure is not symmetric. A withdrawal landing between an accept's
   * check and its reservation takes coins already promised to a taker who is
   * at that moment funding their BTC leg — their money locks in an HTLC with
   * no FBC coming, and the only way out is waiting for a timelock.
   *
   * I first guarded withdrawals against each other and stopped there, which
   * left exactly this case. Hence a lock named after the invariant rather than
   * after either caller: anything that reads uncommitted inventory and then
   * acts on it belongs inside it.
   *
   * A queue rather than a refusal, because takers race each other legitimately
   * and an accept must not fail merely because another accept is in progress.
   * The operator-facing fail-fast on concurrent withdrawals stays where it is
   * — that is a UX choice layered on top, not the safety property.
   */
  private inventoryLock: Promise<unknown> = Promise.resolve();

  private withInventoryLock<T>(fn: () => Promise<T>): Promise<T> {
    // Run after the predecessor settles, whichever way it settled: one
    // caller's failure must not stall every later one.
    const run = this.inventoryLock.then(fn, fn);
    this.inventoryLock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async withdraw(params: {
    chain: "btc" | "fbc";
    address: string;
    amount?: number;
    max?: boolean;
  }): Promise<{ txid: string; amount: number; chain: "btc" | "fbc" }> {
    if (this.withdrawBusy[params.chain]) {
      throw new Error(
        `a ${params.chain.toUpperCase()} withdrawal is already in progress — ` +
          `wait for it to return before starting another. Two at once could ` +
          `each pass the reserve check and together overspend it.`,
      );
    }
    this.withdrawBusy[params.chain] = true;
    try {
      // Same lock acceptOffer holds. The fail-fast above only stops two
      // withdrawals; this is what stops a withdrawal from spending inventory
      // an accept is in the middle of reserving.
      return await this.withInventoryLock(() => this.withdrawLocked(params));
    } finally {
      this.withdrawBusy[params.chain] = false;
    }
  }

  private async withdrawLocked(params: {
    chain: "btc" | "fbc";
    address: string;
    /** Base units — sats for BTC, bumps for FBC. Omit with max:true. */
    amount?: number;
    max?: boolean;
  }): Promise<{ txid: string; amount: number; chain: "btc" | "fbc" }> {
    const { chain, address } = params;
    if (typeof address !== "string" || !address.trim()) {
      throw new Error("a destination address is required");
    }

    if (chain === "fbc") {
      const valid = await this.fbd.validateAddress(address);
      if (!valid) throw new Error(`fbd does not recognise ${address} as a valid address`);
      const availableBumps = await this.availableFbcBumps();
      // fbd charges its fee ON TOP of the amount sent — there is no
      // subtract-from-amount option on that RPC, unlike the BTC path. So
      // withdrawing exactly the unreserved figure spends the fee out of
      // reserved inventory, and a "max" sweep of it simply fails for want of
      // fee headroom. Hold a slice back on both counts.
      const spendableBumps = Math.max(0, availableBumps - FBC_WITHDRAW_FEE_BUMPS);
      const amount = params.max ? spendableBumps : Math.round(params.amount ?? 0);
      if (!Number.isInteger(amount) || amount <= 0) {
        throw new Error(
          params.max
            ? `nothing to withdraw: the unreserved ${availableBumps / 1e6} FBC does not ` +
              `cover the ${FBC_WITHDRAW_FEE_BUMPS / 1e6} FBC held back for the transaction fee`
            : "amount must be a positive number of bumps",
        );
      }
      if (amount > spendableBumps) {
        throw new Error(
          `only ${spendableBumps / 1e6} FBC may be withdrawn — ${availableBumps / 1e6} FBC ` +
            `is unreserved and ${FBC_WITHDRAW_FEE_BUMPS / 1e6} of that is held back for the ` +
            `transaction fee, which fbd charges on top of the amount sent. The rest is ` +
            `promised to swaps in flight; withdrawing it would leave a taker's BTC locked ` +
            `with no FBC to pay them.`,
        );
      }
      const txid = await this.fbd.sendToAddress(address, amount);
      console.log(`[admin] withdrew ${amount / 1e6} FBC to ${address} — ${txid}`);
      return { txid, amount, chain };
    }

    const valid = await bitcoindValidateAddress(address);
    if (!valid) throw new Error(`bitcoind does not recognise ${address} as a valid address`);
    const balance = await bitcoindSpendableSats();
    const reserve = this.btcFeeReserveSats();
    const spendable = Math.max(0, balance - reserve);
    const amount = params.max ? spendable : Math.round(params.amount ?? 0);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(
        params.max
          ? `nothing to withdraw: the whole ${balance} sat balance is inside the ` +
            `${reserve} sat claim-fee reserve`
          : "amount must be a positive number of satoshis",
      );
    }
    if (amount > spendable) {
      throw new Error(
        `only ${spendable} of ${balance} sat may be withdrawn — ${reserve} sat is held ` +
          `back to pay claim fees. Without it the bot cannot claim the BTC from HTLCs ` +
          `it has already funded FBC against.`,
      );
    }
    const feeRate = await bitcoindFeeRate().catch(() => 0);
    const txid = await bitcoindSendToAddress({
      address,
      sats: amount,
      feeRate: feeRate > 0 ? feeRate : undefined,
      // Only when sweeping: otherwise the fee comes from the reserve, which is
      // what the reserve is for.
      subtractFeeFromAmount: params.max === true,
    });
    console.log(`[admin] withdrew ${amount} sat to ${address} — ${txid}`);
    return { txid, amount, chain };
  }

  /**
   * Satoshis kept back so the bot can always claim.
   *
   * A claim costs ~417 sat at 3 sat/vB, but fee markets move and a swap that
   * cannot be claimed loses the whole HTLC rather than the fee. So: a flat
   * floor for the swaps that do not exist yet, plus a generous per-swap
   * allowance for the ones that do.
   */
  btcFeeReserveSats(): number {
    const inFlight = this.store
      .listActiveSwaps()
      .filter((s) => s.funded_btc || s.funded_fbc).length;
    return Math.max(config.btcWithdrawReserveSat, inFlight * 5_000);
  }

  private publicSwap(swap: Swap): Swap {
    return {
      swap_id: swap.swap_id,
      quote_id: swap.quote_id,
      // Published: the counterparty chose the side when it took the quote, so
      // this tells it nothing it did not already decide. It also cannot be
      // withheld — `publicSwap` returns a `Swap`, and `side` is non-nullable.
      side: swap.side,
      state: swap.state,
      offer: swap.offer,
      accept: swap.accept,
      funded_btc: swap.funded_btc,
      funded_fbc: swap.funded_fbc,
      btc_confs: swap.btc_confs,
      fbc_confs: swap.fbc_confs,
      // Counterparty-observable settlement facts. Every one of these is already
      // public on a chain, or the counterparty's own submission echoed back.
      btc_claim_txid: swap.btc_claim_txid,
      // Published: each of these is already public on chain the moment it is
      // broadcast, and a taker watching for our claim benefits from seeing the
      // replacements rather than only the newest.
      btc_claim_txids: swap.btc_claim_txids,
      fbc_claim_txid: swap.fbc_claim_txid,
      btc_claim_confs: swap.btc_claim_confs,
      fbc_refund_txid: swap.fbc_refund_txid,
      fbc_refund_confs: swap.fbc_refund_confs,
      // Published: a claim or refund on either chain is an on-chain fact the
      // counterparty can see anyway, and needs, to know where the swap stands.
      fbc_claim_confs: swap.fbc_claim_confs,
      btc_refund_txid: swap.btc_refund_txid,
      btc_refund_confs: swap.btc_refund_confs,
      error: swap.error ? publicError(swap.error) : null,
      created_at: swap.created_at,
      updated_at: swap.updated_at,

      // Deliberately withheld, and why:
      //   preimage_hex              — a live secret on the sell side
      //   btc_claim_fee_rate        — our fee policy
      //   btc_claim_broadcast_at    — our timing
      //   fbc_funding_txid_pending  — internal, pre-confirmation
      //   fbc_funding_intent_*      — internal
      //   fbc_claim_fee_rate        — our fee policy, sell-side mirror
      //   fbc_claim_broadcast_at    — our timing, sell-side mirror
      //   btc_funding_txid_pending  — internal, sell-side mirror
      //   btc_funding_intent_*      — internal, sell-side mirror
      //   fbc_refund_broadcast_at   — our timing
      preimage_hex: null,
      btc_claim_fee_rate: null,
      btc_claim_broadcast_at: null,
      fbc_funding_txid_pending: null,
      fbc_funding_intent_at: null,
      fbc_funding_intent_height: null,
      fbc_claim_fee_rate: null,
      fbc_claim_broadcast_at: null,
      btc_funding_txid_pending: null,
      btc_funding_intent_at: null,
      btc_funding_intent_height: null,
      fbc_refund_broadcast_at: null,
    };
  }

  async tick() {
    if (!this.started) return;
    // One tick at a time. A tick walks every active swap with several RPCs
    // each and routinely outruns the 8s interval, so overlapping ticks would
    // read the same swap concurrently and act on it twice — the per-swap
    // in-flight sets below only close that race for the three spends they
    // cover, not for the state writes around them.
    if (this.ticking) {
      console.warn("[mm] previous tick still running, skipping this one");
      return;
    }
    this.ticking = true;
    try {
      await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick() {
    const active = this.store.listActiveSwaps();
    if (!active.length) return;

    // Read both tips once per tick rather than per swap. Every deadline in the
    // protocol is a height, so a tick that cannot see the tips cannot safely
    // decide anything — skip rather than guess.
    let tips: Tips;
    try {
      const [btcTip, fbcTip] = await Promise.all([
        fetchBtcTip(),
        this.fbd.getBlockCount(),
      ]);
      tips = { btcTip, fbcTip };
    } catch (err) {
      console.error(
        "[mm] tip read failed, skipping tick:",
        err instanceof Error ? err.message : err,
      );
      return;
    }

    for (const swap of active) {
      try {
        await this.advance(swap.swap_id, tips);
      } catch (err) {
        const s = this.store.getSwap(swap.swap_id);
        if (s) {
          s.error = err instanceof Error ? err.message : String(err);
          this.store.putSwap(s);
        }
        console.error(`[mm] advance ${swap.swap_id}:`, s?.error);
      }
    }
  }

  /** In-process locks so concurrent ticks don't double-spend. */
  private fundingInFlight = new Set<string>();
  private refundInFlight = new Set<string>();
  private claimInFlight = new Set<string>();

  private async advance(swapId: string, tips: Tips) {
    const swap = this.store.getSwap(swapId);
    if (!swap) return;

    // Routing lives in planSwap so it can be enumerated in a unit test — two
    // fund-losing bugs have already hidden in these predicates.
    const plan = planSwap(swap, tips, checkRefundsStillFuture(swap.offer, tips).ok);

    if (plan.includes("expire_unfunded")) {
      // Through abandon(), not `state = "failed"` directly. abandon() is the
      // one place that asks whether OUR coins are on chain before declaring a
      // swap dead, and `failed` drops it from listActiveSwaps — nothing else
      // walks the database, so a swap retired with funds outstanding is
      // retired permanently, not until its timelock.
      //
      // Reaching here means the taker never funded, so on buy_fbc we hold
      // nothing and the guard passes trivially. That is exactly why the
      // shortcut looked safe. It is not safe on sell_fbc, where we fund first:
      // the same path would strand our BTC. Routing every abort through one
      // guarded exit is cheaper than remembering which aborts are special.
      this.abandon(
        swap,
        "taker never funded the BTC HTLC before its refund window opened",
      );
      return;
    }

    if (plan.includes("poll_btc_confs") && swap.funded_btc) {
      swap.btc_confs = await btcConfirmations(swap.funded_btc.funding_txid);
      this.store.putSwap(swap);
      if (btcConfsSufficient(swap.btc_confs)) {
        // Accepting and funding are ~an hour apart at the default conf target,
        // and T1 keeps approaching in between. Re-check before we commit FBC.
        const stillSafe = checkRefundsStillFuture(swap.offer, tips);
        if (!stillSafe.ok) {
          this.abandon(swap, `refusing to fund FBC: ${stillSafe.reason}`);
          return;
        }
        // The taker must not have taken their BTC back while we waited.
        const { btc } = htlcsFromOfferAccept(swap.offer, swap.accept);
        const stillFunded = await verifyBtcFundingOnChain({
          txid: swap.funded_btc.funding_txid,
          vout: swap.funded_btc.funding_vout,
          address: btcP2wshAddress(btc, config.btcNetwork),
          amountSats: swap.funded_btc.funding_amount,
        });
        if (!stillFunded.ok) {
          // An RPC outage is not evidence the taker refunded. Treating it as
          // such would terminally fail a perfectly good swap every time
          // bitcoind restarts.
          if (stillFunded.reason.startsWith("RPC_UNAVAILABLE")) {
            swap.error = `deferring FBC funding: ${stillFunded.reason}`;
            this.store.putSwap(swap);
            console.warn(`[mm] ${swap.swap_id} ${swap.error}`);
            return;
          }
          this.abandon(
            swap,
            `refusing to fund FBC: BTC HTLC no longer spendable — ${stillFunded.reason}`,
          );
          return;
        }
        await this.fundFbc(swapId);
      }
      return;
    }

    if (plan.includes("poll_fbc_confs") && swap.funded_fbc) {
      swap.fbc_confs = await fbcConfirmations(swap.funded_fbc.funding_txid);
      if (swap.fbc_confs >= config.fbcConfTarget) {
        swap.state = "claimable";
      }
      this.store.putSwap(swap);
      // Fall through to preimage watch
    }

    if (plan.includes("watch_preimage") && swap.funded_fbc) {
      const hit = await findFbcPreimage(
        swap.funded_fbc.funding_txid,
        swap.funded_fbc.funding_vout,
        swap.funded_fbc.htlc_address,
        swap.offer.hashlock,
      );
      // Never build a claim around an unverified witness element. A wrong
      // preimage yields a tx that can only fail, and we would retry it forever
      // while the real claim window closes. Fall through rather than return —
      // the refund paths below must stay reachable.
      if (hit && !preimageMatches(hit.preimageHex, swap.offer.hashlock)) {
        console.warn(
          `[mm] ${swapId}: spend ${hit.spendingTxid} does not carry a preimage for our hashlock — ignoring`,
        );
      } else if (hit) {
        swap.preimage_hex = hit.preimageHex;
        swap.fbc_claim_txid = hit.spendingTxid;
        this.store.putSwap(swap);
        await this.claimBtc(swapId, tips);
        return;
      }
    }

    // Long overdue: work out whether this claim can still land.
    if (plan.includes("abandon_claim")) {
      await this.abandonClaim(swap, tips);
      return;
    }

    // A broadcast claim still has to land. Track it to confirmation and bump
    // the fee if it stalls — our deadline is T1, after which the taker refunds
    // and the outpoint is gone.
    if (plan.includes("track_claim") && swap.btc_claim_txid) {
      // Check every attempt, not just the newest. A replacement does not
      // retract its predecessor: a miner may confirm an earlier version, and
      // polling only the latest would report zero confirmations forever on a
      // swap whose BTC had already arrived — eventually failing it and
      // reporting a payment we did in fact receive as lost.
      //
      // Newest first, since it is the likeliest to be mined; whichever has
      // confirmations becomes the claim of record.
      const attempts = swap.btc_claim_txids.length
        ? [...swap.btc_claim_txids].reverse()
        : [swap.btc_claim_txid];
      let best = 0;
      let bestTxid = swap.btc_claim_txid;
      for (const txid of attempts) {
        const confs = await btcConfirmations(txid);
        if (confs > best) {
          best = confs;
          bestTxid = txid;
        }
      }
      if (best > 0 && bestTxid !== swap.btc_claim_txid) {
        console.log(
          `[mm] ${swapId} an earlier claim confirmed (${bestTxid.slice(0, 16)}…), ` +
            `not the latest replacement — adopting it`,
        );
        swap.btc_claim_txid = bestTxid;
      }
      swap.btc_claim_confs = best;
      // Terminal means "we will never have to act on this swap again", and a
      // single confirmation does not mean that: a 1-block reorg evicts the
      // claim, and a swap already dropped from the active set would never
      // notice, never re-broadcast, and lose the BTC leg outright after we had
      // already given up the FBC. Stay in `claiming_btc` until it is buried.
      if (swap.btc_claim_confs >= config.claimBurialConfs) {
        swap.state = "done";
        swap.error = null;
        this.store.putSwap(swap);
        console.log(
          `[mm] done ${swapId} btc_claim=${swap.btc_claim_txid} confs=${swap.btc_claim_confs}`,
        );
        return;
      }
      this.store.putSwap(swap);

      // In a block but not yet buried: a fee bump cannot help (RBF no longer
      // applies) and would only replace a confirmed tx in our own records. If
      // a reorg drops it back to zero we land in the bump path again.
      if (swap.btc_claim_confs >= 1) return;

      const blocksLeft = swap.offer.btc_refund_height - tips.btcTip;
      const stalledMs = Date.now() - (swap.btc_claim_broadcast_at ?? 0);
      // Both branches are rate-limited by how long ago we last broadcast.
      // Without that the urgent branch fires on every 8s tick and compounds
      // 1.5x straight to the cap inside a minute, burning the whole HTLC on
      // fees for a claim the mempool has not had a chance to accept yet.
      const canBumpAgain = stalledMs > MIN_MS_BETWEEN_BUMPS;
      if (!canBumpAgain) return;

      if (stalledMs > CLAIM_REBROADCAST_AFTER_MS) {
        console.warn(
          `[mm] ${swapId} BTC claim unconfirmed after ${Math.round(stalledMs / 60_000)}m ` +
            `(${blocksLeft} blocks to T1) — rebroadcasting at a higher fee`,
        );
        await this.claimBtc(swapId, tips, { bump: true });
      } else if (blocksLeft <= config.btcConfTarget) {
        console.error(
          `[mm] ${swapId} URGENT: BTC claim still unconfirmed with only ${blocksLeft} ` +
            `blocks until the taker can refund — bumping now`,
        );
        await this.claimBtc(swapId, tips, { bump: true });
      }
      return;
    }

    // T2 has passed and the taker never claimed: take our own FBC back.
    if (plan.includes("refund_fbc")) {
      await this.refundFbc(swapId);
      return;
    }

    // Refund broadcast, waiting for it to land.
    if (plan.includes("track_refund") && swap.fbc_refund_txid) {
      swap.fbc_refund_confs = await fbcConfirmations(swap.fbc_refund_txid);
      // Same reasoning as the claim: `refunded` drops the swap from the active
      // set for good, so it has to mean the refund cannot be reorged out. At
      // one confirmation a reorg would silently leave our FBC in an HTLC with
      // nothing watching it — and the taker's claim can still win that race
      // (SPEC §6.1), which is exactly why `watch_preimage` stays planned here.
      if (swap.fbc_refund_confs >= config.refundBurialConfs) {
        swap.state = "refunded";
        swap.error = null;
        swap.fbc_refund_broadcast_at = null;
        console.log(
          `[mm] refunded ${swapId} fbc_refund=${swap.fbc_refund_txid} confs=${swap.fbc_refund_confs}`,
        );
      } else if (
        swap.fbc_refund_confs === 0 &&
        swap.fbc_refund_broadcast_at &&
        Date.now() - swap.fbc_refund_broadcast_at > FBC_REFUND_STALL_MS
      ) {
        // A refund that never confirms leaves our FBC in the HTLC while this
        // loop polls forever, and until now it said nothing — the first hint
        // would have been noticing the coins were still gone. There is no bump
        // path to escalate to yet (see the note on FBC_REFUND_STALL_MS), so the
        // one useful thing is to be loud and to surface it on the API.
        const mins = Math.round((Date.now() - swap.fbc_refund_broadcast_at) / 60_000);
        const msg =
          `FBC refund ${swap.fbc_refund_txid} unconfirmed after ${mins} min — ` +
          `the FBC is still in the HTLC and needs a look`;
        if (swap.error !== msg) {
          swap.error = msg;
          console.error(`[mm] ${swapId} ${msg}`);
        }
      }
      this.store.putSwap(swap);
    }
  }

  private async fundFbc(swapId: string) {
    const swap = this.store.getSwap(swapId);
    if (!swap || swap.funded_fbc) return;
    if (this.fundingInFlight.has(swapId)) return;
    this.fundingInFlight.add(swapId);

    try {
      // Recover stuck "funding_fbc" after vout-resolve failure (tx may already be on chain).
      const { fbc } = htlcsFromOfferAccept(swap.offer, swap.accept);
      const scriptHex = toHex(fbc);
      const amountBumps = swap.offer.amount_fbc;
      const amountFbc = amountBumps / 1e6;
      const addr = fbcP2wshAddress(fbc, config.fbdNetwork);

      // Resolving the vout can fail after the funding tx is already on chain.
      // The txid is recorded the moment it exists so a retry adopts it instead
      // of funding again — this used to be recovered by regex-matching the
      // previous error string, which is not something to build a spend on.
      let txid = swap.fbc_funding_txid_pending;
      let fundedAmountBumps: number | null = null;
      let fundedAddress = addr;

      if (!txid && swap.fbc_funding_intent_at) {
        // We already started a funding call for this swap and never learned its
        // txid. The call may still have broadcast — a lost RPC response leaves
        // an HTLC on chain — so look for the payment before making another one.
        // A second HTLC would spend a second lot of inventory into an address
        // we would then have to refund twice, once per outpoint.
        // The amount is part of the search, not a check afterwards. An HTLC
        // address is public from the moment it is quoted, so a taker can pay
        // it themselves — and the first match used to win, be persisted, and
        // only then be compared, abandoning the swap with our real funding
        // never found and no outpoint to refund at T2.
        const existing = await findFbcPaymentToAddress(
          addr,
          swap.fbc_funding_intent_height,
          amountBumps,
        );
        if (existing) {
          txid = existing.txid;
          swap.fbc_funding_txid_pending = txid;
          this.store.putSwap(swap);
          console.warn(
            `[mm] ${swapId} adopting existing FBC HTLC funding ${txid}:${existing.vout} — ` +
              `a previous fundhtlc call landed on chain without returning`,
          );
          const adopted = checkAmount(existing.value, amountBumps);
          if (adopted === "mismatch") {
            this.abandon(
              swap,
              `existing FBC HTLC funding ${txid} pays ${existing.value} to ${addr}, ` +
                `not the ${amountBumps} bumps this swap promised`,
            );
            return;
          }
          if (adopted === "unreadable") {
            // Our own coins, already on chain. Abandoning here would strand
            // them, so it proceeds — but says so, because the T2 refund will be
            // signed over an amount nothing confirmed.
            console.warn(
              `[mm] ${swapId} adopted FBC funding ${txid} without being able to read its ` +
                `value from fbd; recording ${amountBumps} bumps unverified`,
            );
          }
        }
      }

      if (txid) {
        console.log(`[mm] recovering funded_fbc ${swapId} from ${txid}`);
      } else {
        // Inventory moves between accept and here — the BTC confirmation wait
        // is ~an hour, other swaps fund in that time, and an `accepted`
        // reservation may have expired. Re-check against the live balance
        // rather than against the promise we made an hour ago.
        const available = await this.availableFbcBumps(swapId);
        if (available < amountBumps) {
          swap.error =
            `not funding FBC yet: ${available} bumps uncommitted, need ${amountBumps}`;
          this.store.putSwap(swap);
          console.error(`[mm] ${swapId} ${swap.error}`);
          return;
        }

        // Intent is recorded BEFORE the call, not after it. `fbc_funding_txid_pending`
        // can only be written once fundHtlc returns, so a lost response left no
        // record at all and the next tick funded the HTLC a second time. The
        // height is read first so the two fields are always written together —
        // an intent without a height narrows the search that has to find the
        // payment we may already have made.
        const intentHeight = await this.fbd.getBlockCount();
        swap.state = "funding_fbc";
        swap.fbc_funding_intent_at = Date.now();
        swap.fbc_funding_intent_height = intentHeight;
        this.store.putSwap(swap);

        console.log(`[mm] funding FBC HTLC ${swapId} ${amountFbc} FBC → ${addr}`);
        const funded = await this.fbd.fundHtlc(scriptHex, amountFbc);
        txid = funded.txid;
        swap.fbc_funding_txid_pending = txid;
        this.store.putSwap(swap);

        // Record what fbd actually funded, not what we asked for. The T2 refund
        // is signed over this address and amount, and signing over an assumed
        // amount produces a transaction the network rejects — which we would
        // only discover at T2, with no time left to work it out.
        fundedAddress = funded.address || addr;
        fundedAmountBumps = Number(funded.amount_bumps);
        if (fundedAddress !== addr || fundedAmountBumps !== amountBumps) {
          this.abandon(
            swap,
            `fbd funded ${fundedAmountBumps} bumps to ${fundedAddress}, but this swap ` +
              `derived ${amountBumps} bumps to ${addr} (tx ${txid}) — the HTLC on chain ` +
              `is not the one this swap agreed to`,
          );
          return;
        }
      }

      const output = await resolveFbcFundingOutput(txid, addr);
      const vout = output.vout;
      const paid = checkAmount(output.value, amountBumps);
      if (paid === "mismatch") {
        this.abandon(
          swap,
          `FBC funding ${txid}:${vout} pays ${output.value} to ${addr}, not the ` +
            `${amountBumps} bumps this swap promised`,
        );
        return;
      }

      // The amount recorded here is what the T2 refund will later be signed
      // over, so prefer what the chain says, then what fbd reported, and only
      // fall back to what we asked for. `amountLooksRight` deliberately passes
      // when the node reports no value at all — that is "unverifiable", not
      // "verified" — so say so loudly rather than silently treating a guess as
      // a fact, because a refund signed over the wrong amount is rejected at
      // T2 with no time left to work out why.
      const onChainBumps = readBumps(output.value);
      const recordedAmount = onChainBumps ?? fundedAmountBumps ?? amountBumps;
      if (paid === "unreadable") {
        console.warn(
          `[mm] ${swapId} could not read the funded amount from fbd for ${txid}:${vout}; ` +
            `recording ${recordedAmount} bumps unverified — if the T2 refund is ever ` +
            `rejected for a value mismatch, this is why`,
        );
      }

      swap.funded_fbc = {
        version: 1,
        kind: "funded_fbc",
        offer_id: swap.offer.offer_id,
        funding_txid: txid,
        funding_vout: vout,
        funding_amount: recordedAmount,
        witness_script_hex: scriptHex,
        htlc_address: addr,
      };
      swap.state = "waiting_fbc_confs";
      swap.fbc_confs = await fbcConfirmations(txid);
      if (swap.fbc_confs >= config.fbcConfTarget) {
        swap.state = "claimable";
      }
      swap.error = null;
      this.store.putSwap(swap);
      console.log(
        `[mm] funded_fbc ${swapId} ${txid}:${vout} confs=${swap.fbc_confs} state=${swap.state}`,
      );
    } finally {
      this.fundingInFlight.delete(swapId);
    }
  }

  /**
   * Spend the taker's BTC HTLC with the revealed preimage.
   *
   * Broadcasting is not the end of the job: the tx has to confirm before T1,
   * or the taker refunds and the outpoint disappears. The claim signals RBF,
   * so `bump` re-signs the same input at a higher fee rate and rebroadcasts.
   */
  private async claimBtc(swapId: string, tips: Tips, opts: { bump?: boolean } = {}) {
    const swap = this.store.getSwap(swapId);
    if (!swap?.funded_btc || !swap.preimage_hex) return;
    if (swap.btc_claim_txid && !opts.bump) return;
    if (this.claimInFlight.has(swapId)) return;
    this.claimInFlight.add(swapId);

    try {
      swap.state = "claiming_btc";
      this.store.putSwap(swap);

      const estimated = await fetchBtcFeeRate();
      // Each bump must clear the last attempt's rate by enough to satisfy RBF's
      // incremental relay fee, so step up rather than re-reading the estimate.
      const previous = swap.btc_claim_fee_rate ?? 0;
      const wanted = opts.bump
        ? Math.max(estimated, Math.ceil(previous * FEE_BUMP_FACTOR))
        : estimated;

      /**
       * Two independent ceilings, and the second one is the point.
       *
       * MAX_CLAIM_FEE_RATE is a sanity bound on a runaway estimate. What
       * actually decides the rate is what this HTLC can pay: the claim costs
       * ~139 vB, so a 10,000 sat HTLC has nothing left above ~68 sat/vB, and
       * capping at the flat 500 alone meant `claimHtlc` threw on every attempt
       * and the claim simply never went out — structurally unclaimable rather
       * than expensive. Once the taker holds the preimage our FBC is already
       * gone, so a claim that nets more than dust beats not claiming at all.
       */
      const scriptLen = fromHex(swap.funded_btc.witness_script_hex).length;
      const affordable = maxAffordableClaimFeeRate(
        swap.funded_btc.funding_amount,
        scriptLen,
      );
      if (affordable < 1) {
        // Nothing above dust survives even a 1 sat/vB claim. Retrying cannot
        // change that, and quoting below `minBtcSat` is what let it happen.
        swap.state = "failed";
        swap.error =
          `BTC HTLC ${swap.funded_btc.funding_amount} sat cannot pay for its own ` +
          `claim (${claimVbytes(scriptLen)} vB) and leave more than dust`;
        this.store.putSwap(swap);
        console.error(`[mm] UNCLAIMABLE ${swapId}: ${swap.error}`);
        return;
      }

      const feeRate = Math.max(1, Math.min(wanted, MAX_CLAIM_FEE_RATE, affordable));
      if (feeRate < wanted) {
        console.warn(
          `[mm] ${swapId} claim fee capped at ${feeRate} sat/vB (wanted ${wanted}): ` +
            `a ${swap.funded_btc.funding_amount} sat HTLC cannot pay more and still ` +
            `leave more than dust. The claim may be slow to confirm.`,
        );
      }
      if (opts.bump && feeRate <= previous) {
        // A replacement at or below the previous rate is rejected by the
        // mempool, so broadcasting it would only produce an error every tick.
        console.error(
          `[mm] ${swapId} cannot bump: already at ${previous} sat/vB, the most this ` +
            `HTLC can pay. Waiting for the current claim to confirm.`,
        );
        return;
      }

      const { rawTxHex, txid } = this.btc.claimHtlc({
        fundingTxid: swap.funded_btc.funding_txid,
        fundingVout: swap.funded_btc.funding_vout,
        fundingAmountSats: swap.funded_btc.funding_amount,
        witnessScriptHex: swap.funded_btc.witness_script_hex,
        preimageHex: swap.preimage_hex,
        feeRateSatPerVb: feeRate,
      });

      const blocksLeft = swap.offer.btc_refund_height - tips.btcTip;
      console.log(
        `[mm] broadcasting BTC claim ${swapId} fee=${feeRate} sat/vB ` +
          `(${blocksLeft} blocks to T1)${opts.bump ? " [bump]" : ""}`,
      );
      const broadcastTxid = await broadcastBtc(rawTxHex);

      const claimTxid = broadcastTxid || txid;
      swap.btc_claim_txid = claimTxid;
      // Append, never replace. A bump does not retract the previous attempt —
      // a miner may still confirm it, and then this is the only record of
      // where the money went.
      if (!swap.btc_claim_txids.includes(claimTxid)) {
        swap.btc_claim_txids.push(claimTxid);
      }
      swap.btc_claim_fee_rate = feeRate;
      swap.btc_claim_broadcast_at = Date.now();
      swap.btc_claim_confs = 0;
      swap.error = null;
      this.store.putSwap(swap);
    } finally {
      this.claimInFlight.delete(swapId);
    }
  }

  /**
   * Spend our own FBC HTLC through the refund branch, once T2 has passed and
   * the taker never claimed.
   *
   * Without this the honest-abort case — taker funds BTC, then walks away —
   * strands our inventory in an HTLC forever. SPEC §6.1 asks for a couple of
   * blocks of margin past T2 so an already-inclusion-bound claim can land
   * first; `FBC_REFUND_MARGIN_BLOCKS` is that wait, and the caller checks it.
   */
  private async refundFbc(swapId: string) {
    const swap = this.store.getSwap(swapId);
    if (!swap?.funded_fbc) return;
    if (swap.fbc_refund_txid || swap.preimage_hex) return;
    if (this.refundInFlight.has(swapId)) return;
    this.refundInFlight.add(swapId);

    try {
      swap.state = "refunding_fbc";
      this.store.putSwap(swap);

      console.log(
        `[mm] refunding FBC HTLC ${swapId} ${swap.funded_fbc.funding_amount / 1e6} FBC → ${this.fbcAddress}`,
      );
      // The node's estimate, floored by the configured rate. A flat constant
      // was fine while FBC's mempool has been empty — estimatefee answers the
      // relay minimum at every target — but a spend priced from 2024 is how a
      // refund misses its window on a chain that got busy. Flooring rather
      // than replacing keeps the operator's number meaningful.
      const estimated = await this.fbd.estimateFee(config.fbcConfTarget);
      const feeRate = Math.max(config.fbcFeeRate, estimated ?? 0);
      if (estimated && estimated > config.fbcFeeRate) {
        console.warn(
          `[mm] FBC fee estimate ${estimated} exceeds FBC_FEE_RATE ${config.fbcFeeRate}; using ${feeRate}`,
        );
      }
      const signed = await this.fbd.signHtlcSpend({
        fundingTxid: swap.funded_fbc.funding_txid,
        fundingVout: swap.funded_fbc.funding_vout,
        fundingAmountBumps: swap.funded_fbc.funding_amount,
        scriptHex: swap.funded_fbc.witness_script_hex,
        branch: "refund",
        destination: this.fbcAddress,
        feeRate,
      });

      let txid = signed.txid;
      try {
        txid = (await this.fbd.sendRawTransaction(signed.tx_hex)) || signed.txid;
      } catch (err) {
        // signhtlcspend may already have broadcast; a duplicate is success.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/already|duplicate|in mempool|txn-already/i.test(msg)) throw err;
        console.log(`[mm] refund ${swapId} already broadcast (${msg})`);
      }

      swap.fbc_refund_txid = txid;
      swap.fbc_refund_confs = 0;
      swap.fbc_refund_broadcast_at = Date.now();
      swap.error = null;
      this.store.putSwap(swap);
      console.log(`[mm] broadcast FBC refund ${swapId} ${txid}`);
    } finally {
      this.refundInFlight.delete(swapId);
    }
  }
}

/**
 * How long an unconfirmed FBC refund goes unremarked before it is called stuck.
 *
 * Generous on purpose: FBC blocks are ~2 min, and the burial target is 12, so
 * a healthy refund is buried inside half an hour. An hour without a single
 * confirmation is not slow, it is wrong.
 *
 * Deliberately an alarm and not an escalation. There is no FBC fee-bump path,
 * and building one now would be speculative: measured, `estimatefee` returns
 * the relay floor at every confirmation target because the mempool is empty,
 * and tonight's refund confirmed in three blocks at 142 bumps. Re-signing at a
 * higher rate would also be a double-spend rather than a replacement unless
 * fbd honours BIP125, which is unverified. So this reports rather than acts —
 * and a stuck refund an operator knows about is a different problem from one
 * nobody can see.
 */
const FBC_REFUND_STALL_MS = 60 * 60_000;

/**
 * Held back from every FBC withdrawal to cover the transaction fee.
 *
 * fbd's sendtoaddress has no subtract-from-amount option, so the fee comes on
 * top of whatever is asked for. Without this, withdrawing exactly the
 * unreserved balance dips into coins promised to a live swap, and a max sweep
 * fails outright for want of headroom.
 *
 * Generous on purpose — it is a floor on what stays behind, not an estimate of
 * what a transaction costs, and being wrong in this direction only means a
 * fraction of an FBC is left in the wallet.
 */
const FBC_WITHDRAW_FEE_BUMPS = 10_000; // 0.01 FBC

/** Never re-bump faster than this, however urgent it looks. */
const MIN_MS_BETWEEN_BUMPS = 3 * 60_000;
/** Rebroadcast an unconfirmed claim at a higher fee after this long. */
const CLAIM_REBROADCAST_AFTER_MS = 20 * 60_000;
/** Each bump must clear the previous rate by more than the incremental relay fee. */
const FEE_BUMP_FACTOR = 1.5;
/**
 * Sanity bound on a runaway fee estimate — NOT the limit that decides whether
 * a claim is affordable. See the fee cap in `claimBtc`.
 */
const MAX_CLAIM_FEE_RATE = 500;

/**
 * Does an output value reported by fbd agree with the amount we funded?
 *
 * fbd's transaction JSON does not document the unit of `value`, and the two
 * plausible readings (bumps, whole FBC) differ by 1e6 — so rather than pick one
 * and build a T2 refund on the guess, accept the value when it matches under
 * either reading and treat anything else as a mismatch worth stopping for.
 * A missing field returns true: it is not evidence of a wrong amount, and the
 * address match plus fbd's own `amount_bumps` already stand behind the figure
 * we record.
 */
/**
 * fbd's `value` field is not documented as bumps or whole FBC, so accept a
 * match under either reading and reject anything else rather than guessing.
 * Returns true when there is no value to check — unverifiable, not verified;
 * callers must not treat that as confirmation.
 */
export type AmountCheck = "match" | "mismatch" | "unreadable";

/**
 * Whether an on-chain output pays what a swap promised.
 *
 * Three outcomes, deliberately not two. This used to return a boolean built
 * from `normaliseBumps(...) !== undefined`, which made "the node did not tell
 * us the value" indistinguishable from "the value is correct" — a check that
 * passes when it could not run is not a check.
 *
 * Callers must handle `unreadable` on its own terms. For our own funding that
 * means proceeding with a loud warning, because the alternative is abandoning a
 * swap whose coins are already on chain. For anything a counterparty funded it
 * must mean refusal: an amount nobody could read is not an amount anybody
 * agreed to.
 */
export function checkAmount(value: number | null, expectedBumps: number): AmountCheck {
  if (value == null || !Number.isFinite(value)) return "unreadable";
  return value === expectedBumps ? "match" : "mismatch";
}

/**
 * The output's value in bumps, or null when the node did not report one.
 *
 * fbd reports output values in bumps — verified against the live node, where a
 * 639.2658 FBC output reads as 639265800. There used to be a second branch
 * accepting `Math.round(value * 1e6) === expectedBumps`, defending against fbd
 * reporting whole FBC instead. That case does not occur, and the branch made a
 * value one million times too small pass as correct: 639.26 bumps, which is
 * dust, would have been accepted as 639.26 FBC.
 */
function readBumps(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

/** sha256(ANNOUNCE_TOKEN), or null when no token is configured. */
function announceId(): string | null {
  if (!config.announceToken) return null;
  return toHex(sha256(new TextEncoder().encode(config.announceToken)));
}

/**
 * SHA256(preimage) === hashlock.
 *
 * No length rule. The HTLC script commits to the HASH and nothing else — it
 * carries no `OP_SIZE 32 OP_EQUALVERIFY` — so a preimage of any length is
 * valid, and rejecting one for being 31 bytes would refuse a secret that
 * genuinely unlocks the coins. 80 bytes is the standard push limit, so
 * anything longer cannot have come from a spend that confirmed.
 */
function preimageMatches(preimageHex: string, hashlockHex: string): boolean {
  if (!/^([0-9a-f]{2}){1,80}$/i.test(preimageHex)) return false;
  try {
    const got = toHex(sha256(fromHex(preimageHex)));
    return got.toLowerCase() === hashlockHex.toLowerCase();
  } catch {
    return false;
  }
}

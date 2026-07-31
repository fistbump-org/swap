/**
 * What should happen to a swap on this tick.
 *
 * This is deliberately a pure function of (swap, tips). The routing used to be
 * nested conditions inside `advance()`, and two fund-losing bugs lived in the
 * predicates rather than in the actions:
 *
 *  - the preimage watch excluded `refunding_fbc`, so once a refund was
 *    broadcast we stopped looking for the taker's claim. If their claim won the
 *    T2 race (SPEC §6.1) our refund was void, we lost the FBC, and we never
 *    claimed the BTC that revealing the preimage entitled us to;
 *  - the refund trigger kept matching after the refund was broadcast, so it
 *    shadowed the confirmation tracker below it and swaps sat in
 *    `refunding_fbc` forever.
 *
 * Neither is visible by reading a single branch, and neither needs a chain to
 * reproduce — only the routing. Hence a function that can be enumerated over
 * every reachable state in a unit test.
 */

import { config } from "./config.js";
import type { Swap } from "./store.js";

export type Tips = { btcTip: number; fbcTip: number };

export type SwapAction =
  /** Taker never funded and T1 is close: stop tracking. */
  | "expire_unfunded"
  /** Poll the taker's BTC funding confirmations; fund FBC once deep enough. */
  | "poll_btc_confs"
  /** Poll our own FBC funding confirmations. */
  | "poll_fbc_confs"
  /** Look for the taker's FBC claim so we can extract the preimage. */
  | "watch_preimage"
  /** Our BTC claim is broadcast; track it to confirmation and bump if stalled. */
  | "track_claim"
  /** Claim long overdue: establish whether it can still land, and stop if not. */
  | "abandon_claim"
  /** T2 has passed with no claim: spend our FBC HTLC through the refund branch. */
  | "refund_fbc"
  /** Our refund is broadcast; track it to confirmation. */
  | "track_refund";

/** SPEC §6.1: let an inclusion-bound claim land before racing it with a refund. */
export const FBC_REFUND_MARGIN_BLOCKS = 2;

const TERMINAL_STATES: ReadonlySet<Swap["state"]> = new Set(["done", "failed", "refunded"]);

/**
 * Returns the actions to run this tick, in order. An empty list means "nothing
 * to do"; terminal states always produce one.
 *
 * `refundsStillFuture` is passed in rather than computed here so the timelock
 * rules stay in one place (timelocks.ts) and this stays pure routing.
 *
 * Dispatch on `side` happens here and nowhere else. Every action below means
 * something different depending on which SPEC role this maker plays — on
 * buy_fbc we fund FBC and claim BTC, on sell_fbc the reverse — so routing a
 * swap through the wrong body would spend the wrong chain's coins.
 *
 * Both non-buy branches return `[]`. That is the safe direction: doing nothing
 * loses funds only to a timelock, while acting on a misidentified swap loses
 * them immediately.
 */
export function planSwap(
  swap: Swap,
  tips: Tips,
  refundsStillFuture: boolean,
): SwapAction[] {
  switch (swap.side) {
    case "buy_fbc":
      return planBuyFbc(swap, tips, refundsStillFuture);
    case "sell_fbc":
      // Deliberately distinct from `default`. This one is a code state — it
      // disappears when the sell routing is written. `default` is a data state
      // and stays forever.
      console.error(
        `[plan] ${swap.swap_id}: sell_fbc routing is not implemented; planning nothing`,
      );
      return [];
    default:
      // A swap whose role we cannot determine. Never guess: `reindex()` gives
      // every pre-existing record a side precisely so this branch stays
      // unreachable for real data, which means reaching it is a bug worth
      // shouting about rather than absorbing.
      console.error(
        `[plan] ${swap.swap_id}: unknown side ${JSON.stringify(swap.side)}; planning nothing`,
      );
      return [];
  }
}

/**
 * buy_fbc: the taker is Alice, this maker is Bob.
 *
 * The taker funds BTC first and holds the preimage; we fund FBC, watch for the
 * preimage to appear when they claim, then claim their BTC with it. Our own
 * exposure is the FBC leg, refundable at T2.
 *
 * Moved wholesale from `planSwap` when side dispatch was added — the body is
 * unchanged.
 */
function planBuyFbc(
  swap: Swap,
  tips: Tips,
  refundsStillFuture: boolean,
): SwapAction[] {
  if (TERMINAL_STATES.has(swap.state)) return [];

  // Nothing has been funded by the taker yet.
  if (swap.state === "accepted" && !swap.funded_btc) {
    return refundsStillFuture ? [] : ["expire_unfunded"];
  }

  // Their BTC is on chain; we have not committed FBC yet.
  if (
    (swap.state === "waiting_btc_confs" || swap.state === "funding_fbc") &&
    swap.funded_btc &&
    !swap.funded_fbc
  ) {
    return ["poll_btc_confs"];
  }

  const actions: SwapAction[] = [];

  if (swap.state === "waiting_fbc_confs" && swap.funded_fbc) {
    actions.push("poll_fbc_confs");
  }

  // From here on the decisions key off what we actually hold on chain, not off
  // the state label. A label is bookkeeping and can drift; `funded_fbc` with no
  // recorded spend of ours means real coins are sitting in an HTLC, and that
  // fact alone has to be enough to keep us acting on them. Keying these on a
  // set of state names is what let a swap in the wrong label hold FBC with no
  // planned action at all.
  const holdsUnspentFbc = Boolean(swap.funded_fbc) && !swap.fbc_refund_txid;

  // Watching for the preimage outranks everything below: it is the only action
  // that can still earn us the BTC leg, and it stays valid right up until our
  // refund confirms — including while a refund of ours is racing the taker's
  // claim at T2 (SPEC §6.1).
  if (swap.funded_fbc && !swap.btc_claim_txid) {
    actions.push("watch_preimage");
  }

  if (swap.btc_claim_txid) {
    // `track_claim` has no exit of its own: it re-polls bitcoind every tick
    // forever and a swap in `claiming_btc` never leaves the active set. Once we
    // are well past the height at which the taker may refund the outpoint our
    // claim spends, and nothing has confirmed, route somewhere that can decide
    // to stop. It routes to a decision, not to a conclusion — being past T1
    // does not mean the taker HAS refunded, and the handler checks the chain
    // before giving up on coins that may still be claimable.
    //
    // Claims with a confirmation are excluded: those are on their way to
    // `done` and only need burying.
    if (
      swap.btc_claim_confs < 1 &&
      tips.btcTip >= swap.offer.btc_refund_height + config.claimGiveUpBlocks
    ) {
      actions.push("abandon_claim");
      return actions;
    }
    actions.push("track_claim");
    return actions;
  }

  if (
    holdsUnspentFbc &&
    !swap.fbc_claim_txid &&
    !swap.preimage_hex &&
    tips.fbcTip >= swap.offer.fbc_refund_height + FBC_REFUND_MARGIN_BLOCKS
  ) {
    actions.push("refund_fbc");
    return actions;
  }

  if (swap.fbc_refund_txid) {
    actions.push("track_refund");
  }

  return actions;
}

/** True once the taker's BTC funding is buried deep enough to commit FBC against. */
export function btcConfsSufficient(confs: number): boolean {
  return confs >= config.btcConfTarget;
}

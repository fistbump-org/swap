/**
 * Who plays which SPEC role, for a given side of the market.
 *
 * SPEC is written in terms of Alice and Bob, not maker and taker:
 *
 *   Alice — has BTC, wants FBC. Generates the preimage `s`. Funds the BTC
 *           HTLC, which carries T1. Claims the FBC leg, revealing `s`.
 *   Bob   — has FBC, wants BTC. Funds the FBC HTLC, which carries T2. Claims
 *           the BTC leg once `s` is public.
 *
 * The market side decides which of maker/taker is which:
 *
 *   buy_fbc  — the taker pays BTC, so the TAKER is Alice and the MAKER is Bob.
 *   sell_fbc — the taker pays FBC, so the MAKER is Alice and the TAKER is Bob.
 *
 * The single fact worth internalising: **the timelock assignment does not
 * change between sides.** T1 (BTC) is always the longer one, because Alice
 * always funds BTC and always holds the preimage, whichever party Alice
 * happens to be. What changes is who bears which risk.
 *
 * That is also why the existing quote heights (BTC 48h, FBC 24h) stay correct
 * for sell_fbc — but correct for a *reason*, not by coincidence, and the reason
 * is written here so a later change has to argue with it.
 *
 * Reversing the assignment is the bug this protocol shipped with: it opens a
 * window where Alice can refund her BTC and still claim the FBC, taking both
 * legs. See SPEC §4.2 and §9.1.
 */

export type Side = "buy_fbc" | "sell_fbc";

/** Every side that exists, as data — for validating input and for advertising. */
export const SIDES = ["buy_fbc", "sell_fbc"] as const satisfies readonly Side[];

/**
 * A runtime check, because `Side` is erased.
 *
 * Anything crossing a boundary — an HTTP body, a record loaded off disk —
 * arrives as an unknown string no matter what the type says, and a value that
 * is not a real side must be rejected at that boundary rather than defaulted.
 */
export function isSide(value: unknown): value is Side {
  return typeof value === "string" && (SIDES as readonly string[]).includes(value);
}

export type Chain = "btc" | "fbc";

export interface Roles {
  /** Which party is SPEC's Alice: funds BTC, holds `s`, claims FBC. */
  aliceIs: "maker" | "taker";
  /** Which party is SPEC's Bob: funds FBC, claims BTC. */
  bobIs: "maker" | "taker";
  /** The chain this maker funds an HTLC on. */
  makerFunds: Chain;
  /** The chain this maker claims from. */
  makerClaims: Chain;
  /** True when this maker generates and holds the preimage. */
  makerHoldsPreimage: boolean;
  /**
   * True when this maker is the one who must move FIRST — funding before the
   * counterparty has committed anything. The first funder carries the whole
   * counterparty-vanishes risk until the other leg appears, and its only
   * recourse is the refund branch.
   */
  makerFundsFirst: boolean;
}

const BUY_FBC: Roles = {
  aliceIs: "taker",
  bobIs: "maker",
  makerFunds: "fbc",
  makerClaims: "btc",
  makerHoldsPreimage: false,
  makerFundsFirst: false,
};

const SELL_FBC: Roles = {
  aliceIs: "maker",
  bobIs: "taker",
  makerFunds: "btc",
  makerClaims: "fbc",
  // The maker generates `s`, so it also decides when `s` becomes public — and
  // publishing it is irreversible. Claiming FBC too close to T2 can lose the
  // race to the taker's refund while still leaking `s`, at which point the
  // taker claims the BTC leg and the maker has neither.
  makerHoldsPreimage: true,
  makerFundsFirst: true,
};

export function rolesFor(side: Side): Roles {
  return side === "buy_fbc" ? BUY_FBC : SELL_FBC;
}

/**
 * The chain whose HTLC carries the longer refund timelock.
 *
 * BTC, unconditionally and on both sides — not because BTC is special, but
 * because SPEC defines Alice as the party holding BTC, and Alice is always the
 * one who funds first and holds the preimage. Take no `side` parameter: a
 * function that appears to branch on side, and does not, invites someone to
 * "fix" the dead branch into a real one.
 *
 * If a future side ever has Alice funding FBC, this constant is wrong and so is
 * every quote built on it. That is the thing to check, not this line.
 */
export const LONGER_TIMELOCK_CHAIN: Chain = "btc";

/** True when this maker is exposed to the counterparty simply disappearing. */
export function makerCarriesFirstMoverRisk(side: Side): boolean {
  return rolesFor(side).makerFundsFirst;
}

/**
 * The sides this build actually serves, as opposed to the sides that exist.
 *
 * One constant behind `/v1/status`, the registry announcement, and `getQuote`'s
 * refusal, so they cannot drift into advertising something the router will not
 * plan. Today the two disagree in shape but not in content — status sends a
 * string, announce sends an array — and nothing notices because the registry
 * drops the field from its health-verified copy anyway.
 */
export const SERVED_SIDES = ["buy_fbc"] as const satisfies readonly Side[];

export function servesSide(side: Side): boolean {
  return (SERVED_SIDES as readonly Side[]).includes(side);
}

/**
 * What the MAKER did, for display on the maker's own screens.
 *
 * `Side` is taker-relative by definition — `buy_fbc` means the taker pays BTC
 * to get FBC — which is right for the protocol and for the public API, where
 * the taker is the one choosing. It is wrong on the maker's dashboard, where
 * every row was labelled with the counterparty's action: an operator who had
 * just sold FBC saw "buy_fbc" against it.
 *
 * Returns a display string rather than a `Side` on purpose. An inverted Side
 * that could be passed back into routing or `rolesFor` is a bug waiting to be
 * written; this cannot be mistaken for one.
 */
export function makerActionLabel(side: Side): "sold FBC" | "bought FBC" {
  return side === "buy_fbc" ? "sold FBC" : "bought FBC";
}

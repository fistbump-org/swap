/**
 * Timelock validation for incoming offers (SPEC §4.2, §4.3).
 *
 * Mirrors `checkTimelocks` in web/core/src/offer.ts. Kept as a standalone copy
 * so this bot stays a self-contained reference a third party can lift, but the
 * two MUST agree — if you change one, change the other.
 *
 * The invariant: T1 (the taker's BTC refund) must open at least Δ AFTER
 * T2 (our FBC refund). The taker funds first and is the only party who knows
 * the preimage, so their refund has to be the last one that becomes possible.
 * With the ordering reversed there is a window in which the taker can refund
 * their BTC and still claim our FBC — they take both legs and we get nothing.
 *
 * Note that the wall-clock Δ alone is NOT sufficient. Every number in it comes
 * out of the taker's own offer blob, including the reference heights the refund
 * heights are measured against, so a Δ of "24h" can sit on a T1 that is already
 * in the past. The absolute checks against our own observed tips are what make
 * the relative check meaningful.
 */

import { config } from "./config.js";
import type { OfferBlob, Quote } from "./store.js";

export type Check = { ok: true } | { ok: false; reason: string };

/** Nobody needs a swap whose refund is further out than this. */
const MAX_REFUND_SECONDS = 7 * 24 * 3600;

function isHeight(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) < 500_000_000;
}

export function checkOfferTimelocks(
  offer: OfferBlob,
  quote: Quote,
  observed: { btcTip: number; fbcTip: number },
): Check {
  // ---- Types first. `NaN <= x` is false, so an unvalidated string or a
  // missing field used to skip the comparison below entirely. ----
  for (const name of [
    "btc_reference_height",
    "btc_refund_height",
    "fbc_reference_height",
    "fbc_refund_height",
  ] as const) {
    if (!isHeight(offer[name])) {
      return { ok: false, reason: `${name} is not a valid block height` };
    }
  }

  // ---- The heights must be the ones we quoted. We computed them from live
  // tips seconds ago; there is no legitimate reason for a taker to alter them.
  for (const name of [
    "btc_reference_height",
    "btc_refund_height",
    "fbc_reference_height",
    "fbc_refund_height",
  ] as const) {
    if (offer[name] !== quote[name]) {
      return {
        ok: false,
        reason: `${name} does not match the quote (offered ${offer[name]}, quoted ${quote[name]})`,
      };
    }
  }

  // ---- Relative: wall-clock Δ between the two refund deadlines. ----
  const btcSecondsToT1 =
    (offer.btc_refund_height - offer.btc_reference_height) * config.btcBlockSeconds;
  const fbcSecondsToT2 =
    (offer.fbc_refund_height - offer.fbc_reference_height) * config.fbcBlockSeconds;

  if (btcSecondsToT1 <= 0 || fbcSecondsToT2 <= 0) {
    return { ok: false, reason: "refund heights must be above their reference heights" };
  }

  const deltaSeconds = btcSecondsToT1 - fbcSecondsToT2;
  const minDelta = config.minDeltaHours * 3600;
  if (deltaSeconds < minDelta) {
    const h = (s: number) => (s / 3600).toFixed(1);
    return {
      ok: false,
      reason:
        `unsafe timelocks: BTC refund (T1, ${h(btcSecondsToT1)}h) must fall at least ` +
        `${config.minDeltaHours}h after FBC refund (T2, ${h(fbcSecondsToT2)}h); ` +
        `Δ = ${h(deltaSeconds)}h (SPEC §4.2)`,
    };
  }

  if (btcSecondsToT1 > MAX_REFUND_SECONDS || fbcSecondsToT2 > MAX_REFUND_SECONDS) {
    return { ok: false, reason: "refund height too far in the future" };
  }

  // ---- Absolute: against tips we observed ourselves, right now. ----
  const btcDrift = offer.btc_reference_height - observed.btcTip;
  if (Math.abs(btcDrift) > config.maxRefStalenessBtc) {
    return {
      ok: false,
      reason:
        `btc_reference_height is ${Math.abs(btcDrift)} blocks ` +
        `${btcDrift < 0 ? "behind" : "ahead of"} our tip ${observed.btcTip} (SPEC §4.3)`,
    };
  }
  const fbcDrift = offer.fbc_reference_height - observed.fbcTip;
  if (Math.abs(fbcDrift) > config.maxRefStalenessFbc) {
    return {
      ok: false,
      reason:
        `fbc_reference_height is ${Math.abs(fbcDrift)} blocks ` +
        `${fbcDrift < 0 ? "behind" : "ahead of"} our tip ${observed.fbcTip} (SPEC §4.3)`,
    };
  }

  return checkRefundsStillFuture(offer, observed);
}

/**
 * The taker's BTC refund must not be live or nearly live, and our own FBC
 * refund must still be far enough out to be worth funding.
 *
 * Called again immediately before we fund the FBC leg: accepting an offer and
 * funding against it are separated by the BTC confirmation wait (~1h at the
 * default 6-conf target), and T1 keeps approaching during it.
 */
export function checkRefundsStillFuture(
  offer: OfferBlob,
  observed: { btcTip: number; fbcTip: number },
): Check {
  // We must be able to claim the BTC well after the taker could refund it.
  const btcBlocksLeft = offer.btc_refund_height - observed.btcTip;
  const minBtcBlocks = config.btcConfTarget + 6;
  if (btcBlocksLeft < minBtcBlocks) {
    return {
      ok: false,
      reason:
        `btc_refund_height ${offer.btc_refund_height} is only ${btcBlocksLeft} blocks ` +
        `above our tip ${observed.btcTip} (need ≥ ${minBtcBlocks}) — the taker could ` +
        `refund before we could claim`,
    };
  }
  const fbcBlocksLeft = offer.fbc_refund_height - observed.fbcTip;
  // SPEC §4.3 makes this normative at 60 blocks (~2h), and web/core enforces
  // the same. It is sized for the party who must CLAIM the FBC leg, not the
  // one funding it: the taker waits out fbcConfTarget confirmations before
  // claiming is safe at all, then needs the §6.1 margin on top. Enforcing the
  // old fbcConfTarget + 6 here meant this maker would fund a swap the taker's
  // own UI would refuse to claim.
  const minFbcBlocks = config.minFbcBlocksToRefund;
  if (fbcBlocksLeft < minFbcBlocks) {
    return {
      ok: false,
      reason:
        `fbc_refund_height ${offer.fbc_refund_height} is only ${fbcBlocksLeft} blocks ` +
        `above our tip ${observed.fbcTip} (need ≥ ${minFbcBlocks})`,
    };
  }
  return { ok: true };
}

/**
 * Live mid rate: peg FBC to a fixed USD price, paid in BTC.
 *
 *   MID_FBC_PER_BTC = BTC_USD / FBC_USD
 *   e.g. FBC_USD=0.01, BTC=$100k → 10_000_000 FBC per BTC
 */

import { config } from "./config.js";
import { settings } from "./settings.js";

export type PriceSnapshot = {
  btcUsd: number;
  fbcUsd: number;
  midFbcPerBtc: number;
  source: string;
  fetchedAt: number;
};

let cache: PriceSnapshot | null = null;

/** Outbound price calls must not be able to wedge an API request. */
const PRICE_TIMEOUT_MS = 8_000;

/**
 * Absolute sanity band for BTC/USD.
 *
 * A price feed that lies — or returns something in the wrong unit — sets the
 * rate at which we hand out inventory. These bounds are deliberately wide;
 * they exist to catch a feed returning 0.0001 or 1e12, not to track the market.
 */
const BTC_USD_MIN = 1_000;
const BTC_USD_MAX = 10_000_000;

/** Reject a tick that moves more than this from the last accepted price. */
const MAX_PRICE_JUMP_RATIO = 3;

function sane(btcUsd: number, source: string): number {
  if (!Number.isFinite(btcUsd) || btcUsd < BTC_USD_MIN || btcUsd > BTC_USD_MAX) {
    throw new Error(`${source} returned an implausible BTC/USD: ${btcUsd}`);
  }
  if (cache?.btcUsd) {
    const ratio = btcUsd > cache.btcUsd ? btcUsd / cache.btcUsd : cache.btcUsd / btcUsd;
    if (ratio > MAX_PRICE_JUMP_RATIO) {
      throw new Error(
        `${source} BTC/USD moved ${ratio.toFixed(1)}x from ${cache.btcUsd} to ${btcUsd} — refusing`,
      );
    }
  }
  return btcUsd;
}

async function fetchBtcUsdCoinbase(): Promise<number> {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const j = (await res.json()) as { data?: { amount?: string } };
  const n = Number(j.data?.amount);
  if (!(n > 0)) throw new Error("coinbase bad amount");
  return sane(n, "coinbase");
}

async function fetchBtcUsdKraken(): Promise<number> {
  const res = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", {
    signal: AbortSignal.timeout(PRICE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`kraken ${res.status}`);
  const j = (await res.json()) as {
    result?: Record<string, { c?: string[] }>;
  };
  const row = j.result?.XXBTZUSD || j.result?.XBTUSD;
  const n = Number(row?.c?.[0]);
  if (!(n > 0)) throw new Error("kraken bad price");
  return sane(n, "kraken");
}

async function fetchBtcUsd(): Promise<{ btcUsd: number; source: string }> {
  if (config.btcUsdFixed > 0) {
    return { btcUsd: config.btcUsdFixed, source: "fixed" };
  }
  const src = config.btcUsdSource.toLowerCase();
  if (src === "kraken") {
    return { btcUsd: await fetchBtcUsdKraken(), source: "kraken" };
  }
  // default coinbase, fallback kraken
  try {
    return { btcUsd: await fetchBtcUsdCoinbase(), source: "coinbase" };
  } catch (e1) {
    try {
      return { btcUsd: await fetchBtcUsdKraken(), source: "kraken" };
    } catch (e2) {
      throw new Error(
        `BTC/USD fetch failed: ${e1 instanceof Error ? e1.message : e1}; ${
          e2 instanceof Error ? e2.message : e2
        }`,
      );
    }
  }
}

/** Mid FBC per 1 BTC so that 1 FBC ≈ FBC_USD dollars of BTC. */
export async function getMidFbcPerBtc(): Promise<PriceSnapshot> {
  const now = Date.now();
  if (
    cache &&
    now - cache.fetchedAt < config.priceCacheMs &&
    cache.midFbcPerBtc > 0
  ) {
    return cache;
  }

  // Static mid override (no USD peg)
  if (settings.fbcUsdPrice() <= 0 && config.midFbcPerBtc > 0) {
    cache = {
      btcUsd: 0,
      fbcUsd: 0,
      midFbcPerBtc: config.midFbcPerBtc,
      source: "MID_FBC_PER_BTC",
      fetchedAt: now,
    };
    return cache;
  }

  // settings.fbcUsdPrice() is the operator's live value when they have set
  // one, and config.fbcUsdPrice otherwise. Read per call rather than captured:
  // the whole point of the setting is that it takes effect without a restart.
  const pegged = settings.fbcUsdPrice();
  const fbcUsd = pegged > 0 ? pegged : 0.01;
  const { btcUsd, source } = await fetchBtcUsd();
  const midFbcPerBtc = btcUsd / fbcUsd;

  if (!(midFbcPerBtc > 0) || !Number.isFinite(midFbcPerBtc)) {
    throw new Error(`bad mid rate from btcUsd=${btcUsd} fbcUsd=${fbcUsd}`);
  }

  cache = {
    btcUsd,
    fbcUsd,
    midFbcPerBtc,
    source,
    fetchedAt: now,
  };
  return cache;
}

export function lastPrice(): PriceSnapshot | null {
  return cache;
}

/**
 * Drop the cached snapshot so the next quote re-derives the mid.
 *
 * Called when the operator changes the sell price. Without it the change is
 * real but invisible for up to `priceCacheMs` — the maker sets a new price,
 * asks for a quote to check, and gets the old one back, which reads as the
 * setting having silently failed.
 *
 * Only the derived snapshot is discarded. The BTC/USD feed is re-fetched as a
 * consequence, which is a wasted call at most; the alternative is keeping a
 * mid computed from a price nobody is offering any more.
 */
export function invalidatePrice(): void {
  cache = null;
}

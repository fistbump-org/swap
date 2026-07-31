// Where BTC chain reads come from, in preference order.
//
// Our own bitcoind first, third-party indexers behind it. Both directions of
// that ordering matter:
//
// **Own node first**, because a third party's index lags. A real mainnet swap
// broke on exactly this: the page broadcast its funding transaction, asked
// blockstream for it 32 seconds later, and got a 404 — blockstream had simply
// not indexed it yet. Our node had it in the mempool immediately.
//
// **Fallback still present**, because our node going down must not take the
// swap page with it. Every read here concerns the taker's OWN transaction, so
// asking a stranger is a privacy cost, not a safety one — a lying indexer
// cannot make the taker's coins move. The trust-critical read (did the taker
// actually fund?) happens on the maker's side against its own bitcoind, and
// never comes through this file.
//
// The proxy reproduces Esplora's response shape exactly, so callers do not
// branch on which source answered.

/** Own node, when the page is served from a deployment that has one. */
function ownNode() {
  if (typeof location === "undefined") return null;
  if (location.hostname.endsWith("fistbump.org")) return `${location.origin}/api/btc`;
  // Local development against a registry on the default port.
  if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    return "http://127.0.0.1:8790/btc";
  }
  return null;
}

const OWN_NODE = ownNode();

export const BTC_SOURCES = [
  OWN_NODE,
  "https://blockstream.info/api",
  "https://mempool.space/api",
].filter(Boolean);

// A source that just failed is skipped for a while rather than retried on every
// poll. Without this, a deployment whose proxy is not enabled would pay a
// round-trip to a 503 before every single read — and these are polled on a
// 5-second timer for the length of a swap.
//
// The cooldown is short for "our node is unwell", because it will come back and
// we want it the moment it does, and long for "this deployment has no proxy",
// because that will not change without a redeploy.
const DOWN_MS = 60_000;
const NOT_ENABLED_MS = 6 * 60 * 60_000;
const sleeping = new Map();

function benched(base) {
  const until = sleeping.get(base);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  sleeping.delete(base);
  return false;
}

/**
 * Fetch one Esplora path from the first source that answers.
 *
 * A 404 is an ANSWER, not a failure — "this transaction does not exist here" —
 * so it is returned rather than triggering a fallback. Only a transport error
 * or a 5xx moves to the next source. Getting this backwards would make a
 * not-yet-propagated transaction walk all three sources on every poll, which is
 * the normal case in the seconds after funding.
 *
 * Returns the Response, or throws if no source could be reached at all.
 */
export async function btcFetch(path, options = {}) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const live = BTC_SOURCES.filter((b) => !benched(b));
  // Everything benched at once means we would otherwise report failure while
  // healthy sources sit in the cooldown map. Try them all rather than nothing.
  const order = live.length ? live : BTC_SOURCES;
  let lastError = null;
  for (const base of order) {
    try {
      const res = await fetch(`${base}${p}`, options);
      if (res.status >= 500 || res.status === 429) {
        // 503 from our own proxy means either "not configured on this
        // deployment" or "bitcoind is unreachable". The first is permanent, the
        // second is not, so they get different cooldowns.
        let permanent = false;
        if (base === OWN_NODE && res.status === 503) {
          const body = await res.text().catch(() => "");
          permanent = body.includes("not enabled");
        }
        sleeping.set(base, Date.now() + (permanent ? NOT_ENABLED_MS : DOWN_MS));
        lastError = new Error(`${base} -> HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      sleeping.set(base, Date.now() + DOWN_MS);
      lastError = e;
    }
  }
  throw lastError || new Error(`no BTC source could serve ${p}`);
}

/** btcFetch + JSON, with null for a 404 so callers can treat it as "not yet". */
export async function btcJson(path, options = {}) {
  const res = await btcFetch(path, options);
  if (res.status === 404) return null;
  if (!res.ok) return null;
  return res.json();
}

/** btcFetch + text, for the endpoints Esplora serves as a bare number. */
export async function btcText(path, options = {}) {
  const res = await btcFetch(path, options);
  if (!res.ok) return null;
  return res.text();
}

"""
Verified trade history for the registry.

Makers report their settled swaps; this polls them, checks each one against
both chains (see verify_trade.py), and keeps the survivors. The published price
is therefore a record of swaps that demonstrably happened, not of quotes a
maker was willing to print.

Two properties worth stating, because they bound what the number means:

**A trade is counted once, whoever reports it.** Identity is the BTC funding
outpoint, not the maker's swap id. Two makers reporting the same on-chain swap
— by accident, or to inflate volume — collapse to one row.

**This cannot detect wash trading.** Every check here proves a real atomic swap
occurred; none of them prove the counterparty was a stranger. A maker swapping
with itself produces perfectly valid trades. At one maker that is not worth
defending against, but the published figure should never be described as
anything stronger than "swaps that really settled".
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
import urllib.request
from pathlib import Path
from typing import Any, Callable

from verify_trade import Unverifiable, verify, verify_pending

# Bumps per whole FBC, and sats per whole BTC. Only used to derive the display
# rate; everything stored stays in base units.
BUMPS_PER_FBC = 1_000_000
SATS_PER_BTC = 100_000_000


# ── Historical BTC/USD ───────────────────────────────────────────────────
#
# Needed to express a BTC<->FBC swap in dollars. The rate has to be the one
# from when the swap SETTLED: repricing old trades at the current BTC would
# make every historical FBC price drift with BTC forever, which is the
# opposite of what a price history is for.

COINBASE_CANDLES = "https://api.exchange.coinbase.com/products/BTC-USD/candles"
# Sanity bounds. A feed returning 0, or 10^9, is broken rather than newsworthy,
# and a bad value here silently corrupts every derived FBC price.
BTC_USD_MIN, BTC_USD_MAX = 1_000.0, 10_000_000.0
_usd_cache: dict[int, float | None] = {}
_usd_lock = threading.Lock()


def btc_usd_at(settled_at_ms: int) -> float | None:
    """
    BTC/USD in the minute a swap settled, or None if it cannot be established.

    None is a real answer and must not be turned into a guess. A trade with no
    price is still a trade — it counts toward volume and the BTC-denominated
    rate — it simply cannot contribute to a USD figure. Substituting the
    current price instead would be indistinguishable from data in the output
    and wrong in a direction nobody could see.
    """
    minute = settled_at_ms // 1000 // 60 * 60
    with _usd_lock:
        if minute in _usd_cache:
            return _usd_cache[minute]

    value: float | None = None
    try:
        url = f"{COINBASE_CANDLES}?granularity=60&start={minute - 300}&end={minute + 300}"
        req = urllib.request.Request(url, headers={"User-Agent": "fistbump-registry"})
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_USD) as r:
            candles = json.loads(r.read().decode("utf-8"))
        if isinstance(candles, list) and candles:
            # [time, low, high, open, close, volume]. Take the candle whose
            # window contains the settlement, else the nearest one — a gap in
            # Coinbase's history should degrade to "close enough", not to None.
            best = min(candles, key=lambda c: abs(int(c[0]) - minute))
            close = float(best[4])
            if BTC_USD_MIN <= close <= BTC_USD_MAX:
                value = close
    except Exception:  # noqa: BLE001 - no price is a valid outcome
        value = None

    with _usd_lock:
        # Only successes are cached. A failure cached forever would make one
        # network blip permanently price a trade at nothing.
        if value is not None:
            _usd_cache[minute] = value
    return value


HTTP_TIMEOUT_USD = 10


SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
  -- The BTC funding outpoint IS the identity of a swap. Deliberately not the
  -- maker's swap_id, which is theirs to choose and would let the same on-chain
  -- swap be counted twice under two names.
  btc_funding_txid TEXT NOT NULL,
  btc_funding_vout INTEGER NOT NULL,
  maker_url        TEXT NOT NULL,
  swap_id          TEXT NOT NULL,
  side             TEXT NOT NULL,
  settled_at       INTEGER NOT NULL,
  amount_btc_sat   INTEGER NOT NULL,
  amount_fbc_bumps INTEGER NOT NULL,
  btc_claim_txid   TEXT NOT NULL,
  fbc_funding_txid TEXT NOT NULL,
  fbc_funding_vout INTEGER NOT NULL,
  fbc_claim_txid   TEXT NOT NULL,
  -- Read off the chain during verification, never taken from the maker.
  preimage         TEXT NOT NULL,
  btc_height       INTEGER,
  fbc_height       INTEGER,
  -- BTC/USD at the MINUTE THIS SWAP SETTLED, not when we happened to verify
  -- it. Pricing an old trade at today's BTC silently rewrites history: the
  -- same swap would report a different FBC price every time BTC moved.
  -- Nullable — a price feed being unreachable must not discard a real trade.
  -- The raw input is stored rather than the derived FBC/USD, so the
  -- derivation can be corrected later without having lost what it came from.
  btc_usd          REAL,
  verified_at      INTEGER NOT NULL,
  PRIMARY KEY (btc_funding_txid, btc_funding_vout)
);
CREATE INDEX IF NOT EXISTS idx_trades_settled ON trades(settled_at DESC);

-- Per-maker high-water mark, so a restart does not re-poll from zero and
-- re-verify every trade ever made.
CREATE TABLE IF NOT EXISTS maker_cursor (
  maker_url  TEXT PRIMARY KEY,
  since      INTEGER NOT NULL,
  last_ok    INTEGER,
  last_error TEXT
);

-- Trades that failed verification. Kept rather than dropped: a maker reporting
-- swaps that do not check out is the single most useful thing this table can
-- tell an operator, and silently discarding them hides it.
CREATE TABLE IF NOT EXISTS rejected (
  maker_url   TEXT NOT NULL,
  swap_id     TEXT NOT NULL,
  reason      TEXT NOT NULL,
  rejected_at INTEGER NOT NULL,
  PRIMARY KEY (maker_url, swap_id)
);
"""


class TradeStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False because the poller thread and the HTTP
        # handler threads share one connection, serialised by _lock. SQLite's
        # own locking would allow more concurrency, but the write volume here
        # is a handful of rows an hour.
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        # Databases created before btc_usd existed.
        cols = {r["name"] for r in self._db.execute("PRAGMA table_info(trades)")}
        if "btc_usd" not in cols:
            self._db.execute("ALTER TABLE trades ADD COLUMN btc_usd REAL")
        self._db.commit()
        self._lock = threading.Lock()

    def cursor_for(self, maker_url: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT since FROM maker_cursor WHERE maker_url = ?", (maker_url,)
            ).fetchone()
        return int(row["since"]) if row else 0

    def set_cursor(self, maker_url: str, since: int, error: str | None = None) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO maker_cursor (maker_url, since, last_ok, last_error) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(maker_url) DO UPDATE SET "
                "since = excluded.since, last_ok = excluded.last_ok, "
                "last_error = excluded.last_error",
                (maker_url, since, None if error else int(time.time()), error),
            )
            self._db.commit()

    def record(self, maker_url: str, trade: dict[str, Any], result: Any) -> bool:
        # Priced BEFORE the lock. btc_usd_at can miss its cache and make a
        # Coinbase request with a ten-second timeout; holding _lock across that
        # stalls every /v1/trades and /v1/price reader behind one slow third
        # party, once per newly verified trade. Nothing in the lookup depends
        # on the database.
        btc_usd = btc_usd_at(int(trade["settled_at"]))
        """Insert a verified trade. False when this outpoint is already known."""
        btc = trade["btc"]
        fbc = trade["fbc"]
        with self._lock:
            cur = self._db.execute(
                "INSERT OR IGNORE INTO trades ("
                " btc_funding_txid, btc_funding_vout, maker_url, swap_id, side,"
                " settled_at, amount_btc_sat, amount_fbc_bumps, btc_claim_txid,"
                " fbc_funding_txid, fbc_funding_vout, fbc_claim_txid, preimage,"
                " btc_height, fbc_height, verified_at, btc_usd"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    btc["funding_txid"], int(btc["funding_vout"]), maker_url,
                    trade["swap_id"], trade.get("side", "buy_fbc"),
                    int(trade["settled_at"]), int(trade["amount_btc_sat"]),
                    int(trade["amount_fbc_bumps"]), btc["claim_txid"],
                    fbc["funding_txid"], int(fbc["funding_vout"]), fbc["claim_txid"],
                    result.preimage, result.btc_confirmed_height,
                    result.fbc_confirmed_height, int(time.time()),
                    # Priced at settlement, not at verification.
                    btc_usd,
                ),
            )
            self._db.commit()
            return cur.rowcount > 0

    def reject(self, maker_url: str, swap_id: str, reason: str) -> None:
        with self._lock:
            self._db.execute(
                "INSERT OR REPLACE INTO rejected (maker_url, swap_id, reason, rejected_at) "
                "VALUES (?, ?, ?, ?)",
                (maker_url, swap_id, reason[:300], int(time.time())),
            )
            self._db.commit()

    def recent(self, limit: int = 50, since: int = 0) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self._lock:
            rows = self._db.execute(
                "SELECT swap_id, settled_at, amount_btc_sat, amount_fbc_bumps, side, "
                "maker_url, btc_usd FROM trades WHERE settled_at > ? ORDER BY settled_at DESC LIMIT ?",
                (since, limit),
            ).fetchall()
        return [
            {
                # Needed so a caller can tell a settled row from the pending
                # row for the same swap. Without it the registry's own dedup
                # compared None against None and never matched, so during a
                # poll transition one swap appeared in both lists.
                "swap_id": r["swap_id"],
                "settled_at": r["settled_at"],
                "amount_btc_sat": r["amount_btc_sat"],
                "amount_fbc": r["amount_fbc_bumps"] / BUMPS_PER_FBC,
                "fbc_per_btc": _rate(r["amount_btc_sat"], r["amount_fbc_bumps"]),
                "fbc_usd": _fbc_usd(r["amount_btc_sat"], r["amount_fbc_bumps"], r["btc_usd"]),
                # Whose side: the taker's. The name carries the perspective.
                "taker_side": r["side"],
                # The maker is named, but no txids are published. The registry
                # needs them to verify; a reader does not, and publishing them
                # links the maker's and takers' addresses together in a way the
                # chain does not do on its own. /v1/status withholds maker
                # addresses for exactly this reason — this must not undo it.
                "maker": r["maker_url"],
            }
            for r in rows
        ]

    def summary(self, window_sec: int = 86_400) -> dict[str, Any]:
        cutoff = int(time.time() * 1000) - window_sec * 1000
        with self._lock:
            last = self._db.execute(
                "SELECT settled_at, amount_btc_sat, amount_fbc_bumps, btc_usd FROM trades "
                "ORDER BY settled_at DESC LIMIT 1"
            ).fetchone()
            rows = self._db.execute(
                "SELECT amount_btc_sat, amount_fbc_bumps, btc_usd FROM trades "
                "WHERE settled_at > ?",
                (cutoff,),
            ).fetchall()
            total = self._db.execute("SELECT COUNT(*) AS n FROM trades").fetchone()["n"]

        rates = [_rate(r["amount_btc_sat"], r["amount_fbc_bumps"]) for r in rows]
        usd_rows = [r for r in rows if r["btc_usd"]]
        usd_rates = [
            _fbc_usd(r["amount_btc_sat"], r["amount_fbc_bumps"], r["btc_usd"])
            for r in usd_rows
        ]
        usd_rates = [x for x in usd_rates if x is not None]
        # Volume-weighted in USD: total dollars moved over total FBC moved.
        usd_value = sum(r["btc_usd"] * r["amount_btc_sat"] / SATS_PER_BTC for r in usd_rows)
        usd_fbc = sum(r["amount_fbc_bumps"] for r in usd_rows)
        btc_volume = sum(r["amount_btc_sat"] for r in rows)
        fbc_volume = sum(r["amount_fbc_bumps"] for r in rows)
        return {
            "last_trade": (
                {
                    "settled_at": last["settled_at"],
                    "fbc_per_btc": _rate(last["amount_btc_sat"], last["amount_fbc_bumps"]),
                    "fbc_usd": _fbc_usd(
                        last["amount_btc_sat"], last["amount_fbc_bumps"], last["btc_usd"]
                    ),
                    "btc_usd": last["btc_usd"],
                }
                if last
                else None
            ),
            "window_sec": window_sec,
            "trades": len(rows),
            "trades_all_time": total,
            "volume_btc_sat": btc_volume,
            "volume_fbc": fbc_volume / BUMPS_PER_FBC,
            # Volume-weighted, not a mean of rates: a mean lets one dust trade
            # count as much as the largest one and is trivially skewed.
            "vwap_fbc_per_btc": (
                round(fbc_volume / BUMPS_PER_FBC / (btc_volume / SATS_PER_BTC), 2)
                if btc_volume
                else None
            ),
            "high_fbc_per_btc": max(rates) if rates else None,
            "low_fbc_per_btc": min(rates) if rates else None,
            # USD figures cover only the trades whose settlement price could be
            # established, which is why the count is reported alongside. A
            # VWAP over 3 of 10 trades is not the same number as one over all
            # 10, and printing it without saying so invites reading it as one.
            "usd_priced_trades": len(usd_rows),
            "vwap_fbc_usd": (
                round(usd_value / (usd_fbc / BUMPS_PER_FBC), 6) if usd_fbc else None
            ),
            "high_fbc_usd": max(usd_rates) if usd_rates else None,
            "low_fbc_usd": min(usd_rates) if usd_rates else None,
            # Says plainly what this is. These are settled swaps against a
            # maker whose price is a fixed USD peg, so the rate moves with BTC
            # rather than with anything anyone discovered about FBC.
            "basis": "settled_swaps_verified_on_chain",
        }


def _fbc_usd(btc_sat: int, fbc_bumps: int, btc_usd: float | None) -> float | None:
    """USD per whole FBC, from the BTC/USD that applied when this swap settled."""
    if not btc_usd or not fbc_bumps:
        return None
    return round((btc_usd * (btc_sat / SATS_PER_BTC)) / (fbc_bumps / BUMPS_PER_FBC), 6)


def _rate(btc_sat: int, fbc_bumps: int) -> float | None:
    """Whole FBC per whole BTC."""
    if not btc_sat:
        return None
    return round((fbc_bumps / BUMPS_PER_FBC) / (btc_sat / SATS_PER_BTC), 2)


def _as_epoch_ms(v: Any) -> int | None:
    """
    A millisecond timestamp, or None when the value is not one.
    
    Rejects rather than coerces. `int("soon")` raises, `int(True)` is 1, and
    float("inf") cannot be an int at all — none of which should reach a
    database column or a cursor.
    """
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v != v or v in (float("inf"), float("-inf")):  # NaN or infinite
        return None
    n = int(v)
    # Sanity: 2001-09-09 to 2286-11-20 in ms. A value outside that is a unit
    # mistake (seconds, or microseconds) rather than a date.
    return n if 1_000_000_000_000 <= n <= 9_999_999_999_999 else None


def poll_once(
    store: TradeStore,
    makers: list[dict[str, Any]],
    fetch: Callable[[str, str], dict[str, Any]],
    log: Callable[[str], None] = lambda _m: None,
) -> dict[str, int]:
    """
    One pass over every live maker.

    `fetch(url, origin)` is injected rather than imported so this stays
    testable without a network, and so it can reuse the registry's existing
    SSRF-safe fetcher rather than opening a second way to make outbound
    requests.
    """
    stats = {"polled": 0, "accepted": 0, "rejected": 0, "duplicate": 0, "unverifiable": 0}
    for m in makers:
        url = (m.get("url") or "").rstrip("/")
        if not url:
            continue
        stats["polled"] += 1
        since = store.cursor_for(url)
        try:
            body = fetch(f"{url}/v1/trades?since={since}&limit=100", url)
        except Exception as e:  # noqa: BLE001 - a maker being down is routine
            store.set_cursor(url, since, error=str(e)[:200])
            log(f"[trades] {url}: {e}")
            continue

        trades = body.get("trades") or []
        if not isinstance(trades, list):
            store.set_cursor(url, since, error="trades is not a list")
            continue

        high_water = since
        for t in trades:
            if not isinstance(t, dict) or not isinstance(t.get("swap_id"), str):
                continue
            # Every field below comes from a stranger: announce is
            # permissionless, so any maker can put arbitrary JSON here. A
            # non-numeric settled_at used to raise ValueError out of this whole
            # function, which froze that maker's cursor at 0 forever AND — since
            # makers are walked in sorted order — meant every maker after it was
            # never polled at all. One bad field could take the price feed down
            # permanently for everyone.
            settled_at = _as_epoch_ms(t.get("settled_at"))
            if settled_at is None:
                stats["rejected"] += 1
                store.reject(url, t["swap_id"], "settled_at is not a timestamp")
                log(f"[trades] REJECTED {url} {t['swap_id']}: settled_at is not a timestamp")
                continue
            # `settled_at` from the maker is a PAGING TOKEN and nothing more.
            # The maker filters its own feed by it, so the cursor has to speak
            # the maker's numbering — but it must never reach the database,
            # because it decides the last price, the 24-hour window and the
            # VWAP, and it is chosen by a stranger. verify() replaces it with
            # the BTC claim's block time before anything is stored.
            cursor_at = settled_at
            t = {**t, "settled_at": settled_at}
            try:
                result = verify(t)
            except Unverifiable as e:  # noqa: PERF203
                # A chain we could not read is not evidence of a bad trade.
                # Leave the cursor short of this row so it is retried, and stop
                # this maker's pass here — advancing past an unverified trade
                # would drop it permanently.
                stats["unverifiable"] += 1
                log(f"[trades] {url} {t['swap_id']}: unverifiable, will retry — {e}")
                break
            except Exception as e:  # noqa: BLE001
                # Containment, not politeness. Every field in `t` was written
                # by a stranger, and any unanticipated shape — a leg that is a
                # string, a number where an object belongs — raises something
                # that is not Unverifiable and escapes this whole function.
                # poll_once then aborts, and since makers are walked in sorted
                # order, one maker named early starves every maker after it on
                # every cycle. A permissionless denial of service on the price
                # feed, from one malformed row.
                #
                # Rejecting the row keeps the blast radius at one trade from
                # one maker. Guarding each field as it is added is what failed
                # here twice; this is the backstop that does not depend on
                # anticipating the next shape.
                stats["rejected"] += 1
                store.reject(url, t["swap_id"], f"malformed trade: {type(e).__name__}: {e}")
                log(f"[trades] REJECTED {url} {t['swap_id']}: malformed — {type(e).__name__}: {e}")
                high_water = max(high_water, cursor_at)
                continue
            if not result.ok:
                stats["rejected"] += 1
                store.reject(url, t["swap_id"], result.reason)
                log(f"[trades] REJECTED {url} {t['swap_id']}: {result.reason}")
            else:
                # The settlement time now comes off the chain. A maker can
                # still page us however it likes; it cannot choose when its
                # trade appears to have happened.
                if result.settled_at_ms:
                    t = {**t, "settled_at": result.settled_at_ms}
                try:
                    inserted = store.record(url, t, result)
                except Exception as e:  # noqa: BLE001 — a bad row is not a bad maker
                    stats["rejected"] += 1
                    store.reject(url, t["swap_id"], f"could not store: {e}")
                    log(f"[trades] REJECTED {url} {t['swap_id']}: could not store: {e}")
                    continue
                stats["accepted" if inserted else "duplicate"] += 1
            high_water = max(high_water, cursor_at)

        # Advance past everything examined, including rejects — a trade that
        # failed verification will fail again, and re-checking it every cycle
        # is unbounded work a maker could aim at us on purpose.
        #
        # Minus one millisecond, deliberately. The maker pages on
        # `settled_at > since`, so if a batch ends exactly on a tie — two swaps
        # settling in the same millisecond, one inside the limit and one just
        # outside — advancing to the tie value would skip the second one
        # permanently. Overlapping by a millisecond re-fetches at most a couple
        # of rows, and the outpoint primary key discards them for free.
        if high_water > since:
            store.set_cursor(url, high_water - 1)
    return stats


def poll_pending(
    makers: list[dict[str, Any]],
    fetch: Callable[[str, str], dict[str, Any]],
    log: Callable[[str], None] = lambda _m: None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """
    A snapshot of swaps that are mid-settlement across every live maker.

    Returns a fresh list each call and keeps nothing. These rows are transient
    by nature — each one becomes a settled trade within the hour or stops
    existing — so persisting them would mean writing an expiry policy for
    something that already has one.

    Nothing here is trusted more than `verify_pending` can prove, and what that
    can prove stops short of atomicity: the BTC leg is still unspent, so its
    hashlock is unreadable and cannot be matched against the FBC leg's. These
    rows must therefore never reach the price feed. That is enforced by where
    they go — nowhere near the TradeStore — rather than by remembering to
    exclude them at every read.

    A maker that is down, slow, or serving nonsense contributes nothing and
    costs the others nothing; there is no cursor to corrupt and no state to
    leave behind.
    """
    out: list[dict[str, Any]] = []
    for m in makers:
        url = (m.get("url") or "").rstrip("/")
        if not url:
            continue
        try:
            body = fetch(f"{url}/v1/trades/pending?limit={int(limit)}", url)
        except Exception as e:  # noqa: BLE001 — routine
            log(f"[pending] {url}: {e}")
            continue
        rows = body.get("pending") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            continue
        for t in rows[:limit]:
            if not isinstance(t, dict) or not isinstance(t.get("swap_id"), str):
                continue
            since = _as_epoch_ms(t.get("settling_since"))
            if since is None:
                continue
            try:
                result = verify_pending(t)
            except Unverifiable as e:
                # Nothing to retry against and nothing lost: the next poll
                # rebuilds the whole snapshot from scratch.
                log(f"[pending] {url} {t['swap_id']}: unverifiable — {e}")
                continue
            except Exception as e:  # noqa: BLE001 — same containment as poll_once
                log(f"[pending] {url} {t['swap_id']}: malformed — {type(e).__name__}: {e}")
                continue
            if not result.ok:
                log(f"[pending] REJECTED {url} {t['swap_id']}: {result.reason}")
                continue
            out.append({
                "swap_id": t["swap_id"],
                "maker": url,
                # Identity, for dedup. Same key settled trades use.
                "btc_funding_txid": (t.get("btc") or {}).get("funding_txid"),
                "btc_funding_vout": (t.get("btc") or {}).get("funding_vout"),
                "settling_since": since,
                "amount_btc_sat": t.get("amount_btc_sat"),
                "amount_fbc_bumps": t.get("amount_fbc_bumps"),
                "btc_claim_txid": (t.get("btc") or {}).get("claim_txid"),
                "fbc_claim_txid": (t.get("fbc") or {}).get("claim_txid"),
            })
    # Same identity as a settled trade: the BTC funding outpoint, not the
    # maker's swap id. Two makers reporting one in-flight swap — by accident,
    # or because a maker copied a record that is public on chain anyway —
    # would otherwise show as two settlements in the feed.
    #
    # Newest first, then first-wins, so the surviving row is the freshest
    # report of that outpoint.
    out.sort(key=lambda r: r["settling_since"], reverse=True)
    seen: set[tuple[str, int]] = set()
    deduped: list[dict[str, Any]] = []
    for r in out:
        key = (str(r.get("btc_funding_txid") or "").lower(), int(r.get("btc_funding_vout") or 0))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped

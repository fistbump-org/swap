"""
Tests for mid-settlement ("pending") trades.

The feature is cosmetic — show a swap the moment it is over from the taker's
side instead of an hour later. The risk is not cosmetic: these rows are checked
less thoroughly than settled ones, by necessity, so the tests that matter are
the ones proving what they still get checked for and where they are not allowed
to go.
"""

from __future__ import annotations

import shutil
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import trades as trades_mod
import verify_trade
from verify_trade import Unverifiable, verify_pending

BTC_FUND = "aa" * 32
BTC_CLAIM = "bb" * 32
FBC_FUND = "cc" * 32
FBC_CLAIM = "dd" * 32

# A real HTLC witness script prefix: OP_IF OP_SHA256 <push 32>, then the
# hashlock. sha256(b"\x01" * 32) is what the claim below reveals.
import hashlib

PREIMAGE = "01" * 32
HASHLOCK = hashlib.sha256(bytes.fromhex(PREIMAGE)).hexdigest()
SCRIPT = "63a820" + HASHLOCK + "88" + "21" + "02" * 33 + "ac67"

CLAIM_WITNESS = ["30" * 71, PREIMAGE, "01", SCRIPT]

P2WSH_ADDR = "fb1q" + "z" * 58  # 62 chars, the length a 32-byte program encodes to


def a_pending_trade(**over):
    t = {
        "swap_id": "s_abc",
        "settling_since": 1_785_000_000_000,
        "amount_btc_sat": 10_000,
        "amount_fbc_bumps": 615_147_384,
        "btc": {"funding_txid": BTC_FUND, "funding_vout": 0, "claim_txid": BTC_CLAIM},
        "fbc": {"funding_txid": FBC_FUND, "funding_vout": 0, "claim_txid": FBC_CLAIM},
    }
    t.update(over)
    return t


# Distinguishes "caller did not specify" from "caller wants None", which is a
# real case here: an unspent FBC output IS None and must be expressible.
_DEFAULT = object()


def chain(btc_out=(10_000, "v0_p2wsh"), btc_spender=None,
          fbc_out=(615_147_384, P2WSH_ADDR), fbc_spend=_DEFAULT,
          btc_witness=_DEFAULT):
    """Patch the chain readers. Everything not patched would hit the network."""
    if fbc_spend is _DEFAULT:
        fbc_spend = {"spent": True, "txid": FBC_CLAIM, "witness": CLAIM_WITNESS,
                     "status": {"block_height": 86_500}}
    if btc_witness is _DEFAULT:
        btc_witness = list(CLAIM_WITNESS)
    return mock.patch.multiple(
        verify_trade,
        _btc_output=mock.Mock(return_value=btc_out),
        _btc_spender=mock.Mock(return_value=btc_spender),
        _fbc_output=mock.Mock(return_value=fbc_out),
        _fbc_outspend=mock.Mock(return_value=fbc_spend),
        _btc_witness=mock.Mock(return_value=btc_witness),
        # Only reached in the spent case, and only for a block height.
        _get_json=mock.Mock(return_value={"block_height": 960_209}),
    )


class WhatItStillProves(unittest.TestCase):
    def test_a_genuine_mid_settlement_swap_passes(self):
        with chain():
            r = verify_pending(a_pending_trade())
        self.assertTrue(r.ok, r.reason)
        # The preimage is read off the FBC chain, never taken from the maker.
        self.assertEqual(r.preimage, PREIMAGE)

    def test_a_lied_about_btc_amount_is_caught(self):
        # The whole point of the row is the price it implies, so the amounts are
        # the fields a dishonest maker would move.
        with chain(btc_out=(9_000, "v0_p2wsh")):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("9000", r.reason)

    def test_a_lied_about_fbc_amount_is_caught(self):
        with chain(fbc_out=(1, P2WSH_ADDR)):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)

    def test_an_ordinary_payment_is_not_an_htlc(self):
        with chain(btc_out=(10_000, "v0_p2wpkh")):
            self.assertFalse(verify_pending(a_pending_trade()).ok)
        with chain(fbc_out=(615_147_384, "fb1q" + "z" * 38)):  # P2WPKH length
            self.assertFalse(verify_pending(a_pending_trade()).ok)

    def test_an_unclaimed_fbc_leg_is_not_a_trade(self):
        # An unspent FBC output means nothing has claimed it, so no swap has
        # happened yet whatever the maker says.
        with chain(fbc_spend=None):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("unspent", r.reason)

    def test_a_refund_is_not_a_claim(self):
        # A refund spend has no preimage — [sig, <empty>, script]. Counting one
        # as a trade would publish a price for a swap that did not happen.
        refund = {"spent": True, "txid": FBC_CLAIM, "witness": ["30" * 71, "", SCRIPT],
                  "status": {}}
        with chain(fbc_spend=refund):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("preimage", r.reason)

    def test_a_borrowed_preimage_does_not_pass(self):
        # The preimage must satisfy the hashlock in the claim's OWN script, not
        # merely be present. Otherwise any public 32-byte value would do.
        other = hashlib.sha256(b"different").hexdigest()
        wrong_script = "63a820" + other + "88" + "21" + "02" * 33 + "ac67"
        w = {"spent": True, "txid": FBC_CLAIM,
             "witness": ["30" * 71, PREIMAGE, "01", wrong_script], "status": {}}
        with chain(fbc_spend=w):
            self.assertFalse(verify_pending(a_pending_trade()).ok)

    def test_the_named_claim_must_be_the_actual_spender(self):
        w = {"spent": True, "txid": "ee" * 32, "witness": CLAIM_WITNESS, "status": {}}
        with chain(fbc_spend=w):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("not the reported claim", r.reason)


class WhatPendingMeans(unittest.TestCase):
    def test_an_unspent_btc_leg_passes_but_says_atomicity_is_unproven(self):
        # The weaker of the two cases. It must pass — the swap really is
        # mid-settlement — but must not claim more than it showed.
        with chain(btc_spender=None):
            r = verify_pending(a_pending_trade())
        self.assertTrue(r.ok, r.reason)
        self.assertIn("unproven", r.reason)

    def test_a_claimed_btc_leg_proves_atomicity_in_full(self):
        # Once the BTC claim is on chain its witness script is readable, so the
        # same one-preimage-two-hashlocks proof verify() makes is available. A
        # swap waiting only for burial depth should not be reported as weakly
        # verified.
        with chain(btc_spender=BTC_CLAIM):
            r = verify_pending(a_pending_trade())
        self.assertTrue(r.ok, r.reason)
        self.assertIn("atomicity proven", r.reason)
        self.assertEqual(r.preimage, PREIMAGE)

    def test_two_different_preimages_are_not_one_swap(self):
        # The check the spent case exists to make. Two unrelated HTLCs, each
        # legitimately claimed with its own secret, are two payments — naming
        # them together does not make them a swap, and the price they imply is
        # whatever the maker chose.
        other = "02" * 32
        other_lock = hashlib.sha256(bytes.fromhex(other)).hexdigest()
        other_script = "63a820" + other_lock + "88" + "21" + "02" * 33 + "ac67"
        with chain(btc_spender=BTC_CLAIM,
                   btc_witness=["30" * 71, other, "01", other_script]):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("different preimages", r.reason)

    def test_a_btc_leg_spent_by_something_else_is_refused(self):
        # A refund, or an unrelated spend. Neither is a trade.
        with chain(btc_spender="ee" * 32):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("not the reported claim", r.reason)

    def test_a_btc_refund_is_not_a_claim(self):
        # Spent by the named txid, but the witness has no preimage — the refund
        # branch. Without this, a maker could name its own refund as a claim.
        with chain(btc_spender=BTC_CLAIM, btc_witness=["30" * 71, "", SCRIPT]):
            r = verify_pending(a_pending_trade())
        self.assertFalse(r.ok)
        self.assertIn("no preimage", r.reason)

    def test_malformed_fields_are_rejected_not_raised(self):
        # Every raise from this function is caught upstream as "chain
        # unreadable" and retried, so a bad field must return, not throw.
        for bad in ({"btc": {"funding_txid": "nope", "funding_vout": 0, "claim_txid": BTC_CLAIM}},
                    {"amount_btc_sat": 0},
                    {"amount_fbc_bumps": "lots"},
                    {"fbc": {"funding_txid": FBC_FUND, "funding_vout": -1, "claim_txid": FBC_CLAIM}}):
            with chain():
                r = verify_pending(a_pending_trade(**bad))
            self.assertFalse(r.ok, bad)

    def test_a_chain_being_down_raises_rather_than_rejecting(self):
        # A node outage must not be recorded as "this maker is lying".
        with mock.patch.object(verify_trade, "_btc_output",
                               side_effect=Unverifiable("explorer down")):
            with self.assertRaises(Unverifiable):
                verify_pending(a_pending_trade())


class NeverReachesThePrice(unittest.TestCase):
    """
    The structural guarantee. verify_pending cannot prove both legs share a
    hashlock, because the BTC leg is unspent and a P2WSH hides its script until
    spent. So these rows must never touch anything a price is computed from.
    """

    def test_poll_pending_returns_rows_and_stores_nothing(self):
        calls = []

        def fetch(url, origin):
            calls.append(url)
            return {"pending": [a_pending_trade()]}

        with chain():
            rows = trades_mod.poll_pending([{"url": "https://maker.example"}], fetch)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["swap_id"], "s_abc")
        self.assertIn("/v1/trades/pending", calls[0])

    def test_poll_pending_takes_no_store_argument(self):
        # If it cannot be handed the TradeStore, it cannot write to it, and the
        # price feed reads only from there. This is the guarantee as code.
        import inspect

        params = set(inspect.signature(trades_mod.poll_pending).parameters)
        self.assertNotIn("store", params)
        self.assertEqual(params, {"makers", "fetch", "log", "limit"})

    def test_a_rejected_row_is_dropped_not_published(self):
        def fetch(url, origin):
            return {"pending": [a_pending_trade(amount_btc_sat=999)]}

        with chain():
            rows = trades_mod.poll_pending([{"url": "https://maker.example"}], fetch)
        self.assertEqual(rows, [])

    def test_one_bad_maker_does_not_stop_the_others(self):
        def fetch(url, origin):
            if "bad" in url:
                raise RuntimeError("connection refused")
            return {"pending": [a_pending_trade()]}

        with chain():
            rows = trades_mod.poll_pending(
                [{"url": "https://bad.example"}, {"url": "https://good.example"}], fetch)
        self.assertEqual(len(rows), 1)

    def test_a_maker_cannot_flood_the_snapshot(self):
        def fetch(url, origin):
            return {"pending": [a_pending_trade(swap_id=f"s_{i}") for i in range(500)]}

        with chain():
            rows = trades_mod.poll_pending([{"url": "https://maker.example"}], fetch, limit=5)
        self.assertLessEqual(len(rows), 5)

    def test_garbage_shapes_are_survived(self):
        for body in ({}, {"pending": "not a list"}, {"pending": [None, 3, "x"]}, "nope"):
            with chain():
                rows = trades_mod.poll_pending(
                    [{"url": "https://maker.example"}], lambda u, o: body)
            self.assertEqual(rows, [])


class SettlementIsChainDerived(unittest.TestCase):
    """
    The two things a "verified" trade was still taking on the maker's word:
    that its claims exist at all, and when they happened.
    """

    def test_an_unconfirmed_btc_claim_is_not_settled(self):
        # Everything else about the trade can be true of a transaction sitting
        # in a mempool. An unconfirmed spend can be replaced, evicted or
        # reorged, after which the registry would publish a trade that never
        # happened — permanently, since it is written to the DB.
        with chain(btc_spender=BTC_CLAIM), \
             mock.patch.object(verify_trade, "_get_json", return_value={"block_height": None}):
            with self.assertRaises(verify_trade.NotYetSettled):
                verify_trade.verify(a_pending_trade())

    def test_an_unconfirmed_fbc_claim_is_not_settled(self):
        unconfirmed = {"spent": True, "txid": FBC_CLAIM, "witness": CLAIM_WITNESS, "status": {}}
        with chain(btc_spender=BTC_CLAIM, fbc_spend=unconfirmed), \
             mock.patch.object(verify_trade, "_get_json",
                               return_value={"block_height": 870000, "block_time": 1700000000}):
            with self.assertRaises(verify_trade.NotYetSettled):
                verify_trade.verify(a_pending_trade())

    def test_not_yet_settled_is_retried_not_rejected(self):
        # The routing that matters. Result(False) is permanent — the row is
        # recorded as rejected and the cursor moves past it — and a maker that
        # reports a swap the moment it broadcasts is early, not dishonest.
        self.assertTrue(issubclass(verify_trade.NotYetSettled, verify_trade.Unverifiable))

    def test_settlement_time_comes_from_the_block_not_the_maker(self):
        # A maker could report a genuine swap as settling in 2285 and own the
        # headline price for the next 260 years.
        with chain(btc_spender=BTC_CLAIM), \
             mock.patch.object(verify_trade, "_get_json",
                               return_value={"block_height": 870000, "block_time": 1_700_000_000}):
            r = verify_trade.verify(a_pending_trade(settled_at=9_999_999_999_999))
        self.assertTrue(r.ok, r.reason)
        self.assertEqual(r.settled_at_ms, 1_700_000_000_000)

    def test_a_block_with_no_time_is_retried(self):
        with chain(btc_spender=BTC_CLAIM), \
             mock.patch.object(verify_trade, "_get_json", return_value={"block_height": 870000}):
            with self.assertRaises(verify_trade.NotYetSettled):
                verify_trade.verify(a_pending_trade())


class SettledRowsCarryTheirSwapId(unittest.TestCase):
    def test_recent_exposes_swap_id(self):
        # The registry dedups pending against settled by swap_id. Without this
        # column the comparison was None against None, matched nothing, and one
        # swap could appear in both lists during a poll transition.
        import inspect

        src = inspect.getsource(trades_mod.TradeStore.recent)
        self.assertIn("swap_id", src)
        self.assertIn('"swap_id": r["swap_id"]', src)


class TwoMakersReportingOneSwap(unittest.TestCase):
    """
    The invariant trades.py states in its module docstring and nothing tested:
    identity is the BTC funding outpoint, not the maker's swap id.

    Untestable in practice with one maker, and about to matter — a second maker
    goes live shortly. The failure it prevents is volume inflation: two makers
    naming the same on-chain swap, by accident or on purpose, counting twice.
    """

    def _store(self):
        import tempfile
        from pathlib import Path

        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d, True)
        return trades_mod.TradeStore(d / "trades.db")

    @staticmethod
    def _result():
        return verify_trade.Result(
            True, preimage=PREIMAGE, btc_confirmed_height=870_000,
            fbc_confirmed_height=86_500, settled_at_ms=1_785_000_000_000,
        )

    def test_the_same_outpoint_from_two_makers_is_one_trade(self):
        store = self._store()
        trade = dict(a_pending_trade(), settled_at=1_785_000_000_000)
        first = store.record("https://a.example", trade, self._result())
        # Same on-chain swap, different maker, different swap_id — which is the
        # only part a maker controls.
        second = store.record(
            "https://b.example", dict(trade, swap_id="s_someone_elses_name"), self._result()
        )
        self.assertTrue(first, "the first report should be recorded")
        self.assertFalse(second, "the duplicate must not be recorded again")
        self.assertEqual(len(store.recent(limit=10)), 1)

    def test_genuinely_different_swaps_both_count(self):
        # The other direction: dedup must not collapse distinct swaps just
        # because they share a maker or an amount.
        store = self._store()
        base = dict(a_pending_trade(), settled_at=1_785_000_000_000)
        store.record("https://a.example", base, self._result())
        other = dict(base, btc=dict(base["btc"], funding_txid="ff" * 32), swap_id="s_two")
        store.record("https://a.example", other, self._result())
        self.assertEqual(len(store.recent(limit=10)), 2)

    def test_the_same_txid_at_a_different_vout_is_a_different_outpoint(self):
        # Identity is txid AND vout. One funding transaction can legitimately
        # carry two HTLCs.
        store = self._store()
        base = dict(a_pending_trade(), settled_at=1_785_000_000_000)
        store.record("https://a.example", base, self._result())
        store.record(
            "https://a.example",
            dict(base, btc=dict(base["btc"], funding_vout=1), swap_id="s_two"),
            self._result(),
        )
        self.assertEqual(len(store.recent(limit=10)), 2)

    def test_each_row_remembers_which_maker_reported_it(self):
        store = self._store()
        store.record("https://a.example", dict(a_pending_trade(), settled_at=1_785_000_000_000), self._result())
        rows = store.recent(limit=10)
        self.assertEqual(rows[0]["maker"], "https://a.example")


class OneBadMakerCannotStarveTheRest(unittest.TestCase):
    """
    A permissionless denial of service on the price feed.

    Makers are walked in sorted order and every field they send is a
    stranger's. An exception that is not Unverifiable escapes poll_once
    entirely, so one maker named early aborts the pass before any maker after
    it is polled — every cycle, indefinitely.

    trades.py already carried this lesson for `settled_at`. It was learned for
    one field and not generalised, so it came back through the legs.
    """

    class _Store:
        def __init__(self):
            self.rejected = []
            self.cursors = {}

        def cursor_for(self, u):
            return self.cursors.get(u, 0)

        def set_cursor(self, u, since, error=None):
            self.cursors[u] = since

        def reject(self, url, swap_id, reason):
            self.rejected.append((url, swap_id, reason))

        def record(self, *a):
            return True

    def test_a_string_where_a_leg_belongs_is_rejected_not_raised(self):
        r = verify_trade.verify({"swap_id": "s", "btc": "x", "fbc": {},
                                 "amount_btc_sat": 1, "amount_fbc_bumps": 1})
        self.assertFalse(r.ok)
        self.assertIn("object", r.reason)

    def test_a_malformed_row_does_not_stop_later_makers(self):
        store = self._Store()
        polled = []

        def fetch(url, origin):
            polled.append(url)
            if "aaa" in url:
                return {"trades": [{"swap_id": "s_bad", "settled_at": 1_785_000_000_000,
                                    "btc": "x", "fbc": {},
                                    "amount_btc_sat": 1, "amount_fbc_bumps": 1}]}
            return {"trades": []}

        stats = trades_mod.poll_once(
            store, [{"url": "https://aaa.example"}, {"url": "https://zzz.example"}], fetch
        )
        self.assertEqual(len(polled), 2, "the second maker must still be polled")
        self.assertEqual(stats["rejected"], 1)

    def test_an_unanticipated_shape_is_contained_too(self):
        # The backstop, not the specific guard: this must hold for a shape
        # nobody thought to check, which is how both of these arrived.
        store = self._Store()
        polled = []

        def fetch(url, origin):
            polled.append(url)
            if "aaa" in url:
                # A list where an object belongs — raises inside verify, and is
                # not something any per-field guard anticipates.
                return {"trades": [{"swap_id": "s_odd", "settled_at": 1_785_000_000_000,
                                    "btc": ["not", "a", "dict"], "fbc": {},
                                    "amount_btc_sat": 1, "amount_fbc_bumps": 1}]}
            return {"trades": []}

        trades_mod.poll_once(
            store, [{"url": "https://aaa.example"}, {"url": "https://zzz.example"}], fetch
        )
        self.assertEqual(len(polled), 2)

    def test_the_bad_row_is_not_retried_forever(self):
        # A rejected row must advance the cursor, or the same malformed trade
        # is re-fetched and re-rejected on every cycle — unbounded work a maker
        # could aim at us deliberately.
        store = self._Store()

        def fetch(url, origin):
            return {"trades": [{"swap_id": "s_bad", "settled_at": 1_785_000_000_000,
                                "btc": "x", "fbc": {},
                                "amount_btc_sat": 1, "amount_fbc_bumps": 1}]}

        trades_mod.poll_once(store, [{"url": "https://aaa.example"}], fetch)
        self.assertGreater(store.cursors.get("https://aaa.example", 0), 0)


class BurialBeforeRecording(unittest.TestCase):
    """
    A trade written at one confirmation is a trade a one-block reorg can
    delete from the chain but not from the database. The row is permanent, the
    cursor has advanced past it, and nothing ever revisits it.
    """

    def _mined(self, height=870_000, tip=870_000):
        # _get_json serves both the claim status and the tip, so route by URL.
        def route(url):
            if url.endswith("/blocks/tip/height"):
                return tip
            return {"block_height": height, "block_time": 1_700_000_000}

        return mock.patch.object(verify_trade, "_get_json", side_effect=route)

    def test_one_confirmation_is_not_enough(self):
        with chain(btc_spender=BTC_CLAIM), self._mined(height=870_000, tip=870_000):
            with self.assertRaises(verify_trade.NotYetSettled) as cm:
                verify_trade.verify(a_pending_trade())
        self.assertIn("confirmation", str(cm.exception))

    def test_burial_depth_passes(self):
        tip = 870_000 + verify_trade.BTC_BURIAL_CONFS - 1
        with chain(btc_spender=BTC_CLAIM), self._mined(height=870_000, tip=tip):
            r = verify_trade.verify(a_pending_trade())
        self.assertTrue(r.ok, r.reason)

    def test_an_unreadable_tip_does_not_reject_the_trade(self):
        # A tip we cannot fetch is not evidence about a claim. The
        # confirmed-at-all check still holds; only the depth check is skipped.
        def route(url):
            if url.endswith("/blocks/tip/height"):
                raise verify_trade.Unverifiable("tip unreachable")
            return {"block_height": 870_000, "block_time": 1_700_000_000}

        with chain(btc_spender=BTC_CLAIM), \
             mock.patch.object(verify_trade, "_get_json", side_effect=route):
            r = verify_trade.verify(a_pending_trade())
        self.assertTrue(r.ok, r.reason)

    def test_a_shallow_fbc_claim_is_not_settled(self):
        shallow = {"spent": True, "txid": FBC_CLAIM, "witness": CLAIM_WITNESS,
                   "status": {"block_height": 86_500}, "confirmations": 1}
        tip = 870_000 + verify_trade.BTC_BURIAL_CONFS
        with chain(btc_spender=BTC_CLAIM, fbc_spend=shallow), self._mined(tip=tip):
            with self.assertRaises(verify_trade.NotYetSettled):
                verify_trade.verify(a_pending_trade())

    def test_not_yet_buried_is_retried_not_rejected(self):
        # Permanent rejection would discard a real trade for being young.
        self.assertTrue(issubclass(verify_trade.NotYetSettled, verify_trade.Unverifiable))



class PendingIsDedupedByOutpoint(unittest.TestCase):
    """
    Settled trades are keyed on the BTC funding outpoint so one on-chain swap
    counts once whoever reports it. Pending rows were appended per maker, so
    the same in-flight swap reported twice showed as two settlements.
    """

    def _rows(self, makers):
        def fetch(url, origin):
            return {"pending": [a_pending_trade()]}

        with chain():
            return trades_mod.poll_pending([{"url": u} for u in makers], fetch)

    def test_two_makers_reporting_one_swap_yield_one_row(self):
        rows = self._rows(["https://a.example", "https://b.example"])
        self.assertEqual(len(rows), 1, [r["maker"] for r in rows])

    def test_a_pending_row_carries_its_outpoint(self):
        rows = self._rows(["https://a.example"])
        self.assertEqual(rows[0]["btc_funding_txid"], BTC_FUND)
        self.assertEqual(rows[0]["btc_funding_vout"], 0)

    def test_distinct_swaps_are_not_collapsed(self):
        def fetch(url, origin):
            other = dict(a_pending_trade(), swap_id="s_two")
            other["btc"] = dict(other["btc"], funding_vout=1)
            return {"pending": [a_pending_trade(), other]}

        with chain():
            rows = trades_mod.poll_pending([{"url": "https://a.example"}], fetch)
        self.assertEqual(len(rows), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

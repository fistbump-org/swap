"""
Tests for the BTC proxy.

Two things are worth testing here and they are both about boundaries rather
than logic: that bitcoind's decimal BTC becomes integer sats on the way out
(this codebase has produced two separate 1e8 bugs), and that nothing outside the
allowlist can reach the node.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from btc_proxy import ALLOWED, BtcProxy, BtcUnavailable, _esplora_type, _to_sats


class FakeNode(BtcProxy):
    """A BtcProxy whose RPC is a dict of canned answers."""

    def __init__(self, answers):
        super().__init__("http://unused")
        self.answers = answers
        self.calls = []

    def call(self, method, params=None):
        if method not in ALLOWED:
            raise ValueError(f"rpc method not allowed: {method}")
        self.calls.append((method, params))
        v = self.answers.get(method)
        return v(params) if callable(v) else v


CONFIRMED_TX = {
    "txid": "aa" * 32,
    "version": 2,
    "locktime": 0,
    "size": 222,
    "weight": 561,
    "confirmations": 4,
    "blockhash": "bb" * 32,
    "blocktime": 1_700_000_000,
    "vin": [{"txid": "cc" * 32, "vout": 1, "txinwitness": ["30ab", "02cd"], "sequence": 4294967293}],
    "vout": [
        {"value": 0.00009746,
         "scriptPubKey": {"hex": "0020" + "dd" * 32, "asm": "0 dd..",
                          "type": "witness_v0_scripthash", "address": "bc1qhtlc"}},
        {"value": 1.5,
         "scriptPubKey": {"hex": "0014" + "ee" * 20, "asm": "0 ee..",
                          "type": "witness_v0_keyhash", "address": "bc1qchange"}},
    ],
}


class Units(unittest.TestCase):
    """The 1e8 boundary. bitcoind says BTC, Esplora says sats, callers say sats."""

    def test_output_values_are_integer_sats(self):
        node = FakeNode({"getrawtransaction": CONFIRMED_TX,
                         "getblockheader": {"height": 870_000, "time": 1_700_000_000}})
        tx = node.tx("aa" * 32)
        self.assertEqual(tx["vout"][0]["value"], 9746)
        self.assertEqual(tx["vout"][1]["value"], 150_000_000)
        for o in tx["vout"]:
            self.assertIsInstance(o["value"], int)

    def test_no_float_drift_on_awkward_amounts(self):
        # 0.1 + 0.2 arithmetic in disguise. 20999999.9769 * 1e8 in float is
        # 2099999997689.9998; truncation would lose a satoshi, rounding does not.
        for btc, sats in [
            (0.00000001, 1),
            (0.1, 10_000_000),
            (0.29, 29_000_000),
            (1.1, 110_000_000),
            (20999999.9769, 2099999997690000),
            (0.00009746, 9746),
        ]:
            self.assertEqual(_to_sats(btc), sats, f"{btc} BTC")

    def test_fee_estimates_are_sat_per_vbyte(self):
        # estimatesmartfee answers BTC/kvB. 0.00002 BTC/kvB = 2000 sat/kvB = 2 sat/vB.
        node = FakeNode({"estimatesmartfee": {"feerate": 0.00002, "blocks": 6}})
        self.assertEqual(node.fee_estimates()["6"], 2.0)

    def test_fee_estimates_never_empty(self):
        # {} would read as "fees are zero" to a caller doing `est[target] || …`,
        # and a zero-fee transaction does not relay.
        node = FakeNode({"estimatesmartfee": {}})
        self.assertTrue(node.fee_estimates())


class Fee(unittest.TestCase):
    """
    The fee is what lets the page tell "stalled" from "broken".

    Both branches are exercised because they use entirely different RPCs, and
    the confirmed one does arithmetic that can go negative if a prevout is
    misread.
    """

    def test_unconfirmed_fee_comes_from_the_mempool_entry(self):
        mem = dict(CONFIRMED_TX, confirmations=0)
        mem.pop("blockhash")
        node = FakeNode({"getrawtransaction": mem,
                         "getmempoolentry": {"fees": {"base": 0.00000153}}})
        # 153 sats over 152.5 vB is the 1.003 sat/vB that stalled a real swap.
        self.assertEqual(node.tx("aa" * 32)["fee"], 153)

    def test_older_nodes_expose_a_flat_fee_field(self):
        mem = dict(CONFIRMED_TX, confirmations=0)
        mem.pop("blockhash")
        node = FakeNode({"getrawtransaction": mem, "getmempoolentry": {"fee": 0.00000153}})
        self.assertEqual(node.tx("aa" * 32)["fee"], 153)

    def test_confirmed_fee_is_inputs_minus_outputs(self):
        prev = {"txid": "cc" * 32, "vout": [
            {"value": 0.0, "scriptPubKey": {}},
            {"value": 1.50019746, "scriptPubKey": {}},
        ]}
        def raw(params):
            return prev if params[0] == "cc" * 32 else CONFIRMED_TX
        node = FakeNode({"getrawtransaction": raw,
                         "getblockheader": {"height": 1, "time": 1}})
        # in 150019746, out 9746 + 150000000 = 150009746, so fee 10000.
        self.assertEqual(node.tx("aa" * 32)["fee"], 10_000)

    def test_unknown_fee_is_none_not_zero(self):
        # Zero is a fee rate a caller could act on. "We could not work it out"
        # is not, and must not be reported as free.
        mem = dict(CONFIRMED_TX, confirmations=0)
        mem.pop("blockhash")
        node = FakeNode({"getrawtransaction": mem, "getmempoolentry": None})
        self.assertIsNone(node.tx("aa" * 32)["fee"])

    def test_a_negative_fee_is_refused(self):
        # Inputs smaller than outputs means a prevout was misread. Reporting a
        # negative sat/vB downstream would read as an absurdly good fee.
        prev = {"txid": "cc" * 32, "vout": [{"value": 0.00000001, "scriptPubKey": {}},
                                            {"value": 0.00000001, "scriptPubKey": {}}]}
        def raw(params):
            return prev if params[0] == "cc" * 32 else CONFIRMED_TX
        node = FakeNode({"getrawtransaction": raw,
                         "getblockheader": {"height": 1, "time": 1}})
        self.assertIsNone(node.tx("aa" * 32)["fee"])


class Shape(unittest.TestCase):
    """Esplora compatibility — the frontend must not have to branch."""

    def test_confirmed_status_uses_header_height(self):
        node = FakeNode({"getrawtransaction": CONFIRMED_TX,
                         "getblockheader": {"height": 870_000, "time": 1_700_000_000}})
        st = node.tx_status("aa" * 32)
        self.assertEqual(st, {"confirmed": True, "block_height": 870_000,
                              "block_hash": "bb" * 32, "block_time": 1_700_000_000})

    def test_mempool_tx_is_unconfirmed_not_missing(self):
        # A transaction in the mempool is the whole reason this proxy exists.
        # It must come back confirmed:false, NOT 404 — the funding step polls
        # for exactly this state.
        mem = dict(CONFIRMED_TX, confirmations=0)
        mem.pop("blockhash")
        node = FakeNode({"getrawtransaction": mem})
        st = node.tx_status("aa" * 32)
        self.assertEqual(st["confirmed"], False)
        self.assertIsNone(st["block_height"])
        self.assertIsNotNone(node.tx("aa" * 32))

    def test_unknown_tx_is_none(self):
        node = FakeNode({"getrawtransaction": None})
        self.assertIsNone(node.tx("aa" * 32))
        self.assertIsNone(node.tx_status("aa" * 32))

    def test_witness_is_exposed_under_esplora_name(self):
        # verify_trade and the preimage watcher both read vin[].witness. Core
        # calls it txinwitness; a rename that silently dropped it would make
        # every preimage detector inert without failing anything.
        node = FakeNode({"getrawtransaction": CONFIRMED_TX,
                         "getblockheader": {"height": 1, "time": 1}})
        self.assertEqual(node.tx("aa" * 32)["vin"][0]["witness"], ["30ab", "02cd"])

    def test_script_types_map_to_esplora_names(self):
        # verify_trade rejects a funding output unless its type is "v0_p2wsh".
        # Passing Core's name through would fail every honest trade.
        self.assertEqual(_esplora_type("witness_v0_scripthash"), "v0_p2wsh")
        self.assertEqual(_esplora_type("witness_v0_keyhash"), "v0_p2wpkh")
        self.assertEqual(_esplora_type("witness_v1_taproot"), "v1_p2tr")

    def test_outspend_reports_spentness(self):
        node = FakeNode({"gettxout": {"value": 0.0001}})
        self.assertEqual(node.outspend("aa" * 32, 0)["spent"], False)
        node = FakeNode({"gettxout": None})
        spent = node.outspend("aa" * 32, 0)
        self.assertEqual(spent["spent"], True)
        # bitcoind cannot name the spender, and must not pretend otherwise.
        self.assertIsNone(spent["txid"])
        self.assertTrue(spent["spender_unknown"])


class Allowlist(unittest.TestCase):
    """This endpoint is public. The node behind it holds the maker's keys."""

    def test_wallet_methods_are_refused(self):
        node = BtcProxy("http://unused")
        for method in ("dumpprivkey", "sendtoaddress", "walletpassphrase",
                       "listunspent", "stop", "getnewaddress", "signrawtransactionwithwallet"):
            with self.assertRaises(ValueError, msg=method):
                node.call(method, [])

    def test_allowlist_is_read_only_plus_broadcast(self):
        # Broadcast is the sole write, and it can only express "relay this
        # transaction" — it takes a signed blob, not an instruction.
        self.assertEqual(ALLOWED - {"sendrawtransaction"},
                         {"getblockcount", "getblockhash", "getrawtransaction",
                          "getblockheader", "estimatesmartfee", "gettxout",
                          "getmempoolentry"})

    def test_no_wallet_method_is_reachable_by_name(self):
        self.assertFalse(any("wallet" in m or "priv" in m or "sign" in m for m in ALLOWED))


class Failure(unittest.TestCase):
    """'Not found' and 'node is down' must stay distinguishable."""

    def test_node_down_raises_rather_than_reporting_absence(self):
        # If an unreachable node reported "no such transaction", the funding
        # step would tell a user their money had not arrived when it had.
        class Down(BtcProxy):
            def call(self, method, params=None):
                raise BtcUnavailable("connection refused")

        with self.assertRaises(BtcUnavailable):
            Down("http://unused").tx("aa" * 32)


if __name__ == "__main__":
    unittest.main(verbosity=2)

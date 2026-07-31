"""
Read-only Bitcoin chain data from our own node, in Esplora's shape.

Why this exists: the swap UI was reading BTC chain data from blockstream.info.
On a real mainnet swap that cost a user their evening — the page broadcast a
funding transaction, asked blockstream for it 32 seconds later, and blockstream
had not indexed it yet. The coins were fine; the page reported failure. Our own
node had the transaction in its mempool within a second or two.

Every BTC read the browser makes is about the taker's OWN transaction — has my
funding propagated, how deep is it, broadcast my claim. None of it is
trust-sensitive: lying to someone about their own transaction gains nothing and
they would notice. So serving it from our node costs no security and removes a
third party from the critical path of every swap.

Esplora's response shape is reproduced exactly so the frontend can prefer this
and fall back to blockstream or mempool.space with no branching.

TWO RULES, both load-bearing:

**Method allowlist, never a passthrough.** This is a public endpoint reachable
by anyone. `bitcoindCall(method_from_url)` would expose the wallet — including
`dumpprivkey`, which the maker's claim key lives behind.

**Values are satoshis on the way out.** bitcoind speaks decimal BTC. Esplora
speaks integer sats. That boundary has produced two separate 1e8 bugs in this
codebase already, so the conversion happens in one place and is asserted in the
tests.
"""

from __future__ import annotations

import base64
import json
import threading
import time
import urllib.error
import urllib.request
from typing import Any

# Exactly the methods the five proxied endpoints need. Nothing wallet-scoped.
ALLOWED = frozenset(
    {
        "getblockcount",
        "getblockhash",
        "getrawtransaction",
        "getblockheader",
        "sendrawtransaction",
        "estimatesmartfee",
        "gettxout",
        "getmempoolentry",
    }
)

SATS_PER_BTC = 100_000_000
RPC_TIMEOUT = 10

# A tip height changes every ~10 minutes; re-asking bitcoind per request would
# make a page refresh a load amplifier.
_TIP_TTL = 5.0
_tip_cache: dict[str, Any] = {"at": 0.0, "value": None}
_tip_lock = threading.Lock()


class BtcUnavailable(Exception):
    """The node could not be reached or refused. Distinct from 'not found'."""


class BtcProxy:
    def __init__(self, rpc_url: str, user: str = "", password: str = "") -> None:
        self.rpc_url = rpc_url.rstrip("/")
        self._auth = None
        if user or password:
            raw = f"{user}:{password}".encode("utf-8")
            self._auth = "Basic " + base64.b64encode(raw).decode("ascii")

    # ---- RPC ------------------------------------------------------------

    def call(self, method: str, params: list[Any] | None = None) -> Any:
        if method not in ALLOWED:
            # Not a 400 — a programming error. A method reaching here that is
            # not on the list means a caller built it from user input.
            raise ValueError(f"rpc method not allowed: {method}")
        body = json.dumps({"jsonrpc": "1.0", "id": "swap-proxy", "method": method,
                           "params": params or []}).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self._auth:
            headers["Authorization"] = self._auth
        req = urllib.request.Request(self.rpc_url, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=RPC_TIMEOUT) as r:
                parsed = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            # bitcoind returns 500 with a JSON error body for things like
            # "no such transaction", which is an answer rather than a failure.
            try:
                parsed = json.loads(e.read().decode("utf-8"))
            except Exception:
                raise BtcUnavailable(f"bitcoind HTTP {e.code}") from e
        except Exception as e:  # noqa: BLE001 — DNS, refused, timeout
            raise BtcUnavailable(str(e)) from e
        err = parsed.get("error")
        if err:
            code = err.get("code") if isinstance(err, dict) else None
            msg = err.get("message") if isinstance(err, dict) else str(err)
            # -5 is "not found" for getrawtransaction/getblockhash. Everything
            # else is us asking wrongly or the node being unwell.
            if code == -5:
                return None
            raise BtcUnavailable(f"bitcoind {method}: {msg}")
        return parsed.get("result")

    # ---- Esplora-shaped endpoints ---------------------------------------

    def tip_height(self) -> int:
        with _tip_lock:
            if _tip_cache["value"] is not None and time.monotonic() - _tip_cache["at"] < _TIP_TTL:
                return int(_tip_cache["value"])
        h = int(self.call("getblockcount"))
        with _tip_lock:
            _tip_cache.update(at=time.monotonic(), value=h)
        return h

    def _status(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Esplora's `status` block, derived from confirmations + blockhash."""
        confs = int(raw.get("confirmations") or 0)
        if confs <= 0 or not raw.get("blockhash"):
            return {"confirmed": False, "block_height": None,
                    "block_hash": None, "block_time": None}
        # Height from the header rather than tip-minus-confirmations: the two
        # disagree across a block arriving mid-request, and the header is the
        # one that is actually true.
        header = self.call("getblockheader", [raw["blockhash"]]) or {}
        return {
            "confirmed": True,
            "block_height": header.get("height"),
            "block_hash": raw["blockhash"],
            "block_time": raw.get("blocktime") or header.get("time"),
        }

    def tx(self, txid: str) -> dict[str, Any] | None:
        """Esplora `GET /tx/:txid`. None when the node does not know it."""
        raw = self.call("getrawtransaction", [txid, True])
        if not raw:
            return None
        vout = []
        for o in raw.get("vout") or []:
            spk = o.get("scriptPubKey") or {}
            vout.append({
                "scriptpubkey": spk.get("hex"),
                "scriptpubkey_asm": spk.get("asm"),
                "scriptpubkey_type": _esplora_type(spk.get("type")),
                "scriptpubkey_address": spk.get("address"),
                # Decimal BTC -> integer sats. The one conversion in this file.
                "value": _to_sats(o.get("value")),
            })
        vin = []
        for i in raw.get("vin") or []:
            vin.append({
                "txid": i.get("txid"),
                "vout": i.get("vout"),
                "witness": i.get("txinwitness") or [],
                "sequence": i.get("sequence"),
                "is_coinbase": "coinbase" in i,
            })
        return {
            "txid": raw.get("txid"),
            "version": raw.get("version"),
            "locktime": raw.get("locktime"),
            "size": raw.get("size"),
            "weight": raw.get("weight"),
            "fee": self._fee(raw),
            "vin": vin,
            "vout": vout,
            "status": self._status(raw),
        }

    def _fee(self, raw: dict[str, Any]) -> int | None:
        """
        The fee in satoshis, which Esplora includes on /tx/:txid.

        It is here so the swap page can tell a stalled funding transaction from a
        broken one. A funding tx that underpaid sits unconfirmed for hours while
        the maker waits for six confirmations, and with no fee visible that is
        indistinguishable from a failure — which is how one mainnet swap came to
        look broken while being perfectly fine.

        bitcoind does not report a fee on getrawtransaction, so:

          - unconfirmed: getmempoolentry, one cheap call, and this is the case
            that matters since a stall is by definition unconfirmed.
          - confirmed: sum the inputs. O(inputs) extra calls, but nothing polls
            /tx once a transaction has confirmed.

        None rather than 0 when it cannot be determined. Zero is a real fee rate
        a caller might act on, and "unknown" is not that.
        """
        txid = raw.get("txid")
        if not txid:
            return None
        if not raw.get("blockhash"):
            try:
                entry = self.call("getmempoolentry", [txid])
            except BtcUnavailable:
                return None
            if entry:
                # `fees.base` is BTC; older nodes expose a top-level `fee`.
                base = (entry.get("fees") or {}).get("base", entry.get("fee"))
                return _to_sats(base) if base is not None else None
            return None
        total_in = 0
        for i in raw.get("vin") or []:
            if "coinbase" in i:
                return 0
            prev_txid, prev_vout = i.get("txid"), i.get("vout")
            if not prev_txid or prev_vout is None:
                return None
            try:
                prev = self.call("getrawtransaction", [prev_txid, True])
            except BtcUnavailable:
                return None
            if not prev:
                return None
            outs = prev.get("vout") or []
            if int(prev_vout) >= len(outs):
                return None
            total_in += _to_sats(outs[int(prev_vout)].get("value"))
        total_out = sum(_to_sats(o.get("value")) for o in raw.get("vout") or [])
        fee = total_in - total_out
        # A negative fee means we mis-read something, not that Bitcoin printed
        # money. Report unknown rather than a number that cannot be true.
        return fee if fee >= 0 else None

    def tx_status(self, txid: str) -> dict[str, Any] | None:
        raw = self.call("getrawtransaction", [txid, True])
        if not raw:
            return None
        return self._status(raw)

    def outspend(self, txid: str, vout: int) -> dict[str, Any]:
        """
        Esplora `GET /tx/:txid/outspend/:vout`, partially.

        `gettxout` answers "is this output unspent" from the UTXO set, which is
        all the caller needs. It cannot say WHO spent a spent output — that
        needs an address index bitcoind does not maintain — so `txid` is null
        rather than wrong. Callers that need the spender must use an indexer.
        """
        utxo = self.call("gettxout", [txid, int(vout), True])
        if utxo:
            return {"spent": False, "txid": None, "vin": None, "status": None}
        return {"spent": True, "txid": None, "vin": None, "status": None,
                "spender_unknown": True}

    def broadcast(self, raw_hex: str) -> str:
        return str(self.call("sendrawtransaction", [raw_hex]))

    def fee_estimates(self) -> dict[str, float]:
        """
        Esplora `GET /fee-estimates`: {blocks: sat/vB}.

        estimatesmartfee answers BTC/kvB, so this is the second place decimal
        BTC has to become something else — sat/vB here, not sats.
        """
        out: dict[str, float] = {}
        for target in (1, 2, 3, 6, 10, 25, 144, 504, 1008):
            try:
                r = self.call("estimatesmartfee", [target]) or {}
                btc_per_kvb = r.get("feerate")
                if isinstance(btc_per_kvb, (int, float)) and btc_per_kvb > 0:
                    out[str(target)] = round(btc_per_kvb * SATS_PER_BTC / 1000, 3)
            except BtcUnavailable:
                continue
        # A node with no estimate yet (fresh regtest, or a very quiet mempool)
        # must not return {} and have callers read that as "fees are zero".
        return out or {"1": 1.0, "6": 1.0, "144": 1.0}


def _to_sats(btc: Any) -> int:
    """Decimal BTC to integer satoshis, the only place this happens."""
    if not isinstance(btc, (int, float)):
        return 0
    return int(round(float(btc) * SATS_PER_BTC))


def _esplora_type(core_type: str | None) -> str:
    """Core's scriptPubKey type names to Esplora's."""
    return {
        "witness_v0_keyhash": "v0_p2wpkh",
        "witness_v0_scripthash": "v0_p2wsh",
        "witness_v1_taproot": "v1_p2tr",
        "pubkeyhash": "p2pkh",
        "scripthash": "p2sh",
        "pubkey": "p2pk",
        "nulldata": "op_return",
    }.get(core_type or "", core_type or "unknown")

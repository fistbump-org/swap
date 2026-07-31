"""
Verify that a maker-reported trade really happened, on chain.

A maker publishing its own trade history is publishing a claim. Anyone can
report a swap that never occurred, or report a real one at the wrong size, and
a price feed built on unverified claims is worth nothing — it is exactly the
number a dishonest maker would want to move.

So nothing here trusts the maker for anything except *which transactions to go
look at*. Everything else is read from BTC and FBC directly:

  1. the BTC funding output pays the stated amount, to a P2WSH (HTLC shape)
  2. that output was spent by the stated BTC claim transaction
  3. the FBC funding output pays the stated amount
  4. that output was spent by the stated FBC claim transaction
  5. one preimage satisfies the hashlock in BOTH witness scripts

Check 5 is the one that makes this a swap rather than two payments. Checks 1-4
would pass for any two unrelated transactions a maker chose to name together;
one preimage satisfying two independent hashlocks is only produced by an actual
HTLC pair, and it cannot be forged after the fact because both spends are
already mined.

The hashlock is read out of the witness script itself, never taken from the
maker. An earlier version compared any 32-byte element from each leg against
the other and checked neither against a script — so a preimage already public
on mainnet could be borrowed, an HTLC built to its hash for any amount, claimed
by its own author, and all five checks would pass.

The preimage is deliberately NOT taken from the maker. Reading it off the chain
is what keeps the check from being circular.
"""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

BTC_API = "https://blockstream.info/api"
FBC_BASE = "https://explorer.fistbump.org"

# The largest element Bitcoin's standard rules will push, so nothing longer can
# have been the preimage of a spend that confirmed. Length is otherwise NOT a
# criterion: the HTLC script carries no OP_SIZE check, so a preimage may be any
# length, and identifying it by size would miss a 31-byte one entirely.
MAX_PUSH_BYTES = 80

# Confirmations a claim needs before its trade is written down.
#
# One is not enough. A single-block reorg evicts a claim that had one
# confirmation, and this database is permanent: the row is written, the cursor
# advances past it, and the price feed then quotes a swap that no longer
# exists. Nothing ever revisits it.
#
# These match the burial depths the bot itself waits for before calling a swap
# done, which is the same question asked by a different party — there is no
# reason for the registry to believe a claim sooner than the maker does.
BTC_BURIAL_CONFS = 6
FBC_BURIAL_CONFS = 12

HTTP_TIMEOUT = 15


class Unverifiable(Exception):
    """A chain could not be reached. Distinct from a trade being invalid."""


class NotYetSettled(Unverifiable):
    """
    Real so far, but not final — a claim is still unconfirmed.

    A subclass of Unverifiable so it takes the RETRY path rather than the
    reject path. The distinction is the whole point: `Result(False)` is
    permanent (the row is recorded as rejected and the cursor moves past it),
    and a maker who reports a swap the moment it broadcasts is early, not
    dishonest. Rejecting them would discard a real trade forever.
    """


def _get_json(url: str) -> Any:
    try:
        with urllib.request.urlopen(url, timeout=HTTP_TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise Unverifiable(f"{url} -> HTTP {e.code}") from e
    except Exception as e:  # noqa: BLE001 - network, DNS, JSON, all the same here
        raise Unverifiable(f"{url} -> {e}") from e


@dataclass
class Result:
    ok: bool
    reason: str = ""
    preimage: str | None = None
    btc_confirmed_height: int | None = None
    fbc_confirmed_height: int | None = None
    #: When the BTC claim was mined, in epoch ms, read from the block header.
    #: This is the settlement time the price feed must use — see poll_once.
    settled_at_ms: int | None = None


def _btc_tip() -> int | None:
    """
    Current BTC height, or None when it cannot be read.

    None means the depth check is skipped rather than the trade rejected: an
    unreachable tip is not evidence about a claim, and the confirmed-at-all
    check above already holds.
    """
    try:
        raw = _get_json(f"{BTC_API}/blocks/tip/height")
    except Unverifiable:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def _btc_output(txid: str, vout: int) -> tuple[int, str] | None:
    """(value_sat, scriptpubkey_type) for one BTC output."""
    tx = _get_json(f"{BTC_API}/tx/{txid}")
    if not tx:
        return None
    outs = tx.get("vout") or []
    if vout >= len(outs):
        return None
    o = outs[vout]
    return int(o.get("value", -1)), str(o.get("scriptpubkey_type", ""))


def _btc_spender(txid: str, vout: int) -> str | None:
    o = _get_json(f"{BTC_API}/tx/{txid}/outspend/{vout}")
    if not o or not o.get("spent"):
        return None
    return o.get("txid")


def _btc_witness(txid: str, prev_txid: str, prev_vout: int) -> list[str] | None:
    tx = _get_json(f"{BTC_API}/tx/{txid}")
    if not tx:
        return None
    for vin in tx.get("vin") or []:
        if vin.get("txid") == prev_txid and int(vin.get("vout", -1)) == prev_vout:
            w = vin.get("witness")
            return list(w) if isinstance(w, list) else None
    return None


def _fbc_output(txid: str, vout: int) -> tuple[int, str] | None:
    """(value_bumps, address) for one FBC output.

    The address is returned so the caller can require it to be a P2WSH — the
    BTC side has always checked its scriptPubKey type and this side checked
    nothing, so a plain payment to a normal address counted as an HTLC.
    """
    tx = _get_json(f"{FBC_BASE}/tx/{txid}?json=1")
    if not tx or not tx.get("found"):
        return None
    outs = tx.get("vout") or []
    if vout >= len(outs):
        return None
    o = outs[vout]
    return int(o.get("value", -1)), str(o.get("address") or "")


def _fbc_outspend(txid: str, vout: int) -> dict[str, Any] | None:
    """The explorer's outspend record, which carries the witness inline."""
    o = _get_json(f"{FBC_BASE}/tx/{txid}/outspend/{vout}")
    if not o or not o.get("spent"):
        return None
    return o


def _hashlock_from_witness_script(witness: list[str] | None) -> str | None:
    """
    The hashlock an HTLC witness script commits to.

    Layout, from SPEC Appendix A and htlc.ts:

        63 a8 20 <32-byte hashlock> 88 21 <33-byte pk> ac 67 ...
        IF SHA256 push32  hashlock  EQUALVERIFY push33 pk CHECKSIG ELSE

    So the hashlock is bytes 3..35 of the script, and the script is the LAST
    witness element. Reading it from the script rather than from the maker is
    what makes the check non-circular.
    """
    if not witness:
        return None
    script = witness[-1]
    if not isinstance(script, str):
        return None
    try:
        raw = bytes.fromhex(script)
    except ValueError:
        return None
    # 63 a8 20 — OP_IF OP_SHA256 <push 32 bytes>
    if len(raw) < 35 or raw[0] != 0x63 or raw[1] != 0xA8 or raw[2] != 0x20:
        return None
    return raw[3:35].hex()


def _preimage_from_witness(witness: list[str] | None) -> str | None:
    """
    The element of an HTLC claim witness that hashes to the script's own
    hashlock.

    This used to return any 32-byte element without checking it against
    anything, which made the atomicity test meaningless: two unrelated
    transactions each containing some 32-byte value would "share a preimage" if
    the values happened to match, and a maker could borrow a preimage already
    public on mainnet, build an HTLC to its hash for any amount, claim it, and
    have all five checks pass.

    Now the script's hashlock is extracted from the witness and the preimage
    must hash to it. Nothing here is taken on the maker's word, and nothing
    depends on the preimage being 32 bytes.
    """
    if not witness or len(witness) < 4:
        return None
    want = _hashlock_from_witness_script(witness)
    if not want:
        return None
    for element in witness:
        if not isinstance(element, str) or not element or len(element) % 2:
            continue
        if len(element) > MAX_PUSH_BYTES * 2:
            continue
        try:
            raw = bytes.fromhex(element)
        except ValueError:
            continue
        if hashlib.sha256(raw).hexdigest() == want:
            return element.lower()
    return None


def verify_pending(trade: dict[str, Any]) -> Result:
    """
    Check a swap that is claimed to be mid-settlement, as far as chains allow.

    This exists so the market feed can show a swap the moment it is over from
    the taker's point of view, rather than an hour later once the maker's BTC
    claim is buried. A feed whose newest row is a day old reads as broken to
    someone who has just traded.

    "Mid-settlement" covers two genuinely different situations, and the amount
    that can be proven differs between them:

      (a) the BTC funding is still unspent — the taker has claimed the FBC leg
          and the maker has not yet claimed the BTC leg. A P2WSH reveals its
          script only when spent, so the BTC leg's hashlock is unreadable and
          there is NO way to show it matches the FBC leg's. A maker could pair
          a genuine FBC claim with an unrelated BTC output of any size and this
          would pass. Everything else is checked: both amounts, both P2WSH
          shapes, the FBC spend, and a preimage satisfying the FBC script's own
          hashlock.

      (b) the BTC funding has been spent by the claim named — then the BTC
          witness script is on chain too, and the full atomicity check applies:
          one preimage satisfying the hashlock in BOTH scripts. This is the
          same proof `verify()` makes. The only thing still missing is burial
          depth, which is a reorg question, not an evidence question.

    `result.reason` records which case it was, because they are not equally
    strong and a caller that treats them alike is claiming more than it knows.

    Either way the row must never reach a price, a volume, or any other
    statistic. In case (a) because atomicity is unproven; in case (b) because
    an unburied trade can still be reorged away, which is exactly what the
    settled feed's burial wait exists to rule out.
    """
    btc = trade.get("btc") or {}
    fbc = trade.get("fbc") or {}
    # Both legs must be objects before anything calls .get on them.
    #
    # `{"btc": "x"}` makes `btc.get(...)` raise AttributeError, which is not an
    # Unverifiable and so escapes poll_once entirely — aborting the whole pass.
    # Makers are walked in sorted order, so one named early starves every maker
    # after it, on every cycle, indefinitely. That is a permissionless denial
    # of service on the price feed.
    #
    # trades.py already carries this lesson for `settled_at` ("One bad field
    # could take the price feed down permanently for everyone"). It was learned
    # for one field and not generalised; a leg is the other thing a stranger
    # gets to shape.
    if not isinstance(btc, dict) or not isinstance(fbc, dict):
        return Result(False, "btc and fbc must each be an object")
    for field, value in (
        ("btc.funding_txid", btc.get("funding_txid")),
        ("fbc.funding_txid", fbc.get("funding_txid")),
        ("fbc.claim_txid", fbc.get("claim_txid")),
    ):
        if not isinstance(value, str) or len(value) != 64:
            return Result(False, f"{field} is not a txid")
        if not all(c in "0123456789abcdefABCDEF" for c in value):
            return Result(False, f"{field} is not hex")
    for field, value in (("btc.funding_vout", btc.get("funding_vout")),
                         ("fbc.funding_vout", fbc.get("funding_vout"))):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100_000:
            return Result(False, f"{field} is not a vout")
    if not isinstance(trade.get("amount_btc_sat"), int) or trade["amount_btc_sat"] <= 0:
        return Result(False, "amount_btc_sat is not a positive integer")
    if not isinstance(trade.get("amount_fbc_bumps"), int) or trade["amount_fbc_bumps"] <= 0:
        return Result(False, "amount_fbc_bumps is not a positive integer")

    got = _btc_output(btc["funding_txid"], int(btc["funding_vout"]))
    if got is None:
        return Result(False, "BTC funding output not found")
    value_sat, spk_type = got
    if value_sat != trade["amount_btc_sat"]:
        return Result(False, f"BTC funding pays {value_sat}, reported {trade['amount_btc_sat']}")
    if spk_type != "v0_p2wsh":
        return Result(False, f"BTC funding is {spk_type}, not the P2WSH an HTLC uses")

    # Who, if anyone, has spent the BTC leg decides how much can be proven.
    # A spend by anything other than the named claim is a refund or an
    # unrelated spend, and neither is a trade.
    spender = _btc_spender(btc["funding_txid"], int(btc["funding_vout"]))
    if spender is not None:
        claim_txid = btc.get("claim_txid")
        if not isinstance(claim_txid, str) or spender.lower() != claim_txid.lower():
            return Result(
                False,
                f"BTC funding was spent by {spender}, not the reported claim — "
                f"a refund or an unrelated spend, not a trade",
            )

    fbc_out = _fbc_output(fbc["funding_txid"], int(fbc["funding_vout"]))
    if fbc_out is None:
        return Result(False, "FBC funding output not found")
    fbc_value, fbc_addr = fbc_out
    if len(fbc_addr) < 55:
        return Result(False, f"FBC funding pays {fbc_addr}, not the P2WSH an HTLC uses")
    if fbc_value != trade["amount_fbc_bumps"]:
        return Result(False, f"FBC funding pays {fbc_value}, reported {trade['amount_fbc_bumps']}")

    fbc_spend = _fbc_outspend(fbc["funding_txid"], int(fbc["funding_vout"]))
    if fbc_spend is None:
        return Result(False, "FBC funding output is still unspent")
    if fbc_spend.get("txid") != fbc["claim_txid"]:
        return Result(False, f"FBC funding was spent by {fbc_spend.get('txid')}, not the reported claim")

    preimage = _preimage_from_witness(fbc_spend.get("witness"))
    if not preimage:
        return Result(False, "FBC claim witness carries no preimage (a refund, not a claim)")

    fbc_status = fbc_spend.get("status") or {}
    if spender is None:
        return Result(
            True,
            reason="atomicity unproven: BTC leg still unspent, its hashlock unreadable",
            preimage=preimage,
            fbc_confirmed_height=fbc_status.get("block_height"),
        )

    # Case (b): the BTC claim is on chain, so its witness script is readable and
    # the same one-preimage-two-hashlocks proof `verify()` makes is available.
    # Doing it here rather than trusting the spend means a pending row is never
    # weaker than it needs to be.
    btc_witness = _btc_witness(claim_txid, btc["funding_txid"], int(btc["funding_vout"]))
    btc_preimage = _preimage_from_witness(btc_witness)
    if not btc_preimage:
        return Result(False, "BTC claim witness carries no preimage (a refund, not a claim)")
    if btc_preimage != preimage:
        return Result(False, "the two claims reveal different preimages — not one atomic swap")

    status = _get_json(f"{BTC_API}/tx/{claim_txid}/status") or {}
    return Result(
        True,
        reason="atomicity proven; awaiting burial depth",
        preimage=preimage,
        btc_confirmed_height=status.get("block_height"),
        fbc_confirmed_height=fbc_status.get("block_height"),
    )


def verify(trade: dict[str, Any]) -> Result:
    """
    Check one maker-reported trade against both chains.

    Raises Unverifiable when a chain could not be read — the caller must retry
    rather than record the trade as bogus. A node being down is not evidence.
    """
    btc = trade.get("btc") or {}
    fbc = trade.get("fbc") or {}
    # Both legs must be objects before anything calls .get on them.
    #
    # `{"btc": "x"}` makes `btc.get(...)` raise AttributeError, which is not an
    # Unverifiable and so escapes poll_once entirely — aborting the whole pass.
    # Makers are walked in sorted order, so one named early starves every maker
    # after it, on every cycle, indefinitely. That is a permissionless denial
    # of service on the price feed.
    #
    # trades.py already carries this lesson for `settled_at` ("One bad field
    # could take the price feed down permanently for everyone"). It was learned
    # for one field and not generalised; a leg is the other thing a stranger
    # gets to shape.
    if not isinstance(btc, dict) or not isinstance(fbc, dict):
        return Result(False, "btc and fbc must each be an object")
    for field, value in (
        ("btc.funding_txid", btc.get("funding_txid")),
        ("btc.claim_txid", btc.get("claim_txid")),
        ("fbc.funding_txid", fbc.get("funding_txid")),
        ("fbc.claim_txid", fbc.get("claim_txid")),
    ):
        if not isinstance(value, str) or len(value) != 64:
            return Result(False, f"{field} is not a txid")
        if not all(c in "0123456789abcdefABCDEF" for c in value):
            return Result(False, f"{field} is not hex")
    # Cast the vouts here rather than at the first use. `int(None)` and
    # `int("x")` raise, and every raise from this function is caught upstream as
    # Unverifiable — "we could not reach a chain" — so a malformed field would
    # be retried forever instead of being rejected once.
    for field, value in (("btc.funding_vout", btc.get("funding_vout")),
                         ("fbc.funding_vout", fbc.get("funding_vout"))):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0 or value > 100_000:
            return Result(False, f"{field} is not a vout")
    if not isinstance(trade.get("amount_btc_sat"), int) or trade["amount_btc_sat"] <= 0:
        return Result(False, "amount_btc_sat is not a positive integer")
    if not isinstance(trade.get("amount_fbc_bumps"), int) or trade["amount_fbc_bumps"] <= 0:
        return Result(False, "amount_fbc_bumps is not a positive integer")

    # 1. BTC funding pays what was claimed, into an HTLC-shaped output.
    got = _btc_output(btc["funding_txid"], int(btc["funding_vout"]))
    if got is None:
        return Result(False, "BTC funding output not found")
    value_sat, spk_type = got
    if value_sat != trade["amount_btc_sat"]:
        return Result(False, f"BTC funding pays {value_sat}, reported {trade['amount_btc_sat']}")
    if spk_type != "v0_p2wsh":
        return Result(False, f"BTC funding is {spk_type}, not the P2WSH an HTLC uses")

    # 2. …and was spent by the claim the maker named.
    spender = _btc_spender(btc["funding_txid"], int(btc["funding_vout"]))
    if spender is None:
        return Result(False, "BTC funding output is still unspent")
    if spender != btc["claim_txid"]:
        return Result(False, f"BTC funding was spent by {spender}, not the reported claim")

    # 3. FBC funding pays what was claimed.
    fbc_out = _fbc_output(fbc["funding_txid"], int(fbc["funding_vout"]))
    if fbc_out is None:
        return Result(False, "FBC funding output not found")
    fbc_value, fbc_addr = fbc_out
    # A P2WSH on FBC is a 32-byte witness program, which bech32-encodes to a
    # 62-character address. A 42-character one is P2WPKH — an ordinary payment,
    # not an HTLC.
    if len(fbc_addr) < 55:
        return Result(False, f"FBC funding pays {fbc_addr}, not the P2WSH an HTLC uses")
    if fbc_value != trade["amount_fbc_bumps"]:
        return Result(False, f"FBC funding pays {fbc_value}, reported {trade['amount_fbc_bumps']}")

    # 4. …and was spent by the claim the maker named.
    fbc_spend = _fbc_outspend(fbc["funding_txid"], int(fbc["funding_vout"]))
    if fbc_spend is None:
        return Result(False, "FBC funding output is still unspent")
    if fbc_spend.get("txid") != fbc["claim_txid"]:
        return Result(False, f"FBC funding was spent by {fbc_spend.get('txid')}, not the reported claim")

    # 5. The atomicity proof: one preimage, both chains.
    fbc_preimage = _preimage_from_witness(fbc_spend.get("witness"))
    if not fbc_preimage:
        return Result(False, "FBC claim witness carries no preimage (a refund, not a claim)")
    btc_witness = _btc_witness(
        btc["claim_txid"], btc["funding_txid"], int(btc["funding_vout"])
    )
    btc_preimage = _preimage_from_witness(btc_witness)
    if not btc_preimage:
        return Result(False, "BTC claim witness carries no preimage (a refund, not a claim)")
    if btc_preimage != fbc_preimage:
        return Result(False, "the two claims reveal different preimages — not one atomic swap")

    # Both claims must be MINED, not merely broadcast. Everything above is
    # equally true of a transaction sitting in a mempool, and an unconfirmed
    # spend can still be replaced, evicted, or reorged away — after which the
    # registry would be publishing, permanently, a trade that never happened.
    #
    # NotYetSettled rather than Result(False): a maker reporting a swap the
    # moment it broadcasts is early, and rejecting them is permanent.
    status = _get_json(f"{BTC_API}/tx/{btc['claim_txid']}/status") or {}
    fbc_status = fbc_spend.get("status") or {}
    btc_height = status.get("block_height")
    fbc_height = fbc_status.get("block_height")
    if not btc_height:
        raise NotYetSettled(f"BTC claim {btc['claim_txid'][:16]}… is not confirmed yet")
    if not fbc_height:
        raise NotYetSettled(f"FBC claim {fbc['claim_txid'][:16]}… is not confirmed yet")

    # And BURIED, not merely mined. A trade recorded at one confirmation is a
    # trade a one-block reorg can delete from the chain but not from here.
    btc_tip = _btc_tip()
    if btc_tip is not None:
        confs = btc_tip - int(btc_height) + 1
        if confs < BTC_BURIAL_CONFS:
            raise NotYetSettled(
                f"BTC claim has {confs} confirmation(s), needs {BTC_BURIAL_CONFS}"
            )
    fbc_confs = fbc_spend.get("confirmations")
    if isinstance(fbc_confs, int) and fbc_confs < FBC_BURIAL_CONFS:
        raise NotYetSettled(
            f"FBC claim has {fbc_confs} confirmation(s), needs {FBC_BURIAL_CONFS}"
        )

    # The settlement time comes from the block header, never from the maker.
    # `settled_at` is the field that decides the last price, the 24-hour
    # window and the VWAP, and it was the one thing in a "verified" trade still
    # taken on trust: a maker could report a genuine swap as settling in 2285
    # and own the headline price for the next 260 years.
    block_time = status.get("block_time")
    if not isinstance(block_time, (int, float)) or block_time <= 0:
        raise NotYetSettled(f"BTC claim {btc['claim_txid'][:16]}… has no block time yet")

    return Result(
        True,
        preimage=btc_preimage,
        btc_confirmed_height=btc_height,
        fbc_confirmed_height=fbc_height,
        settled_at_ms=int(block_time) * 1000,
    )

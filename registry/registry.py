#!/usr/bin/env python3
"""
Fistbump maker registry — discovery only, not a matching engine or custodian.

Makers POST heartbeats with their public base URL. The registry verifies
GET {url}/health (or /v1/status), then lists them until TTL expires.

  GET  /health
  GET  /v1/makers
  POST /v1/makers/announce

Announcing is authenticated by proof of control of the announced origin:
the maker publishes  announce_id = sha256(ANNOUNCE_TOKEN)  in its /health
document and sends the token itself in the X-Fistbump-Announce-Token header.
The digest is public and worthless on its own — only the holder of the
preimage can list or refresh a URL, so a stranger who reads someone else's
/health still cannot claim their origin. See README.md.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

try:
    from trades import TradeStore, poll_once, poll_pending
except ImportError:  # trade history is optional
    TradeStore = None  # type: ignore[assignment]
    poll_once = None  # type: ignore[assignment]
    poll_pending = None  # type: ignore[assignment]
try:
    from btc_proxy import BtcProxy, BtcUnavailable
except ImportError:  # BTC proxy is optional
    BtcProxy = None  # type: ignore[assignment]
    BtcUnavailable = Exception  # type: ignore[assignment,misc]

HOST = os.environ.get("REGISTRY_HOST", "127.0.0.1")
PORT = int(os.environ.get("REGISTRY_PORT", "8790"))
DATA_PATH = Path(os.environ.get("REGISTRY_DATA", "./data/makers.json"))
TTL_SEC = int(os.environ.get("REGISTRY_TTL_SEC", "90"))
VERIFY_TIMEOUT = float(os.environ.get("REGISTRY_VERIFY_TIMEOUT", "4"))
MAX_MAKERS = int(os.environ.get("REGISTRY_MAX_MAKERS", "200"))
# Slots one credential, and one source network, may hold at the same time.
# MAX_MAKERS on its own is not a defence: announce auth proves control of an
# origin, and one wildcard DNS record makes 200 origins (and 200 tokens) cost
# one domain. These caps make filling the table cost distinct source networks
# instead, and a full table evicts the least-recently-seen entry rather than
# refusing newcomers, so first-come is never permanent.
MAX_PER_CREDENTIAL = int(os.environ.get("REGISTRY_MAX_PER_CREDENTIAL", "4"))
MAX_PER_NETWORK = int(os.environ.get("REGISTRY_MAX_PER_NETWORK", "8"))
# Announces allowed to be verifying at once. Each one holds a worker thread on
# an outbound fetch, and ThreadingHTTPServer starts threads without any
# ceiling, so this is the only bound on how many of them can exist.
VERIFY_CONCURRENCY = int(os.environ.get("REGISTRY_VERIFY_CONCURRENCY", "16"))
# Verified trade history. Off unless a path is configured, so an operator who
# does not want the registry making outbound calls to makers on a timer simply
# does not set it.
TRADES_DB = os.environ.get("REGISTRY_TRADES_DB", "")
TRADES_POLL_SEC = int(os.environ.get("REGISTRY_TRADES_POLL_SEC", "300"))
# One pass over every maker, start to finish. Verification is several chain
# lookups per trade against third-party APIs, so this is generous.
TRADES_POLL_BUDGET_SEC = float(os.environ.get("REGISTRY_TRADES_BUDGET_SEC", "120"))
# Read-only BTC chain data from our own node, in Esplora's shape, so the swap UI
# does not depend on a third-party indexer for the taker's own transaction. Off
# unless an RPC URL is configured.
BTC_RPC_URL = os.environ.get("REGISTRY_BTC_RPC_URL", "")
BTC_RPC_USER = os.environ.get("REGISTRY_BTC_RPC_USER", "")
BTC_RPC_PASSWORD = os.environ.get("REGISTRY_BTC_RPC_PASSWORD", "")
# Off by default: an announce URL is chosen by an untrusted stranger, so
# allowing loopback turns the registry into a port scanner for whatever else
# runs on the host. Only set this to 1 on a dev box.
ALLOW_HTTP_LOCAL = os.environ.get("REGISTRY_ALLOW_HTTP_LOCAL", "0") == "1"
# Announce quota per source network, sliding window.
ANNOUNCE_QUOTA = int(os.environ.get("REGISTRY_ANNOUNCE_QUOTA", "20"))
ANNOUNCE_WINDOW_SEC = float(os.environ.get("REGISTRY_ANNOUNCE_WINDOW_SEC", "60"))
# Reverse proxies whose X-Forwarded-For we believe. Empty = trust nobody.
TRUSTED_PROXIES = [
    p.strip()
    for p in os.environ.get("REGISTRY_TRUSTED_PROXIES", "").split(",")
    if p.strip()
]
CORS = os.environ.get(
    "REGISTRY_CORS",
    "https://swap.fistbump.org,http://127.0.0.1:8766,http://localhost:8766",
).split(",")

TOKEN_HEADER = "X-Fistbump-Announce-Token"
MAX_BODY = 16_384
_MAX_HEALTH_BYTES = 65_536
_MAX_REDIRECTS = 2
_MAX_PINNED_ADDRS = 4
_LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")

_lock = threading.Lock()
# url -> record
_store: dict[str, dict[str, Any]] = {}

_rate_lock = threading.Lock()
# client network -> announce timestamps inside the current window
_announce_hits: dict[str, list[float]] = {}

# Held for the duration of one outbound /health verification.
_verify_slots = threading.BoundedSemaphore(VERIFY_CONCURRENCY)


class HttpError(Exception):
    """Announce failure that maps to a specific status code."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def _now() -> float:
    return time.time()


def _log(msg: str) -> None:
    # flush: stdout is a pipe under systemd, and these lines are the only place
    # the detail behind a generic client error survives.
    print(f"[registry] {msg}", flush=True)


def _load() -> None:
    global _store
    if not DATA_PATH.exists():
        _store = {}
        return
    try:
        data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
        raw = data.get("makers") or {}
    except Exception:
        _store = {}
        return
    # Records written before announce authentication carry no announce_id and
    # cannot be re-verified; drop them rather than serve unowned listings.
    # Reloaded records carry no client_net (it is never written, see _save), so
    # they count against no network's cap until they are refreshed or expire.
    _store = {
        u: r
        for u, r in raw.items()
        if isinstance(r, dict) and _is_announce_id(r.get("announce_id"))
    }


def _save() -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_PATH.with_suffix(".tmp")
    # client_net exists for the per-network cap on live entries and nothing
    # else, so it stays in memory: this file is a restart cache for listings
    # that expire in TTL_SEC, not a durable record of who announced from where.
    makers = {u: {k: v for k, v in r.items() if k != "client_net"} for u, r in _store.items()}
    payload = {"makers": makers, "updated_at": _now()}
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(DATA_PATH)


def _prune_locked() -> None:
    cutoff = _now() - TTL_SEC
    dead = [u for u, r in _store.items() if r.get("last_seen", 0) < cutoff]
    for u in dead:
        del _store[u]


def _normalize_url(raw: str) -> str:
    u = (raw or "").strip().rstrip("/")
    if not u:
        raise ValueError("url required")
    if not re.match(r"^https?://", u, re.I):
        u = "https://" + u
    parsed = urlparse(u)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("url must be http(s)")
    if parsed.scheme == "http":
        host = (parsed.hostname or "").lower()
        if not (ALLOW_HTTP_LOCAL and host in _LOCAL_HOSTS):
            raise ValueError("public makers must use https")
    if parsed.username or parsed.password:
        raise ValueError("url must not include credentials")
    try:
        parsed.port  # noqa: B018 — raises on a non-numeric port
    except ValueError:
        raise ValueError("url has an invalid port") from None
    # no path beyond root for base URL
    if parsed.path not in ("", "/"):
        raise ValueError("url must be origin only (no path), e.g. https://mm.example.com")
    # Canonicalise: the store key is what ownership pinning and MAX_MAKERS are
    # counted on, so "https://MM.Example.com", "https://mm.example.com" and
    # "https://mm.example.com:443" must not be three separate slots that one
    # token and one origin can all satisfy.
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").lower()
    if not host:
        raise ValueError("url must have a host")
    netloc = f"[{host}]" if ":" in host else host
    port = parsed.port
    if port is not None and port != (443 if scheme == "https" else 80):
        netloc = f"{netloc}:{port}"
    return f"{scheme}://{netloc}"


# ── Announce credential ───────────────────────────────────────────────────

_ANNOUNCE_ID_OK = re.compile(r"\A[0-9a-f]{64}\Z")


def _announce_id(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_announce_id(value: Any) -> bool:
    # Keeps hmac.compare_digest (ASCII-only) off any non-hex input.
    return isinstance(value, str) and bool(_ANNOUNCE_ID_OK.match(value))


def _check_token(token: str) -> None:
    if not token:
        raise HttpError(401, f"{TOKEN_HEADER} required")
    if not (16 <= len(token) <= 512) or not token.isascii() or not token.isprintable():
        raise HttpError(400, f"{TOKEN_HEADER} must be 16-512 printable ASCII chars")


# ── Outbound fetch (SSRF-hardened) ────────────────────────────────────────

# Ranges ipaddress does not already classify for us on every supported version.
_BLOCKED_NETS = [ipaddress.ip_network("100.64.0.0/10")]  # CGNAT / shared address space


def _check_addr(ip: Any, allow_local: bool) -> None:
    """Reject anything that is not a globally routable unicast address.

    The hostname comes from an untrusted announce, so "it resolved" is not
    enough: loopback, RFC1918, link-local (169.254.169.254 metadata services),
    CGNAT and reserved space are all reachable from the production host and
    none of them can legitimately host a public maker.
    """
    if isinstance(ip, ipaddress.IPv6Address):
        # 4-in-6 forms smuggle an arbitrary v4 destination past a v6-only check,
        # so the embedded address must pass too. Note "as well as", not "instead
        # of": returning here would skip the checks on the v6 address actually
        # being connected to, which lets e.g. a Teredo address whose embedded
        # client is global through despite being private itself.
        teredo = ip.teredo
        for embedded in (ip.ipv4_mapped, ip.sixtofour, teredo[1] if teredo else None):
            if embedded is not None:
                _check_addr(embedded, allow_local)
    if allow_local and ip.is_loopback:
        return
    blocked = any(net.version == ip.version and ip in net for net in _BLOCKED_NETS)
    if blocked or not ip.is_global or ip.is_multicast or ip.is_reserved:
        raise ValueError("maker url must resolve to a public address")


def _resolve_pinned(host: str, port: int, allow_local: bool) -> list[str]:
    """Resolve host ourselves and return the vetted addresses to connect to.

    Every answer must pass, and the caller connects only to these literals:
    that closes the DNS-rebinding window between our check and the connect.
    All of them are returned, not just the first, because a dual-stack maker
    whose first record is unreachable (no v6 route out, one host down) is a
    working maker that would otherwise fail verification forever.
    """
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ValueError("maker url does not resolve") from None
    pinned: list[str] = []
    for family, _type, _proto, _canon, sockaddr in infos:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(str(sockaddr[0]).split("%", 1)[0])
        # Checked before the candidate cap below: a rejected answer must fail
        # the announce, never merely fall off the end of the candidate list.
        _check_addr(ip, allow_local)
        text = str(ip)
        if text not in pinned and len(pinned) < _MAX_PINNED_ADDRS:
            pinned.append(text)
    if not pinned:
        raise ValueError("maker url does not resolve")
    return pinned


def _connect_pinned(ips: list[str], port: int, timeout: float, deadline: float) -> socket.socket:
    """Connect to the first vetted address that answers, within the budget.

    Each attempt is re-bounded by what is left of the shared verify deadline,
    so falling back across addresses cannot multiply what one announce costs.
    """
    last: OSError | None = None
    for ip in ips:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            return socket.create_connection((ip, port), min(timeout, remaining))
        except OSError as e:
            last = e
    if last is not None:
        raise last
    raise OSError("verification budget exhausted")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, ips: list[str], timeout: float, deadline: float):
        super().__init__(host, port, timeout=timeout)
        self._pinned_ips = ips
        self._deadline = deadline

    def connect(self) -> None:
        self.sock = _connect_pinned(self._pinned_ips, self.port, self.timeout, self._deadline)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, ips: list[str], timeout: float, deadline: float):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._pinned_ips = ips
        self._deadline = deadline

    def connect(self) -> None:
        # Assign before wrapping so the deadline watchdog, which aborts
        # whatever is currently in self.sock, can also cut short a TLS
        # handshake whose records are being dribbled out one at a time.
        self.sock = _connect_pinned(self._pinned_ips, self.port, self.timeout, self._deadline)
        # SNI and certificate validation still use the announced hostname, so
        # pinning the address does not weaken TLS.
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


class _AbortGuard:
    """Force one outbound fetch to stop when the shared verify budget is spent.

    A socket timeout is per-recv, so a maker that sends one byte every second
    never trips VERIFY_TIMEOUT on any single read and keeps the worker thread
    for as long as it likes; the deadline checked between hops never gets a
    chance to run. Shutting the socket down is the only thing that ends a
    trickle, so a watchdog thread does it once the deadline passes.

    It keeps shutting down until the fetch returns, because connect() swaps
    self.sock (raw socket, then the TLS wrapper) and a single shutdown could
    land on the object being replaced.
    """

    def __init__(self, conn: http.client.HTTPConnection, deadline: float) -> None:
        self._conn = conn
        self._deadline = deadline
        self._done = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while True:
            remaining = self._deadline - time.monotonic()
            if self._done.wait(remaining if remaining > 0 else 0.25):
                return
            if time.monotonic() < self._deadline:
                continue
            sock = self._conn.sock
            if sock is None:
                continue
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # already closed, or closed under us — nothing left to stop

    def __enter__(self) -> "_AbortGuard":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._done.set()
        self._thread.join(1.0)


def _origin_key(scheme: str, host: str, port: int) -> str:
    return f"{scheme}://{host}:{port}"


def _fetch_json(url: str, deadline: float, origin: str) -> dict[str, Any]:
    """GET url over a connection pinned to a pre-validated public address.

    Redirects are followed at most _MAX_REDIRECTS times and must stay on
    `origin`: the document the announce credential is read out of has to be
    served by the origin being claimed, or control of a redirect target would
    be accepted as proof of control of the announced host. Each hop is still
    resolved and re-validated from scratch, because the name can resolve
    somewhere else — 127.0.0.1, a metadata service — the second time round.

    `deadline` is an absolute monotonic time shared across the whole verify,
    not a per-request timeout: two paths, three hops each, up to four addresses
    per hop, all of them stalling at times the announcer picks. _AbortGuard is
    what makes the budget bind on a peer that keeps the socket busy rather than
    idle, since a socket timeout alone never fires against a trickle.
    """
    target = url
    for _hop in range(_MAX_REDIRECTS + 1):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("verification budget exhausted")
        parsed = urlparse(target)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower()
        if scheme not in ("http", "https") or not host:
            raise ValueError("maker url must be http(s)")
        local = ALLOW_HTTP_LOCAL and host in _LOCAL_HOSTS
        if scheme == "http" and not local:
            raise ValueError("public makers must use https")
        port = parsed.port or (443 if scheme == "https" else 80)
        if _origin_key(scheme, host, port) != origin:
            raise ValueError("health redirected off the announced origin")
        ips = _resolve_pinned(host, port, local)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        if scheme == "https":
            conn: http.client.HTTPConnection = _PinnedHTTPSConnection(
                host, port, ips, min(VERIFY_TIMEOUT, remaining), deadline
            )
        else:
            conn = _PinnedHTTPConnection(
                host, port, ips, min(VERIFY_TIMEOUT, remaining), deadline
            )
        try:
            with _AbortGuard(conn, deadline):
                conn.request(
                    "GET",
                    path,
                    headers={
                        "User-Agent": "fistbump-maker-registry/1",
                        "Accept": "application/json",
                        "Connection": "close",
                    },
                )
                resp = conn.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    location = resp.getheader("Location") or ""
                    if not location:
                        raise ValueError("redirect without Location")
                    target = urljoin(target, location)
                    continue
                if resp.status != 200:
                    raise ValueError(f"health returned HTTP {resp.status}")
                data = json.loads(resp.read(_MAX_HEALTH_BYTES).decode("utf-8"))
        finally:
            conn.close()
        if not isinstance(data, dict):
            raise ValueError("health must be a JSON object")
        return data
    raise ValueError("too many redirects")


def _verify_maker(base: str) -> dict[str, Any]:
    """Fetch /health or /v1/status; return the parsed JSON document."""
    # One budget for the whole verification, shared across both paths and every
    # redirect hop, so an announce cannot tie up a thread indefinitely.
    deadline = time.monotonic() + VERIFY_TIMEOUT * 2
    # base is already canonical (_normalize_url), so this is the origin whose
    # control the announce claims; nothing outside it may answer for it.
    parsed = urlparse(base)
    scheme = parsed.scheme.lower()
    origin = _origin_key(
        scheme,
        (parsed.hostname or "").lower(),
        parsed.port or (443 if scheme == "https" else 80),
    )
    for path in ("/health", "/v1/status"):
        try:
            return _fetch_json(base + path, deadline, origin)
        except Exception as e:  # noqa: BLE001 — log detail, try next path
            # The caller is a stranger: a specific error ("connection refused"
            # vs "not JSON") tells them what is listening where. Log it here,
            # return one flat message below.
            _log(f"verify {base}{path} failed: {e!r}")
            continue
    raise ValueError("could not verify maker /health")


# ── Announce field hygiene ────────────────────────────────────────────────

# C0/C1 controls plus the bidi overrides, which can visually reorder a name.
_CONTROL_CHARS = re.compile("[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]")
# The UI prints note where the maker's host would go, so a note that can look
# like a domain lets one maker impersonate another's origin. Plain words only:
# no dot, slash, colon, @ or non-ASCII homoglyphs.
_NOTE_OK = re.compile(r"\A[A-Za-z0-9 '&()+,!?_-]{0,80}\Z")
# name sits in the same maker card, one line above note, so a name that reads
# as a domain impersonates an origin exactly as a note would. Same charset,
# same reason. The one hostname a maker may call itself is its own, which the
# announce has just proved control of — that is also the name a maker that
# sends none is given.
_NAME_OK = re.compile(r"\A[A-Za-z0-9 '&()+,!?_-]{1,64}\Z")
_PROTOCOL_OK = re.compile(r"\A[A-Za-z0-9._/+-]{1,64}\Z")
_SIDE_OK = re.compile(r"\A[a-z_]{1,24}\Z")
_LIQUIDITY = ("fbc", "btc", "both")


def _clean_text(raw: str, limit: int) -> str:
    return _CONTROL_CHARS.sub("", raw).strip()[:limit]


def _num(value: Any, lo: float, hi: float) -> float | None:
    """Accept a finite in-range JSON number, else None — maker /health is
    untrusted input that we re-serve to every visitor."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    if not math.isfinite(f) or f < lo or f > hi:
        return None
    return f


def _clean_status(health: dict[str, Any]) -> dict[str, Any]:
    liquidity = health.get("liquidity")
    return {
        "liquidity": liquidity if liquidity in _LIQUIDITY else None,
        "mid_fbc_per_btc": _num(health.get("mid_fbc_per_btc"), 1e-9, 1e12),
        "spread_bps": _num(health.get("spread_bps"), 0, 10_000),
        "max_fbc": _num(health.get("max_fbc"), 0, 1e15),
    }


def _list_makers() -> list[dict[str, Any]]:
    with _lock:
        _prune_locked()
        out = []
        for url, rec in _store.items():
            out.append(
                {
                    "name": rec.get("name") or url,
                    "url": url,
                    # What a TAKER can ask this maker for. `Side` is defined
                    # from the taker's view — buy_fbc means the taker pays BTC
                    # — so a bare `side` on a maker record reads as the exact
                    # opposite of the truth: a maker listed as "buy_fbc" SELLS
                    # FBC. The perspective is in the name now.
                    "taker_sides": rec.get("taker_sides") or rec.get("side") or ["buy_fbc"],
                    "note": rec.get("note") or "",
                    "protocol": rec.get("protocol") or "fistbump-swap-mm/v1",
                    "last_seen": rec.get("last_seen"),
                    "status": rec.get("status") or {},
                }
            )
        out.sort(key=lambda m: (m["name"].lower(), m["url"]))
        return out


def _net_key(client_ip: str) -> str:
    """The source network an announce came from: /24 for v4, /48 for v6.

    Per-address accounting is worthless against anyone holding a v6 prefix —
    a /64 is one allocation and rotating inside it is free — so both the quota
    and the occupancy cap are counted per network. It is also the only form of
    the announcer's address the registry keeps.
    """
    try:
        ip = ipaddress.ip_address(client_ip)
    except ValueError:
        return client_ip
    # Unwrap 4-in-6 exactly as _check_addr does. Without this, a dual-stack
    # listener or a proxy writing ::ffff:a.b.c.d collapses every IPv4 announcer
    # on earth into a single ::/48 bucket — one quota and one occupancy cap
    # between all of them — and the attribution warning does not catch it,
    # because ::ffff:8.8.8.8 still reports is_global True.
    if isinstance(ip, ipaddress.IPv6Address):
        teredo = ip.teredo
        for embedded in (ip.ipv4_mapped, ip.sixtofour, teredo[1] if teredo else None):
            if embedded is not None:
                ip = embedded
                break
    return str(ipaddress.ip_network(f"{ip}/{24 if ip.version == 4 else 48}", strict=False))


def _quota_ok(client_net: str) -> bool:
    now = _now()
    cutoff = now - ANNOUNCE_WINDOW_SEC
    with _rate_lock:
        for net in [n for n, hits in _announce_hits.items() if not hits or hits[-1] < cutoff]:
            del _announce_hits[net]
        hits = [t for t in _announce_hits.get(client_net, []) if t >= cutoff]
        if len(hits) >= ANNOUNCE_QUOTA:
            _announce_hits[client_net] = hits
            return False
        if client_net not in _announce_hits and len(_announce_hits) >= 8192:
            return False
        hits.append(now)
        _announce_hits[client_net] = hits
        return True


def _check_pin_locked(url: str, announce_id: str) -> None:
    """Refuse an announce for a url a different credential already holds.

    A live listing is never rebound to another credential, so a stranger cannot
    take over a maker's entry. Checked before the outbound fetch to keep the
    refusal cheap, and again after it, because the table moves while we fetch.
    Call under _lock.
    """
    existing = _store.get(url)
    if existing is None:
        return
    stored_id = existing.get("announce_id")
    if not (_is_announce_id(stored_id) and hmac.compare_digest(str(stored_id), announce_id)):
        raise HttpError(403, "url is claimed by a different announce token")


def _check_caps_locked(url: str, announce_id: str, client_net: str) -> None:
    """Refuse an announce that would hand one announcer more than its share.

    Announce auth proves control of an origin, and origins are cheap: one
    wildcard record and one token per name fills MAX_MAKERS from a single host.
    Capping per credential and per source network means occupying the table
    costs addresses in that many distinct networks instead. Call under _lock.
    """
    per_credential = 0
    per_network = 0
    for stored_url, rec in _store.items():
        if stored_url == url:
            continue  # this slot is replaced, not added, if the announce lands
        if rec.get("announce_id") == announce_id:
            per_credential += 1
        if client_net and rec.get("client_net") == client_net:
            per_network += 1
    if per_credential >= MAX_PER_CREDENTIAL:
        raise HttpError(429, f"one announce token may list at most {MAX_PER_CREDENTIAL} urls")
    if per_network >= MAX_PER_NETWORK:
        raise HttpError(429, f"one source network may list at most {MAX_PER_NETWORK} urls")


_warned_attribution = False


def _warn_attribution_once(client_ip: str) -> None:
    """Say something the first time an announce is attributed to a local address.

    Behind a reverse proxy with REGISTRY_TRUSTED_PROXIES unset or wrong, every
    announce looks like it came from the proxy itself, and then the quota and
    the per-network cap are shared by every maker on earth instead of applying
    per announcer. That failure is silent otherwise: announces keep working
    until the table hits MAX_PER_NETWORK and stops.
    """
    global _warned_attribution
    if _warned_attribution:
        return
    try:
        ip = ipaddress.ip_address(client_ip)
    except ValueError:
        return
    if ip.is_global:
        return
    _warned_attribution = True
    _log(
        f"attribution warning: announce attributed to {client_ip}, which is not a public "
        "address. If a reverse proxy fronts this registry, REGISTRY_TRUSTED_PROXIES must "
        "list the address it connects from, or every maker shares one quota and one "
        "per-network slot cap."
    )


def _is_own_host(raw_name: str, url: str) -> bool:
    """True when `raw_name` is just the announced origin's host, however written.

    Compares HOSTS, not URLs: the reference bot's default name is PUBLIC_URL
    with the scheme stripped, so it carries no scheme of its own and must not be
    re-inferred as one. Accepts a trailing slash, a redundant default port, and
    any casing — the shapes that actually come out of
    the bot stripping the scheme off PUBLIC_URL.
    """
    candidate = raw_name.strip().rstrip("/").lower()
    if not candidate:
        return False
    candidate = re.sub(r"^https?://", "", candidate)
    own = urlparse(url).netloc  # already canonical: lowercased, default port dropped
    if candidate == own:
        return True
    # The bot may keep an explicit default port that _normalize_url dropped.
    scheme = urlparse(url).scheme
    default_port = ":443" if scheme == "https" else ":80"
    return candidate == own + default_port


def _announce(body: dict[str, Any], client_ip: str, token: str) -> dict[str, Any]:
    _check_token(token)
    url = _normalize_url(str(body.get("url") or ""))
    own_host = urlparse(url).netloc  # already lowercased by _normalize_url
    raw_name = str(body.get("name") or "")
    name = _clean_text(raw_name, 64)
    # Checked against the RAW name, not the cleaned one. The reference bot
    # derives its default from PUBLIC_URL without canonicalising, so a host
    # longer than 64 chars, carrying an explicit :443, or written with a
    # capitalised scheme gets truncated or altered here and then fails the
    # pattern — leaving a correctly-configured maker unable to list at all,
    # with nothing but a 400 and exponential backoff to show for it.
    if raw_name and _is_own_host(raw_name, url):
        name = own_host  # store the canonical form of the host it just proved
    elif name and not _NAME_OK.match(name):
        raise ValueError(
            "name must be <=64 chars of plain text (letters, digits, spaces, "
            "'&()+,!?_- ) or the announced host itself; it may not look like "
            "some other hostname"
        )
    name = name or own_host
    # Accept either key. A maker announcing `taker_sides` is speaking the
    # current protocol; `side` is what older ones send.
    side = body.get("taker_sides") or body.get("side") or ["buy_fbc"]
    if isinstance(side, str):
        side = [side]
    if not isinstance(side, list) or not side:
        side = ["buy_fbc"]
    side = [str(s) for s in side][:4]
    if not all(_SIDE_OK.match(s) for s in side):
        raise ValueError("side entries must be lowercase identifiers, e.g. buy_fbc")
    note = str(body.get("note") or "")
    if not _NOTE_OK.match(note):
        raise ValueError(
            "note must be <=80 chars of plain text (letters, digits, spaces, "
            "'&()+,!?_- ); it may not look like a hostname"
        )
    protocol = str(body.get("protocol") or "fistbump-swap-mm/v1")
    if not _PROTOCOL_OK.match(protocol):
        raise ValueError("protocol must match [A-Za-z0-9._/+-]{1,64}")

    announce_id = _announce_id(token)
    client_net = _net_key(client_ip)
    with _lock:
        _prune_locked()
        # Ownership before occupancy, so a refusal names the real reason rather
        # than a cap the announcer could not have done anything about.
        _check_pin_locked(url, announce_id)
        _check_caps_locked(url, announce_id, client_net)

    if not _verify_slots.acquire(blocking=False):
        # Every verify parks this thread on a fetch to an address the announcer
        # chose, and ThreadingHTTPServer will start a thread per request with no
        # ceiling. Shedding here is what stops a pile of slow makers from
        # becoming an unbounded pile of threads.
        raise HttpError(503, "registry busy verifying, retry shortly")
    try:
        health = _verify_maker(url)
    finally:
        _verify_slots.release()
    published = health.get("announce_id")
    published = published.strip().lower() if isinstance(published, str) else ""
    if not _is_announce_id(published) or not hmac.compare_digest(published, announce_id):
        raise HttpError(
            403,
            "maker /health must publish announce_id = sha256(announce token) hex",
        )

    with _lock:
        _prune_locked()
        _check_pin_locked(url, announce_id)
        _check_caps_locked(url, announce_id, client_net)
        if url not in _store and len(_store) >= MAX_MAKERS:
            # Evict the least-recently-seen entry instead of refusing. Refusing
            # made a full table permanent for everyone except its occupants: no
            # honest maker could ever list, and whoever filled it kept it by
            # heartbeating. The caps above are what stop eviction becoming the
            # same weapon in reverse — one network holds at most
            # MAX_PER_NETWORK slots, so it can force at most that many
            # evictions per TTL, and each evicted maker re-lists on its next
            # heartbeat.
            victim = min(_store.items(), key=lambda kv: (kv[1].get("last_seen", 0), kv[0]))[0]
            _log(f"registry full ({MAX_MAKERS}); evicting least-recently-seen {victim}")
            del _store[victim]
        _store[url] = {
            "name": name,
            "url": url,
            "taker_sides": side,
            "note": note,
            "protocol": protocol,
            "last_seen": _now(),
            "client_net": client_net,
            "announce_id": announce_id,
            "status": _clean_status(health),
        }
        _save()
        rec = _store[url]

    return {
        "ok": True,
        "url": rec["url"],
        "name": rec["name"],
        "ttl_sec": TTL_SEC,
        "expires_in": TTL_SEC,
    }


def _is_trusted_proxy(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    for entry in TRUSTED_PROXIES:
        try:
            net = ipaddress.ip_network(entry, strict=False)
        except ValueError:
            continue
        if net.version == ip.version and ip in net:
            return True
    return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Socket timeout for the inbound side. ThreadingHTTPServer keeps a thread
    # per connection with no ceiling, and HTTP/1.1 keep-alive means an idle
    # client holds one indefinitely without this. It bounds a stall between
    # reads, not the total connection: a client that dribbles bytes can still
    # stretch a request out, though only over the MAX_BODY it is allowed to send.
    timeout = 15

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[registry] {self.address_string()} {fmt % args}")

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        allowed = [o.strip() for o in CORS if o.strip()]
        if origin and origin in allowed:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        elif "*" in allowed:
            self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Deliberately does NOT list TOKEN_HEADER: announce is a server-to-server
        # call, and leaving the header un-allowed means no browser page — even on
        # an allowed origin — can preflight its way into announcing.
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code: int, obj: Any) -> None:
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _text(self, code: int, body: str) -> None:
        """Esplora serves /blocks/tip/height as a bare number, not JSON."""
        raw = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        if self.close_connection:
            self.send_header("Connection", "close")
        self._cors()
        self.end_headers()
        self.wfile.write(raw)

    def _client_ip(self) -> str:
        """Peer address, or the address a trusted proxy observed.

        X-Forwarded-For is client-writable: Apache appends to whatever the
        client sent, so the left-most hop is forged input. Walk right-to-left
        and take the first hop that is not itself a configured proxy.
        """
        peer = self.client_address[0]
        if not _is_trusted_proxy(peer):
            return peer
        hops = [h.strip() for h in (self.headers.get("X-Forwarded-For") or "").split(",")]
        for hop in reversed([h for h in hops if h]):
            try:
                addr = str(ipaddress.ip_address(hop))
            except ValueError:
                break
            if not _is_trusted_proxy(addr):
                return addr
        return peer

    def _read_body(self) -> bytes | None:
        """
        Consume this request's body, or refuse it.

        Every verb must call this before responding. A body we never read stays
        in the socket, and on a keep-alive connection the next parse treats it
        as a request line — request smuggling. GET is not exempt: Apache's
        mod_proxy forwards GET bodies, and a `GET` with a `Content-Length` and
        a second request in the body produced two responses on one socket.

        Returns the body, or None if a refusal has already been written and the
        caller should stop.
        """
        if (self.headers.get("Transfer-Encoding") or "").strip():
            self.close_connection = True
            self._json(411, {"error": "content-length required"})
            return None
        declared = (self.headers.get("Content-Length") or "0").strip()
        # Bare int() would accept "+16", "1_6" and surrounding whitespace. For a
        # check whose whole job is agreeing with the front-end proxy on framing,
        # it has to be the same grammar the proxy used.
        if not re.fullmatch(r"[0-9]+", declared):
            self.close_connection = True
            self._json(400, {"error": "bad content-length"})
            return None
        length = int(declared)
        if length > MAX_BODY:
            self.close_connection = True
            self._json(413, {"error": "body too large"})
            return None
        raw = self.rfile.read(length) if length else b""
        if len(raw) < length:
            self.close_connection = True
        return raw

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self._read_body() is None:
            return
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self._read_body() is None:
            return
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        if path in ("/health", ""):
            self._json(200, {"ok": True, "service": "fistbump-maker-registry"})
            return
        if path == "/v1/makers":
            self._json(
                200,
                {
                    "protocol": "fistbump-swap-mm/v1",
                    "ttl_sec": TTL_SEC,
                    "makers": _list_makers(),
                },
            )
            return
        if path.startswith("/btc/"):
            if _btc is None:
                self._json(503, {"error": "btc proxy is not enabled on this registry"})
                return
            try:
                if path == "/btc/blocks/tip/height":
                    self._text(200, str(_btc.tip_height()))
                    return
                if path == "/btc/fee-estimates":
                    self._json(200, _btc.fee_estimates())
                    return
                m = re.fullmatch(r"/btc/tx/([0-9a-fA-F]{64})", path)
                if m:
                    tx = _btc.tx(m.group(1).lower())
                    self._json(200, tx) if tx else self._json(404, {"error": "not found"})
                    return
                m = re.fullmatch(r"/btc/tx/([0-9a-fA-F]{64})/status", path)
                if m:
                    st = _btc.tx_status(m.group(1).lower())
                    self._json(200, st) if st else self._json(404, {"error": "not found"})
                    return
                m = re.fullmatch(r"/btc/tx/([0-9a-fA-F]{64})/outspend/(\d{1,5})", path)
                if m:
                    self._json(200, _btc.outspend(m.group(1).lower(), int(m.group(2))))
                    return
            except BtcUnavailable as e:
                # 503, never 404: "our node is unwell" and "no such transaction"
                # must be distinguishable, or a caller falls back when it should
                # retry, or gives up when it should fall back.
                self._json(503, {"error": f"btc node unavailable: {e}"})
                return
            self._json(404, {"error": "not found"})
            return
        if path in ("/v1/trades", "/v1/price"):
            if _trade_store is None:
                self._json(503, {"error": "trade history is not enabled on this registry"})
                return
            if path == "/v1/price":
                self._json(200, _trade_store.summary())
            else:
                q = self.path.split("?", 1)
                params = {}
                if len(q) > 1:
                    for pair in q[1].split("&"):
                        k, _, v = pair.partition("=")
                        params[k] = v
                try:
                    limit = int(params.get("limit", "50"))
                    since = int(params.get("since", "0"))
                except ValueError:
                    self._json(400, {"error": "limit and since must be integers"})
                    return
                with _pending_lock:
                    pending = list(_pending)
                settled = _trade_store.recent(limit=limit, since=since)
                # A swap can be in both lists for one poll cycle if it settles
                # between the two passes. Settled wins — it is the stronger
                # claim, and showing the same swap twice reads as two trades.
                done_ids = {t.get("swap_id") for t in settled}
                self._json(200, {
                    "trades": settled,
                    # Separate key, never merged into `trades`. A consumer that
                    # does not know about pending rows keeps working and keeps
                    # showing only fully-verified swaps.
                    "pending": [p for p in pending if p["swap_id"] not in done_ids],
                })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0].rstrip("/") or "/"
        raw = self._read_body()
        if raw is None:
            return
        if path == "/btc/tx":
            # Broadcast. The only write in the proxy, and it cannot express
            # anything except "relay this transaction" — a raw hex blob is not
            # an RPC method name.
            if _btc is None:
                self._json(503, {"error": "btc proxy is not enabled on this registry"})
                return
            # _read_body returns BYTES. Matching a str pattern against them
            # raises TypeError before the transaction reaches bitcoind, so this
            # endpoint answered 502 to every broadcast from the day it shipped.
            # It went unnoticed because btcFetch treats 5xx as "try the next
            # source": the browser fell back to blockstream and broadcasts kept
            # working, they simply never used our node.
            try:
                body = raw.decode("ascii").strip()
            except (UnicodeDecodeError, AttributeError):
                self._json(400, {"error": "body must be a raw transaction in hex"})
                return
            if not re.fullmatch(r"[0-9a-fA-F]{40,400000}", body):
                self._json(400, {"error": "body must be a raw transaction in hex"})
                return
            try:
                self._text(200, _btc.broadcast(body.lower()))
            except BtcUnavailable as e:
                # bitcoind's rejection reason is the useful part — "min relay fee
                # not met", "missing inputs" — and it says nothing private.
                self._json(400, {"error": str(e)})
            return
        if path != "/v1/makers/announce":
            self._json(404, {"error": "not found"})
            return

        client = self._client_ip()
        _warn_attribution_once(client)
        if not _quota_ok(_net_key(client)):
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            body = json.dumps({"error": "too many announces"}).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Retry-After", str(int(ANNOUNCE_WINDOW_SEC)))
            self.send_header("Cache-Control", "no-store")
            self._cors()
            self.end_headers()
            self.wfile.write(body)
            return
        try:
            body_obj = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._json(400, {"error": "invalid JSON"})
            return
        if not isinstance(body_obj, dict):
            self._json(400, {"error": "body must be object"})
            return
        try:
            result = _announce(body_obj, client, self.headers.get(TOKEN_HEADER, "").strip())
            self._json(200, result)
        except HttpError as e:
            self._json(e.code, {"error": str(e)})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            _log(f"announce error: {e!r}")
            self._json(500, {"error": "internal error"})


_trade_store: Any = None
_btc: Any = None
# Swaps mid-settlement, rebuilt from scratch on every poll. Held in memory
# rather than the TradeStore on purpose: these are unproven in one specific way
# (the BTC leg is unspent, so its hashlock cannot be matched against the FBC
# leg's), and keeping them out of the database is what guarantees they can
# never reach /v1/price. See verify_trade.verify_pending.
_pending: list = []
_pending_lock = threading.Lock()


def _maker_origin(base: str) -> str:
    parsed = urlparse(base)
    scheme = parsed.scheme.lower()
    return _origin_key(
        scheme,
        (parsed.hostname or "").lower(),
        parsed.port or (443 if scheme == "https" else 80),
    )


def _trades_poll_loop() -> None:
    """
    Collect and verify settled swaps from every live maker, forever.

    Deliberately reuses `_fetch_json`, the same SSRF-pinned fetcher the announce
    path uses. A maker URL is a stranger's string; a second, more relaxed way to
    make outbound requests would be a way around every check on the first.
    """
    # A short delay before the first pass, not a full interval: makers have to
    # announce before there is anything to poll (TTL_SEC), but waiting the whole
    # period would leave /v1/price empty for five minutes after every restart.
    time.sleep(min(20, TRADES_POLL_SEC))
    while True:
        try:
            makers = _list_makers()
            if not makers:
                # `continue` here skipped the sleep at the bottom of the loop
                # and spun the thread — on the box that also runs bitcoind and
                # fbd, entered by any gap in maker heartbeats.
                time.sleep(TRADES_POLL_SEC)
                continue
            deadline = time.monotonic() + TRADES_POLL_BUDGET_SEC

            def fetch(url: str, base: str) -> dict[str, Any]:
                return _fetch_json(url, deadline, _maker_origin(base))

            stats = poll_once(_trade_store, makers, fetch, log=print)
            if stats["accepted"] or stats["rejected"]:
                print(f"[trades] {stats}")
            # After the settled pass, so a swap that just reached burial depth
            # is a confirmed trade rather than appearing in both lists.
            try:
                fresh = poll_pending(makers, fetch, log=print)
            except Exception as e:  # noqa: BLE001 — never at the cost of the settled feed
                print(f"[pending] poll failed: {e}")
            else:
                with _pending_lock:
                    global _pending
                    _pending = fresh
        except Exception as e:  # noqa: BLE001 — a poll failing must not end the thread
            print(f"[trades] poll failed: {e}")
        time.sleep(TRADES_POLL_SEC)


def main() -> None:
    _load()
    with _lock:
        _prune_locked()
    global _trade_store, _btc
    if BTC_RPC_URL and BtcProxy is not None:
        _btc = BtcProxy(BTC_RPC_URL, BTC_RPC_USER, BTC_RPC_PASSWORD)
        try:
            print(f"[registry] btc proxy on, node at height {_btc.tip_height()}")
        except Exception as e:  # noqa: BLE001 — starting without it is allowed
            print(f"[registry] btc proxy configured but node unreachable: {e}")
    else:
        print("[registry] btc proxy off (set REGISTRY_BTC_RPC_URL to enable)")
    if TRADES_DB and TradeStore is not None:
        _trade_store = TradeStore(Path(TRADES_DB))
        threading.Thread(target=_trades_poll_loop, daemon=True).start()
        print(f"[registry] trade history on, polling every {TRADES_POLL_SEC}s -> {TRADES_DB}")
    else:
        print("[registry] trade history off (set REGISTRY_TRADES_DB to enable)")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[registry] listening on http://{HOST}:{PORT}  ttl={TTL_SEC}s  data={DATA_PATH}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

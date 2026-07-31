# Maker registry

Public **discovery** for market makers. Not custody, not matching.

- Makers `POST /v1/makers/announce` with their public base URL (heartbeat).
- Registry verifies `GET {url}/health` (or `/v1/status`).
- UI `GET /v1/makers` for the live list.
- Entries expire after TTL (~90s) without heartbeat.

## Announce credential

The Auto UI auto-selects the best-priced maker for people who have never seen
this page before, so anyone who can get listed is trusted with real money.
Announcing therefore requires **proof of control of the origin you claim**:

1. The maker operator picks a secret, `ANNOUNCE_TOKEN` (>=16 printable ASCII
   chars; 32+ random ones is the sane default).
2. The maker publishes the **digest** in its `/health` (and `/v1/status`) body:

   ```json
   { "announce_id": "<sha256(ANNOUNCE_TOKEN) as lowercase hex>" }
   ```

3. The announce request carries the **preimage** in a header:

   ```
   X-Fistbump-Announce-Token: <ANNOUNCE_TOKEN>
   ```

The registry recomputes `sha256(token)` and requires it to equal the
`announce_id` served by the URL being claimed. The digest is public, so
publishing it costs the maker nothing; the preimage never leaves the maker and
the registry, so a stranger who reads someone else's `/health` still cannot
announce their URL.

Additional rules:

- A URL that is already listed is **pinned to the credential that listed it**.
  An announce for that URL with a different token is rejected `403` without
  the registry ever fetching `/health`, so a live maker cannot be taken over
  or re-pointed mid-TTL.
- Rotating a token means the old entry keeps serving until it expires (TTL,
  ~90s), then the next announce re-claims the URL. There is no delete verb.
- `announce_id` is only ever read from the **origin being claimed**. Redirects
  are followed (up to 2) but must stay on that scheme/host/port: honouring an
  off-origin redirect would accept control of the redirect target as proof of
  control of the announced host, so `https://mm.example.com` redirecting
  `/health` to `https://attacker.example/health` is refused.
- Failure is always closed: no header, malformed token, unreachable `/health`,
  missing or mismatched `announce_id` → not listed. Nothing is listed on the
  strength of the announce body alone.
- `X-Fistbump-Announce-Token` is not a CORS-safelisted header and is
  deliberately **not** in `Access-Control-Allow-Headers`, so the preflight for
  it fails from every origin. A web page cannot drive a visitor's browser into
  announcing, not even from an allowed origin.

### What the reference bot must send

`bot/src/announce.ts` needs one new config value, `ANNOUNCE_TOKEN`
(`envOpt("ANNOUNCE_TOKEN", "")` — skip announcing with a warning when empty,
same as a missing `PUBLIC_URL`), and two changes:

```ts
// 1. POST /v1/makers/announce — unchanged JSON body, one extra header
headers: {
  "Content-Type": "application/json",
  "X-Fistbump-Announce-Token": config.announceToken,
}

// 2. GET /health and GET /v1/status must include
announce_id: createHash("sha256").update(config.announceToken).digest("hex")
```

Body shape is unchanged: `{ "url", "name", "side", "protocol", "note" }`.
Registry responses on refusal: `401` (header absent), `400` (malformed token
or field), `403` (URL claimed by another token / `announce_id` mismatch),
`429` (over the quota, or over the per-credential / per-network slot cap),
`503` (too many verifications in flight — retry), `413` (body > 16 KiB).

## How many entries one announcer gets

`MAX_MAKERS` alone bounds nothing an attacker cares about: announce auth proves
control of an origin, and one wildcard DNS record plus one token per name makes
200 origins cost a single domain. So:

- one announce token holds at most `REGISTRY_MAX_PER_CREDENTIAL` URLs at once,
- one source network (/24 for IPv4, /48 for IPv6 — a /64 is one cheap
  allocation, so per-address accounting is meaningless) holds at most
  `REGISTRY_MAX_PER_NETWORK`,
- and when the table is full the **least-recently-seen** entry is evicted
  instead of the newcomer being refused. Refusing made a full table permanent
  for everyone except its occupants; the two caps above are what stop eviction
  from being usable as a way to push honest makers out.

An entry that is simply refreshed by its owner takes no new slot.

## Field rules

The registry re-serves these to every visitor, so it only stores what it can
vouch for:

- `note` — max 80 chars of plain text, `[A-Za-z0-9 '&()+,!?_-]` only. The Auto
  UI prints `note` where the maker's host would go, so anything that can read
  as a domain (`.`, `/`, `:`, `@`, non-ASCII homoglyphs) is rejected.
- `name` — max 64 chars, same charset and same reason: it sits one line above
  `note` in the same maker card, so a name that reads as a domain impersonates
  an origin just as well. The one exception is the maker's **own** host, which
  the announce has just proved control of — that is also what a maker that
  sends no `name` is labelled with, and it is what the reference bot sends when
  `MAKER_NAME` is unset.
- `side` — up to 4 lowercase identifiers, e.g. `buy_fbc`.
- `protocol` — `[A-Za-z0-9._/+-]{1,64}`.
- From the maker's `/health`, only `liquidity` (`fbc` | `btc` | `both`) and the
  finite numbers `mid_fbc_per_btc`, `spread_bps` (0–10000) and `max_fbc` are
  copied. Anything else, or a value out of range, is stored as `null`.

## Run locally

```bash
python3 registry.py
# http://127.0.0.1:8790/v1/makers
```

Announcing a `http://127.0.0.1:…` maker needs `REGISTRY_ALLOW_HTTP_LOCAL=1`
(dev only — see below).

## Announce (from a bot)

```bash
TOKEN=$(openssl rand -hex 16)
curl -s -X POST http://127.0.0.1:8790/v1/makers/announce \
  -H 'Content-Type: application/json' \
  -H "X-Fistbump-Announce-Token: $TOKEN" \
  -d '{"url":"https://mm.example.com","name":"Example MM","side":["buy_fbc"]}'
# requires https://mm.example.com/health to serve
#   "announce_id": "<sha256 hex of $TOKEN>"
```

## Environment

| Var | Default | Notes |
|-----|---------|-------|
| `REGISTRY_HOST` / `REGISTRY_PORT` | `127.0.0.1` / `8790` | |
| `REGISTRY_DATA` | `./data/makers.json` | Restart cache for listings that expire in TTL anyway. Git-ignored, and it deliberately stores no announcer address — only the network the entry came from is kept, in memory, for the per-network cap. |
| `REGISTRY_TTL_SEC` | `90` | |
| `REGISTRY_CORS` | swap.fistbump.org + localhost | |
| `REGISTRY_ALLOW_HTTP_LOCAL` | `0` | Allow `http://127.0.0.1:*` makers. **Dev only:** the announced URL is chosen by a stranger, so enabling this turns the registry into a port scanner for the host it runs on. |
| `REGISTRY_TRUSTED_PROXIES` | *(empty)* | IPs/CIDRs whose `X-Forwarded-For` is believed. Empty = attribution is always the socket peer. |
| `REGISTRY_ANNOUNCE_QUOTA` | `20` | Announces per source network (/24, /48) per window. |
| `REGISTRY_ANNOUNCE_WINDOW_SEC` | `60` | |
| `REGISTRY_MAX_MAKERS` | `200` | Table size. Full → least-recently-seen is evicted, not the newcomer refused. |
| `REGISTRY_MAX_PER_CREDENTIAL` | `4` | URLs one announce token may hold at once. |
| `REGISTRY_MAX_PER_NETWORK` | `8` | URLs one source /24 or /48 may hold at once. |
| `REGISTRY_VERIFY_CONCURRENCY` | `16` | Verifications in flight; over it, announce returns `503`. Each one parks a worker thread on an outbound fetch and `ThreadingHTTPServer` has no thread ceiling of its own. |
| `REGISTRY_VERIFY_TIMEOUT` | `4` | Per socket operation of the `/health` fetch. The whole verification — both paths, every redirect hop, every fallback address — shares one budget of `2 x` this, enforced by shutting the socket down, so a maker that trickles bytes cannot outlast it. |

Verification fetches resolve the maker hostname in-process, refuse anything
that is not a globally routable unicast address (loopback, RFC1918,
link-local/metadata, CGNAT, reserved), connect to the pinned addresses with the
original `Host`/SNI, and follow at most 2 redirects, re-validating each hop and
refusing any that leaves the announced origin. Every address the name resolves
to must pass; up to 4 of them are tried in order, so a dual-stack maker whose
first record is unreachable still verifies.

## Production (swap.fistbump.org)

Apache proxies `/api/` → `127.0.0.1:8790`. Public UI uses:

```
https://swap.fistbump.org/api/v1/makers
```

Apache must pass `X-Fistbump-Announce-Token` through, and
`REGISTRY_TRUSTED_PROXIES` must list the address Apache connects from
(`127.0.0.1,::1` in the shipped unit) or every announce is attributed to
localhost: one shared quota bucket, and one shared per-network cap, which would
hold the whole world to `REGISTRY_MAX_PER_NETWORK` entries between them. The
registry logs `attribution warning: ...` once if it sees this.

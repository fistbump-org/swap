# Reference market maker (`buy_fbc`)

Sample implementation of **[MM_API.md](../MM_API.md)**.

Anyone can run this (or reimplement the API in any language). You are a **principal** holding **your own FBC**; you are not a custodian and not a shared exchange.

Settlement: **[SPEC.md](../SPEC.md)** HTLCs.

## Quick start

```bash
cp .env.example .env
# Required for swaps: BTC_WIF, FBD_WALLET, rates, CORS_ORIGINS
# Required to show up in the UI: PUBLIC_URL=https://your-mm.example  (public HTTPS)
# REGISTRY_URL=https://swap.fistbump.org/api  (default)

npm install
npm start
```

On start the bot heartbeats the registry. The Auto UI loads makers from the registry automatically — no manual URL paste for users.

```bash
curl -s http://127.0.0.1:8787/health
curl -s https://swap.fistbump.org/api/v1/makers
```

## API

See **[../MM_API.md](../MM_API.md)** — that document is the contract. This bot is one implementation.

## Nodes required (no explorers)

All **chain** data is from your nodes only:

| Chain | Source |
|--------|--------|
| BTC tip / fees / confs / broadcast / claim key | **Bitcoin Core** `BTC_RPC_*` |
| FBC tip / fund HTLC / confs / claim preimage watch | **fbd** `FBD_RPC_*` |

Public explorers (Blockstream, mempool.space, fistbump explorer) are **not** used.

```bash
BTC_RPC_URL=http://192.168.1.10:8332
BTC_RPC_USER=bitcoinrpc
BTC_RPC_PASSWORD=secret
BTC_RPC_WALLET=mm

FBD_RPC_URL=http://192.168.1.10:32869
FBD_RPC_PASSWORD=...
FBD_WALLET=mm
```

`BTC_RPC_WALLET` appends `/wallet/<name>` for wallet-scoped RPCs (claim address / keys).  
Core should have `server=1`, `txindex=1`. Prefer VPN/Tailscale for RPC, not public internet.

Price feeds (Coinbase/Kraken) are **off-chain USD quotes only**, not blockchain data.

## Security

- Your keys, your inventory, your risk  
- Start with dust sizes and low `MAX_FBC`  
- Do not commit `.env`  

## Upgrading an existing deployment

The security branch changes required configuration. Work through this before
restarting, or the bot will refuse to boot (by design) or run degraded.

**1. Timelocks — the bot will not start without this.**

```bash
BTC_REFUND_HOURS=48    # the TAKER's refund window
FBC_REFUND_HOURS=24    # yours; must be shorter by ≥ MIN_DELTA_HOURS
```

Earlier deployments shipped these inverted (BTC 24 / FBC 48), which hands your
whole FBC inventory to the first taker who simply waits. Startup now fails loudly
rather than running that way.

**2. Announce credential — without it you will not appear in the UI.**

```bash
ANNOUNCE_TOKEN=$(openssl rand -hex 16)
```

The bot publishes `sha256(token)` at `/health`; the registry checks the two agree.
The registry must be running the matching version, and any proxy in front of it
must pass `X-Fistbump-Announce-Token` through.

**3. Proxy awareness.**

```bash
TRUST_PROXY=1    # ONLY if a reverse proxy you run is in front
```

With a proxy in front and this off, every internet client shares one rate-limit
bucket and a single caller can starve the maker. With it on and no proxy, callers
pick their own bucket by forging `X-Forwarded-For`. Set it to match reality.

**4. One supervisor, not two.**

Check for a manually-started instance before restarting:

```bash
ss -lptn 'sport = :8787'
ps -eo pid,etime,cmd | grep '[t]sx src/index.ts'
```

A `nohup ./node_modules/.bin/tsx src/index.ts &` started by hand survives
`systemctl restart` and silently keeps the port, so systemd restart-loops while
the old build keeps serving. Kill it before enabling the unit.

**5. In-flight swaps.**

Check before stopping anything:

```bash
jq '.swaps | map_values(.state)' data/mm.json
```

Any swap not in `done` / `failed` / `refunded` has funds attached. The store
migrates forward automatically on load (indexes rebuilt, new fields defaulted),
but a swap negotiated under the old inverted timelocks can no longer satisfy
validation — settle or refund those before upgrading.

## Operational notes

The bot refuses to start if `BTC_REFUND_HOURS` does not exceed `FBC_REFUND_HOURS` by at least
`MIN_DELTA_HOURS`. The taker funds first and holds the preimage, so their refund must open
last — reversed, they can refund their BTC and still claim your FBC. See SPEC §4.2.

It also checks that `bitcoind` reports the chain you configured before touching any key.

**Refunds.** If a taker funds BTC and then walks away, the bot spends its own FBC HTLC through
the refund branch a couple of blocks after `T2` and returns the coins to the fbd swap address.
Claims are tracked to confirmation and RBF-bumped if they stall, because a claim that never
confirms loses the swap at `T1`.

**Exposure.** Every endpoint is unauthenticated by design (browsers have to reach it). Body size,
read timeouts and per-IP rate limits are enforced in-process, but put a reverse proxy in front
for TLS and set `TRUST_PROXY=1` only then — otherwise callers choose their own rate-limit bucket
via `X-Forwarded-For`.

**Testing.** `npm test` covers the timelock rules and the store's uniqueness guarantees. There is
no integration test against a live fbd/bitcoind; the FBC refund path in particular has not been
exercised end to end. Rehearse on regtest before running real inventory.

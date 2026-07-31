# Market Maker HTTP API v1

**Status:** Draft (compatible with `swap/bot` reference implementation)  
**Settlement:** [SPEC.md](./SPEC.md) — HTLC atomic swaps BTC ↔ FBC  
**Role of this API:** Replace human blob-paste with an always-online **principal** (the market maker).

Anyone can run a market maker. There is no shared order book and no central matching engine. The taker picks a maker base URL, requests a quote, and settles with **that** counterparty under SPEC.md. Fistbump (the project) may ship a static UI and a **reference** bot; neither is required to use someone else’s bot.

```
Taker (browser + wallets)          Maker (your bot)
        │                                  │
        │  POST /v1/quote                  │
        │─────────────────────────────────►│  price from YOUR inventory
        │  POST /v1/swaps  (offer)         │
        │─────────────────────────────────►│  return accept (YOUR pubkeys)
        │  fund HTLC on chain              │
        │  POST .../funded_*               │
        │─────────────────────────────────►│  verify + fund other leg
        │  claim                           │  claim other leg
        │◄──────── HTLCs ─────────────────►│
```

**You never custody the taker’s coins.** You only hold **your own** inventory and lock it in HTLCs the same way a human Bob would.

---

## Design rules

1. **Principal only.** The maker is Alice or Bob in SPEC.md — a counterparty, not an escrow.
2. **One maker per swap.** No multi-party matching in this API.
3. **Settlement is on-chain HTLCs.** HTTP only carries messages that humans used to paste (offer / accept / funded_*).
4. **Blobs match SPEC.md** field-for-field. Do not invent alternate script layouts.
5. **CORS:** If browsers call you from `https://swap.fistbump.org` (or any static UI), allow those origins on API responses.
6. **HTTPS** in production. Treat quote/accept as commercially sensitive but not secret-key material.

---

## Base URL

Makers expose an HTTPS origin, e.g. `https://mm.example.com`.  
All paths below are relative to that origin.

### Discovery (registry)

Bots self-register so UIs do not require pasting URLs. The registry is a **phone book**, not a matching engine.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `{registry}/v1/makers` | Live list (TTL heartbeats) |
| `POST` | `{registry}/v1/makers/announce` | Register / heartbeat |

**Announce body:** `{ "url", "name", "taker_sides", "protocol", "note?" }`

Announcing requires **proof that you control the URL you are claiming**. The UI auto-selects the best-priced maker for anyone who has not used it before, so getting listed is being trusted with a stranger's funds — an open announce endpoint lets anybody put themselves in that position.

1. Pick a secret `ANNOUNCE_TOKEN` (≥16 printable ASCII chars; 32 random ones is the sane default).
2. Publish the **digest** in your `/health` and `/v1/status` body: `"announce_id": "<sha256(token) lowercase hex>"`. The digest is public and proves nothing on its own.
3. Send the **preimage** when announcing: `X-Fistbump-Announce-Token: <token>`.

The registry recomputes `sha256(token)` and requires it to match the `announce_id` served by the URL being claimed. A URL that is already listed is pinned to the credential that listed it, so a live maker cannot be taken over mid-TTL. Failure is always closed: no header → `401`, malformed token → `400`, mismatch or a URL claimed by someone else → `403`, over quota → `429`.

The header is deliberately not CORS-safelisted and not in `Access-Control-Allow-Headers`, so no web page can drive a visitor's browser into announcing.

Registry verifies `GET {url}/health` (or `/v1/status`) before listing, resolving the hostname itself and refusing any non-public address. Entries expire without heartbeats (~90s). Full contract in `registry/README.md`.

Public registry (when deployed): `https://swap.fistbump.org/api`  
Reference bot: set `PUBLIC_URL` + `REGISTRY_URL` (see `bot/.env.example`).

Optional static pins: `makers.json` on the static site (merged into the UI list).

---

## Endpoints

### `GET /health`

Liveness. May include the same fields as `/v1/status`.

**200**

```json
{
  "ok": true,
  "taker_sides": ["buy_fbc"],
  "liquidity": "fbc",
  "protocol": "fistbump-swap-mm/v1"
}
```

---

### `GET /v1/status`

Public maker metadata for UIs.

**200** (example — extend freely with extra fields; clients ignore unknowns)

```json
{
  "protocol": "fistbump-swap-mm/v1",
  "taker_sides": ["buy_fbc"],
  "liquidity": "fbc",
  "name": "optional display name",
  "announce_id": "…sha256(ANNOUNCE_TOKEN), 64 hex…",
  "mid_fbc_per_btc": 42000,
  "spread_bps": 50,
  "max_fbc": 100000,
  "min_btc_sat": 10000,
  "btc_conf_target": 6,
  "fbc_conf_target": 12,
  "networks": { "btc": "main", "fbc": "main" }
}
```

| Field | Meaning |
|--------|---------|
| `taker_sides` | Every side you serve, as a list, **named from the taker's point of view** — which is the only view `Side` has. This is the field to read. `buy_fbc` = the taker pays BTC and receives FBC, so **you supply FBC**. `sell_fbc` = the taker pays FBC and receives BTC, so you supply BTC. A maker may serve one or both. |
| `liquidity` | What you actually hold and hand out — `fbc` or `btc`. The maker-relative fact, and the one to read if you want to know what a maker *is*. |
| `liquidity` | What inventory you advertise (`fbc`, `btc`, or `both`). |
| `mid_fbc_per_btc` | Whole FBC per whole BTC (a price). The example means 1 BTC ≈ 42,000 FBC. |
| `spread_bps` | Your half-spread in basis points (informational). |
| `max_fbc` | Largest quote you will write, in **whole FBC** — not bumps. |
| `min_btc_sat` | Smallest BTC leg you will accept, in **sats** (SPEC §8 floor: 10,000). |
| `*_conf_target` | Confirmations you wait for on each chain before acting. |

Note the deliberate mix: `max_fbc` is whole FBC while `min_btc_sat` is sats. The names carry the unit; do not assume a shared convention across this object.

---

### `POST /v1/quote`

Request a firm quote. Locks soft inventory for `expires_at` if you implement inventory locks (recommended).

> **Units.** This is the *only* endpoint in the API that speaks decimal coin amounts, and
> it does so in the request only. `amount_btc` in the **request** is a decimal number of
> **whole BTC** (`0.01` = one million sats). `amount_btc` in the **response** is an integer
> number of **sats**. Same key, different unit, one hop apart — a client that echoes the
> request value into an offer, or a maker that reads the request as sats, is off by 10⁸.
> Everything downstream of the quote response (offer, funded_\*, swap object) is integer
> base units, per SPEC §5.
>
> **Prefer `amount_sat`.** It is an integer number of sats, cannot be confused with the
> response field, and needs no decimal round-trip. `amount_btc` stays supported because
> deployed clients send it.

`side` is **required**. It was optional in earlier drafts, which meant an absent side
silently meant `buy_fbc` — harmless while that was the only side, and a wrong-chain spend
the moment it is not. A request without one gets `400 side is required`, never a guess.
Read `taker_sides` from `GET /v1/status` to learn what a maker serves. Note the
asymmetry, which is deliberate: on a maker's record the field is named for whose
view it is, because "buy_fbc" on a maker reads as the opposite of the truth — a
maker serving `buy_fbc` **sells** FBC. In a quote request there is no such
ambiguity, since the taker is naming their own action, so the field stays `side`.

**Request** — `amount_sat` is integer **sats**, the amount the taker pays:

```json
{
  "side": "buy_fbc",
  "amount_sat": 1000000
}
```

Equivalent, in decimal **whole BTC**:

```json
{
  "side": "buy_fbc",
  "amount_btc": 0.01
}
```

Alternate spelling, identical meaning and unit (decimal whole BTC) for `buy_fbc`:

```json
{
  "side": "buy_fbc",
  "amount_in": 0.01
}
```

If both `amount_sat` and `amount_btc` are present, `amount_sat` wins — a caller sending
both disagreeing values is confused, and the unambiguous field is the one to trust.

A reference maker rejects `amount_btc` ≥ 1000 outright with a units error rather than
letting it fail later against the inventory cap, since 1000 BTC is not a real order and
the cap's message ("exceeds max inventory quote") points at liquidity instead of units.

For `sell_fbc` (when you support it), `amount_fbc` is a decimal number of **whole FBC** the taker sells — not bumps:

```json
{
  "side": "sell_fbc",
  "amount_fbc": 100
}
```

**200** — every amount here is an **integer in base units**:

```json
{
  "quote_id": "q_…",
  "side": "buy_fbc",
  "amount_btc": 1000000,
  "amount_fbc": 417900000,
  "mid_fbc_per_btc": 42000,
  "spread_bps": 50,
  "mm_btc_pubkey": "02…",
  "mm_fbc_pubkey": "03…",
  "btc_reference_height": 920000,
  "fbc_reference_height": 180000,
  "btc_refund_height": 920288,
  "fbc_refund_height": 180720,
  "btc_refund_hours": 48,
  "fbc_refund_hours": 24,
  "expires_at": "2026-07-27T22:00:00.000Z",
  "eta_note": "optional human string"
}
```

| Field | Notes |
|--------|--------|
| `amount_btc` | Integer **sats** the taker pays (1 BTC = 1e8 sat). The example is 0.01 BTC. **Not** the decimal value from the request |
| `amount_fbc` | Integer **bumps** the taker receives (1 FBC = 1e6 bumps; SPEC §5 calls these dollarydoos — same unit). The example is 417.9 FBC |
| `mid_fbc_per_btc` | Whole FBC per whole BTC — a price, not a base-unit ratio |
| `spread_bps` | Half-spread in basis points |
| `*_refund_hours` | Whole hours, informational; the binding values are the heights |
| `mm_*_pubkey` | Your compressed secp256k1 pubkeys (33 bytes hex) used in ACCEPT |
| `*_refund_height` | Absolute heights for SPEC timelocks. **`T1` (BTC) must fall at least Δ ≥ 12h AFTER `T2` (FBC)** in wall-clock terms (§4.2). The taker funds first and holds the preimage, so their refund must open last — quoting it the other way round loses your inventory to the first taker who waits. |
| `expires_at` | ISO-8601; reject accepts after this |

Quotes are **single-use**. Bind each `quote_id` to at most one swap and delete it on accept; otherwise one quote can back many offers that all derive the same HTLC address, and a single BTC funding output buys several FBC HTLCs.

**4xx** `{ "error": "human readable" }`

---

### `POST /v1/swaps`

Taker submits a SPEC **offer** (Alice when `side=buy_fbc`). Maker returns **accept** (Bob).

**Request** — the `offer` is a SPEC §5.1 blob verbatim: `amount_btc` is integer **sats**, `amount_fbc` is integer **bumps**, and both must equal the quote response's values exactly (not the decimal amount the taker typed into the quote request).

```json
{
  "quote_id": "q_…",
  "offer": {
    "version": 1,
    "kind": "offer",
    "network": { "btc": "main", "fbc": "main" },
    "hashlock": "…64 hex…",
    "alice_btc_pubkey": "02…",
    "alice_fbc_pubkey": "03…",
    "amount_btc": 1000000,
    "amount_fbc": 417900000,
    "btc_refund_height": 920288,
    "fbc_refund_height": 180720,
    "btc_reference_height": 920000,
    "fbc_reference_height": 180000,
    "expires_at": "…",
    "offer_id": "…32 hex…"
  }
}
```

**Validate before accept**

- `quote_id` known, not expired, and **not already consumed**
- amounts match quote
- networks match
- `offer_id` is 16 bytes of hex, and you have not seen it before — an `offer_id` you already hold a swap for is a replay, so return the existing swap rather than creating or overwriting one
- `hashlock` unused by any live swap (SPEC §9.4 requires a fresh preimage per swap)
- pubkeys well-formed **and compressed** (`02`/`03` prefix, 33 bytes)
- all four height fields are integers and **exactly equal the ones you quoted** — do not accept counterparty-supplied heights
- timelock wall-clock rule with the correct sign, `T1 ≥ T2 + Δ` (SPEC §4.2)
- both reference heights within a few blocks of tips **you observe yourself** (SPEC §4.3: 10 BTC blocks, 20 FBC blocks), and both refund heights still far enough out — `T1` ≥ tip + `btc_conf_target` + 6, `T2` ≥ tip + 60 FBC blocks. The FBC floor is the larger one because it is sized for the taker, who must sit through your FBC conf target before claiming and still land the claim 6 blocks before `T2` — quote a nearer `T2` and a taker running `web/core` will simply refuse your offer.
- you still have *uncommitted* inventory — count FBC already promised to live swaps, not just your wallet balance

The last four matter more than they look. Every number in the wall-clock Δ comes out of the taker's blob, including the reference heights it is measured against, so Δ can read as a healthy 24h while `T1` sits in the past. Checking against your own tips is what makes the relative check mean anything.

**Never derive the swap id from the offer.** Generate it yourself. Keying on caller-supplied `offer_id` (or a truncation of it) lets a taker collide with a live swap and reset it, and a reset swap gets funded a second time.

**200**

```json
{
  "swap_id": "s_…",
  "accept": {
    "version": 1,
    "kind": "accept",
    "offer_id": "…same as offer…",
    "bob_btc_pubkey": "02…",
    "bob_fbc_pubkey": "03…"
  }
}
```

`bob_*` **must** be the keys you will use to claim/refund. For `buy_fbc`, you are Bob: you claim BTC with `bob_btc_pubkey`, refund FBC with `bob_fbc_pubkey`.

---

### `POST /v1/swaps/:swap_id/funded_btc`

Taker (Alice) funded the BTC HTLC. Required for `buy_fbc`.

**Request** — SPEC `funded_btc` object; `funding_amount` is integer **sats** and must equal the offer's `amount_btc`:

```json
{
  "version": 1,
  "kind": "funded_btc",
  "offer_id": "…",
  "funding_txid": "…",
  "funding_vout": 0,
  "funding_amount": 1000000,
  "witness_script_hex": "…"
}
```

**Maker must**

1. Rebuild expected BTC script from offer+accept (SPEC / swap-core `verifyFundedBtc`)
2. Confirm on-chain that the outpoint pays the BTC P2WSH address for that amount **and is still unspent** — use `gettxout`, not `getrawtransaction`, which happily returns a transaction whose outputs were spent long ago
3. Bind `funding_txid:funding_vout` to this swap and reject it for any other. One payment must never back two FBC HTLCs
4. Wait for your conf policy (reference: 6)
5. **Re-check before funding**: the confirmation wait is ~an hour, during which `T1` keeps approaching and the taker may have refunded. Re-read both tips, re-run the §4.3 checks, and re-confirm the outpoint is unspent
6. Fund the FBC HTLC (you are Bob)
7. Expose `funded_fbc` on `GET /v1/swaps/:id`
8. After taker claims FBC, extract the preimage, **verify `SHA256(preimage) == hashlock`**, then claim BTC

**200** — current swap object (see GET).

---

### `POST /v1/swaps/:swap_id/funded_fbc` (optional until sell path)

Used when the **taker** funds FBC (`sell_fbc`). Same idea as `funded_btc` with a SPEC `funded_fbc` body. Omit until you support sell.

---

### `GET /v1/swaps/:swap_id`

Poll status. Clients poll every few seconds after funding.

**200** — `funded_btc.funding_amount` is integer **sats**; `funded_fbc.funding_amount` is integer **bumps**. Both mirror the offer's `amount_btc` / `amount_fbc`.

```json
{
  "swap_id": "s_…",
  "quote_id": "q_…",
  "state": "waiting_btc_confs",
  "offer": { },
  "accept": { },
  "funded_btc": { },
  "funded_fbc": {
    "version": 1,
    "kind": "funded_fbc",
    "offer_id": "…",
    "funding_txid": "…",
    "funding_vout": 0,
    "funding_amount": 417900000,
    "witness_script_hex": "…",
    "htlc_address": "fb1q…"
  },
  "btc_confs": 3,
  "fbc_confs": 0,
  "btc_claim_txid": null,
  "fbc_claim_txid": null,
  "error": null,
  "created_at": 0,
  "updated_at": 0
}
```

#### `state` values (recommended)

| State | Meaning |
|--------|---------|
| `accepted` | Waiting for taker funding |
| `waiting_btc_confs` | Saw `funded_btc`, waiting confs |
| `funding_fbc` | Broadcasting your FBC fund |
| `waiting_fbc_confs` | FBC funded, waiting confs |
| `claimable` | Safe for taker to claim FBC (≥ your FBC conf target) |
| `claiming_btc` | You saw preimage, claiming BTC |
| `done` | You claimed BTC (or sell path complete) |
| `failed` | Terminal error; see `error` |
| `refunding_fbc` | Your FBC refund is broadcast, waiting for it to confirm |
| `refunded` | You refunded your HTLC after timeout |

Clients treat unknown states as non-terminal unless `error` is set.

---

## Roles by `side`

### `buy_fbc` (you supply FBC) — v1 minimum

| Party | SPEC role | Actions |
|--------|-----------|---------|
| Taker | Alice | Offer, fund BTC, claim FBC |
| Maker | Bob | Accept, fund FBC after BTC confs, claim BTC after preimage |

### `sell_fbc` (you supply BTC) — optional extension

| Party | SPEC role | Actions |
|--------|-----------|---------|
| Maker | Alice | Offer + fund BTC first |
| Taker | Bob | Accept, fund FBC after BTC confs, claim BTC |

Implement sell only if you hold BTC inventory. Same HTTP surface; different who posts which funded_* first.

---

## Implementation checklist

- [ ] Scripts byte-identical to SPEC / `web/core` / fbd `Script.htlc`
- [ ] `T1 ≥ T2 + Δ` enforced with the correct sign, and Δ ≥ 12h (SPEC §4.2)
- [ ] Offer heights bound to the quote you issued, and re-validated against tips you observe (SPEC §4.3)
- [ ] On-chain verification of counterparty funding — the outpoint exists, pays the right address and amount, **and is unspent** (`gettxout`, not `getrawtransaction`)
- [ ] Funding outpoints bound to exactly one swap; `offer_id` and `hashlock` never reusable
- [ ] Swap ids generated by you, never derived from caller input
- [ ] Quotes single-use; inventory reserved against committed swaps, not raw balance
- [ ] Persistent swap state (survive process restart)
- [ ] `SHA256(preimage) == hashlock` checked before building a claim
- [ ] Auto-claim BTC when FBC claim reveals preimage (don’t rely on taker HTTP callback)
- [ ] Claims and refunds tracked to a **burial depth of more than one confirmation**, with RBF fee-bumping, and bumping resumed if the depth returns to zero (SPEC §6.3) — a broadcast claim that never confirms, or that a 1-block reorg evicts unnoticed, loses the swap at `T1`
- [ ] Refund your HTLC if the other side never completes after `T2`
- [ ] Request body cap, read timeouts, and per-IP rate limits — every endpoint here is unauthenticated
- [ ] Internal errors not echoed to callers (they leak node topology and balances)
- [ ] CORS for the UIs you care about, and `Content-Type: application/json` required on POSTs so browsers must preflight
- [ ] Never log long-lived preimages in clear text after done

---

## Reference implementation

`swap/bot/` is a **sample** maker for `buy_fbc` (FBC liquidity). It is not privileged:

```bash
cd bot
cp .env.example .env   # your keys, your fbd wallet
npm install && npm start
```

Frontend points at **any** maker base URL:

```
https://swap.fistbump.org/auto/?api=https://your-mm.example
```

or `localStorage.mm_api`.

---

## What this is not

- Not a CEX and not a custodial exchange  
- Not a shared order book or matching engine  
- Not permissioned — no API key required by this spec (you may add auth for your own ops; public quote/swap for takers should stay open if you want browser use)

---

## Versioning

- Protocol id: `fistbump-swap-mm/v1`  
- Breaking changes → `v2` path prefix  
- SPEC.md blob changes are independent; this API only transports them  

# Fistbump Swap

Trustless, peer-to-peer atomic swaps between Bitcoin (BTC) and Fistbump (FBC).

No custody. No matching engine. No fee collection by the author. Two counterparties exchange small JSON blobs out of band, each funds a hash time-locked contract on their chain, and the swap resolves atomically: either both sides claim, or both sides refund. Nothing in between is possible.

This repo contains the protocol specification, the browser-side core library, and the static frontend deployed at [swap.fistbump.org](https://swap.fistbump.org). The Swift counterpart (node + wallet extension additions) lives in the [fbd](https://github.com/fistbump-org/fbd) and [wallet](https://github.com/fistbump-org/wallet) repositories.

## Directory layout

```
.
├── SPEC.md                 — Protocol spec (v1). Read this first.
├── build.sh                — Rebuilds web/core and syncs its dist into web/app/core.
├── web/
│   ├── core/               — TypeScript library: scripts, addresses, blobs.
│   │   ├── src/
│   │   ├── test/           — Node --test units. Cross-checked against the Swift impl.
│   │   └── package.json
│   └── app/                — Static frontend served from swap.fistbump.org.
│       ├── index.html
│       ├── app.js          — Step-by-step swap driver. Delegates all signing.
│       ├── style.css
│       ├── fistbump.css    — Shared theme (see the dev repo's sync-theme.sh).
│       ├── fonts/          — IBM Plex Sans + Mono subsets.
│       └── core/           — Copy of web/core/dist for direct ESM import.
└── README.md               — (this file)
```

## What lives where

**Protocol** — `SPEC.md` is the single source of truth for the HTLC script layout, blob formats, timelock parameters, and failure paths. Any implementation must match it byte-for-byte.

**TypeScript core** (`web/core/`) — `@fistbump/swap-core`. Builds HTLC scripts (byte-identical to the Swift reference implementation, verified by paired tests), derives P2WSH addresses on both chains, and encodes/decodes offer/accept/funded blobs. Never holds or touches keys — all signing is delegated to user wallets.

**Frontend** (`web/app/`) — Static site. Pure client-side. Walks either side of the swap through the protocol step-by-step: connect wallets, build offer, exchange blobs, fund HTLCs, claim. Only dependencies are the user's own wallets: the Fistbump browser extension for FBC, and a BTC signer for BTC. See **BTC wallet support** below — that second one is narrower than it sounds.

## External components

The swap protocol depends on two things shipped in other repos:

- **[fistbump-org/fbd](https://github.com/fistbump-org/fbd)** exposes the FBC leg via five RPC methods: `getswappubkey`, `buildhtlcscript`, `parsehtlcscript`, `createhtlcfund`, `signhtlcspend`. The script construction lives in the `Script` module, wallet-level fund/spend logic in the `Wallet` module, and unit tests (cross-locked with this repo's TS tests) in the test suite.

- **[fistbump-org/wallet](https://github.com/fistbump-org/wallet)** adds three page-facing methods to `window.fistbump`: `getPublicKey()`, `fundHtlc(...)`, `signHtlcSpend(...)`. Each shows a purpose-specific confirmation modal before signing.

Both are required to run a real swap from the frontend. For development against regtest, you can spin up a local `fbd` and point the browser extension at it via the wallet's network settings.

## Local development

```bash
# Run the core tests (cross-checked against fbd's Swift tests)
cd web/core
npm install
npm test

# Rebuild + sync dist to the frontend
cd ../..
./build.sh

# Serve the frontend locally
cd web/app
python3 -m http.server 8765
open http://localhost:8765
```

## BTC wallet support

Funding a swap is an ordinary payment to a P2WSH address, so any wallet can do
it. **Spending** one is not: every claim and refund spends a P2WSH input whose
witness script is a one-off HTLC, and most wallets refuse to sign a script they
cannot attribute.

| Signer | Fund | Claim / refund | Notes |
|--------|------|----------------|-------|
| **Unisat** | yes | *sometimes* | The only wallet wired into the UI. Some builds reject custom P2WSH inputs with "Unknown inputs not allowed" (SPEC §11.2). |
| **Bitcoin Core** (`walletprocesspsbt`) | yes | yes | The witness script travels in the PSBT; signs if the key is in the wallet. Most reliable option. |
| **Sparrow**, **Electrum** (software keys) | yes | yes | Import the exported PSBT, sign, broadcast. |
| **Ledger, Trezor, Coldcard** | yes | **no** | Not a firmware gap. Hardware wallets sign only scripts they can attribute — Ledger wants a registered policy of extended keys with origins, and an HTLC embeds two raw one-off pubkeys, one of them your counterparty's. There is nothing to register. |

Every spend step therefore also offers the unsigned **PSBT**, so you can sign
anywhere. `tools/refund-htlc.mjs` produces the same thing offline for a refund.

**Implication worth stating plainly:** HTLC spends need a *hot* key. The claim
has to land inside a timelock window, which rules out a signing flow that
depends on retrieving a device from a safe. Use a dedicated key — a Core
descriptor wallet, or a throwaway funded only for swaps — and treat swap
balances as spending money, not savings.

## Recovering a stuck swap

Every swap has a refund branch that needs no counterparty and no preimage — only
that its timelock has expired. If a swap gets stuck, nothing is lost; it just has
to wait.

Which path applies depends on what you still have:

| Situation | Recovery |
|-----------|----------|
| The browser still has the session (P2P or Auto) | Use the UI. P2P has **Refund BTC** at step 7; Auto has **Recover BTC** on the session card. |
| Session gone, preimage lost, or the UI cannot help | `tools/refund-htlc.mjs` — needs only the witness script and the funding outpoint. |
| You are the maker and your FBC leg is stranded | The bot refunds automatically past `T2`. If it is not running, spend the HTLC via fbd's `signhtlcspend` with `branch: "refund"`. |

```bash
node tools/refund-htlc.mjs \
  --script <witness_script_hex> \
  --txid <funding_txid> --vout <n> \
  --to <your_address>
```

It derives the HTLC address from the script, checks that the outpoint really
pays it, confirms the output is still unspent, refuses to build before the
refund height, and emits an **unsigned PSBT**. It never touches a private key —
sign in Sparrow, Electrum, or `bitcoin-cli`, then broadcast.

The one thing to preserve from any swap is the **witness script hex** and the
**funding outpoint**. With those two, the coins are always recoverable by
whoever holds the refund key. Both frontends show them, and the maker API
returns them on `GET /v1/swaps/:id`.

## Regulatory posture

This project is designed to be operable by a US entity as a **publisher of open-source non-custodial software**, not as a money transmitter or exchange:

- No entity ever custodies user funds.
- No matching engine, order book, fee collection, or price discovery.
- The web UI is static HTML/JS served from edge cache; no backend service is operated.
- Users supply their own wallets; counterparty discovery is out of band.

This mirrors the posture affirmed by FinCEN 2019 guidance (FIN-2019-G001, §4.2) for non-custodial software providers. **It is not legal advice.** Running `swap.fistbump.org` requires counsel review with specific attention to:

- State-level money transmitter laws (NY BitLicense is the primary concern).
- OFAC sanctions screening at the UI layer.
- The regulatory status of FBC itself (Howey analysis of the initial distribution).

See `SPEC.md` Appendix C for the full discussion.

## Deployment

The frontend is pure static files. `web/app/` rsyncs directly to any static host:

```bash
rsync -a --delete web/app/ fb-web:/var/www/html/swap/
```

Apache/nginx on the host serves it behind a dedicated vhost for `swap.fistbump.org`. A minimal Apache config with the required security headers (strict CSP, HSTS, X-Frame-Options, etc.) is documented in the project notes.

Before production deploy:

1. ~~Bundle `web/core`'s runtime dependencies~~ — **done.** `./build.sh` now runs `esbuild` and emits `web/app/core/bundle.js` with `@noble/hashes`, `@scure/base`, and `@scure/btc-signer` inlined. The frontend imports the bundle directly; no `importmap`, no third-party CDN calls. The `<meta http-equiv="Content-Security-Policy">` in `index.html` is set to `default-src 'self'` with outbound connections allowlisted only to Blockstream and the Fistbump explorer.
2. Geo-block US-sanctioned jurisdictions in the UI as minimum hygiene (Iran, North Korea, Syria, Cuba, Crimea).
3. Have counsel read `SPEC.md` Appendix C and sign off.

## Known gaps (for future iteration)

- **Adaptor signatures / PTLCs**: the BTC side could be upgraded to PTLCs (better privacy, smaller on-chain footprint) as soon as FBC ships Schnorr via a consensus soft fork. Not v1.
- **Multi-counterparty / multi-asset**: out of scope for v1 per SPEC §10.

## License

MIT

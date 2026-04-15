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

**Frontend** (`web/app/`) — Static site. Pure client-side. Walks either side of the swap through the protocol step-by-step: connect wallets, build offer, exchange blobs, fund HTLCs, claim. Only dependencies are the user's own wallets: the Fistbump browser extension for FBC, and any BIP-174 BTC wallet (Unisat, Xverse, OKX) for BTC.

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

1. Bundle `web/core`'s runtime dependencies (`@noble/hashes`, `@scure/base`) into a single self-hosted JS file so the site has no third-party CDN calls and the CSP can stay at `default-src 'self'`. A one-shot `esbuild` invocation accomplishes this.
2. Replace the `importmap` entries in `index.html` with a local path to that bundle.
3. Geo-block US-sanctioned jurisdictions in the UI as minimum hygiene (Iran, North Korea, Syria, Cuba, Crimea).
4. Have counsel read `SPEC.md` Appendix C and sign off.

## Known gaps (for future iteration)

- **BTC claim/refund signing**: the frontend funds BTC HTLCs via `window.unisat.sendBitcoin(...)`, but claim and refund spending paths currently require wallet-level PSBT construction with custom witness data. Unisat's `signPsbt` supports this but needs wiring; alternatively, users can use a BTC CLI out-of-band.
- **Chain monitors**: the frontend trusts the user to confirm on-chain events. A v2 should poll mempool.space and the Fistbump explorer and advance the UI automatically when funding txs confirm.
- **Adaptor signatures / PTLCs**: the BTC side could be upgraded to PTLCs (better privacy, smaller on-chain footprint) as soon as FBC ships Schnorr via a consensus soft fork. Not v1.

## License

MIT

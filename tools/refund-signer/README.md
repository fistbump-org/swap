# HTLC refund signer

Recovers a stuck atomic swap by spending its HTLC through the refund branch,
after the timelock opens.

This signed and broadcast a real mainnet refund on 2026-07-29 —
`f7046f7442f8c589ae748e6fc847160e4101950dec65befa7793dda2558920a5`, 9,746 sats
recovered from swap `s_07fbd8179d1d6e16` after its preimage was lost. The path
is exercised, not theoretical.

Lives in the repo rather than on a Desktop because it is the recovery tool for
the one failure that costs a user their coins, and a Desktop folder gets tidied
away.

## Use it

1. Build the PSBT:

   ```bash
   node tools/refund-htlc.mjs \
     --script <witness_script_hex> \
     --txid <funding_txid> --vout <n> \
     --to <your_address>
   ```

   It refuses to emit until the refund height has passed unless you pass
   `--yes`.

2. Double-click **`serve.command`** (or `cd tools/refund-signer && python3 -m
   http.server 8973 --bind 127.0.0.1`).

   Do **not** open `index.html` directly. Browser extensions are not injected
   into `file://` pages unless you specifically enable "Allow access to file
   URLs", so Unisat would simply not exist on the page.

3. Paste the PSBT, press **Check it**, read the summary, then sign.

## What it checks before letting you sign

- The witness script parses as a real HTLC
- **That script actually locks the coin being spent** — it rebuilds the script,
  derives its P2WSH address, and compares against the funding output. A script
  that hashes to the right address cannot be a different script.
- `nSequence` is not `0xffffffff` — that value disables `nLockTime` entirely and
  the script rejects the spend
- `nLockTime` is at or above the script's CLTV height
- The chain tip has reached that height, so the transaction can relay
- The output has not already been spent
- Outputs do not exceed the input
- Unisat is on the account the refund branch commits to — checked *before* the
  wallet is asked, so a wrong-account signature is never produced

It cannot tell you whether the destination is yours. Nothing can. Check the
**Pays to** line.

## Why this exists rather than using a normal wallet

A refund spend needs the witness stack `[signature, <empty>, witness_script]`.
The empty element selects the `OP_ELSE` branch. Wallet finalize routines do not
recognise the script and either refuse outright or overwrite the witness with
just the script — which fails at `OP_IF` with
`SCRIPT_ERR_UNBALANCED_CONDITIONAL`.

So the wallet is asked for a signature only, and the witness is assembled here.

Hardware wallets (Ledger, Trezor, Coldcard) cannot sign these at all. They sign
against registered wallet policies, and an HTLC carrying a counterparty's raw
pubkey is not a policy they will register.

## If Unisat refuses

Some builds answer `Unknown inputs not allowed`, because the input's
scriptPubKey is the HTLC address rather than one of yours. There is a WIF field
behind the disclosure toggle as a last resort — the key stays in the page — but
weigh that against the amount before pasting a private key into a browser.

Broadcasting is separate from signing. If it fails, the signed hex stays valid
and pushes from anywhere.

## Files

| | |
|--|--|
| `index.html` | the page |
| `sign.js` | checks, wallet calls, witness assembly, broadcast |
| `psbt.js` | standalone PSBT + bech32 decoder, written independently of the code that builds the PSBT so it verifies rather than agrees |
| `bundle.js` | a copy of `web/app/core/bundle.js` — refresh it if `web/core` changes |

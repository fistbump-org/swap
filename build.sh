#!/usr/bin/env bash
#
# build.sh — Rebuild the TypeScript core and sync its dist into the frontend.
#
# The frontend imports `./core/index.js` directly (no bundler on the deploy
# host). Whenever `web/core/src/` changes, the compiled output in
# `web/app/core/` must be regenerated so the site serves the updated code.
# This script is the one place that pairing is expressed; CI and deploys both
# go through it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE="$SCRIPT_DIR/web/core"
APP_CORE="$SCRIPT_DIR/web/app/core"

cd "$CORE"

if [ ! -d node_modules ]; then
  echo "==> installing core deps"
  npm install
fi

echo "==> building core"
npm run build

echo "==> bundling core + deps into single ESM file"
# The frontend loads core via `./core/bundle.js`, which has all of
# @noble/hashes, @scure/base, and @scure/btc-signer inlined. This lets the
# site ship with `default-src 'self'` CSP and no third-party CDN calls.
npm run bundle

echo "==> syncing dist → web/app/core"
rm -rf "$APP_CORE"
mkdir -p "$APP_CORE"
cp -R "$CORE/dist/." "$APP_CORE/"

echo "done."

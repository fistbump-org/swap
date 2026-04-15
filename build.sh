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

echo "==> syncing dist → web/app/core"
rm -rf "$APP_CORE"
mkdir -p "$APP_CORE"
cp -R "$CORE/dist/." "$APP_CORE/"

echo "done."

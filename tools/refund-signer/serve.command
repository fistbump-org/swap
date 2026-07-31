#!/bin/bash
# Serves this folder on localhost and opens it.
#
# Not openable as a file:// — browser extensions are not injected into file://
# pages unless you specifically enable "Allow access to file URLs", so Unisat
# would simply not exist on the page.
cd "$(dirname "$0")" || exit 1
PORT=8973
while lsof -i ":$PORT" >/dev/null 2>&1; do PORT=$((PORT + 1)); done
echo "Serving $(pwd)"
echo "  -> http://127.0.0.1:$PORT"
echo
echo "Leave this window open while you sign. Ctrl-C when done."
( sleep 1; open "http://127.0.0.1:$PORT" ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1

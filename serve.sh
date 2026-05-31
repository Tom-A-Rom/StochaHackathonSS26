#!/usr/bin/env bash
# ============================================================================
# serve.sh — start a local static server for the Chess Probability Visualizer
# and open it in the browser. Picks whatever server tool is available.
#   Usage:  ./serve.sh            (defaults to port 8000)
#           PORT=9000 ./serve.sh
# ============================================================================
set -euo pipefail

PORT="${PORT:-8000}"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}"

cd "$DIR"

# Open the browser shortly after the server starts (best-effort, backgrounded).
open_browser() {
  sleep 1
  if   command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open     >/dev/null 2>&1; then open "$URL"     >/dev/null 2>&1 || true
  elif command -v wslview  >/dev/null 2>&1; then wslview "$URL"  >/dev/null 2>&1 || true
  fi
}

echo "============================================================"
echo "  Schach-Wahrscheinlichkeiten"
echo "  Serving on:  $URL"
echo "  Press Ctrl+C to stop."
echo "============================================================"

open_browser &

# A Web Worker + SHA-256 (Web Crypto) require a real http origin — opening the
# file directly (file://) will NOT work, which is exactly why we serve it.
if   command -v python3 >/dev/null 2>&1; then exec python3 -m http.server "$PORT"
elif command -v python  >/dev/null 2>&1; then exec python  -m http.server "$PORT"
elif command -v npx     >/dev/null 2>&1; then exec npx --yes http-server -p "$PORT" -c-1
elif command -v php     >/dev/null 2>&1; then exec php -S "localhost:${PORT}"
else
  echo "ERROR: need one of python3, python, node/npx or php to serve files." >&2
  exit 1
fi

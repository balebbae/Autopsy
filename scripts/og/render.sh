#!/usr/bin/env bash
# Render the Autopsy social card from scripts/og/template.html → site/og.png.
#
# Usage:  bash scripts/og/render.sh
#
# Requires headless Chrome on $PATH or at the default Devin location.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="$REPO_ROOT/scripts/og/template.html"
OUT="$REPO_ROOT/site/og.png"

CHROME="${CHROME_BIN:-}"
if [ -z "$CHROME" ]; then
  for c in chromium chromium-browser \
           /opt/.devin/chrome/chrome/linux-137.0.7118.2/chrome-linux64/chrome \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome; do
    if [ -x "$c" ] || command -v "$c" >/dev/null 2>&1; then
      CHROME="$c"
      break
    fi
  done
fi

if [ -z "$CHROME" ]; then
  echo "error: no chrome/chromium binary found on PATH" >&2
  exit 1
fi

"$CHROME" \
  --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=1200,630 --virtual-time-budget=3000 \
  --screenshot="$OUT" "file://$TEMPLATE" 2>/dev/null

echo "  rendered $OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"

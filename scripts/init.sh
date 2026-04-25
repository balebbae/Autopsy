#!/usr/bin/env bash
# Install the Autopsy opencode plugin into the current project.
#
# Usage (from your project root):
#   curl -fsSL https://raw.githubusercontent.com/balebbae/Autopsy/main/scripts/init.sh | bash
#
# Re-run at any time to update to the latest plugin version.
set -euo pipefail

REPO="balebbae/Autopsy"
BRANCH="main"
OPENCODE_DIR=".opencode"
PLUGINS_DIR="$OPENCODE_DIR/plugins"
PLUGIN_FILE="$PLUGINS_DIR/autopsy.js"
SDK_PKG="@opencode-ai/plugin"
SDK_VERSION="1.14.25"

# -------------------------------------------------------------------
# Preflight
# -------------------------------------------------------------------

if ! command -v bun &>/dev/null; then
  echo "error: bun is required but not found on PATH" >&2
  echo "  install: https://bun.sh" >&2
  exit 1
fi

if ! command -v curl &>/dev/null; then
  echo "error: curl is required but not found on PATH" >&2
  exit 1
fi

# -------------------------------------------------------------------
# Download plugin source
# -------------------------------------------------------------------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "==> downloading Autopsy plugin from github.com/$REPO ($BRANCH)..."
curl -fsSL "https://github.com/$REPO/archive/$BRANCH.tar.gz" \
  | tar -xz -C "$TMP" --strip-components=1

if [ ! -f "$TMP/plugin/src/index.ts" ]; then
  echo "error: plugin source not found in downloaded archive" >&2
  exit 1
fi

# -------------------------------------------------------------------
# Build single-file bundle
# -------------------------------------------------------------------

echo "==> building plugin bundle..."
(
  cd "$TMP/plugin"
  bun install --frozen-lockfile 2>/dev/null || bun install
  bun build src/index.ts \
    --outfile=dist/autopsy.js \
    --target=bun \
    --format=esm \
    --external "$SDK_PKG"
)

if [ ! -f "$TMP/plugin/dist/autopsy.js" ]; then
  echo "error: plugin build failed" >&2
  exit 1
fi

# -------------------------------------------------------------------
# Install into .opencode/
# -------------------------------------------------------------------

mkdir -p "$PLUGINS_DIR"
cp "$TMP/plugin/dist/autopsy.js" "$PLUGIN_FILE"
echo "==> installed $PLUGIN_FILE"

# Ensure .opencode/package.json exists with the SDK dependency.
if [ ! -f "$OPENCODE_DIR/package.json" ]; then
  echo "{}" > "$OPENCODE_DIR/package.json"
fi

if ! grep -q "$SDK_PKG" "$OPENCODE_DIR/package.json" 2>/dev/null; then
  echo "==> installing $SDK_PKG@$SDK_VERSION..."
  (cd "$OPENCODE_DIR" && bun add "$SDK_PKG@$SDK_VERSION")
fi

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------

echo ""
echo "Autopsy plugin installed."
echo ""
echo "Set these env vars (or add to .env) so the plugin can reach the service:"
echo ""
echo "  AAG_URL=http://localhost:4000   # where the Autopsy service is running"
echo "  AAG_TOKEN=                      # optional auth token"
echo ""
echo "Then start opencode as usual — the plugin loads automatically."

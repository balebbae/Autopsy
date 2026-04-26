#!/usr/bin/env bash
# Install the Autopsy opencode plugin into the current project.
#
# Usage (from your project root):
#   curl -fsSL https://install.autopsy.surf/install.sh | bash
#
# Re-run at any time to update to the latest plugin version.
set -euo pipefail

BOLD=$(printf '\033[1m')
DIM=$(printf '\033[2m')
OK=$(printf '\033[32m')
WARN=$(printf '\033[33m')
ERR=$(printf '\033[31m')
RESET=$(printf '\033[0m')

log()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
okay() { printf '%s✓%s %s\n' "$OK" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$WARN" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$ERR" "$RESET" "$*" >&2; exit 1; }

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

command -v bun  &>/dev/null || fail $'bun is required but not found on PATH.\n  install: https://bun.sh'
command -v curl &>/dev/null || fail "curl is required but not found on PATH"
command -v tar  &>/dev/null || fail "tar is required but not found on PATH"

# -------------------------------------------------------------------
# Download plugin source
# -------------------------------------------------------------------

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

log "downloading Autopsy plugin from github.com/$REPO ($BRANCH)"
curl -fsSL "https://github.com/$REPO/archive/$BRANCH.tar.gz" \
  | tar -xz -C "$TMP" --strip-components=1

[ -f "$TMP/plugin/src/index.ts" ] || fail "plugin source not found in downloaded archive"

# -------------------------------------------------------------------
# Build single-file bundle
# -------------------------------------------------------------------

log "building plugin bundle"
(
  cd "$TMP/plugin"
  bun install --frozen-lockfile 2>/dev/null || bun install
  bun build src/index.ts \
    --outfile=dist/autopsy.js \
    --target=bun \
    --format=esm \
    --external "$SDK_PKG"
) >/dev/null 2>&1 || fail "plugin build failed (re-run with bash -x for full output)"

[ -f "$TMP/plugin/dist/autopsy.js" ] || fail "plugin build produced no output"

# -------------------------------------------------------------------
# Install into .opencode/
# -------------------------------------------------------------------

mkdir -p "$PLUGINS_DIR"
cp "$TMP/plugin/dist/autopsy.js" "$PLUGIN_FILE"
okay "installed $PLUGIN_FILE"

# Ensure .opencode/package.json exists with the SDK dependency.
[ -f "$OPENCODE_DIR/package.json" ] || echo "{}" > "$OPENCODE_DIR/package.json"

if ! grep -q "$SDK_PKG" "$OPENCODE_DIR/package.json" 2>/dev/null; then
  log "installing $SDK_PKG@$SDK_VERSION"
  (cd "$OPENCODE_DIR" && bun add "$SDK_PKG@$SDK_VERSION") >/dev/null 2>&1 \
    || fail "failed to install $SDK_PKG"
  okay "installed $SDK_PKG@$SDK_VERSION"
fi

# -------------------------------------------------------------------
# Done
# -------------------------------------------------------------------

cat <<EOF

${OK}Autopsy plugin installed.${RESET}

${BOLD}Next steps${RESET}

  1. Make sure the Autopsy service is running (see github.com/$REPO).
  2. Set these env vars (or add to .env) so the plugin can reach it:

       AAG_URL=http://localhost:4000   ${DIM}# where the Autopsy service is running${RESET}
       AAG_TOKEN=                      ${DIM}# optional auth token${RESET}

  3. Start opencode as usual — the plugin loads automatically.

${DIM}Re-run \`curl -fsSL https://install.autopsy.surf/install.sh | bash\` any time to update.${RESET}

EOF

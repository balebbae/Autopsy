#!/usr/bin/env bash
# Symlink the plugin source into .opencode/plugins/ so opencode auto-loads it.
# Run from the repo root: `make plugin-link`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/plugin/src/index.ts"
DST="$ROOT/.opencode/plugins/autopsy.ts"

if [[ ! -f "$SRC" ]]; then
  echo "plugin source not found: $SRC" >&2
  exit 1
fi

mkdir -p "$ROOT/.opencode/plugins"
ln -sf "$SRC" "$DST"
echo "linked $DST -> $SRC"

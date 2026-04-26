#!/usr/bin/env bash
# scripts/demo-prep.sh — one-shot bring-up + verify for a fresh demo machine.
#
# 1. Picks the embedding provider that will actually work on this machine
#    (preferring richer signal: openai > local > stub) and writes it into
#    `.env` so subsequent commands inherit it.
# 2. Boots postgres via `docker compose` (v2) or `docker-compose` (v1).
# 3. Syncs service deps (with the `ml` extra when EMBED_PROVIDER=local).
# 4. Starts uvicorn long enough to seed the graph and run the closed-loop
#    `trace-preflight.py` probe, then stops it.
#
# Idempotent — safe to re-run. Run from the repo root:
#   make demo-prep
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  OK=$(printf '\033[32m');  WARN=$(printf '\033[33m')
  ERR=$(printf '\033[31m'); RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; OK=""; WARN=""; ERR=""; RESET=""
fi
log()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
okay() { printf '  %s✓%s %s\n' "$OK" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$WARN" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$ERR" "$RESET" "$*" >&2; exit 1; }

# --- 1. .env + embedding provider ----------------------------------------

if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi

# Read API keys from the env or .env (env wins). We don't echo values.
GEMINI_KEY="${GEMINI_API_KEY:-}"
if [ -z "$GEMINI_KEY" ] && grep -qE '^GEMINI_API_KEY=.+' .env; then
  GEMINI_KEY="$(grep -E '^GEMINI_API_KEY=' .env | head -1 | cut -d= -f2-)"
fi
OPENAI_KEY="${OPENAI_API_KEY:-}"
if [ -z "$OPENAI_KEY" ] && grep -qE '^OPENAI_API_KEY=.+' .env; then
  OPENAI_KEY="$(grep -E '^OPENAI_API_KEY=' .env | head -1 | cut -d= -f2-)"
fi

# Decide which provider is actually viable on this box.
# Priority: gemini (free, same key as Gemma classifier) > openai > local > stub.
PROVIDER="stub"
if [ -n "$GEMINI_KEY" ]; then
  PROVIDER="gemini"
elif [ -n "$OPENAI_KEY" ]; then
  PROVIDER="openai"
elif [ -d "service/.venv" ] && service/.venv/bin/python -c 'import sentence_transformers' 2>/dev/null; then
  PROVIDER="local"
fi
log "embedding provider: $PROVIDER"
case "$PROVIDER" in
  gemini) okay "GEMINI_API_KEY present — using Google gemini-embedding-001 truncated to 768d (free tier)" ;;
  openai) okay "OPENAI_API_KEY present — using hosted OpenAI embeddings (1536d, requires embed-reset)" ;;
  local)  okay "sentence-transformers installed — using local embeddings (384d, requires embed-reset)" ;;
  stub)
    warn "no GEMINI_API_KEY and no OPENAI_API_KEY and no sentence-transformers — falling back to deterministic stub."
    warn "preflight will only fire on byte-identical prompts. Set GEMINI_API_KEY in .env to upgrade (free)."
    ;;
esac

# Update EMBED_PROVIDER in .env (idempotent).
if grep -qE '^EMBED_PROVIDER=' .env; then
  sed -i.bak -E "s|^EMBED_PROVIDER=.*|EMBED_PROVIDER=$PROVIDER|" .env && rm -f .env.bak
else
  printf '\nEMBED_PROVIDER=%s\n' "$PROVIDER" >> .env
fi

# --- 2. postgres ---------------------------------------------------------

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  fail "neither 'docker compose' (v2) nor 'docker-compose' (v1) found — install Docker Desktop."
fi

log "postgres"
$COMPOSE -f infra/docker-compose.yml up -d >/dev/null
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' aag-postgres 2>/dev/null || echo none)
  if [ "$status" = "healthy" ]; then okay "postgres healthy at localhost:5432"; break; fi
  if [ "$i" = "30" ]; then fail "postgres did not become healthy in 30s"; fi
  sleep 1
done

# --- 3. service deps -----------------------------------------------------

log "service deps"
if [ "$PROVIDER" = "local" ]; then
  ( cd service && uv sync --extra ml ) >/dev/null
  okay "uv sync --extra ml"
else
  ( cd service && uv sync ) >/dev/null
  okay "uv sync"
fi

# --- 4. seed + verify ----------------------------------------------------

log "starting service for seed/verify"
( cd service && uv run uvicorn aag.main:app --host 127.0.0.1 --port 4000 ) \
  >/tmp/aag-demo-prep.log 2>&1 &
SVC=$!
trap 'kill "$SVC" 2>/dev/null || true; wait 2>/dev/null || true' EXIT

# Wait for /v1/health.
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:4000/v1/health >/dev/null 2>&1; then
    okay "service up at http://localhost:4000"
    break
  fi
  if [ "$i" = "20" ]; then
    tail -30 /tmp/aag-demo-prep.log >&2
    fail "service did not respond on /v1/health within 20s"
  fi
  sleep 1
done

log "seed"
( cd service && uv run python ../scripts/seed.py ) | tail -5

log "trace (closed-loop probe)"
if ( cd service && uv run python ../scripts/trace-preflight.py ) | tail -5; then
  okay "demo-prep complete — service ready, graph seeded, preflight verified"
  echo
  echo "  next:"
  echo "    make service-dev      # foreground service"
  echo "    make dashboard-dev    # dashboard at http://localhost:3000"
else
  fail "trace-preflight.py failed — check /tmp/aag-demo-prep.log"
fi

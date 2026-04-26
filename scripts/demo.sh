#!/usr/bin/env bash
# scripts/demo.sh — bulletproof one-shot for live demos.
#
# DESTRUCTIVE: drops the postgres volume so every demo starts on a clean
# graph. Then boots postgres, picks an embedding provider, syncs deps,
# starts the service, seeds 14 runs across 5 failure-mode clusters, runs
# Act 1 (fresh failure) + Act 2 (preflight catches a similar task), and
# starts the dashboard.
#
# Run via:  make demo
#
# After it finishes, hit Ctrl+C to stop service+dashboard. Postgres
# stays up so you can re-run `make demo` without waiting on docker again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  OK=$(printf '\033[32m');  WARN=$(printf '\033[33m')
  ERR=$(printf '\033[31m'); CYAN=$(printf '\033[36m')
  RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; OK=""; WARN=""; ERR=""; CYAN=""; RESET=""
fi
log()  { printf '%s▶%s %s\n' "$BOLD" "$RESET" "$*"; }
okay() { printf '  %s✓%s %s\n' "$OK" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$WARN" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$ERR" "$RESET" "$*" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  fail "docker compose not found"
fi
COMPOSE="$COMPOSE -f infra/docker-compose.yml"

# --- 1. .env + embedding provider ----------------------------------------

if [ ! -f .env ]; then
  log "creating .env from .env.example"
  cp .env.example .env
fi

GEMINI_KEY="${GEMINI_API_KEY:-}"
if [ -z "$GEMINI_KEY" ] && grep -qE '^GEMINI_API_KEY=.+' .env; then
  GEMINI_KEY="$(grep -E '^GEMINI_API_KEY=' .env | head -1 | cut -d= -f2-)"
fi

# Decide embedding provider. Priority: gemini (best quality, free) > local
# (sentence-transformers, offline) > stub (byte-identical retrieval only).
PROVIDER="stub"
if [ -n "$GEMINI_KEY" ]; then
  PROVIDER="gemini"
elif [ -d "service/.venv" ] && service/.venv/bin/python -c 'import sentence_transformers' 2>/dev/null; then
  PROVIDER="local"
fi
log "embedding provider: ${BOLD}${PROVIDER}${RESET}"

case "$PROVIDER" in
  gemini) okay "GEMINI_API_KEY present — using gemini-embedding-001 truncated to 768d" ;;
  local)  okay "sentence-transformers installed — using local embeddings (384d)" ;;
  stub)
    warn "no GEMINI_API_KEY and no sentence-transformers — falling back to stub."
    warn "Act 2 retrieval will only fire on byte-identical prompts."
    warn "Set GEMINI_API_KEY in .env or run 'cd service && uv sync --extra ml' for real similarity."
    ;;
esac

# Update .env (idempotent).
if grep -qE '^EMBED_PROVIDER=' .env; then
  sed -i.bak -E "s|^EMBED_PROVIDER=.*|EMBED_PROVIDER=$PROVIDER|" .env && rm -f .env.bak
else
  printf '\nEMBED_PROVIDER=%s\n' "$PROVIDER" >> .env
fi

# --- 2. Postgres (clean slate) -------------------------------------------

log "postgres (clean reset)"
$COMPOSE down -v >/dev/null 2>&1 || true
$COMPOSE up -d >/dev/null

for i in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' aag-postgres 2>/dev/null || echo none)
  if [ "$status" = "healthy" ]; then
    okay "postgres healthy at localhost:5432"
    break
  fi
  [ "$i" = "40" ] && fail "postgres not healthy after 40s"
  sleep 1
done

# --- 3. Service deps -----------------------------------------------------

log "service deps"
if [ "$PROVIDER" = "local" ]; then
  (cd service && uv sync --extra ml >/dev/null 2>&1)
else
  (cd service && uv sync >/dev/null 2>&1)
fi
okay "uv sync"

# --- 4. Embeddings dim alignment -----------------------------------------
#
# When we just dropped the postgres volume, the schema is freshly applied
# from contracts/db-schema.sql at vector(768) (the gemini/stub default).
# If the chosen provider is `local` (384) or `openai` (1536), recreate.

if [ "$PROVIDER" = "local" ] || [ "$PROVIDER" = "openai" ]; then
  log "embed-reset (provider=$PROVIDER)"
  (cd service && uv run python ../scripts/embed-reset.py >/dev/null 2>&1)
  okay "embeddings table aligned"
fi

# --- 5. Service + dashboard (background, logs to /tmp) -------------------

mkdir -p /tmp/aag-demo
SVC_LOG=/tmp/aag-demo/service.log
DASH_LOG=/tmp/aag-demo/dashboard.log

# Kill any prior demo processes.
pkill -f 'uvicorn aag.main:app' 2>/dev/null || true
pkill -f 'next dev' 2>/dev/null || true
sleep 1

log "starting service (logs: $SVC_LOG)"
(
  cd service
  nohup uv run uvicorn aag.main:app --host 0.0.0.0 --port 4000 \
    > "$SVC_LOG" 2>&1 &
)

# Wait for /v1/health.
for i in $(seq 1 30); do
  if curl -fsS http://localhost:4000/v1/health >/dev/null 2>&1; then
    okay "service up at http://localhost:4000"
    break
  fi
  [ "$i" = "30" ] && { tail -30 "$SVC_LOG"; fail "service did not respond on /v1/health within 30s"; }
  sleep 1
done

# --- 6. Seed + Acts ------------------------------------------------------

log "seeding the demo graph"
(cd service && uv run python ../scripts/seed-demo.py)

# --- 7. Dashboard (foreground-ish) ---------------------------------------

log "starting dashboard (logs: $DASH_LOG)"
(
  cd dashboard
  if [ ! -d node_modules ]; then
    npm install >/dev/null 2>&1
  fi
  nohup npm run dev > "$DASH_LOG" 2>&1 &
)

# Wait for dashboard.
for i in $(seq 1 60); do
  if curl -fsS http://localhost:3000 >/dev/null 2>&1; then
    okay "dashboard up at http://localhost:3000"
    break
  fi
  [ "$i" = "60" ] && { tail -30 "$DASH_LOG"; warn "dashboard did not respond on :3000 within 60s — check $DASH_LOG"; break; }
  sleep 1
done

cat <<EOF

${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}
${BOLD}  Demo is live.${RESET}
${BOLD}${CYAN}════════════════════════════════════════════════════════════════${RESET}

  ${BOLD}runs${RESET}           http://localhost:3000
  ${BOLD}graph${RESET}          http://localhost:3000/graph
  ${BOLD}retrieval view${RESET} http://localhost:3000/graph?view=retrieval
  ${BOLD}timeline view${RESET}  http://localhost:3000/graph?view=timeline
  ${BOLD}branched view${RESET}  http://localhost:3000/graph?view=branched

  ${BOLD}Act 1 (fresh failure)${RESET}     http://localhost:3000/runs/demo-act1-flagged-pricing
  ${BOLD}Act 2 (preflight caught)${RESET}  http://localhost:3000/runs/demo-act2-customer-deleted-at

  ${DIM}service log:    $SVC_LOG${RESET}
  ${DIM}dashboard log:  $DASH_LOG${RESET}

  ${DIM}'make stop' to kill service + dashboard. Postgres stays up.${RESET}
  ${DIM}'make demo' is safe to re-run — it resets the DB.${RESET}

EOF

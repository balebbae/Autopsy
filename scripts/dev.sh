#!/usr/bin/env bash
# scripts/dev.sh — bring up the full local stack with one command.
#
# Starts postgres (docker), the FastAPI service, and the Next.js dashboard.
# Streams both servers' logs to stdout with line prefixes.
# Ctrl+C tears down the foreground servers cleanly; postgres stays up.
#
# Run via:  make dev
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE="docker-compose -f infra/docker-compose.yml"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
gray() { printf '\033[2m%s\033[0m\n' "$1"; }

# --- 1. Postgres ----------------------------------------------------------

bold "▶ postgres"
$COMPOSE up -d >/dev/null

# Wait for the container's healthcheck (defined in docker-compose.yml).
for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' aag-postgres 2>/dev/null || echo none)
  if [ "$status" = "healthy" ]; then
    gray "  postgres: healthy at localhost:5432 (db=aag user=aag pass=aag)"
    break
  fi
  if [ "$i" = "30" ]; then
    echo "postgres did not become healthy in 30s; check '$COMPOSE logs postgres'" >&2
    exit 1
  fi
  sleep 1
done

# --- 2. Service (FastAPI / uvicorn) ---------------------------------------

bold "▶ service"
gray "  http://localhost:4000        (api)"
gray "  http://localhost:4000/docs   (openapi)"

# --- 3. Dashboard (Next.js) -----------------------------------------------

bold "▶ dashboard"
gray "  http://localhost:3000"
echo
gray "Ctrl+C stops service + dashboard. Postgres stays up; 'make compose-down' to stop it."
echo

prefix() {
  local tag="$1"; shift
  "$@" 2>&1 | sed -u "s/^/[$tag] /"
}

prefix svc bash -c '
  cd service
  exec uv run uvicorn aag.main:app --reload --host 0.0.0.0 --port 4000
' &
SVC=$!

prefix dash bash -c '
  cd dashboard
  exec npm run dev
' &
DASH=$!

cleanup() {
  echo
  bold "▶ stopping"
  # Kill the entire process tree under each background subshell.
  pkill -P "$SVC" 2>/dev/null || true
  pkill -P "$DASH" 2>/dev/null || true
  kill "$SVC" "$DASH" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup INT TERM

wait

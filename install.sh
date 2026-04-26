#!/usr/bin/env bash
# Install Autopsy. By default brings up the full local stack
# (postgres + service + dashboard) and installs the opencode plugin into the
# current project. Re-run any time to update.
#
# Usage (from your project root):
#   curl -fsSL https://install.autopsy.surf/install.sh | bash
#   curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --plugin-only
#   curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --no-start
#   curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --no-prompt
#
# Flags:
#   --plugin-only   Skip the local stack, install only the plugin (point
#                   AAG_URL at an existing Autopsy service).
#   --no-start      Set up everything but don't start service/dashboard.
#                   Postgres still comes up.
#   --no-prompt     Don't prompt for the optional Gemini API key. The service
#                   stays in deterministic-classifier-only mode.
#   --help, -h      Print this message.
set -euo pipefail

# ---- aesthetics ----------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  OK=$(printf '\033[32m');   WARN=$(printf '\033[33m')
  ERR=$(printf '\033[31m');  RESET=$(printf '\033[0m')
else
  BOLD=""; DIM=""; OK=""; WARN=""; ERR=""; RESET=""
fi

log()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
okay() { printf '  %s✓%s %s\n' "$OK" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$WARN" "$RESET" "$*" >&2; }
fail() { printf '%serror:%s %s\n' "$ERR" "$RESET" "$*" >&2; exit 1; }

print_help() {
  cat <<'HELP'
Install Autopsy. By default brings up the full local stack
(postgres + service + dashboard) and installs the opencode plugin into
the current project. Re-run any time to update.

Usage (from your project root):
  curl -fsSL https://install.autopsy.surf/install.sh | bash
  curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --plugin-only
  curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --no-start
  curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --no-prompt

Flags:
  --plugin-only   Skip the local stack, install only the plugin (point
                  AAG_URL at an existing Autopsy service).
  --no-start      Set up everything but do not start the service or dashboard.
                  Postgres still comes up.
  --no-prompt     Don't prompt for the optional Gemini API key. The service
                  stays in deterministic-classifier-only mode.
  --help, -h      Print this message.

Environment:
  AUTOPSY_HOME    Override the install root (default: ~/.autopsy).
  AUTOPSY_NO_PROMPT=1
                  Same as --no-prompt.
  GEMINI_API_KEY  If set in the calling shell, skips the prompt and uses the
                  given key for the LLM enhancer.
HELP
}

# ---- args ----------------------------------------------------------------
PLUGIN_ONLY=0
NO_START=0
NO_PROMPT="${AUTOPSY_NO_PROMPT:-0}"
for arg in "$@"; do
  case "$arg" in
    --plugin-only) PLUGIN_ONLY=1 ;;
    --no-start)    NO_START=1 ;;
    --no-prompt)   NO_PROMPT=1 ;;
    --help|-h)     print_help; exit 0 ;;
    *) warn "ignoring unknown arg: $arg" ;;
  esac
done

# ---- paths ---------------------------------------------------------------
PROJECT_DIR="$(pwd)"
INSTALL_ROOT="${AUTOPSY_HOME:-$HOME/.autopsy}"
REPO_DIR="$INSTALL_ROOT/Autopsy"
RUN_DIR="$INSTALL_ROOT/run"
mkdir -p "$INSTALL_ROOT" "$RUN_DIR"

REPO="balebbae/Autopsy"
BRANCH="main"
SDK_PKG="@opencode-ai/plugin"
SDK_VERSION="1.14.25"

# ---- preflight -----------------------------------------------------------
need() {
  command -v "$1" >/dev/null 2>&1 \
    || fail "$1 is required but not on PATH${2:+ (}${2:-}${2:+)}"
}

need bun  "https://bun.sh"
need curl ""
need tar  ""

DOCKER_COMPOSE=""
if [ "$PLUGIN_ONLY" -eq 0 ]; then
  need git    "https://git-scm.com"
  need uv     "https://docs.astral.sh/uv/getting-started/installation/"
  need node   "https://nodejs.org"
  need npm    "ships with node"
  need docker "Docker Desktop or OrbStack on macOS, otherwise docker-ce"

  if ! docker info >/dev/null 2>&1; then
    fail "docker is installed but the daemon isn't running"
  fi

  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE="docker-compose"
  else
    fail "neither 'docker compose' (v2 plugin) nor 'docker-compose' (v1) found"
  fi
fi

# =========================================================================
# Plugin-only path: original behavior. Tarball, build, drop into project.
# =========================================================================
if [ "$PLUGIN_ONLY" -eq 1 ]; then
  TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
  log "downloading plugin source from github.com/$REPO ($BRANCH)"
  curl -fsSL "https://github.com/$REPO/archive/$BRANCH.tar.gz" \
    | tar -xz -C "$TMP" --strip-components=1
  [ -f "$TMP/plugin/src/index.ts" ] || fail "plugin source not found in archive"

  log "building plugin bundle"
  (
    cd "$TMP/plugin"
    bun install --frozen-lockfile 2>/dev/null || bun install
    bun build src/index.ts \
      --outfile=dist/autopsy.js \
      --target=bun --format=esm \
      --external "$SDK_PKG"
  ) >/dev/null 2>&1 || fail "plugin build failed (re-run with bash -x for details)"

  mkdir -p "$PROJECT_DIR/.opencode/plugins"
  cp "$TMP/plugin/dist/autopsy.js" "$PROJECT_DIR/.opencode/plugins/autopsy.js"
  okay "installed $PROJECT_DIR/.opencode/plugins/autopsy.js"

  [ -f "$PROJECT_DIR/.opencode/package.json" ] || echo '{}' > "$PROJECT_DIR/.opencode/package.json"
  if ! grep -q "$SDK_PKG" "$PROJECT_DIR/.opencode/package.json"; then
    log "installing $SDK_PKG@$SDK_VERSION"
    (cd "$PROJECT_DIR/.opencode" && bun add "$SDK_PKG@$SDK_VERSION") >/dev/null 2>&1 \
      || fail "failed to install $SDK_PKG"
    okay "installed $SDK_PKG@$SDK_VERSION"
  fi

  cat <<EOF

${OK}Autopsy plugin installed (plugin-only mode).${RESET}

${BOLD}Next steps${RESET}
  1. Make sure an Autopsy service is reachable (point AAG_URL at it).
     ${DIM}export AAG_URL=http://localhost:4000${RESET}
  2. Start opencode as usual.

${DIM}Re-run without --plugin-only to bring up a local service + dashboard.${RESET}

EOF
  exit 0
fi

# =========================================================================
# Full-stack path
# =========================================================================

# 1. clone or update the repo into ~/.autopsy/Autopsy
if [ -d "$REPO_DIR/.git" ]; then
  log "updating $REPO_DIR"
  git -C "$REPO_DIR" fetch --quiet origin "$BRANCH"
  git -C "$REPO_DIR" reset --quiet --hard "origin/$BRANCH"
  okay "synced to origin/$BRANCH"
else
  log "cloning github.com/$REPO into $REPO_DIR"
  git clone --quiet --depth 1 --branch "$BRANCH" \
    "https://github.com/$REPO.git" "$REPO_DIR"
  okay "cloned"
fi

COMPOSE="$DOCKER_COMPOSE -f $REPO_DIR/infra/docker-compose.yml"

# 2. postgres
log "starting postgres (pgvector/pgvector:pg16)"
$COMPOSE up -d >/dev/null

for i in $(seq 1 30); do
  status=$(docker inspect -f '{{.State.Health.Status}}' aag-postgres 2>/dev/null || echo none)
  [ "$status" = "healthy" ] && { okay "postgres healthy on :5432"; break; }
  [ "$i" = "30" ] && fail "postgres did not become healthy in 30s; check '$COMPOSE logs postgres'"
  sleep 1
done

# 3. service deps
log "installing service deps (uv sync)"
( cd "$REPO_DIR/service" && uv sync --quiet )
okay "service ready"

# 4. dashboard deps
log "installing dashboard deps (npm install)"
( cd "$REPO_DIR/dashboard" && npm install --silent --no-audit --no-fund )
okay "dashboard ready"

# 5. build plugin and copy into the project
log "building plugin bundle"
(
  cd "$REPO_DIR/plugin"
  bun install --silent --frozen-lockfile 2>/dev/null || bun install --silent
  bun build src/index.ts \
    --outfile=dist/autopsy.js \
    --target=bun --format=esm \
    --external "$SDK_PKG" >/dev/null 2>&1
) || fail "plugin build failed"

mkdir -p "$PROJECT_DIR/.opencode/plugins"
cp "$REPO_DIR/plugin/dist/autopsy.js" "$PROJECT_DIR/.opencode/plugins/autopsy.js"
okay "installed $PROJECT_DIR/.opencode/plugins/autopsy.js"

[ -f "$PROJECT_DIR/.opencode/package.json" ] || echo '{}' > "$PROJECT_DIR/.opencode/package.json"
if ! grep -q "$SDK_PKG" "$PROJECT_DIR/.opencode/package.json"; then
  ( cd "$PROJECT_DIR/.opencode" && bun add "$SDK_PKG@$SDK_VERSION" >/dev/null 2>&1 ) \
    || fail "failed to install $SDK_PKG"
  okay "installed $SDK_PKG@$SDK_VERSION"
fi

# 6. project .env
ENV_FILE="$PROJECT_DIR/.env"
if ! grep -q '^AAG_URL=' "$ENV_FILE" 2>/dev/null; then
  printf '\n# Autopsy\nAAG_URL=http://localhost:4000\n' >> "$ENV_FILE"
  okay "wrote AAG_URL=http://localhost:4000 to $ENV_FILE"
fi

# 6b. optional Gemini key. When supplied, configures BOTH the LLM enhancer
#     (Gemma classifier) AND the embedding provider (Google text-embedding-004,
#     768-d, free tier on the same key). Skip if --no-prompt, no /dev/tty,
#     or the key is already set in the calling shell or service .env.
SERVICE_ENV="$REPO_DIR/.env"
GEMMA_CONFIGURED=0
EMBED_PROVIDER_CHANGED=0

write_gemma_env() {
  # $1 = key
  {
    printf '\n# Autopsy LLM enhancer\n'
    printf 'LLM_PROVIDER=gemma\n'
    printf 'GEMINI_API_KEY=%s\n' "$1"
    printf 'PREFLIGHT_LLM_ENABLED=true\n'
  } >> "$SERVICE_ENV"
}

# Idempotent: replace any existing EMBED_PROVIDER= line, otherwise append.
# Returns 0 if the value changed (caller should run `embed-reset`), 1 otherwise.
set_embed_provider() {
  # $1 = provider (stub|local|openai|gemini)
  local desired="$1"
  local current=""
  if [ -f "$SERVICE_ENV" ]; then
    current="$(grep -E '^EMBED_PROVIDER=' "$SERVICE_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)"
  fi
  if [ "$current" = "$desired" ]; then
    return 1
  fi
  if [ -f "$SERVICE_ENV" ] && grep -qE '^EMBED_PROVIDER=' "$SERVICE_ENV"; then
    sed -i.bak -E "s|^EMBED_PROVIDER=.*|EMBED_PROVIDER=$desired|" "$SERVICE_ENV" \
      && rm -f "$SERVICE_ENV.bak"
  else
    printf '\n# Autopsy embeddings\nEMBED_PROVIDER=%s\n' "$desired" >> "$SERVICE_ENV"
  fi
  return 0
}

if grep -qE '^GEMINI_API_KEY=.+' "$SERVICE_ENV" 2>/dev/null; then
  GEMMA_CONFIGURED=1
  okay "Gemini key already in $SERVICE_ENV (LLM enhancer enabled)"
elif [ -n "${GEMINI_API_KEY:-}" ]; then
  write_gemma_env "$GEMINI_API_KEY"
  GEMMA_CONFIGURED=1
  okay "wrote GEMINI_API_KEY (from env) to $SERVICE_ENV"
elif [ "$NO_PROMPT" -eq 0 ] && [ -e /dev/tty ]; then
  printf '\n%sGemini API key (optional, recommended)%s\n' "$BOLD" "$RESET"
  printf '  Enables LLM-augmented failure analysis AND semantic-similarity\n'
  printf '  retrieval (Google text-embedding-004, free tier).\n'
  printf '  Without it, retrieval falls back to deterministic stub embeddings\n'
  printf '  that only match byte-identical task strings.\n'
  printf '  Get a key at %shttps://ai.google.dev%s. Press Enter to skip.\n\n' "$DIM" "$RESET"
  printf '  Gemini API key: '
  GEMINI_INPUT=""
  IFS= read -r GEMINI_INPUT < /dev/tty || GEMINI_INPUT=""
  if [ -n "$GEMINI_INPUT" ]; then
    write_gemma_env "$GEMINI_INPUT"
    GEMMA_CONFIGURED=1
    okay "wrote Gemini key to $SERVICE_ENV (LLM enhancer + embeddings)"
  else
    okay "skipped — running with deterministic classifier + stub embeddings"
  fi
else
  log "skipping Gemini prompt (deterministic classifier + stub embeddings)"
fi

# Flip embeddings to gemini when (and only when) the key is configured.
# This must happen before the service starts so verify_vector_dim() doesn't
# crash on the dim mismatch baked into contracts/db-schema.sql (vector(384)).
if [ "$GEMMA_CONFIGURED" -eq 1 ]; then
  if set_embed_provider gemini; then
    EMBED_PROVIDER_CHANGED=1
    okay "set EMBED_PROVIDER=gemini in $SERVICE_ENV (768-d embeddings)"
  fi
fi

# Recreate the embeddings table at the right dim when we just flipped the
# provider. Destructive in theory, but on a fresh install the table is empty
# (or doesn't exist yet) so nothing of value is lost. Skipped silently when
# scripts/embed-reset.py isn't bundled (e.g. older repo checkouts).
if [ "$EMBED_PROVIDER_CHANGED" -eq 1 ] \
    && [ -f "$REPO_DIR/scripts/embed-reset.py" ]; then
  log "recreating embeddings table to match EMBED_PROVIDER=gemini (uv run embed-reset.py)"
  if ( cd "$REPO_DIR/service" && uv run --quiet python ../scripts/embed-reset.py ) \
      >"$RUN_DIR/embed-reset.log" 2>&1; then
    okay "embeddings table recreated at 768-d"
  else
    warn "embed-reset failed; service may refuse to start with EMBED_PROVIDER=gemini."
    warn "  see $RUN_DIR/embed-reset.log; you can re-run \`make embed-reset\` manually."
  fi
fi

# 7. start service + dashboard
SERVICE_PID="$RUN_DIR/service.pid"
DASHBOARD_PID="$RUN_DIR/dashboard.pid"

stop_pidfile() {
  local f="$1"; [ -f "$f" ] || return 0
  local pid; pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

write_stop_script() {
  cat > "$INSTALL_ROOT/stop.sh" <<'STOPSH'
#!/usr/bin/env bash
# Stop the Autopsy service + dashboard. Postgres also stopped.
set -e
ROOT="${AUTOPSY_HOME:-$HOME/.autopsy}"
RUN="$ROOT/run"
REPO="$ROOT/Autopsy"
for f in service.pid dashboard.pid; do
  if [ -f "$RUN/$f" ]; then
    pid="$(cat "$RUN/$f" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$RUN/$f"
    echo "stopped $(basename "$f" .pid)"
  fi
done
if docker compose version >/dev/null 2>&1; then
  docker compose -f "$REPO/infra/docker-compose.yml" stop >/dev/null
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose -f "$REPO/infra/docker-compose.yml" stop >/dev/null
fi
echo "stopped postgres"
STOPSH
  chmod +x "$INSTALL_ROOT/stop.sh"
}

if [ "$NO_START" -eq 0 ]; then
  log "starting service + dashboard in the background"
  stop_pidfile "$SERVICE_PID"
  stop_pidfile "$DASHBOARD_PID"

  ( cd "$REPO_DIR/service" && \
    nohup uv run uvicorn aag.main:app --host 0.0.0.0 --port 4000 \
      > "$RUN_DIR/service.log" 2>&1 & echo $! > "$SERVICE_PID" )

  ( cd "$REPO_DIR/dashboard" && \
    NEXT_PUBLIC_AAG_URL="http://localhost:4000" \
    nohup npm run dev -- --port 3000 \
      > "$RUN_DIR/dashboard.log" 2>&1 & echo $! > "$DASHBOARD_PID" )

  for i in $(seq 1 45); do
    if curl -fsS http://localhost:4000/v1/health >/dev/null 2>&1; then
      okay "service up at http://localhost:4000"
      break
    fi
    [ "$i" = "45" ] && warn "service didn't respond on :4000 in 45s; check $RUN_DIR/service.log"
    sleep 1
  done

  for i in $(seq 1 60); do
    if curl -fsS http://localhost:3000 >/dev/null 2>&1; then
      okay "dashboard up at http://localhost:3000"
      break
    fi
    [ "$i" = "60" ] && warn "dashboard didn't respond on :3000 in 60s; check $RUN_DIR/dashboard.log"
    sleep 1
  done

  write_stop_script
fi

# 8. final banner
if [ "$GEMMA_CONFIGURED" -eq 1 ]; then
  LLM_LINE="  ${BOLD}LLM${RESET}        Gemma via Google AI Studio (key in $SERVICE_ENV)"
  EMBED_LINE="  ${BOLD}Embeddings${RESET} Google text-embedding-004 (768-d, same key)"
else
  LLM_LINE="  ${BOLD}LLM${RESET}        ${DIM}deterministic classifier only — re-run to add a Gemini key${RESET}"
  EMBED_LINE="  ${BOLD}Embeddings${RESET} ${DIM}stub (byte-identical match only) — add a Gemini key for semantic similarity${RESET}"
fi

cat <<EOF

${OK}Autopsy is up.${RESET}

  ${BOLD}Plugin${RESET}     $PROJECT_DIR/.opencode/plugins/autopsy.js
  ${BOLD}Service${RESET}    http://localhost:4000  ${DIM}docs at /docs${RESET}
  ${BOLD}Dashboard${RESET}  http://localhost:3000
  ${BOLD}Postgres${RESET}   localhost:5432  ${DIM}db=aag user=aag pass=aag${RESET}
  ${BOLD}.env${RESET}       AAG_URL=http://localhost:4000
$LLM_LINE
$EMBED_LINE

${BOLD}Files${RESET}
  $REPO_DIR                  ${DIM}# cloned repo${RESET}
  $RUN_DIR/service.log       ${DIM}# service stdout/stderr${RESET}
  $RUN_DIR/dashboard.log     ${DIM}# dashboard stdout/stderr${RESET}
  $INSTALL_ROOT/stop.sh      ${DIM}# stop everything${RESET}

${BOLD}Next${RESET}
  • Start opencode in this directory; the plugin loads automatically.
  • Open http://localhost:3000 in your browser to watch runs live.
  • Re-run \`curl -fsSL https://install.autopsy.surf/install.sh | bash\` to update.

EOF

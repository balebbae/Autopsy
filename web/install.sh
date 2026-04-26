#!/usr/bin/env bash
# Install Autopsy. By default brings up the full local stack
# (postgres + service + dashboard) and installs the opencode plugin into the
# current project. Re-run any time to update.
#
# Usage (from your project root):
#   curl -fsSL https://install.autopsy.surf/install.sh | bash
#   curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --plugin-only
#   curl -fsSL https://install.autopsy.surf/install.sh | bash -s -- --no-start
#
# Flags:
#   --plugin-only   Skip the local stack, install only the plugin (point
#                   AAG_URL at an existing Autopsy service).
#   --no-start      Set up everything but don't start service/dashboard.
#                   Postgres still comes up.
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
  sed -n '1,16s/^# \{0,1\}//p' "$0" 2>/dev/null || sed -n '2,16p' "$0"
}

# ---- args ----------------------------------------------------------------
PLUGIN_ONLY=0
NO_START=0
for arg in "$@"; do
  case "$arg" in
    --plugin-only) PLUGIN_ONLY=1 ;;
    --no-start)    NO_START=1 ;;
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
cat <<EOF

${OK}Autopsy is up.${RESET}

  ${BOLD}Plugin${RESET}     $PROJECT_DIR/.opencode/plugins/autopsy.js
  ${BOLD}Service${RESET}    http://localhost:4000  ${DIM}docs at /docs${RESET}
  ${BOLD}Dashboard${RESET}  http://localhost:3000
  ${BOLD}Postgres${RESET}   localhost:5432  ${DIM}db=aag user=aag pass=aag${RESET}
  ${BOLD}.env${RESET}       AAG_URL=http://localhost:4000

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

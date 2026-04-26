# Agent Autopsy Graph — dev shortcuts.
# All commands assume you run them from the repo root.

# Pick docker compose v2 (`docker compose`) when present, else fall back to the
# legacy v1 binary (`docker-compose`). Most modern Docker installs only ship v2.
COMPOSE := $(shell docker compose version >/dev/null 2>&1 && echo 'docker compose' || echo 'docker-compose') -f infra/docker-compose.yml

.PHONY: help dev stop install demo-prep \
        compose-up compose-down compose-logs db-reset embed-reset \
        service-install service-dev service-test service-lint \
        plugin-install plugin-link plugin-unlink \
        dashboard-install dashboard-dev \
        seed replay reindex clean

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  %-20s %s\n", $$1, $$2}'

# --- One-shot quickstart --------------------------------------------------

dev: install ## Quickstart: postgres + service (:4000) + dashboard (:3000), Ctrl+C to stop
	bash scripts/dev.sh

stop: ## Stop dashboard + service (postgres stays up); use compose-down to stop postgres too
	@-pkill -f 'uvicorn aag.main:app' 2>/dev/null || true
	@-pkill -f 'next dev'             2>/dev/null || true
	@echo "stopped service + dashboard (postgres still running; 'make compose-down' to stop it)"

install: service-install dashboard-install ## One-time deps install for service + dashboard

# --- Infra ----------------------------------------------------------------

compose-up: ## Start postgres+pgvector in the background
	$(COMPOSE) up -d
	@echo "Postgres up on localhost:5432 (db=aag user=aag pass=aag)"

compose-down: ## Stop infra
	$(COMPOSE) down

compose-logs: ## Tail postgres logs
	$(COMPOSE) logs -f postgres

db-reset: ## DESTRUCTIVE: drop and recreate the postgres volume
	$(COMPOSE) down -v
	$(COMPOSE) up -d

embed-reset: ## DESTRUCTIVE: drop + recreate embeddings table to match EMBED_PROVIDER's dim
	cd service && uv run python ../scripts/embed-reset.py

# --- Service (Python / FastAPI / uv) --------------------------------------

service-install: ## Sync python deps via uv
	cd service && uv sync

service-dev: ## Run FastAPI with hot reload on :4000
	cd service && uv run uvicorn aag.main:app --reload --host 0.0.0.0 --port 4000

service-test: ## Run service tests
	cd service && uv run pytest -q

service-lint: ## Run ruff
	cd service && uv run ruff check . && uv run ruff format --check .

# --- Plugin (TS opencode plugin) ------------------------------------------

plugin-install: ## Install plugin TS deps (requires bun)
	cd plugin && bun install

plugin-link: ## Symlink plugin source into .opencode/plugins/autopsy.ts
	bash scripts/link-plugin.sh

plugin-unlink: ## Remove the plugin symlink
	rm -f .opencode/plugins/autopsy.ts

# --- Dashboard (Next.js) --------------------------------------------------

dashboard-install: ## npm install in dashboard/
	cd dashboard && npm install

dashboard-dev: ## Run Next.js on :3000
	cd dashboard && npm run dev

# --- Helpers --------------------------------------------------------------

seed: ## Seed the graph with synthetic failure cases via the public API
	cd service && uv run python ../scripts/seed.py

replay: ## Replay a fixture run into POST /v1/events
	cd service && uv run python ../scripts/replay-fixture.py ../contracts/fixtures/run-rejected-schema.json

trace: ## Seed runs, then call /v1/preflight on each to verify the closed loop end-to-end
	cd service && uv run python ../scripts/trace-preflight.py

demo-prep: ## Boot postgres, seed the graph, and verify the closed loop end-to-end (uses scripts/demo-prep.sh)
	bash scripts/demo-prep.sh

demo: ## DESTRUCTIVE: reset DB, seed 14 runs across 5 clusters, run Act 1 + Act 2, start dashboard
	bash scripts/demo.sh

demo-seed: ## Seed-only: run scripts/seed-demo.py against an already-running service (no DB reset)
	cd service && uv run python ../scripts/seed-demo.py

reindex: ## Re-run the finalizer pipeline over every existing run (idempotent)
	cd service && uv run python ../scripts/reindex.py

# --- autopsy.surf landing -------------------------------------------------

site-og: ## Re-render site/og.png from scripts/og/template.html (1200x630 social card)
	bash scripts/og/render.sh

site-pack: ## Build dist/autopsy-surf.zip for direct upload to Cloudflare Pages (root domain)
	mkdir -p dist
	rm -f dist/autopsy-surf.zip
	cd site && zip -r -X ../dist/autopsy-surf.zip . -x '.DS_Store' '*.swp'
	@echo ""
	@echo "  built dist/autopsy-surf.zip"
	@echo "  upload at: https://dash.cloudflare.com/?to=/:account/pages/new/upload"

# --- install.autopsy.surf landing -----------------------------------------

web-pack: ## Sync install.sh into web/ and build dist/install-autopsy-surf.zip for Cloudflare Pages upload
	cp install.sh web/install.sh
	mkdir -p dist
	rm -f dist/install-autopsy-surf.zip
	cd web && zip -r -X ../dist/install-autopsy-surf.zip . -x '.DS_Store' '*.swp'
	@echo ""
	@echo "  built dist/install-autopsy-surf.zip"
	@echo "  upload at: https://dash.cloudflare.com/?to=/:account/pages/new/upload"

clean: ## Remove generated artifacts
	rm -rf service/.venv service/.pytest_cache service/.ruff_cache
	rm -rf plugin/node_modules plugin/dist
	rm -rf dashboard/node_modules dashboard/.next
	rm -rf dist

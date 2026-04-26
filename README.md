# Agent Autopsy Graph

A blackbox recorder for AI coding agents. Wraps an opencode runtime, records what the agent does, classifies failures, stores them in a graph + vector memory layer, and warns future runs before they repeat the same mistake.

## Repo layout

```
Autopsy/
├── .opencode/     opencode project dir; plugins/ is auto-loaded by opencode
├── plugin/        @aag/opencode-plugin — TS recorder + preflight client
├── service/       Python FastAPI ingestion + analyzer + graph + preflight
├── dashboard/     Next.js UI: live timeline, autopsy report, failure graph
├── infra/         docker-compose for postgres+pgvector, init.sql
├── contracts/     OpenAPI, DB schema, event mapping, run fixtures (HOUR-1 SoT)
├── scripts/       dev / seed / replay helpers
└── docs/          architecture, demo script, ownership map
```

opencode itself is **not** vendored in this repo. Install it separately
(<https://opencode.ai/docs/>) and run `opencode` from any project; our plugin
is loaded via the `.opencode/plugins/` symlink.

## Quickstart

Prereqs: `uv`, `node` 20+, `docker` (with compose). `opencode` and `bun` are
only needed if you want to exercise the recorder end-to-end against a real
agent run.

```bash
cp .env.example .env
make dev                  # starts postgres + service + dashboard
```

That single command:

1. Brings up **postgres+pgvector** at `localhost:5432` (via docker-compose; daemonized)
2. Starts the **FastAPI service** at <http://localhost:4000> (`/docs` for OpenAPI)
3. Starts the **Next.js dashboard** at <http://localhost:3000>

Service + dashboard logs stream to the same terminal with `[svc]` / `[dash]`
prefixes. **Ctrl+C** stops both cleanly. Postgres keeps running between
sessions; `make compose-down` stops it.

## Install in your project

From **your project's root** (not the Autopsy repo), run:

```bash
curl -fsSL https://install.autopsy.surf/install.sh | bash
```

This downloads the plugin source, bundles it, and places it at
`.opencode/plugins/autopsy.js`. Set these env vars (or add to `.env`) so the
plugin can reach the Autopsy service:

```bash
AAG_URL=http://localhost:4000   # where the Autopsy service is running
AAG_TOKEN=                      # optional auth token
```

Then start `opencode` as usual — the plugin loads automatically. Re-run the
curl command at any time to update to the latest version.

### For Autopsy contributors

If you're working on the plugin itself, use the dev symlink instead:

```bash
make plugin-link          # symlinks plugin/src/index.ts into .opencode/plugins/
opencode                  # loads the symlinked .ts source directly (hot-reloadable)
```

### Populate the dashboard without opencode

```bash
make replay               # streams contracts/fixtures/run-rejected-schema.json
```

Then refresh <http://localhost:3000>.

## Hour-1 contracts

Don't start coding before these four files are agreed on:

- `contracts/openapi.yaml` — every HTTP endpoint and its schema
- `contracts/db-schema.sql` — Postgres DDL for raw + graph + embeddings tables
- `contracts/events.md` — opencode bus event → AAG normalized event mapping
- `contracts/fixtures/run-rejected-schema.json` — handcrafted demo run for offline iteration

See `docs/ownership.md` for who owns which directory.

## What's left to build

R1 (Plugin) and R2 (Service ingestion) are complete. R3 (Analyzer/Graph) is
partially built — classifier and extractor are done, graph + preflight are stubs.
R4 (Dashboard) is ~60% done.

### R3 — Analyzer & Knowledge Graph

- [x] **Failure classifier** — rules-based pipeline: loads run+events+diffs, runs
      all rules, merges symptoms, picks highest-confidence failure mode. Currently
      heuristic/regex only — could be upgraded with a small LLM (e.g. Gemma) for
      deeper semantic classification (understanding *why* a change is incomplete
      rather than pattern-matching file paths and diff lines).
- [x] **Analyzer rules** — four deterministic rules implemented:
  - `rules/schema_change.py` — scan diffs for schema field additions
  - `rules/missing_migration.py` — detect missing migration when schema_change fires
  - `rules/missing_test.py` — detect code changes without corresponding test changes
  - `rules/frontend_drift.py` — detect backend type changes without frontend regen
- [x] **Entity extractor** — extracts files, components, tool calls, errors (stderr/exit
      codes), and threads classifier output into a structured `Extraction` for the graph writer.
- [x] **Finalizer wiring** — `workers/finalizer.py` chains classifier → persist FailureCase
      on run completion. Wired into the outcome route.
- [ ] **Graph writer orchestrator** — `upsert_node()` and `upsert_edge()` helpers exist, but no
      top-level pipeline that ties classifier output into graph construction.
- [ ] **Preflight traversal** — `graph/traversal.py` returns an empty response. Needs ANN vector
      search + 2-hop CTE over graph edges.
- [ ] **Embedding write path** — stub provider works, but `embeddings.write_for()` isn't called
      from anywhere yet.
- [ ] **Graph API routes** — `GET /v1/graph/nodes` and `GET /v1/graph/edges` are in the OpenAPI
      spec but have no route handlers.
- [ ] **Graph seeder** — `scripts/seed.py` only health-checks. Needs to create ~5 synthetic runs
      covering distinct failure modes.

### R4 — Dashboard

- [ ] **Graph visualization** — `/graph` page is a placeholder. Needs Cytoscape.js or react-flow
      rendering nodes/edges with filtering by FailureMode, Component, ChangePattern.
- [ ] **Live SSE updates** — SSE client infra exists in `src/lib/sse.ts` but isn't wired into
      any page.
- [ ] **Preflight warning panel** — referenced in architecture docs but not built in the dashboard.

### Plugin

- [x] **opencode 1.x API compatibility** — plugin reworked for opencode 1.x hook shape,
      rejection handling piggybacks on bus events.
- [ ] **Task enrichment** — `onToolBefore` posts an empty task string; should include the latest
      user message from the SDK client.

### Tests

- [x] Classifier + extractor unit tests (25 tests covering rules, helpers, extraction).
- [ ] Integration tests (ingestion routes, outcome → finalizer → DB pipeline).

## Demo loop

`docs/demo-script.md` contains the exact commands. Summary:

1. Run a "schema field addition" task in opencode → user rejects with "missed migration".
2. Service stores the run, analyzer classifies, graph writer records the failure.
3. Start a similar new task → preflight injects a system addendum + dashboard shows the warning panel.
4. Agent does the right thing the first time.

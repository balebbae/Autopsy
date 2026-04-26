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

## Status

The four pillars (plugin, service, analyzer/graph, dashboard) are end-to-end functional. The demo loop in `docs/demo-script.md` runs cleanly against `make dev`.

### Plugin (`plugin/`)
- opencode 1.x event/tool/permission/system handlers, batched event ingestion, preflight client.
- `tool.execute.before` context injection (`handlers/tool-before.ts`): blocks high-confidence past-failure matches with a graph-cited rationale, emits `aag.preflight.warned` / `aag.preflight.blocked` for the dashboard. Bounded by `AAG_PREFLIGHT_TIMEOUT_MS` with fail-open.
- Postflight code-check runner (`postflight.ts`): debounced lint/typecheck/test suite that files `automated_check_failed` rejections back into the graph.
- Frustration detection on user chat messages, dedup'd per session.

### Service (`service/`)
- `/v1/events`, `/v1/runs`, run diff/outcome/feedback routes, SSE re-broadcast on `/v1/runs/:id/stream`.
- Analyzer: four deterministic rules (`schema_change`, `missing_migration`, `missing_test`, `frontend_drift`), classifier, entity extractor, finalizer pipeline wired to the outcome route.
- Graph: `upsert_node` / `upsert_edge` primitives plus a top-level writer that consumes classifier output, vector embeddings (`embeddings.write_for`) for semantic similarity, ANN + 2-hop CTE traversal in `/v1/preflight`, and `GET /v1/graph/{nodes,edges}` for the dashboard.
- ~5k lines of pytest covering routes, finalizer, traversal, classifier, extractor, embeddings, and a full demo-loop integration test.

### Dashboard (`dashboard/`)
- Run list + detail pages with live SSE timeline (`run-refresher.tsx`, `timeline.tsx`).
- 3D force-graph explorer at `/graph` with filtering by FailureMode / Component / ChangePattern.
- Per-run preflight panel showing every `/v1/preflight` hit and which were blocking.

### Open work / nice-to-haves
- No CI yet — running `make service-lint`, `make service-test`, `bun run typecheck`, and the smoke tests on push would catch regressions early.
- The classifier is regex/heuristic only. An optional LLM pass for "*why* the change is incomplete" (vs. pattern-matching paths) is wired up behind `preflight_llm_enabled` for the preflight synth path but not for classification itself.
- `AAG_PREFLIGHT_TOOLS` defaults include `bash`, which means the injection handler can hard-block bash calls. Worth a deliberate yes/no per project.

## Demo loop

`docs/demo-script.md` contains the exact commands. Summary:

1. Run a "schema field addition" task in opencode → user rejects with "missed migration".
2. Service stores the run, analyzer classifies, graph writer records the failure.
3. Start a similar new task → preflight injects a system addendum and (for high-confidence matches) blocks the offending tool call with a cited rationale; the dashboard shows the warning + blocked events on the timeline.
4. Agent does the right thing the first time.

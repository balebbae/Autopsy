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

The plugin is **not a server** — it's a TypeScript file loaded by opencode at
runtime. To exercise it end-to-end, in a separate terminal:

```bash
make plugin-link          # symlink plugin/src/index.ts into .opencode/plugins/
opencode                  # run opencode against this directory (or any project
                          # whose .opencode/plugins/ contains autopsy.ts)
```

To populate the dashboard without running opencode:

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

## Demo loop

`docs/demo-script.md` contains the exact commands. Summary:

1. Run a "schema field addition" task in opencode → user rejects with "missed migration".
2. Service stores the run, analyzer classifies, graph writer records the failure.
3. Start a similar new task → preflight injects a system addendum + dashboard shows the warning panel.
4. Agent does the right thing the first time.

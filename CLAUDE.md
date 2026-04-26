# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

**Agent Autopsy Graph (AAG)** — a blackbox recorder for AI coding agents. An opencode plugin records bus events, the Python service classifies failures and writes them to a Postgres+pgvector knowledge graph, and the Next.js dashboard surfaces autopsies + preflight warnings so future runs avoid the same mistakes.

Four lanes coordinated through `contracts/` (the source of truth for HTTP/DB/event shapes):

```
plugin/      TS opencode plugin (recorder + preflight client)
service/     Python / FastAPI / SQLAlchemy async / pgvector
dashboard/   Next.js 16 + React 19 + Tailwind v4 (App Router)
infra/       docker-compose for postgres+pgvector
contracts/   openapi.yaml, db-schema.sql, events.md, fixtures/
```

Project guidance worth reading before editing a lane: `AGENTS.md` (root, workspace conventions), `dashboard/AGENTS.md` (Next.js 16 caveat), `docs/architecture.md` (full data-flow picture), `docs/ownership.md` (R1–R4 lane map).

## Common commands

The `Makefile` is the canonical command surface. Run from the repo root.

| Command | What it does |
|---|---|
| `make dev` | Runs `scripts/dev.sh`: postgres (background) + service (:4000) + dashboard (:3000); Ctrl+C stops fg only |
| `make install` | One-shot `service-install` + `dashboard-install` (uv sync + npm install). Plugin deps need `bun`: `make plugin-install` |
| `make stop` | Kill service + dashboard processes; postgres stays up (use `make compose-down` to stop it too) |
| `make compose-up` / `make compose-down` | Postgres in/out (volume preserved) |
| `make db-reset` | **DESTRUCTIVE** — drops the postgres volume; reapplies `contracts/db-schema.sql` on next boot |
| `make embed-reset` | **DESTRUCTIVE** — drop + recreate the embeddings table. Required after switching `EMBED_PROVIDER` between providers with different dims (gemini/stub=768, local=384, openai=1536). Gemini ↔ stub does NOT require a reset since both share the 768-d default schema. |
| `make service-dev` / `make service-test` / `make service-lint` | Uvicorn :4000 / pytest / ruff |
| `make dashboard-dev` | Next.js dev server on :3000 |
| `make plugin-link` / `make plugin-unlink` | Symlink `plugin/src/index.ts` into `.opencode/plugins/autopsy.ts` |
| `make seed` | Drive 5 synthetic failure runs through the public API (populates graph + embeddings) |
| `make replay` | Replay `contracts/fixtures/run-rejected-schema.json` into `/v1/events` |

### Tests

Tests live inside packages. Don't try to run them from the repo root.

```bash
cd service && uv run pytest -q                                       # all
cd service && uv run pytest tests/test_classifier.py -q              # one file
cd service && uv run pytest tests/test_classifier.py::test_name -q   # one test
```

`service/tests/conftest.py` forces `EMBED_PROVIDER=stub` for the whole session and recycles the async SQLAlchemy engine per test — pytest-asyncio creates a new event loop per test and the cached engine would otherwise raise "Future attached to a different loop".

The plugin has no test runner wired up (only a smoke file at `plugin/src/__smoke__/`). The dashboard has no test runner wired up; type-check with `cd dashboard && npx tsc --noEmit`.

## Architecture

### Components

```
opencode runtime ──┐
 (installed sep.)  │ hooks
                   ▼
        plugin/ (TS, loaded via .opencode/plugins/autopsy.ts)
                   │ HTTP (POST /v1/events, /v1/preflight, /v1/runs/:id/outcome)
                   ▼
        service/ (FastAPI on :4000, all routes prefixed /v1/)
          routes/      HTTP handlers (events, runs, preflight, stream, graph)
          ingestion/   assembler (events → rows + side-effects) + in-proc pubsub
          analyzer/    rules-based classifier + optional Gemma LLM enhancer
          graph/       writer (nodes/edges) + traversal (ANN + recursive CTE) + embeddings
          workers/     finalizer chains classifier → graph writer → embedder
          models/      SQLAlchemy ORM (mirrors contracts/db-schema.sql)
          schemas/     Pydantic v2 (mirrors contracts/openapi.yaml)
                   │
                   ▼
        Postgres + pgvector (pgvector/pgvector:pg16)
                   │
                   ▼
        dashboard/ (Next.js 16, SSE consumer in src/lib/sse.ts)
```

### Data flow per run

1. `session.created` → plugin batches and POSTs `/v1/events`. Service upserts `runs` row.
2. `tool.execute.before` for `edit`/`write`/`bash` → plugin POSTs `/v1/preflight`; if `block: true`, throws to abort the tool call.
3. `tool.execute.after` → plugin **synthesizes** an event (in opencode 1.x these are no longer on the bus). For `edit`/`write`, `result` carries `oldText`/`newText`; service captures it as `artifact(kind='diff')`.
4. `session.diff` → also stored as `artifact(kind='diff')`.
5. `permission.replied(reject)` → plugin POSTs `/v1/runs/:id/outcome` (status='rejected') and `/v1/runs/:id/feedback` if reason was captured. The plugin's `event` handler also auto-fires the rejection pipeline when a user message matches `FRUSTRATION_RE`.
6. `POST /v1/runs/:id/outcome` `await`s `workers.finalizer.on_run_complete(run_id)` inline — there is no task queue. Pipeline: rule-based classifier (+ optional Gemma) → persist `FailureCase` → `graph.writer.write` (Run/Task/File/Component/ChangePattern/Symptom/FailureMode/FixPattern/Outcome nodes; ATTEMPTED/TOUCHED/BELONGS_TO/HAD_CHANGE_PATTERN/EMITTED_SYMPTOM/INDICATES/RESOLVED_BY/RESULTED_IN edges) → `embeddings.write_for` (task/failure/fix/run_summary vectors).
7. Next session: plugin's `experimental.chat.system.transform` calls `/v1/preflight`. `graph/traversal.py` embeds the task → ANN over `embeddings(entity_type='task')` → recursive CTE up to **3 hops** over `graph_edges` (3 hops because Run → Symptom → FailureMode → FixPattern is three edges) → returns markdown `system_addendum` which the plugin appends to `output.system`.

### Cross-cutting conventions

- **`contracts/` is the source of truth.** Changing a route → update `contracts/openapi.yaml` AND `aag.schemas` AND the route in the same commit. Changing a table → update `contracts/db-schema.sql` AND the SQLAlchemy model (then `make db-reset` if local schema diverged).
- **All write paths are idempotent.** Events upsert on `(run_id, event_id)`. Graph edges upsert on `(source_id, target_id, type, evidence_run_id)`. Embeddings upsert on `(entity_type, entity_id)`.
- **Plugin must never block the LLM stream.** The `event` hook uses a fire-and-forget batcher (200ms / 32-event flush). Only `tool.execute.before` is allowed to block, and only briefly — that's the synchronous preflight.
- **No LLM in the preflight critical path.** Vector ANN + graph traversal must work offline. Gemma is opt-in (`LLM_PROVIDER=gemma`) and runs only at run-end inside the finalizer.
- **Embedding dim is 768** by default in `db-schema.sql` (sized for `EMBED_PROVIDER=gemini`, the default). The stub provider also emits 768-d vectors so dev/test boots share the same schema. Switching to `local` (sentence-transformers, 384-d) or `openai` (text-embedding-3-small, 1536-d) requires `make embed-reset`. Note: `text-embedding-004` is no longer available in v1beta — gemini uses `gemini-embedding-001` with `output_dimensionality=768` (MRL-truncated, semantically meaningful).
- **Two databases is one too many.** Recursive CTEs over `graph_edges` cover the traversal — don't reach for Neo4j.
- **In-process pubsub.** `aag.ingestion.pubsub` is single-process only. Replace with Postgres `LISTEN/NOTIFY` or Redis if scaling beyond one uvicorn worker.

## Environment

`cp .env.example .env`. Variables that matter:

- `DATABASE_URL` — defaults to `postgresql+asyncpg://aag:aag@localhost:5432/aag`. The `+asyncpg` driver hint is required.
- `AAG_URL`, `AAG_TOKEN` — plugin → service.
- `EMBED_PROVIDER` ∈ {`stub`, `local`, `openai`, `gemini`} — defaults to `gemini` (Google `gemini-embedding-001` MRL-truncated to 768-d via `output_dimensionality=768`; free tier, requires `GEMINI_API_KEY`). `stub` is the offline fallback (sha256-hashed deterministic noise) and shares the 768-d schema so dev/test envs can swap to it without `make embed-reset`. Tests force `stub` via `service/tests/conftest.py`.
- `LLM_PROVIDER` ∈ {`none`, `gemma`} + `GEMINI_API_KEY` + `GEMMA_MODEL` — opt-in classifier enhancer.
- `NEXT_PUBLIC_AAG_URL` — dashboard → service.

## Gotchas

- **Dashboard is Next.js 16 + React 19**, not the Next.js in your training data. `dashboard/CLAUDE.md` re-imports `dashboard/AGENTS.md` which says: read `node_modules/next/dist/docs/` before assuming any Next.js API.
- **opencode is not vendored.** Install from <https://opencode.ai/docs/>. The `.opencode/plugins/autopsy.ts` symlink is gitignored on purpose — every machine relinks via `make plugin-link`.
- **Python deps are managed by `uv`.** Use `uv add` / `uv remove`; do not hand-edit `pyproject.toml` deps. Python pinned to 3.12 by `service/.python-version`.
- **The `event` hook drops chatty bus events at the source** (see `NOISY_TYPES` in both `plugin/src/handlers/event.ts` and `service/src/aag/routes/events.py`). User-authored text parts are exempt because the classifier and Gemma both need them.
- **Diff artifacts have two shapes**: `session.diff` produces `{files: [...]}`; `tool.execute.after` for edit/write produces `{path, oldText, newText}`. Both `routes/runs._normalize_diff_files` and `analyzer/classifier._build_context` handle both — match that pattern when adding diff consumers.

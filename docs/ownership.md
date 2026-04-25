# Ownership

Four people, four lanes. Each person owns the directory marked **Primary**
and consults their backup if blocked.

## Lanes

| Role | Directory | Primary | Backup |
|---|---|---|---|
| **R1** Plugin / recorder | `plugin/` | __NAME__ | __NAME__ |
| **R2** Ingestion + trace | `service/src/aag/routes/`, `service/src/aag/ingestion/` | __NAME__ | __NAME__ |
| **R3** Analyzer + graph | `service/src/aag/analyzer/`, `service/src/aag/graph/`, `service/src/aag/workers/` | __NAME__ | __NAME__ |
| **R4** Dashboard + demo | `dashboard/`, `infra/`, `Makefile`, `scripts/`, `docs/demo-script.md` | __NAME__ | __NAME__ |

Co-owned (no single primary; co-edit from `contracts/`):

- `service/src/aag/models/` — SQLAlchemy ORM
- `service/src/aag/schemas/` — Pydantic v2

## Hour-1 contracts (everyone, before any deep work)

1. `contracts/openapi.yaml` — every endpoint locked
2. `contracts/db-schema.sql` — DDL locked
3. `contracts/events.md` — opencode → AAG event mapping
4. `contracts/fixtures/run-rejected-schema.json` — handcrafted demo run
5. `infra/docker-compose.yml` works locally (`make compose-up`)
6. service `/v1/health` returns ok (`make service-dev`)

After these, each lane works in their own dir against the contracts.

## Phase A — vertical slice (~3 hours)

Get one round-trip working before going deep:

- R1: plugin posts a hardcoded event
- R2: `/v1/events` insert; `/v1/runs/:id` returns it
- R3: stub `/v1/preflight` returns canned response from fixture
- R4: dashboard subscribes to `/v1/runs/:id/stream`, shows live row

## Phase B — parallel deep work

| R1 | R2 | R3 | R4 |
|---|---|---|---|
| event hook batcher | runs assembler from raw events | rules: schema_change, missing_migration, frontend_drift, missing_test | runs list + run page polish |
| tool.execute.before preflight call | session.diff & tool diff capture | graph.writer.write nodes/edges | failure-graph view (cytoscape/react-flow) |
| permission.replied → outcome + feedback | run-end detection (idle, abort) | embedder + pgvector ANN | preflight panel for active run |
| experimental.chat.system.transform | SSE pubsub → /stream | preflight: ANN + 2-hop traversal | demo script + offline replay path |

## Phase C — integration & demo (final 4-6 hours)

- Stop new features
- Wire R3's `on_run_complete` into `routes.runs.post_outcome`
- Run `docs/demo-script.md` end-to-end three times
- Pre-record a video as backup

## Communication

- All HTTP shape changes happen in a PR that updates `contracts/openapi.yaml`
  AND the schema/route in the same commit.
- DB shape changes update `contracts/db-schema.sql` first, then the SQLAlchemy
  model. `make db-reset` if needed.
- If something blocks you for >15 min: ask the lane owner directly, or ping
  the channel — don't grind alone.

# Agent Autopsy Graph — Test Plan

How to test each of the 9 features delivered against `plan.md`. Mix of automated tests (`pytest`) and manual verification (`curl`, `psql`, scripts).

## Prerequisites

Once per machine:

```bash
cd /Users/alan/Projects/Autopsy
make compose-up                  # postgres + pgvector at :5432 (one-shot, daemonized)
cd service && uv sync            # install service deps
cd ..
```

Verify Postgres is healthy:

```bash
docker ps --filter name=aag-postgres --format '{{.Status}}'
# expect:  Up X (healthy)
```

`.env` must have `EMBED_PROVIDER=stub` for local dev (the test suite forces this anyway via `service/tests/conftest.py`):

```bash
grep EMBED_PROVIDER /Users/alan/Projects/Autopsy/.env
# expect:  EMBED_PROVIDER=stub
```

For the manual steps, start the service in one terminal and leave it running:

```bash
make service-dev                  # uvicorn on :4000 with --reload
```

Verify:

```bash
curl -sf http://localhost:4000/v1/health
# expect:  {"ok":true}
```

## Run everything at once

```bash
cd /Users/alan/Projects/Autopsy/service
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
```

Expected: **72 passed**, lint/format clean on every file touched by F1–F9. (Three pre-existing lint errors unrelated to this work remain — see "Known pre-existing issues" at the end.)

---

## F1 — Graph writer orchestrator

**What it does**: turns a `Run` + `FailureCaseOut` + `Extraction` into a full set of `graph_nodes` and `graph_edges` rows tagged with `evidence_run_id`.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_graph_writer.py
# expect:  4 passed
```

The 4 tests cover:
- `test_write_creates_all_node_types` — every expected node type (Run/Task/File/Component/ChangePattern/Symptom/FailureMode/FixPattern/Outcome) exists after `write()`.
- `test_write_creates_expected_edges` — all 8 edge types exist, every edge has `evidence_run_id`, EMITTED_SYMPTOM confidence matches symptom confidence.
- `test_write_is_idempotent` — calling `write()` twice produces the same node/edge counts (no duplicates).
- `test_write_skips_fix_pattern_when_none` — when `fix_pattern is None`, no FixPattern node nor RESOLVED_BY edge is emitted.

### Manual

After running F7 (`make seed`) you can inspect the graph it produced via the writer:

```bash
docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT type, count(*) FROM graph_nodes GROUP BY type ORDER BY type;"
# expect rows for: ChangePattern, Component, FailureMode, File, FixPattern,
#                  Outcome, Run, Symptom, Task

docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT type, count(*) FROM graph_edges GROUP BY type ORDER BY type;"
# expect rows for: ATTEMPTED, BELONGS_TO, EMITTED_SYMPTOM, HAD_CHANGE_PATTERN,
#                  INDICATES, RESOLVED_BY, RESULTED_IN, TOUCHED
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/graph/writer.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_graph_writer.py" />.

---

## F2 — Embedding write path

**What it does**: computes embeddings for `task / failure / fix / run_summary` text per run and upserts them into the `embeddings` table.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_embeddings_write.py
# expect:  4 passed
```

Tests cover:
- `test_write_for_creates_all_rows` — all 4 entity_types written for a complete failure case.
- `test_write_for_skips_empty_fix_pattern` — `fix_pattern=None` → no `fix` row.
- `test_write_for_idempotent` — second call doesn't duplicate; updated text/vector match the second call's input.
- `test_write_for_skips_blank_task` — empty `task`/`run_summary` strings are skipped.

### Manual

After `make seed`:

```bash
docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT entity_type, count(*) FROM embeddings GROUP BY entity_type;"
# expect:
#   task         | 4
#   failure      | 4
#   fix          | 4
#   run_summary  | 4
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/graph/embeddings.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_embeddings_write.py" />.

---

## F3 — Finalizer wiring

**What it does**: `POST /v1/runs/:id/outcome` triggers `on_run_complete()` which chains classifier → graph writer → embeddings in a single transaction.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_finalizer.py
# expect:  3 passed
```

Tests cover:
- `test_on_run_complete_full_pipeline` — rejected schema-change run produces `failure_cases` row + graph nodes/edges + ≥3 embeddings rows.
- `test_on_run_complete_no_symptoms` — approved run with no diffs produces no FailureCase, no graph nodes for that run, no embeddings.
- `test_on_run_complete_missing_run` — passing a non-existent `run_id` returns silently and creates nothing.

### Manual

Insert a synthetic rejected run via the seeder script (which goes through the full HTTP path → finalizer):

```bash
cd /Users/alan/Projects/Autopsy/service
uv run python ../scripts/seed.py
```

Then check that all four backing tables got data for `seed-001`:

```bash
docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT failure_mode FROM failure_cases WHERE run_id='seed-001';"
# expect:  incomplete_schema_change

docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT count(*) FROM graph_nodes WHERE id LIKE 'Run:seed-%';"
# expect: 4

docker exec aag-postgres psql -U aag -d aag -c \
  "SELECT count(*) FROM embeddings WHERE entity_id='seed-001';"
# expect: 4
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/workers/finalizer.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/analyzer/classifier.py" /> (signature change), <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_finalizer.py" />.

---

## F4 — Preflight traversal

**What it does**: vector ANN over `embeddings` + recursive 3-hop CTE over `graph_edges` to turn a new task string into similar past failures, missing followups, recommended checks, and a markdown system addendum.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_traversal.py
# expect:  4 passed
```

Tests cover:
- `test_preflight_returns_none_for_unrelated_task` — distance > threshold → `risk_level == "none"`.
- `test_preflight_finds_similar_run` — identical task → `risk_level != "none"`, `similar_runs` includes the seeded id, `missing_followups` includes the failure mode.
- `test_preflight_empty_task_safe` — empty task fast-paths to defaults with zero SQL.
- `test_preflight_with_no_seeded_data` — empty DB → empty response.

### Manual

Make sure the DB has seed data (`make seed`), then call traversal directly via the route (covered in F5).

You can also inspect the SQL the traversal generates via `EXPLAIN`:

```bash
docker exec aag-postgres psql -U aag -d aag -c "
WITH RECURSIVE hops AS (
  SELECT id::text AS source_id, target_id, type, confidence, 1 AS depth
  FROM graph_edges WHERE source_id = ANY(ARRAY['Run:seed-001'])
  UNION ALL
  SELECT h.target_id, e.target_id, e.type, h.confidence*e.confidence, h.depth+1
  FROM graph_edges e JOIN hops h ON e.source_id = h.target_id
  WHERE h.depth < 3
)
SELECT n.type, n.name, AVG(h.confidence)::float AS conf, COUNT(*) AS freq
FROM hops h JOIN graph_nodes n ON n.id = h.target_id
WHERE n.type IN ('FailureMode','FixPattern','ChangePattern')
GROUP BY n.type, n.name ORDER BY freq DESC;
"
# expect rows for FailureMode:incomplete_schema_change, FixPattern:..., ChangePattern:...
```

Tunable constants live at the top of `service/src/aag/graph/traversal.py`:
- `SIMILARITY_THRESHOLD = 0.6` (cosine distance cutoff for ANN matches)
- `K = 5` (top-K neighbours)
- `MAX_HOP_DEPTH = 3` (must be 3 to reach FixPattern via Symptom → FailureMode → FixPattern)
- `RISK_HIGH_THRESHOLD = 3.0`, `RISK_MEDIUM_THRESHOLD = 1.5`

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/graph/traversal.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_traversal.py" />.

---

## F5 — Preflight route handler

**What it does**: wires `POST /v1/preflight` to F4's traversal function. `response_model_exclude_none=True` so optional fields drop out when null.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_preflight_route.py
# expect:  4 passed
```

Tests cover:
- `test_preflight_empty_task` — `{"task": ""}` returns 200 with safe defaults.
- `test_preflight_finds_seeded_run` — identical task returns the seeded run_id, failure mode, addendum.
- `test_preflight_unrelated_task_safe` — unrelated task returns valid response, `risk_level in {"none","low"}`.
- `test_preflight_request_validation` — missing `task` field → 422.

### Manual

Service must be running (`make service-dev`) and the DB seeded (`make seed`).

```bash
curl -sf -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{"task": "Add preferredName to user profile API"}' | jq
```

Expected (something like):

```json
{
  "risk_level": "high",
  "block": false,
  "similar_runs": ["seed-001"],
  "missing_followups": ["incomplete_schema_change", "missing_test_coverage"],
  "recommended_checks": [
    "Add database migration and regenerate types after schema changes",
    "Add or update tests covering the changed code paths"
  ],
  "system_addendum": "⚠️ Similar past task failed with: **incomplete_schema_change**. Watch out for: ... Recommended checks: ..."
}
```

Negative case (random task that shouldn't match):

```bash
curl -sf -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{"task": "what is the weather"}' | jq
# expect risk_level "none" or "low", empty similar_runs
```

Validation:

```bash
curl -i -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{}'
# expect HTTP 422
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/routes/preflight.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_preflight_route.py" />.

---

## F6 — Graph API routes

**What it does**: `GET /v1/graph/nodes` and `GET /v1/graph/edges` for the dashboard team to consume. Filters: `type`, `limit` for nodes; `source_id`, `target_id`, `type`, `limit` for edges.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_graph_routes.py
# expect:  7 passed
```

Tests cover:
- `test_list_nodes_no_filter` — returns inserted nodes when no filter applied.
- `test_list_nodes_filter_by_type` — filtering by `type` returns only matching nodes.
- `test_list_nodes_unknown_type_returns_empty` — unknown type → 200 + `[]`.
- `test_list_nodes_respects_limit` — `?limit=1` returns exactly one row.
- `test_list_edges_filter_by_source` — `?source_id=X` returns edges out of X.
- `test_list_edges_filter_by_type` — `?type=ATTEMPTED` returns only ATTEMPTED edges.
- `test_list_edges_filter_by_target` — `?target_id=X` filter works.

### Manual

After `make seed`:

```bash
curl -sf "http://localhost:4000/v1/graph/nodes?type=FailureMode" | jq
# expect array containing FailureMode:incomplete_schema_change, FailureMode:missing_test_coverage

curl -sf "http://localhost:4000/v1/graph/nodes?type=Run&limit=10" | jq
# expect 4 Run nodes (seed-001..seed-004; seed-005 was approved → no Run node)

curl -sf "http://localhost:4000/v1/graph/edges?type=ATTEMPTED&limit=5" | jq
# expect ATTEMPTED edges from each Run:seed-XXX → Task:...

curl -sf "http://localhost:4000/v1/graph/edges?source_id=Run:seed-001" | jq
# expect every edge type emitted by F1 for seed-001's run
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/routes/graph.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_graph_routes.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/main.py" /> (router registration), <ref_file file="/Users/alan/Projects/Autopsy/contracts/openapi.yaml" /> (tag fix).

---

## F7 — Graph seeder

**What it does**: `scripts/seed.py` drives 5 synthetic runs end-to-end through the public HTTP API to populate `failure_cases`, `graph_nodes`, `graph_edges`, `embeddings` for offline iteration and the demo loop.

The seed runs:
1. `seed-001` rejected → `incomplete_schema_change` (preferredName + serializer, no migration)
2. `seed-002` rejected → `missing_test_coverage` (parseUserId refactor, no test)
3. `seed-003` rejected → `incomplete_schema_change` (Order type addition)
4. `seed-004` rejected → `incomplete_schema_change` (nickname on User model)
5. `seed-005` approved → no FailureCase (counter-example)

### Automated

The seeder doesn't have unit tests of its own — its output is the test substrate for F4 and F9's `test_demo_loop.py`. Verifying the seeder's correctness IS the manual test below.

### Manual

Service must be running:

```bash
make seed                         # or:  cd service && uv run python ../scripts/seed.py
```

Expected output:

```
service ok at http://localhost:4000
  seed-001: 6 new event(s), outcome=rejected
  seed-002: 5 new event(s), outcome=rejected
  seed-003: 5 new event(s), outcome=rejected
  seed-004: 6 new event(s), outcome=rejected
  seed-005: 4 new event(s), outcome=approved

seeded 5 runs: {'rejected': 4, 'approved': 1}
graph_nodes by type: {... Run: 4, FailureMode: 2, ...}
embeddings by entity_type: {'task': 4, 'failure': 4, 'fix': 4, 'run_summary': 4}
```

DB state check:

```bash
docker exec aag-postgres psql -U aag -d aag -c "
SELECT failure_mode, count(*) FROM failure_cases GROUP BY failure_mode;
"
# expect:
#   incomplete_schema_change | 3
#   missing_test_coverage    | 1
```

**Idempotency check** — re-run and confirm counts don't change:

```bash
make seed
docker exec aag-postgres psql -U aag -d aag -c "SELECT count(*) FROM run_events;"
# Note the count.
make seed
docker exec aag-postgres psql -U aag -d aag -c "SELECT count(*) FROM run_events;"
# Expect: same count.
```

Each event uses a stable `event_id` of `"{run_id}:{seq:03d}"` so the assembler's `(run_id, event_id)` unique constraint dedupes silently.

Files: <ref_file file="/Users/alan/Projects/Autopsy/scripts/seed.py" />.

---

## F8 — Plugin task enrichment

**What it does**: replaces the empty `task: ""` parameter in the plugin's `onToolBefore` preflight call with the latest user message text, captured from the opencode event bus.

### Automated

The plugin uses no test framework. There is a smoke script:

```bash
cd /Users/alan/Projects/Autopsy/plugin
bun run src/__smoke__/last-task.smoke.ts
# expect:  ok
echo $?
# expect:  0
```

Asserts `latestUserMessage()` returns null initially, set→get round-trips, whitespace doesn't clobber prior values, and trim-on-set works.

### Typecheck

```bash
cd /Users/alan/Projects/Autopsy/plugin
bunx tsc --noEmit
# expect:  no output, exit 0
```

### Manual / behavioural

Hard to fully test without a real opencode runtime, but you can confirm the wiring with a small repro:

1. Add temporary `console.log` lines inside `setLatestUserMessage` and `latestUserMessage` in <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/last-task.ts" />.
2. `make plugin-link && opencode` from any project. Send a chat message; trigger a tool that's in `config.preflightTools` (default: `edit`, `write`).
3. Logs should show the message captured by `setLatestUserMessage`, then `latestUserMessage` reading it inside the tool-before hook, then a `POST /v1/preflight` body with that text rather than an empty string.
4. Remove the `console.log` lines.

The defensive event-extraction logic in `plugin/src/handlers/event.ts` looks at multiple plausible event types (`message.created`, `message.updated`, `message.part.updated`, `chat.user.message`) and three plausible payload shapes — see the comment in the file for context, and tighten to one event name once the opencode bus shape is confirmed empirically.

Files: <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/last-task.ts" />, <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/handlers/event.ts" />, <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/handlers/tool-before.ts" />, <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/__smoke__/last-task.smoke.ts" />.

---

## F9 — Test coverage gap (route + integration tests)

**What it does**: adds the route-level and end-to-end tests that weren't covered by F1–F6's per-feature tests.

### Automated

```bash
cd /Users/alan/Projects/Autopsy/service
uv run pytest -q tests/test_events_route.py \
                 tests/test_runs_route.py \
                 tests/test_stream_route.py \
                 tests/test_demo_loop.py
# expect:  20 passed
```

Per-file coverage:

#### `test_events_route.py` (5 tests)

- `test_post_events_creates_run_row` — `session.created` event creates a `runs` row.
- `test_post_events_idempotent_on_event_id` — repeat POST with same `event_id` doesn't duplicate.
- `test_post_events_appends_run_events` — multiple events for one run produce ordered `run_events` rows.
- `test_post_events_creates_diff_artifact_from_session_diff` — `session.diff` events produce `kind='diff'` artifacts.
- `test_post_events_empty_batch` — `{"events": []}` returns 202.

#### `test_runs_route.py` (11 tests)

CRUD over `/v1/runs`, `/v1/runs/{id}`, `/v1/runs/{id}/diff`, `/v1/runs/{id}/outcome`, `/v1/runs/{id}/feedback`. Includes 404s, filter behaviour (`project`, `status`, `limit`), assembled-run shape with events/diffs/failure_case fields.

#### `test_stream_route.py` (3 tests)

SSE-specific. Spins up a real `uvicorn.Server` in a daemon thread on a free port (TestClient and ASGITransport both buffer SSE bodies and don't deliver chunked frames incrementally — see deviation notes in the file's docstring). Coordinates by reaching into `pubsub._subscribers` to wait for the SSE generator to register.

- `test_stream_returns_event_stream_content_type` — initial connect returns `text/event-stream`.
- `test_stream_receives_published_event` — publishing into the in-process `pubsub` from the test thread is delivered to the subscriber.
- `test_stream_isolated_per_run_id` — events for run A don't appear on run B's stream.

#### `test_demo_loop.py` (1 test)

`test_demo_loop_full` — full integration of the demo-script flow:

1. POST events for a rejected schema-change run.
2. POST `/v1/runs/{id}/diff` to attach the diff artifact.
3. POST `/v1/runs/{id}/outcome` (rejected) → finalizer fires.
4. Assert `failure_cases`, populated graph nodes, populated embeddings.
5. POST `/v1/preflight` with the same task.
6. Assert `risk_level != "none"`, `similar_runs` includes the demo run id, `system_addendum` mentions the failure mode.

### Manual

This wave is purely test code; the manual equivalent is what you'd do by hand in the service's `/docs` Swagger UI. Walk through the demo from <ref_file file="/Users/alan/Projects/Autopsy/docs/demo-script.md" /> against a running service: ingest a fixture run, watch the autopsy populate, hit `/v1/preflight` with a similar task.

```bash
make replay                       # streams contracts/fixtures/run-rejected-schema.json
curl -sf http://localhost:4000/v1/runs | jq '.[0]'
curl -sf -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{"task": "Add preferredName to user profile API"}' | jq
```

Files: <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_events_route.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_runs_route.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_stream_route.py" />, <ref_file file="/Users/alan/Projects/Autopsy/service/tests/test_demo_loop.py" />.

---

## Test infrastructure

Things to know if a test starts failing.

### `service/tests/conftest.py` (modified during F1+F2 verification)

- Forces `EMBED_PROVIDER=stub` at module load time so tests never reach for `sentence_transformers` or OpenAI.
- Clears `get_settings.cache_clear()` after the env var is set.
- Provides a sync `client` (FastAPI TestClient) fixture.
- **Autouse `_dispose_engine_between_tests`** disposes `aag.db._engine` before and after every test — pytest-asyncio creates a new event loop per test by default, and the cached engine would otherwise belong to a stale loop ("Future attached to a different loop" errors).

If you add a new test file that mixes the sync `TestClient` with async DB queries (e.g. setup via `aag.db.sessionmaker()` from inside the test), follow the pattern in `tests/test_graph_routes.py`: call `await dispose()` once after async DB setup so the FastAPI handler's portal loop gets a fresh engine, then `await dispose()` again before async cleanup.

### Skip-on-no-postgres

Every DB-backed test file has:

```python
import socket
def _db_reachable() -> bool:
    s = socket.socket(); s.settimeout(0.5)
    try: s.connect(("localhost", 5432)); return True
    except OSError: return False
    finally: s.close()

pytestmark = pytest.mark.skipif(
    not _db_reachable(),
    reason="postgres unreachable on localhost:5432"
)
```

If you see "S" markers in pytest output rather than dots, Postgres isn't reachable. Run `docker ps` and `make compose-up`.

### Cleanup

Every test that inserts uses unique `uuid4().hex[:8]` suffixes and a `try/finally` that deletes the run row (FK cascades to events/artifacts/failure_cases/graph_edges). Embeddings have no FK so are deleted explicitly. Tests can be run repeatedly without DB state leaking — verify with:

```bash
cd service && uv run pytest -q tests/ --count=2 2>/dev/null || uv run pytest -q tests/
```

(`--count` requires `pytest-repeat`; if you don't have it, just run `pytest -q` twice and confirm both pass.)

---

## Smoke tests for the dashboard team

Before the dashboard team starts integrating, confirm the API surface is solid. Service must be running with seed data loaded.

```bash
# All four endpoints they'll consume:
curl -sf http://localhost:4000/v1/runs | jq 'length'
curl -sf http://localhost:4000/v1/runs/seed-001 | jq '{run_id, status, failure_case: .failure_case.failure_mode}'
curl -sf "http://localhost:4000/v1/graph/nodes?type=FailureMode" | jq
curl -sf "http://localhost:4000/v1/graph/edges?type=ATTEMPTED&limit=10" | jq
curl -sf -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{"task":"Add preferredName to user profile API"}' | jq

# SSE (Ctrl-C after one event):
curl -N http://localhost:4000/v1/runs/seed-001/stream
```

If all of those return sensible JSON, the contract in `contracts/openapi.yaml` is honoured.

---

## Known pre-existing issues (NOT introduced by F1–F9)

`uv run ruff check .` reports three lint errors that were already on `main` before this work started:

- `src/aag/graph/embeddings.py:34` — unused `from sentence_transformers import SentenceTransformer` inside the `local` provider branch.
- `src/aag/models/run.py:5` — unused `String` import.
- `src/aag/schemas/__init__.py:3` — import block not sorted.

All can be auto-fixed via `uv run ruff check --fix .` and `uv run ruff format .`. They're outside the F1–F9 scope so were left alone for a separate cleanup commit.

---

## Quick green-light checklist

Run these in order; if any fail, stop and investigate before declaring the build healthy.

```bash
# 1. Infra
docker ps --filter name=aag-postgres --format '{{.Status}}' | grep -q healthy

# 2. Service tests
cd /Users/alan/Projects/Autopsy/service && uv run pytest -q
# expect: 72 passed

# 3. Plugin typecheck + smoke
cd /Users/alan/Projects/Autopsy/plugin && bunx tsc --noEmit && bun run src/__smoke__/last-task.smoke.ts
# expect: no tsc output; smoke prints "ok"

# 4. Service running
curl -sf http://localhost:4000/v1/health
# expect: {"ok":true}

# 5. Seed + end-to-end smoke
make seed
curl -sf -X POST http://localhost:4000/v1/preflight \
  -H 'content-type: application/json' \
  -d '{"task":"Add preferredName to user profile API"}' | jq -e '.risk_level != "none"'
# expect: exit 0 (risk_level is "low", "medium", or "high")
```

If all five pass, F1–F9 are healthy.

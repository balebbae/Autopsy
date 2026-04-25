# Agent Autopsy Graph — Outstanding Backend Work

Scope: this plan covers **service** (FastAPI) and **plugin** (opencode recorder) only. The **dashboard** (Next.js) is owned by a teammate and is intentionally excluded; integration with it happens later via the existing OpenAPI contract.

What's been built (do not redo):
- R1 plugin: event/tool/permission/system handlers, batched ingestion, preflight client.
- R2 ingestion: `/v1/events`, `/v1/runs`, `/v1/runs/:id`, diff/outcome/feedback, SSE re-broadcast.
- Analyzer: 4 deterministic rules (`schema_change`, `missing_migration`, `missing_test`, `frontend_drift`) + classifier that picks the highest-confidence failure mode and persists `FailureCase`.
- Entity extractor (`analyzer/extractor.py`): full implementation extracting Files, Components, ChangePatterns, tool calls, errors. (README still lists this as empty — it isn't.)
- Graph upsert primitives: `upsert_node`, `upsert_edge` (no orchestrator that calls them).
- Embedding *provider* (`graph/embeddings.embed`) with stub/local/openai backends.
- DB schema, OpenAPI contract, fixtures.

The features below are what's actually missing on the backend side.

---

## Feature index & dependency graph

```
F1  Graph writer orchestrator
F2  Embedding write path                 (independent of F1)
F3  Finalizer wiring                     ← F1, F2
F4  Preflight traversal                  ← F2, F1, F7
F5  Preflight route handler              ← F4
F6  Graph API routes (/nodes /edges)     ← F1
F7  Graph seeder                         ← F1, F2 (and exercised through F3)
F8  Plugin task enrichment (onToolBefore) ← (soft) F5 to be useful
F9  Test coverage expansion              (touches all of the above)
```

Roughly: **F1 + F2** are foundational and should land first. **F3** glues the pipeline. **F7** then has data to seed. **F4 → F5** light up preflight on the read side. **F6** exposes the graph for the dashboard team to consume later. **F8** is small and independent. **F9** grows with each feature.

---

## F1 — Graph writer orchestrator

Wire `Extraction` + `FailureCaseOut` into a full node/edge write so the graph actually has content.

Files: `service/src/aag/graph/writer.py`, `service/src/aag/graph/__init__.py`.

Subplan
- Add `async def write(session, *, failure_case: FailureCaseOut, extraction: Extraction) -> None` in `writer.py`.
- Node creation (call `upsert_node` for each):
  - `Run:{run_id}` with `properties={status, started_at, ended_at}`.
  - `Task:{task_type or 'unknown'}` with the raw task string in properties.
  - `File:{path}` for every entry in `extraction.files`.
  - `Component:{component}` for every entry in `extraction.components`.
  - `ChangePattern:{name}` for every entry in `extraction.change_patterns`.
  - `Symptom:{name}` for every entry in `failure_case.symptoms` (carry `evidence` + `confidence` into properties).
  - `FailureMode:{failure_case.failure_mode}`.
  - `FixPattern:{failure_case.fix_pattern}` if non-null.
  - `Outcome:{run.status}` (rejected/approved/aborted).
- Edge creation (call `upsert_edge`, every edge tagged with `evidence_run_id=run_id` and a confidence per spec):
  - `Run -ATTEMPTED-> Task`
  - `Run -TOUCHED-> File` (for each file)
  - `File -BELONGS_TO-> Component`
  - `Run -HAD_CHANGE_PATTERN-> ChangePattern`
  - `Run -EMITTED_SYMPTOM-> Symptom` (confidence = symptom.confidence)
  - `Symptom -INDICATES-> FailureMode`
  - `FailureMode -RESOLVED_BY-> FixPattern` (when fix_pattern present)
  - `Run -RESULTED_IN-> Outcome`
- Use a single `await session.flush()` at end; commit is the caller's job (finalizer owns the transaction).
- Edge case: when classifier returns None (no failure), `write()` is not called — finalizer guards this.
- Add `from .writer import write, upsert_node, upsert_edge` to `graph/__init__.py`.
- Tests: `service/tests/test_graph_writer.py` exercising one rejected run end-to-end against a sqlite-or-test-postgres fixture; assert node count + that the expected edge types exist with correct evidence_run_id.

Dependencies: classifier (done), extractor (done).

---

## F2 — Embedding write path

`embeddings.embed()` exists but nothing persists vectors. Without this, F4/F5 can't retrieve.

Files: `service/src/aag/graph/embeddings.py`, `service/src/aag/models/embedding.py` (already correct).

Subplan
- Add `async def write_for(session, *, failure_case: FailureCaseOut, run: Run) -> None` to `embeddings.py`.
- Compute embeddings for these strings, persist one row per non-empty text using `pg_insert(...).on_conflict_do_update`:
  - `(entity_type='task', entity_id=run.run_id, text=run.task or '')`
  - `(entity_type='failure', entity_id=run.run_id, text=summary_or_concat_of_symptoms)`
  - `(entity_type='fix', entity_id=run.run_id, text=failure_case.fix_pattern)` if present
  - `(entity_type='run_summary', entity_id=run.run_id, text=summary_for_run)`
- The summary string should concatenate task + failure_mode + change_patterns so ANN can match either side.
- Skip silently when `text` is empty after strip.
- Add a unit test that uses the stub provider (deterministic) and asserts rows are upserted idempotently across two calls.

Dependencies: none (uses existing classifier output).

---

## F3 — Finalizer wiring

Connect classifier → graph writer → embeddings into a single pipeline triggered from `/v1/runs/:id/outcome`.

Files: `service/src/aag/workers/finalizer.py`.

Subplan
- After `session.merge(row)` and before commit, call:
  - `extraction = extractor.extract(ctx, fc)` — but `classifier.classify` currently throws away `ctx`. Refactor `classify` to return `(ctx, FailureCaseOut)` *or* expose `_build_context` and re-call it here. Pick the refactor (return tuple) — it's the smallest change.
  - `await graph.writer.write(session, failure_case=fc, extraction=extraction)`
  - `await graph.embeddings.write_for(session, failure_case=fc, run=run)` — load `run` via `session.get(Run, run_id)`.
- Single `session.commit()` at the end.
- Wrap the post-classify steps in `try/except` and log; never let analyzer errors break the request that already returned 204. (`post_outcome` already awaits this — switch to `asyncio.create_task(on_run_complete(run_id))` if latency becomes a problem; for the demo, awaiting is fine and easier to debug.)
- Remove the two TODO comments.
- Test `test_finalizer.py`: feed a full rejected fixture run, assert `failure_cases`, `graph_nodes`, `graph_edges`, `embeddings` rows are all populated.

Dependencies: F1 (graph writer), F2 (embeddings write).

---

## F4 — Preflight traversal

Vector ANN + 2-hop CTE that turns a new task string into similar past failures, missing followups, recommended checks, and a markdown system addendum.

Files: `service/src/aag/graph/traversal.py`, `service/src/aag/schemas/preflight.py`.

Subplan
- Inspect `PreflightResponse` and ensure it has the fields documented in `contracts/openapi.yaml` (`risk_level`, `block`, `reason`, `similar_runs`, `missing_followups`, `recommended_checks`, `system_addendum`). Add any missing fields to the pydantic model — keep defaults safe (`risk_level="none"`, `block=False`).
- Implement `async def preflight(session, req) -> PreflightResponse`:
  1. `vec = await embeddings.embed(req.task)`.
  2. Raw SQL via `text()`:
     ```sql
     SELECT entity_id, vector <=> :v AS dist
     FROM embeddings
     WHERE entity_type = 'task'
     ORDER BY vector <=> :v
     LIMIT :k
     ```
     Bind `v` as a pgvector list. `k` from settings (default 5).
  3. Filter to neighbours with `dist < SIMILARITY_THRESHOLD` (e.g. 0.6 cosine distance). If none → return empty response with `risk_level="none"`.
  4. Recursive 2-hop CTE over `graph_edges` starting from each `Run:{entity_id}` node, projecting target nodes whose `type IN ('FailureMode','FixPattern','ChangePattern')`.
  5. Aggregate by `(target_type, target_name)` summing `frequency * avg(confidence) * (1 - dist)`. Pick top `FailureMode`s for `missing_followups`, top `FixPattern`s for `recommended_checks`, top `ChangePattern`s as supporting evidence.
  6. Compute `risk_level`:
     - `high` if top failure score > 0.8
     - `medium` if > 0.4
     - `low` if any neighbours
     - else `none`
     - `block` stays False for now (the plugin's `onToolBefore` honors it; we never want to abort tools in the demo unless explicitly raised).
  7. Build `system_addendum` markdown:
     ```
     ⚠️ Similar past task failed with: <failure_mode>.
     Missing followups: <list>.
     Recommended checks before finishing: <list>.
     ```
- Tests: `test_traversal.py` seeded with fixture data via the seeder (F7); assert that an exact-task query returns risk≥medium and that the addendum mentions the failure mode.

Dependencies: F1 (graph data), F2 (embeddings), F7 to make tests interesting.

---

## F5 — Preflight route handler

Files: `service/src/aag/routes/preflight.py`.

Subplan
- Replace the stub return with `from aag.graph.traversal import preflight as do_preflight; return await do_preflight(session, req)`.
- Add response_model_exclude_none=True so empty arrays don't pollute JSON.
- Smoke test: integration test posts a task that matches a seeded run and asserts non-empty `system_addendum`.

Dependencies: F4.

---

## F6 — Graph API routes

OpenAPI declares `GET /v1/graph/nodes` and `GET /v1/graph/edges`; no handlers. The dashboard team will consume these — the contract is the integration point, so finishing this unblocks them without further coordination.

Files: new `service/src/aag/routes/graph.py`, `service/src/aag/main.py`.

Subplan
- Create `routes/graph.py` exporting `router = APIRouter()`.
- `GET /graph/nodes`: query params `type` (optional, must be one of the documented enum), `limit` (default 200, capped at 1000). Return `list[GraphNodeOut]`.
- `GET /graph/edges`: query params `source_id`, `target_id`, `type`, `limit` (default 500, cap 2000). Return `list[GraphEdgeOut]`.
- Use SQLAlchemy `select(GraphNode).where(...)` style; build the where clause incrementally.
- Wire into `main.py`: `app.include_router(graph.router, prefix="/v1", tags=["graph"])`.
- Update OpenAPI tag from `preflight` → `graph` to match.
- Tests: hit each endpoint with the seeded DB and assert filtering + limit work.

Dependencies: F1 (so the tables aren't empty in real usage; tests can write fixture data directly).

---

## F7 — Graph seeder

`scripts/seed.py` only health-checks. The graph is empty at first boot, so preflight has nothing to retrieve.

Files: `scripts/seed.py`, `service/src/aag/graph/seed.py`.

Subplan
- Pick 5 distinct synthetic runs that cover each rule:
  1. `incomplete_schema_change` — schema field added without migration.
  2. `missing_test_coverage` — code edit, no test edit.
  3. `frontend_backend_drift` — backend type changed, no `generated/types.ts` update.
  4. A second `incomplete_schema_change` with different files, to give the failure mode multiple evidence runs (so `confidence` aggregates).
  5. An approved counter-example (no symptoms) to verify classifier returns None.
- Implementation choice: drive these end-to-end through the **public HTTP API** so we exercise the same code path as the plugin:
  - For each run, `POST /v1/events` with `session.created`, a few `tool.execute.after` events with `oldText/newText`, and `permission.replied` with reject/approve.
  - `POST /v1/runs/:id/outcome` to trigger the finalizer.
- Build the event/diff payloads as inline Python dicts — keep one helper `make_run(run_id, task, files, accepted)` to avoid copy-paste.
- Delete `service/src/aag/graph/seed.py` (move to scripts) or have it re-export from scripts. Simpler: just keep everything in `scripts/seed.py` and remove the `aag.graph.seed` stub.
- `make seed` already shells `python scripts/seed.py` — verify in `Makefile`.

Dependencies: F1, F2, F3 (otherwise seeded data won't reach the graph/embeddings).

---

## F8 — Plugin: enrich `onToolBefore` task

The preflight call in `tool-before.ts` posts an empty `task: ""`, which makes ANN useless. The plugin still belongs to the recorder/instrumentation layer (not the web frontend), so it's in scope here.

Files: `plugin/src/handlers/tool-before.ts`, possibly `plugin/src/batcher.ts` or a new tiny module.

Subplan
- The plugin loader injects a `client` (opencode SDK). Either:
  - Pass `client` through to `onToolBefore` (currently constructed in `index.ts` — thread it via closure or via the plugin context object).
  - Or read the latest user message from a small in-memory buffer that `onEvent` populates whenever `e.type === 'message.created' && properties.role === 'user'`.
- Pick option B: it's local, no SDK call in the hot path.
- Add `latestUserMessage()` accessor in `plugin/src/batcher.ts` (or a new tiny module) that `onEvent` writes to and `onToolBefore` reads.
- Update preflight call: `task: latestUserMessage() ?? ""`.
- Keep the preflight call optional — config already gates by `preflightTools`.

Dependencies: works without F5 but only useful once preflight does real retrieval.

---

## F9 — Test coverage expansion

Currently: `test_health.py`, `test_classifier.py`, `test_extractor.py`. Most write paths and routes are untested.

Files: `service/tests/*`.

Subplan (each row is one test file, all using `httpx.AsyncClient` + a sqlite-or-throwaway-postgres fixture in `conftest.py`):
- `test_events_route.py` — POST a batch, assert `runs`, `run_events`, `artifacts` rows.
- `test_runs_route.py` — list + get + diff + outcome + feedback round trips.
- `test_stream_route.py` — connect to SSE, publish via `pubsub.publish`, assert message arrives.
- `test_graph_writer.py` — under F1.
- `test_embeddings_write.py` — under F2.
- `test_finalizer.py` — under F3.
- `test_traversal.py` — under F4 (depends on F7 fixture).
- `test_preflight_route.py` — under F5.
- `test_graph_routes.py` — under F6.
- A single integration test (`test_demo_loop.py`) that runs the full demo: ingest a rejected run, assert FailureCase + graph + embeddings, then call `/v1/preflight` with a similar task and assert non-empty `system_addendum`.
- Add `make service-test` to CI if a CI surface ever exists; for now just ensure `cd service && uv run pytest -q` is green.

Dependencies: each sub-test depends on its corresponding feature.

---

## Suggested execution order

1. F1, F2 in parallel (different files; no overlap).
2. F3 immediately after — small change, unblocks the rest.
3. F7 — gives F4 and F9 real data to work with.
4. F6 (route) and F4 (traversal) in parallel.
5. F5 (preflight handler) once F4 lands.
6. F8 (plugin task enrichment) anytime — small, isolated.
7. F9 grows alongside each feature, not at the end.

## Hand-off contract for the dashboard teammate

The frontend team should be able to build against these endpoints without further coordination once the listed features land:

- `GET /v1/runs`, `GET /v1/runs/:id` — already shipped.
- `GET /v1/runs/:id/stream` (SSE) — already shipped.
- `POST /v1/preflight` — completed by F5.
- `GET /v1/graph/nodes`, `GET /v1/graph/edges` — completed by F6.

All shapes are documented in `contracts/openapi.yaml`. If the dashboard needs a field that isn't there, update the OpenAPI spec **and** the route in the same commit (per `AGENTS.md`).

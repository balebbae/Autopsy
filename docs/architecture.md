# Architecture

## One-liner

Agent Autopsy Graph turns failed AI coding runs into reusable memory, so future
agents can avoid the same mistakes before they write code.

## Components

```
┌─ Dev's machine ──────────────────────────────────────────────┐
│  opencode runtime (installed separately; opencode.ai/docs)   │
│  └── .opencode/plugins/autopsy.ts        thin recorder       │
│       • event hook → POST /v1/events    (batched)            │
│       • tool.execute.before → POST /v1/preflight, may throw  │
│       • experimental.chat.system.transform → inject addendum │
│       • permission.replied(reject) → POST /v1/runs/:id/outcome│
└──────────────────────────────────────────────────────────────┘
                       │ HTTPS
                       ▼
┌─ AAG service (Python / FastAPI / Postgres+pgvector) ─────────┐
│  Routes (R2)                                                 │
│   POST /v1/events            batched event ingestion         │
│   GET  /v1/runs              list                            │
│   GET  /v1/runs/:id          assembled run + autopsy         │
│   POST /v1/runs/:id/outcome  triggers analyzer               │
│   POST /v1/preflight         risk + warnings + addendum      │
│   GET  /v1/runs/:id/stream   SSE re-broadcast                │
│                                                              │
│  Workers (R3)                                                │
│   • Trace assembler (R2)  raw events → Run record            │
│   • Failure analyzer       rules → FailureCase               │
│   • Graph writer           nodes/edges with evidence_run_id  │
│   • Embedder               task/failure/fix → pgvector       │
│                                                              │
│  Postgres                                                    │
│   runs, run_events, artifacts                                │
│   failure_cases                                              │
│   graph_nodes(type,name,properties)                          │
│   graph_edges(src,dst,type,confidence,evidence_run_id)       │
│   embeddings(entity_type, entity_id, vector)                 │
└──────────────────────────────────────────────────────────────┘
                       │
                       ▼
            Dashboard (Next.js 16, App Router)
            • runs list
            • per-run timeline + autopsy
            • failure-graph view
            • preflight panel
```

## Why a plugin and not a fork

opencode exposes everything we need through three orthogonal extension surfaces:

1. **Plugin hooks** — `event`, `tool.execute.before`, `tool.execute.after`,
   `permission.ask`, `experimental.chat.system.transform`. The plugin can
   observe every bus event, capture tool I/O, abort tool calls, and inject
   system-prompt addenda — all without touching opencode source.
2. **SSE stream** — `GET /global/event` re-broadcasts the bus to external
   clients. We don't use this in the MVP (the plugin has lower latency and
   richer hooks) but it's available as a fallback.
3. **SQLite read** — `~/.local/share/opencode/opencode.db` has a stable Drizzle
   schema. Useful for backfilling historical runs into the graph.

We start as a plugin. A thin fork is reserved for Phase 5 if we want
TUI-side UX (inline autopsy badges, dedicated preflight pane).

## Data flow per run

1. opencode emits `session.created`. Plugin batches it and POSTs to `/v1/events`.
   Service upserts a `runs` row.
2. Each `tool.execute.before` triggers a preflight check for risky tools.
3. Each `tool.execute.after` for `edit`/`write` carries `contentOld`/`contentNew`,
   captured as a diff `artifact`.
4. `session.diff` snapshots are stored as `artifact(kind='diff')`.
5. `permission.replied(reject)` flips `runs.status = 'rejected'` and the
   plugin POSTs `/v1/runs/:id/outcome` with the user's feedback.
6. `outcome` triggers the analyzer worker:
   `classifier(rules) → FailureCase → graph.writer → embedder`.
7. Next session: plugin's `system.transform` hook calls `/v1/preflight`,
   service does ANN + 2-hop traversal, returns a markdown addendum which the
   plugin pushes into `output.system`.

## Key contracts

- `contracts/openapi.yaml` — every HTTP endpoint and its request/response shape.
- `contracts/db-schema.sql` — Postgres DDL applied at first compose-up.
- `contracts/events.md` — opencode bus event → AAG normalized event mapping.
- `contracts/fixtures/*.json` — runnable demo runs for offline iteration.

## Risk flags

- **Rejection feedback string is not on the bus.** opencode's
  `permission.replied` only carries `reply: "reject"`. The plugin captures the
  reason string from the reply API or the dashboard "Why?" form. Test this
  early — it's the most failure-prone part of the recorder.
- **Two databases is one too many.** Don't reach for Neo4j; recursive CTEs
  over `graph_edges` cover the 2-hop traversal we need.
- **The graph is empty at first boot.** `make seed` (R3) pre-loads synthetic
  failure cases so the first preflight call returns useful warnings.
- **No LLM in the preflight critical path.** Vector retrieval + traversal
  must work without any API call. LLM-generated text is only for the autopsy
  *report*, not for `/v1/preflight`.

## Status

The four pillars (plugin, service, analyzer/graph, dashboard) are end-to-end
functional. The demo loop in `docs/demo-script.md` runs cleanly against
`make dev`.

### Plugin (`plugin/`)
- opencode 1.x event/tool/permission/system handlers, batched event
  ingestion, preflight client.
- `tool.execute.before` context injection (`handlers/tool-before.ts`):
  blocks high-confidence past-failure matches with a graph-cited rationale,
  emits `aag.preflight.warned` / `aag.preflight.blocked` for the dashboard.
  Bounded by `AAG_PREFLIGHT_TIMEOUT_MS` with fail-open.
- Postflight code-check runner (`postflight.ts`): debounced
  lint/typecheck/test suite that files `automated_check_failed` rejections
  back into the graph.
- Frustration detection on user chat messages, dedup'd per session.

### Service (`service/`)
- `/v1/events`, `/v1/runs`, run diff/outcome/feedback routes, SSE
  re-broadcast on `/v1/runs/:id/stream`.
- Analyzer: four deterministic rules (`schema_change`, `missing_migration`,
  `missing_test`, `frontend_drift`), classifier, entity extractor, finalizer
  pipeline wired to the outcome route.
- Graph: `upsert_node` / `upsert_edge` primitives plus a top-level writer
  that consumes classifier output, vector embeddings (`embeddings.write_for`)
  for semantic similarity, ANN + 2-hop CTE traversal in `/v1/preflight`,
  and `GET /v1/graph/{nodes,edges}` for the dashboard.
- ~5k lines of pytest covering routes, finalizer, traversal, classifier,
  extractor, embeddings, and a full demo-loop integration test.

### Dashboard (`dashboard/`)
- Run list + detail pages with live SSE timeline (`run-refresher.tsx`,
  `timeline.tsx`).
- 3D force-graph explorer at `/graph` with filtering by FailureMode /
  Component / ChangePattern.
- Per-run preflight panel showing every `/v1/preflight` hit and which were
  blocking.

## Open work / nice-to-haves

- The classifier is regex/heuristic only. An optional LLM pass for "*why*
  the change is incomplete" (vs. pattern-matching paths) is wired up behind
  `preflight_llm_enabled` for the preflight synth path but not for
  classification itself.
- `AAG_PREFLIGHT_TOOLS` defaults include `bash`, which means the injection
  handler can hard-block bash calls. Worth a deliberate yes/no per project.
- Ranked retrieval. The current ANN + 2-hop CTE returns top-K by raw
  cosine; weighting by recency, project-scope, and counter-evidence would
  noticeably improve preflight precision on noisy graphs.

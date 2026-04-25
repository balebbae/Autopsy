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

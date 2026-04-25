# Agent Autopsy Graph — A Wiki for Humans

> A friendly tour of the codebase, written for people who haven't read the
> code yet. Heavy on analogies, light on jargon.

---

## 1. The big idea, in one sentence

**AI coding agents make the same mistakes over and over. We build a flight
recorder + crash-investigation lab + pre-flight safety briefing for them, so
the next agent run knows about the last one's mistakes _before_ it writes a
single line of code.**

If that's all you remember, you're 80% of the way there.

---

## 2. The plane analogy

The whole system maps cleanly onto how aviation deals with crashes. Hold this
in your head and the rest of the codebase will make sense.

| Aviation | Agent Autopsy Graph (AAG) |
|---|---|
| A flight | **A run** — one opencode session where the agent tries to do something |
| The cockpit | **opencode**, the AI coding-agent runtime |
| The black-box recorder bolted into the cockpit | **The plugin** (`plugin/`) |
| Cockpit voice + data recordings | **Events** (`tool.execute.after`, `permission.replied`, …) |
| Boxes of evidence shipped back to HQ | `POST /v1/events` — the plugin uploading what it saw |
| The NTSB investigation lab | **The service** (`service/`) — FastAPI + Postgres |
| The forensic checklist (broken bolt? missed migration?) | **The analyzer rules** (`service/src/aag/analyzer/rules/`) |
| The case file written after each crash | **A FailureCase** — one row in the `failure_cases` table |
| A wall of evidence with red strings between suspects | **The graph** — `graph_nodes` + `graph_edges` |
| "This looks like the 1998 Chicago incident…" | **Embeddings + pgvector** (semantic similarity search) |
| The pre-flight safety briefing the pilot reads | **`POST /v1/preflight`** — warnings injected into the next agent's system prompt |
| Mission control's wall of monitors | **The dashboard** (`dashboard/`, Next.js) |

The whole repo is just the machinery to make that loop happen automatically.

---

## 3. The four pieces of the repo

```
Autopsy/
├── plugin/        the black-box recorder (TypeScript, runs inside opencode)
├── service/       the investigation lab (Python / FastAPI / Postgres)
├── dashboard/     the mission-control screen (Next.js)
├── infra/         the building the lab lives in (docker-compose for Postgres)
├── contracts/     the blueprints everyone signed before construction
├── scripts/       maintenance hatches (seed the lab, replay old crashes)
└── docs/          you are here
```

Each one is owned by a different role on the team — see <ref_file file="/Users/alan/Projects/Autopsy/docs/ownership.md" />.

---

## 4. The "Hour-1 contracts" — why they exist

Before anyone writes plumbing, four files in `contracts/` have to be agreed on.
These are the **architectural drawings** of the building. If R1 (plugin) and
R2 (service) disagree about what an event looks like, nothing fits together at
the end. So they freeze the shapes first:

- <ref_file file="/Users/alan/Projects/Autopsy/contracts/openapi.yaml" /> — every HTTP endpoint and what it expects/returns. The "phone-system directory" between plugin/service/dashboard.
- <ref_file file="/Users/alan/Projects/Autopsy/contracts/db-schema.sql" /> — the shape of every table in Postgres. The "filing cabinet labels" inside the lab.
- <ref_file file="/Users/alan/Projects/Autopsy/contracts/events.md" /> — a translation table from "what opencode emits" to "what we store". Like a glossary that says _"when the cockpit says 'CLB' we write it down as 'climbing'"_.
- <ref_file file="/Users/alan/Projects/Autopsy/contracts/fixtures/run-rejected-schema.json" /> — a fake, hand-written crash. Lets the dashboard get built without ever needing a real opencode run.

The rule (from the root <ref_file file="/Users/alan/Projects/Autopsy/AGENTS.md" />): if you change an endpoint or table, you update the contract file in the **same commit**. The drawings stay in sync with the building.

---

## 5. Walk-through: what happens when an agent screws up

This is the loop the demo script (<ref_file file="/Users/alan/Projects/Autopsy/docs/demo-script.md" />) puts on stage. We'll trace one run end-to-end.

### Scene 1 — The pilot makes a mistake

Developer types into opencode:

> "Add `preferredName` to the user profile API and UI."

The agent edits `profile.service.ts` and `user.serializer.ts` — but **forgets**
the database migration and the regenerated frontend types. The user clicks
**reject** with the feedback _"missed the migration and frontend types."_

That's our crash. Now we record and investigate it.

### Scene 2 — The black box catches everything

The plugin (`plugin/src/`) is hooked into opencode's event bus the moment
opencode starts. As the agent works, every event goes through:

```
opencode bus → handlers/event.ts → batcher.ts → client.ts → POST /v1/events
```

Why a **batcher** in the middle? Because the agent is talking to the LLM in
real time, and we **must not slow it down**. So events go into a bucket; every
200ms or every 32 events, the bucket gets dumped to the service in one HTTP
call. Fire-and-forget — if the service is down, the agent doesn't know or care.
(See <ref_file file="/Users/alan/Projects/Autopsy/plugin/src/batcher.ts" />.)

When the user rejects, `handlers/permission.ts` notices, posts the outcome to
`/v1/runs/:id/outcome`, and tries to grab the rejection text. (Capturing the
rejection reason is the trickiest bit — opencode's bus event doesn't include
it, so the plugin has to fetch it from opencode's local HTTP server, or fall
back to the dashboard's "Why?" form. The risk flag in <ref_snippet file="/Users/alan/Projects/Autopsy/docs/architecture.md" lines="94-97" /> calls this out.)

### Scene 3 — The lab files the evidence

Inside the service, `routes/events.py` receives the batch. For each event:

1. **Make sure the run exists.** `assembler.upsert_run()` creates the row in the `runs` table if this is the first event we've seen for this `run_id`.
2. **File the event.** `assembler.insert_event()` adds it to `run_events`. **Idempotent** — if the plugin retries, the same `(run_id, event_id)` pair won't double-file. Like a courier delivering the same letter twice; only the first one gets stamped and shelved.
3. **Update aggregates.** `apply_event_side_effects()` reacts:
   - `tool.execute.after` for an `edit` → bump `tool_calls`, extract the diff, save it as an `artifacts` row of `kind='diff'`.
   - `session.diff` → save the snapshot as another artifact.
   - `permission.replied` with `reply='reject'` → set `runs.status='rejected'` and stamp `ended_at`.
4. **Broadcast live.** `pubsub.publish()` (in <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/ingestion/pubsub.py" />) shoves the event into an in-memory queue so the dashboard's SSE stream lights up in real time.

Think of it like the lab's mailroom: open the box, log the contents, file the
forms in the right cabinets, and ring the bell so the people upstairs know
something arrived.

### Scene 4 — The investigators run their checklist

When `/v1/runs/:id/outcome` fires, the **finalizer** (`workers/finalizer.py`)
is supposed to wake up and run the autopsy. It coordinates four steps:

1. **`extractor.extract()`** — pulls "things that were touched" out of the run. Files (`src/profile/profile.service.ts`), Components (`profile`), ChangePatterns (`schema_field_addition`). It's the pathologist labelling what was on the table.

2. **`classifier.classify()`** — runs every rule and aggregates the results. Each rule is one item on the forensic checklist:
   - <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/analyzer/rules/schema_change.py" /> — "Did they add a field to a schema/model file?"
   - <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/analyzer/rules/missing_migration.py" /> — "If yes, did they touch `migrations/`? They didn't? Symptom: `missing_migration`."
   - <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/analyzer/rules/frontend_drift.py" /> — "Did they change backend types but skip the regenerated frontend types?"
   - <ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/analyzer/rules/missing_test.py" /> — "Did they touch production code without touching any test file?"

   The classifier merges every rule's symptoms, picks the most-confident
   `failure_mode` (e.g. `incomplete_schema_change_workflow`), and looks up a
   recommended `fix_pattern`. The result is one row in `failure_cases`.

3. **`graph.writer.write()`** — turns the case file into a wall of evidence.

4. **`embeddings.write_for()`** — files a "this case looked like this in
   English" record so future searches can find it by similarity.

> The repo's checked-in versions of the analyzer, finalizer, and graph writer
> are **stubs**. They have the right signatures and docstrings; the actual
> bodies are R3's job. The plumbing is there; the contents are not.

### Scene 5 — Building the wall of evidence (the graph)

The "graph" isn't a separate database. It's just two tables in Postgres:
`graph_nodes` and `graph_edges` (see <ref_snippet file="/Users/alan/Projects/Autopsy/contracts/db-schema.sql" lines="78-104" />). That's enough.

Imagine a corkboard at the back of the lab. Pinned to it:

- **Nodes** — index cards. Types: `Run`, `Task`, `File`, `Component`, `ChangePattern`, `Symptom`, `FailureMode`, `FixPattern`, `Outcome`. One card per thing.
- **Edges** — red strings between cards. Types like `ATTEMPTED`, `TOUCHED`, `EMITTED_SYMPTOM`, `INDICATES`, `RESOLVED_BY`, `RESULTED_IN`. Each string has a **confidence** number (how sure are we?) and an **`evidence_run_id`** — the case number that justified pinning that string.

So our crash leaves behind something like:

```
(Run: fixture-001) ──ATTEMPTED──▶ (Task: "add preferredName")
                  ──HAD_CHANGE_PATTERN──▶ (ChangePattern: schema_field_addition)
                  ──EMITTED_SYMPTOM──▶ (Symptom: missing_migration)
                                                │
                                                INDICATES (conf=0.9, evidence=Run fixture-001)
                                                ▼
                                       (FailureMode: incomplete_schema_change_workflow)
                                                │
                                                RESOLVED_BY
                                                ▼
                                       (FixPattern: also_touch_migrations_dir)
```

The repo deliberately picks Postgres tables over Neo4j (see <ref_snippet file="/Users/alan/Projects/Autopsy/docs/architecture.md" lines="98-99" />). For the 2-hop traversals we need, a recursive CTE on `graph_edges` is plenty, and one database is one fewer thing to operate.

### Scene 6 — Filing the case in the "memory by similarity" cabinet

The corkboard is great if you already know which case to look at. But when a
new task comes in, we don't have a node for it yet — we need to find _similar
old tasks_.

That's what **embeddings** (<ref_file file="/Users/alan/Projects/Autopsy/service/src/aag/graph/embeddings.py" />) are for. The text of the task ("Add preferredName…") gets turned into a vector — a long list of numbers that captures its meaning. Similar phrases become similar vectors. We store these vectors in the `embeddings` table using the **pgvector** extension, with an ANN (approximate nearest neighbor) index for fast lookup.

Three backends are wired:
- **`stub`** (default): a deterministic hash, just so the API runs without internet.
- **`local`**: sentence-transformers, real embeddings on your laptop.
- **`openai`**: OpenAI Embeddings API.

Picture a card catalog where each card is filed not alphabetically but by
"vibe." When a new task arrives, you ask "what's the closest vibe?" and pull
the nearest cards. _Then_ you walk the corkboard's red strings from those
cards.

---

## 6. Walk-through: how the system stops the next mistake

This is the magic trick — the whole point of having recorded and analyzed
that crash. A new opencode run starts. The user types:

> "Add `nickname` to the user profile API."

The plugin has a hook called **`experimental.chat.system.transform`**
(<ref_file file="/Users/alan/Projects/Autopsy/plugin/src/handlers/system.ts" />). It fires _just before_ the LLM gets called. Inside that hook, the plugin does:

1. Call `POST /v1/preflight` with the task text.
2. The service:
   - **Embeds** the task → vector.
   - **ANN-searches** the `embeddings` table for similar past tasks (our previous failed run shows up — "Add preferredName" has nearly the same vector).
   - **Walks the graph** 2 hops out from those past Runs: Run → ChangePattern → FailureMode → Symptoms → FixPattern.
   - **Aggregates** the findings: "the most common failure mode in similar runs was `incomplete_schema_change_workflow`, with symptoms `missing_migration` and `frontend_type_drift`."
   - Returns a `PreflightResponse` with a markdown **`system_addendum`** like _"⚠️ Past similar tasks failed because the agent forgot the migration and frontend type regeneration. Make sure to touch `migrations/` and `*/generated/`."_
3. The plugin **appends** that addendum to the system prompt.
4. The LLM sees the warning before it writes a single token of code, and
   does the right thing on the first try.

That's it. That's the product.

A few **rules of the game** for preflight (from <ref_snippet file="/Users/alan/Projects/Autopsy/docs/architecture.md" lines="92-104" />):

- **No LLM calls in preflight.** It runs every turn; an LLM round-trip would make opencode feel laggy. Only vector retrieval + a SQL traversal.
- **The graph can't be empty on day 1.** `make seed` (<ref_file file="/Users/alan/Projects/Autopsy/scripts/seed.py" />) pre-loads synthetic failure cases so the very first preflight returns something useful — like stocking the lab's reference library before any real cases arrive.
- **Plugin must never block the LLM.** Preflight is on a tight deadline; if it takes too long, the plugin moves on without waiting.

The plugin _also_ calls preflight from `tool.execute.before`
(<ref_file file="/Users/alan/Projects/Autopsy/plugin/src/handlers/tool-before.ts" />)
for risky tools (`edit`, `write`, `bash`). If the response says
`block: true`, the plugin **throws**, which aborts the tool call. That's a
safety pilot pulling the throttle.

---

## 7. The mission-control screen (dashboard)

The dashboard (<ref_file file="/Users/alan/Projects/Autopsy/dashboard/" />) is
deliberately simple. Three pages:

- **`/`** (<ref_file file="/Users/alan/Projects/Autopsy/dashboard/src/app/page.tsx" />) — the runs list, server-rendered from `GET /v1/runs`. Like the wall of recent flights, with a status light next to each.
- **`/runs/[id]`** (<ref_file file="/Users/alan/Projects/Autopsy/dashboard/src/app/runs/[id]/page.tsx" />) — the per-run timeline + autopsy report. Lists every event in order, plus the failure-case panel if the analyzer has run.
- **`/graph`** (<ref_file file="/Users/alan/Projects/Autopsy/dashboard/src/app/graph/page.tsx" />) — currently a placeholder; will render the corkboard with cytoscape/react-flow.

Two helpers do all the work:

- <ref_file file="/Users/alan/Projects/Autopsy/dashboard/src/lib/api.ts" /> — typed `fetch` wrappers for `/v1/runs` and `/v1/runs/:id`. `cache: "no-store"` so refreshes always show fresh state.
- <ref_file file="/Users/alan/Projects/Autopsy/dashboard/src/lib/sse.ts" /> — a `useRunStream(runId)` React hook that opens an `EventSource` to `/v1/runs/:id/stream` for live event tickers. Server-Sent Events are basically a one-way "the lab keeps the door open and shouts new findings down the hall as they happen."

---

## 8. The infrastructure (one container, that's it)

Postgres-with-pgvector, in Docker. Nothing else.

- <ref_file file="/Users/alan/Projects/Autopsy/infra/docker-compose.yml" /> — one service: `pgvector/pgvector:pg16` on `localhost:5432`, login `aag/aag`, with a persistent volume.
- <ref_file file="/Users/alan/Projects/Autopsy/infra/postgres/init.sql" /> — runs at first boot, turns on the `vector` and `pg_trgm` extensions.
- The contracts file <ref_file file="/Users/alan/Projects/Autopsy/contracts/db-schema.sql" /> is also mounted into `/docker-entrypoint-initdb.d/`, so the moment the container comes up the schema is applied.

`make db-reset` nukes the volume and starts over. The root <ref_file file="/Users/alan/Projects/Autopsy/AGENTS.md" /> warns: this is destructive. Don't run it casually.

---

## 9. The Makefile is the front door

Most of the time you don't run any of the components by hand — the <ref_file file="/Users/alan/Projects/Autopsy/Makefile" /> has shortcuts.

| Command | What it does |
|---|---|
| `make dev` | Start everything (Postgres + service + dashboard) in one terminal |
| `make compose-up` / `make compose-down` | Just Postgres |
| `make service-dev` | FastAPI on `:4000` with hot reload, `/docs` for the OpenAPI page |
| `make dashboard-dev` | Next.js on `:3000` |
| `make plugin-link` | Symlink the plugin entry into `.opencode/plugins/autopsy.ts` so opencode loads it |
| `make seed` | Populate the graph with synthetic failure cases (the reference library) |
| `make replay` | Stream `contracts/fixtures/run-rejected-schema.json` into `/v1/events` so you can demo without ever launching opencode |
| `make db-reset` | **Destructive.** Drops the postgres volume |

The replay path is huge for development. It means **you can build and test
the whole service + dashboard without ever wiring up a real LLM run.** The
fixture is the demo's "training video" — a perfectly choreographed crash that
exercises every event type.

---

## 10. The end-to-end picture in one ASCII drawing

```
   developer
       │
       │  "add preferredName…"
       ▼
┌─────────────────────────────────┐
│  opencode (cockpit)             │
│  ┌───────────────────────────┐  │
│  │ plugin (black box)        │  │      events (batched)
│  │  • event hook ────────────┼──┼─────────────────┐
│  │  • tool.execute.before ───┼──┼─── preflight ───┤   HTTPS
│  │  • permission.replied ────┼──┼─── outcome ─────┤
│  │  • system.transform ──────┼──┼─── preflight ───┤
│  └───────────────────────────┘  │                 │
└─────────────────────────────────┘                 │
                                                    ▼
                              ┌──────────────────────────────────────┐
                              │  service (lab)  FastAPI :4000        │
                              │   ingestion ─► assembler ─► Postgres │
                              │                  │                   │
                              │                  ▼                   │
                              │            pubsub ──► SSE ──► dash   │
                              │                                      │
                              │   outcome ─► finalizer               │
                              │       │                              │
                              │       ▼                              │
                              │   classifier ─ extractor             │
                              │       │            │                 │
                              │       ▼            ▼                 │
                              │   FailureCase   graph.writer ──┐     │
                              │                                ▼     │
                              │               ┌─────── Postgres ────┐│
                              │               │ runs / run_events   ││
                              │               │ artifacts           ││
                              │               │ failure_cases       ││
                              │               │ graph_nodes/edges   ││
                              │               │ embeddings (pgvec)  ││
                              │               └─────────────────────┘│
                              │                                      │
                              │   preflight ─► embed ─► ANN ─► CTE   │
                              │                            │         │
                              │                            ▼         │
                              │                     system_addendum  │
                              └──────────────────────────────────────┘
                                                    │
                                                    ▼
                              ┌──────────────────────────────────────┐
                              │  dashboard (mission control) :3000   │
                              │   /            runs list             │
                              │   /runs/[id]   timeline + autopsy    │
                              │   /graph       corkboard view        │
                              └──────────────────────────────────────┘
```

---

## 11. Five gotchas worth memorizing

1. **The plugin must never block the LLM.** Every call out of the plugin is fire-and-forget or has a tight timeout. If the service is down, opencode keeps working — it just stops getting smarter.
2. **The rejection reason isn't on the bus.** Capturing _why_ a user rejected a tool call is the most fragile piece. Three fallbacks exist: query opencode's local HTTP server, wrap `permission.ask`, or have the user fill in a "Why?" form on the dashboard. <ref_snippet file="/Users/alan/Projects/Autopsy/contracts/events.md" lines="47-60" />
3. **Preflight has zero LLM calls.** Vector search + recursive CTE only. If you're tempted to add an LLM call to "make the warning prettier," don't — that goes in the autopsy report, not preflight.
4. **The graph is empty on first boot.** `make seed` matters; without it, the very first preflight returns nothing useful.
5. **Idempotency everywhere.** `(run_id, event_id)` for events; `(type, name)` for nodes; `(source, target, type, evidence_run_id)` for edges. The plugin can retry safely; the analyzer can re-run safely.

---

## 12. Status at a glance — what's real vs. stubbed

The contracts and plumbing are real. Most of the **brains** are stubs awaiting
implementation by the lane owners (see <ref_file file="/Users/alan/Projects/Autopsy/docs/ownership.md" />):

| Component | State |
|---|---|
| Plugin event capture, batcher, HTTP client | Real |
| Service event ingestion + assembler + pubsub + SSE | Real |
| Run list / run detail endpoints | Real |
| `routes/preflight.py` | **Stub** — returns empty response |
| `analyzer/classifier.py` and all rules | **Stub** — return nothing |
| `analyzer/extractor.py` | **Stub** |
| `graph/writer.py`, `graph/traversal.py` | **Stub** |
| `workers/finalizer.py` (the wire from outcome → analyzer) | **Stub** |
| `graph/seed.py` and `scripts/seed.py` | **Stub** |
| Embeddings (stub backend) | Real; switch to `local`/`openai` via env |
| Dashboard runs list + run detail | Real |
| Dashboard `/graph` page | **Placeholder** |

Treat this wiki as the map. Treat the code's `TODO` comments as the
construction signs.

---

## 13. Where to read more

- <ref_file file="/Users/alan/Projects/Autopsy/README.md" /> — quickstart and the Hour-1 contracts list.
- <ref_file file="/Users/alan/Projects/Autopsy/docs/architecture.md" /> — the more terse, technical view of the same picture, including risk flags.
- <ref_file file="/Users/alan/Projects/Autopsy/docs/ownership.md" /> — who owns which lane and what the parallel deep-work phase looks like.
- <ref_file file="/Users/alan/Projects/Autopsy/docs/demo-script.md" /> — the exact terminal commands and prompts for the live demo.
- <ref_file file="/Users/alan/Projects/Autopsy/AGENTS.md" /> — workspace conventions (uv for Python deps, ruff, pyright; never edit `pyproject.toml` deps by hand; etc.).

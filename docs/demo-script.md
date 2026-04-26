# Demo script

The whole hackathon converges on this loop. Practice it end-to-end before
final hours.

## Setup (once)

```bash
make demo-prep            # boots postgres, picks the right embedding provider,
                          # syncs deps, seeds the graph, and verifies the
                          # closed loop end-to-end.
make dashboard-install    # one-time npm install for the dashboard.
```

`make demo-prep` is idempotent — re-run any time. By default it picks `EMBED_PROVIDER=stub` (deterministic hash, byte-identical-only retrieval). For real semantic similarity in the demo flow below, set `GEMINI_API_KEY` in `.env` (recommended — free, same key as the Gemma classifier) and re-run `make demo-prep`, which will auto-promote you to `gemini` (Google `text-embedding-004`, 768-d). Alternatively set `OPENAI_API_KEY` or run `cd service && uv sync --extra ml` for the `local` provider.

## Run the demo

Three terminals.

### Terminal 1 — service

```bash
make service-dev
# uvicorn on :4000  (open http://localhost:4000/docs to verify)
```

### Terminal 2 — dashboard

```bash
make dashboard-dev
# next.js on :3000 (open http://localhost:3000)
```

### Terminal 3 — opencode + plugin

```bash
make plugin-link
opencode                 # requires opencode installed (https://opencode.ai/docs/)
                         # graph is already seeded by `make demo-prep`; re-run
                         # `make seed` only if you've reset the database.
```

## The flow

1. **Failed run.** In opencode, paste:
   > Add `preferredName` to the user profile API and UI.

   The agent edits backend types + serializer but no migration. Reject the
   tool call with feedback "missed the migration and frontend types."

2. **Autopsy.** Refresh <http://localhost:3000>. Click the rejected run.
   - timeline shows tool calls, diffs, the rejection
   - autopsy panel shows `failure_mode = incomplete_schema_change_workflow`
     with symptoms `missing_migration`, `frontend_type_drift`
   - failure graph (`/graph`) shows new nodes + edges connected by
     `evidence_run_id`

3. **Preflight on retry.** New opencode session, similar prompt:
   > Add `nickname` to the user profile API.

   Plugin's `experimental.chat.system.transform` calls `/v1/preflight`. The
   first assistant turn shows the injected addendum. Dashboard preflight panel
   surfaces the same warning.

4. **Agent does the right thing.** This time it touches `migrations/` and
   `generated/types.ts`, run completes, user approves. Counter-evidence
   strengthens the graph.

## Offline backup

If opencode fails to start at demo time:

```bash
make replay   # streams contracts/fixtures/run-rejected-schema.json into the API
```

The fixture exercises every event type the plugin emits, so the dashboard
populates without the live runtime.

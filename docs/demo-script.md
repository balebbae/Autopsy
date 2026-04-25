# Demo script

The whole hackathon converges on this loop. Practice it end-to-end before
final hours.

## Setup (once)

```bash
cp .env.example .env
make compose-up
make service-install
make dashboard-install
```

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
make seed                # pre-populate graph with synthetic failures (R3)
opencode                 # requires opencode installed (https://opencode.ai/docs/)
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

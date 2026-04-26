# Demo Benchmark — Opus 4.5 vs 4.7 vs 4.7 + Autopsy

A repeatable, scripted demo that shows judges why Autopsy matters.

## The story in 30 seconds

> Opus 4.5 is great at agentic coding because Cursor, Codex, and Windsurf
> have all been optimized for it. Opus 4.7 is a *smarter* model overall,
> but it hasn't been tuned for tool-use workflows — so it makes common
> mistakes like forgetting DB migrations.
>
> Autopsy records those failures and turns them into guardrails. The next
> time 4.7 gets a similar task, the preflight system injects a warning
> into its context. Result: **4.7 + Autopsy outperforms 4.5 alone.**

## Quick start

```bash
# 1. Make sure the stack is up
make demo-prep            # postgres + seed + verify (idempotent, ~30s)

# 2. Start the service (keep this terminal open)
make service-dev          # uvicorn on :4000

# 3. In another terminal, run the benchmark
make demo-benchmark       # full three-act run with comparison table
```

## What it does

The benchmark replays three fixture runs through the AAG service and
measures real API latency:

| Act | Model    | Autopsy | Outcome  | What happens                                              |
|-----|----------|---------|----------|-----------------------------------------------------------|
| 1   | Opus 4.5 | off     | PASS     | Trained for tool-use; adds field + migration + types      |
| 2   | Opus 4.7 | off     | **FAIL** | Smarter but untrained; forgets migration → rejected       |
| 3   | Opus 4.7 | **on**  | PASS     | Preflight injects warning from Act 2's failure → succeeds |

After the three acts, a **preflight sweep** fires five related prompts
through `/v1/preflight` to show retrieval consistency.

Output:
- Color-coded terminal report (ideal for a live screen share)
- `benchmark-report.json` at the repo root (machine-readable)

## Commands

| Command                      | Description                                           |
|------------------------------|-------------------------------------------------------|
| `make demo-benchmark`        | Full run: seeds graph, replays 3 acts, sweep, report  |
| `make demo-benchmark-quick`  | Skip seeding (assumes `make seed` was already run)    |
| `make demo-sweep`            | Preflight sweep only — fires prompts, prints table    |

## Fixtures

All benchmark fixtures live in `contracts/fixtures/`:

| File                              | Model    | Outcome  | Description                              |
|-----------------------------------|----------|----------|------------------------------------------|
| `bench-opus45-pass.json`          | Opus 4.5 | approved | Correct: field + migration + types       |
| `bench-opus47-fail.json`          | Opus 4.7 | rejected | Incomplete: field only, no migration     |
| `bench-opus47-autopsy-pass.json`  | Opus 4.7 | approved | With Autopsy warning: does everything    |

### Adding new scenarios

1. Copy an existing fixture and change `run_id`, `model`, `label`, events.
2. Add it to the `SCENARIOS` list in `scripts/demo-benchmark.py`.
3. If you want it in the sweep, add a prompt to `REPEAT_PROMPTS`.

## Live demo flow for judges

### Setup (before judges arrive)

```bash
make demo-prep
make service-dev          # terminal 1
make dashboard-dev        # terminal 2
```

### Presenting (3–5 minutes)

1. **"The problem."** Open the dashboard (`localhost:3000`). Show the
   failure graph — it already has nodes from the seed data.

2. **"The benchmark."** In terminal 3:

   ```bash
   make demo-benchmark
   ```

   Walk through each act as it runs:

   - **Act 1 (Opus 4.5):** "4.5 is what Cursor was built on. It knows
     to add migrations. ✓ approved."
   - **Act 2 (Opus 4.7 without Autopsy):** "4.7 is smarter but hasn't
     learned this lesson yet. It forgets the migration. ✗ rejected."
   - **Act 3 (Opus 4.7 + Autopsy):** "Now Autopsy kicks in. It finds
     the failure from Act 2 and injects a warning. 4.7 reads it, does
     the migration, and passes. ✓ approved."

3. **"Retrieval."** The sweep table shows that similar prompts all
   trigger the same warning — the guardrail generalizes.

4. **"Dashboard."** Refresh `localhost:3000`. Click the failed run to
   show the timeline, autopsy panel, and failure graph edges.

### Talking points

- "Every rejected run becomes a guardrail for the next one."
- "We don't fine-tune the model — we inject *context*. This works with
  any model, any provider."
- "The graph is project-local. Each team builds its own institutional
  memory."
- "Preflight runs in <100ms. The model never even sees the extra context
  unless there's a real risk."

## Extending for more model comparisons

The benchmark architecture is model-agnostic. To compare other models:

1. Create fixture files that simulate each model's behavior on the same
   task (include realistic tool call patterns).
2. Add entries to `SCENARIOS` in `demo-benchmark.py`.
3. The comparison table auto-scales to any number of acts.

For *live* model comparison (actually calling different LLMs via
opencode), you'd run separate opencode sessions with different
`OPENAI_MODEL` / `ANTHROPIC_MODEL` env vars and let the plugin record
each run normally. The dashboard then shows them side by side.

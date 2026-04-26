<div align="center">

<img src="site/favicon.svg" alt="Autopsy" width="96" />

# Agent Autopsy Graph

**Forensic memory for AI coding agents.** Every failure becomes a guardrail.

A blackbox recorder that wraps an [opencode](https://opencode.ai/docs/)
runtime, records every tool call and rejection, builds a failure graph in
Postgres + pgvector, and warns future runs before they make the same
mistake.

[autopsy.surf](https://autopsy.surf) ·
[install.autopsy.surf](https://install.autopsy.surf) ·
[architecture](docs/architecture.md) ·
[demo script](docs/demo-script.md)

</div>

---

## Install in your project

From your project's root:

```bash
curl -fsSL https://install.autopsy.surf/install.sh | bash
```

This brings up the full local stack (postgres, FastAPI service on `:4000`,
Next.js dashboard on `:3000`), installs the opencode plugin into the
current project, writes `AAG_URL` to the project's `.env`, and prompts once
for an optional Gemini API key (press Enter to skip; Autopsy works fully
without it). `~/.autopsy/stop.sh` brings everything back down.

Flags: `--plugin-only` (skip the stack, point at a remote service),
`--no-start` (set up but don't launch), `--no-prompt` (skip the Gemini key
prompt), `--stop` (tear down the running stack and exit).
See `install.sh --help`.

## How it works

```
opencode runtime
   │  events (tool calls, edits, chat, rejections, postflight checks)
   ▼
recorder plugin   ─POST─▶  AAG service  ─▶  Postgres + pgvector
                              │
                              │  classify failure → graph node + edges
                              │  embed task text → vector index
                              ▼
                          /v1/preflight
                              │
                              │  ANN + 3-hop traversal over the failure graph
                              ▼
opencode runtime  ◀────  system addendum + (sometimes) hard-blocks tool calls
```

Every failed run becomes a guardrail for the next similar task. The
dashboard at `localhost:3000` shows the live timeline, the failure graph,
and which preflight hits Autopsy injected into the agent's system prompt.

For the long version see [docs/architecture.md](docs/architecture.md).

## Develop

Prereqs: `uv`, `node` 20+, `bun`, `docker` (with compose).

```bash
cp .env.example .env
make dev                  # postgres + service + dashboard, Ctrl+C to stop
make plugin-link          # symlink plugin/src/index.ts into .opencode/plugins/
make seed                 # populate the graph with synthetic failures
make trace                # end-to-end preflight smoke test
```

Service + dashboard logs stream to the same terminal with `[svc]` /
`[dash]` prefixes. Postgres keeps running between sessions; `make
compose-down` stops it.

| Package        | Lint / typecheck                     | Tests              |
| -------------- | ------------------------------------ | ------------------ |
| `service/`     | `make service-lint`                  | `make service-test` (needs postgres) |
| `dashboard/`   | `cd dashboard && npx tsc --noEmit`   | none yet           |
| `plugin/`      | `cd plugin && bun run typecheck`     | none yet           |

CI (lint + typecheck across all three packages, plus shellcheck on
`install.sh`) runs on every PR via `.github/workflows/ci.yml`.

## Contracts

`contracts/openapi.yaml`, `contracts/db-schema.sql`, `contracts/events.md`,
and `contracts/fixtures/*.json` are the source of truth for routes, schema,
event mapping, and demo runs. Update them in the same commit when changing
endpoints or tables. Ownership map in [docs/ownership.md](docs/ownership.md).

## Demo loop

[docs/demo-script.md](docs/demo-script.md) has the exact commands. Summary:

1. Run a "schema field addition" task in opencode → user rejects with
   "missed migration".
2. Service stores the run, analyzer classifies, graph writer records the
   failure.
3. Start a similar new task → preflight injects a system addendum and (for
   high-confidence matches) blocks the offending tool call with a cited
   rationale; the dashboard shows the warning + blocked events on the
   timeline.
4. Agent does the right thing the first time.

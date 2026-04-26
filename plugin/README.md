# @aag/opencode-plugin

opencode plugin for Agent Autopsy Graph.

## What it does

- Mirrors every opencode bus event to the AAG service via `POST /v1/events`
- On `tool.execute.before` for risky tools, asks `POST /v1/preflight` and may throw to abort
- On `experimental.chat.system.transform`, injects a preflight warning addendum into the system prompt
- On `permission.replied` with reject, posts the run outcome + tries to capture rejection feedback
- On `tool.execute.after` for file-modifying tools (`edit`, `write`, …), debounces and runs a **post-flight code-check suite** (lint / typecheck / test). Any non-zero check files a rejection (`failure_mode=automated_check_failed`) which lights up the dashboard and feeds the next preflight.

## Local dev

```bash
make plugin-link            # symlinks src into .opencode/plugins/autopsy.ts
opencode                    # run opencode (https://opencode.ai/docs/) here
```

The plugin reads `AAG_URL` (default `http://localhost:4000`) and `AAG_TOKEN` from env.

## Build

Optional — opencode loads .ts directly. If you want a bundle for distribution:

```bash
make plugin-install
make plugin-build           # writes dist/index.js
```

## Layout

```
src/
  index.ts                main plugin export
  config.ts               env reading
  client.ts               fetch wrapper around AAG service
  batcher.ts              debounced event flush
  postflight.ts           post-flight code-check suite (debounced)
  types.ts                shared types
  handlers/
    event.ts              event hook → forward
    tool-before.ts        preflight + may abort
    tool-after.ts         capture diffs (edit/write) + bash output + schedule postflight
    permission.ts         capture asks + replies + rejection feedback
    system.ts             experimental.chat.system.transform injector
```

## Post-flight checks

After the agent uses a file-modifying tool (`edit`, `write`, `multiedit`,
`patch`) and goes quiet for `AAG_POSTFLIGHT_DEBOUNCE_MS` (default 3000ms),
the plugin runs a hardcoded suite of code checks against the working tree:

| Name                  | Command                                                    | Default timeout |
| --------------------- | ---------------------------------------------------------- | --------------- |
| `service-lint`        | `make service-lint`                                        | 60s             |
| `service-test`        | `make service-test`                                        | 180s            |
| `plugin-typecheck`    | `bun run typecheck` (cwd `plugin`)                         | 60s             |
| `dashboard-typecheck` | `npx next typegen && npx tsc --noEmit` (cwd `dashboard`)   | 120s            |

Each check runs through `$` (Bun shell) with `nothrow().quiet()` so a
non-zero exit is a captured failure rather than a thrown error.

**On any failure**, the plugin:

1. Emits an `aag.postflight.completed` event with `passed: false` and a
   per-check breakdown for the dashboard timeline.
2. POSTs `/v1/runs/{run_id}/rejections` with
   `failure_mode=automated_check_failed`,
   `symptoms=<check>_failed,<check>_failed,…`, and a multi-line `reason`
   that includes a tail of stderr/stdout for each failed check.
3. POSTs `/v1/runs/{run_id}/feedback` so the latest reason is mirrored
   onto the run summary.

Because rejections drive the analyzer and graph writer, repeated check
failures across runs build up evidence that the next preflight call can
warn about *before* the agent makes the same mistake again.

### Knobs

| Env var                       | Default | Effect                                              |
| ----------------------------- | ------- | --------------------------------------------------- |
| `AAG_POSTFLIGHT_DISABLED`     | `0`     | Set to `1`/`true` to disable post-flight entirely.  |
| `AAG_POSTFLIGHT_DEBOUNCE_MS`  | `3000`  | Quiet period after the last edit before running.    |
| `AAG_POSTFLIGHT_TOOLS`        | `edit,write,multiedit,patch` | Comma-separated tool names that trigger a run. |

The check suite itself is hardcoded for the Autopsy monorepo (see
`DEFAULT_CHECKS` in `src/postflight.ts`). Downstream projects that vendor
this plugin should call `setPostflightChecks([...])` from a thin wrapper.

### Smoke test

```bash
bun src/__smoke__/postflight.smoke.ts
```

Stub-fetches the AAG service and runs through all-pass / failure /
timeout / scheduler / cancel paths. Prints `ok` and exits 0 on success.

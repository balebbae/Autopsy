# @aag/opencode-plugin

opencode plugin for Agent Autopsy Graph.

## What it does

- Mirrors every opencode bus event to the AAG service via `POST /v1/events`
- On `tool.execute.before` for risky tools, asks `POST /v1/preflight` and may throw to abort
- On `experimental.chat.system.transform`, injects a preflight warning addendum into the system prompt
- On `permission.replied` with reject, posts the run outcome + tries to capture rejection feedback

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
  types.ts                shared types
  handlers/
    event.ts              event hook → forward
    tool-before.ts        preflight + may abort
    tool-after.ts         capture diffs (edit/write) + bash output
    permission.ts         capture asks + replies + rejection feedback
    system.ts             experimental.chat.system.transform injector
```

# Event mapping: opencode bus → AAG normalized events

This is the contract between the **plugin** (R1) and the **service** (R2). The plugin
forwards opencode bus events to `POST /v1/events`. Each event is normalized to:

```json
{
  "event_id": "<plugin-side ulid, optional>",
  "run_id":   "<opencode sessionID>",
  "project":  "<plugin's project.id>",
  "worktree": "<plugin's worktree path>",
  "ts":       1714000000000,
  "type":     "<opencode event type, verbatim>",
  "properties": { ...verbatim opencode event payload... }
}
```

The service stores events in `run_events` (idempotent on `(run_id, event_id)`) and
publishes them on the in-process pubsub for SSE.

## Forwarded events

| opencode bus event       | direction | use                                                                    |
| ------------------------ | --------- | ---------------------------------------------------------------------- |
| `session.created`        | →         | create `runs` row, capture `task` from first user message              |
| `session.updated`        | →         | update `runs.summary`, etc.                                            |
| `session.idle`           | →         | finalize hint (assembler may auto-mark approved)                       |
| `session.diff`           | →         | append to `artifacts(kind='diff')`; bump `files_touched`               |
| `message.part.updated`   | →         | timeline rendering; do **not** persist part text deltas — too chatty   |
| `tool.execute.before`    | →         | timeline marker; preflight already happened plugin-side                |
| `tool.execute.after`     | →         | bump `tool_calls`; for `edit`/`write` extract diff into `artifacts`    |
| `file.edited`            | →         | redundant w/ tool.execute.after but useful for non-tool edits          |
| `permission.asked`       | →         | timeline marker                                                        |
| `permission.replied`     | →         | if `reply='reject'` set `runs.status='rejected'`; capture feedback     |

## Plugin-only events (not from opencode bus)

| AAG type                 | source                                   | use                                                           |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------- |
| `aag.preflight.warned`   | plugin `tool.execute.before`             | record that preflight returned a warning for this tool call   |
| `aag.preflight.blocked`  | plugin `tool.execute.before` (threw)     | record that preflight aborted a tool call                     |
| `aag.system.injected`    | `experimental.chat.system.transform`     | record that a preflight system addendum was injected          |

These flow through the same `POST /v1/events` channel so the dashboard can
visualize them inline.

## Rejection feedback (the tricky one)

The opencode `permission.replied` bus event drops the user's free-text reason.
To capture it the plugin should also `POST /v1/runs/:id/feedback` with
`{feedback: "<text>", source: "plugin"}` after observing a rejection. The reply
text can be obtained either by:

1. Calling `GET /session/:id/permission/:permissionID` against the local opencode
   HTTP server right after seeing `permission.replied`, **or**
2. Wrapping `permission.ask` and recording the `output.message` if the plugin
   later sees a reject (less reliable; preferred path is #1).

If neither works under hackathon time pressure, the dashboard exposes a manual
"Why did you reject?" form that POSTs the same endpoint with `source=dashboard`.

## Outcome event

When the plugin observes session shutdown (idle + no further user input, or
explicit abort) it should `POST /v1/runs/:id/outcome` with one of
`approved | rejected | aborted`. This call is what triggers the analyzer.

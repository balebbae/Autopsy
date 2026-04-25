// In opencode 1.x, tool.execute.* are no longer on the global bus, so the
// `event` hook never sees them. We synthesize an AAG event here so the
// service can count tool calls and capture diffs.
//
// Output shape (what we persist on `result`):
//   { title, output_preview, output_size, metadata, ok, error }
//
// Rationale: opencode tool outputs (especially read/grep/bash) can be huge
// and bloat the JSONB row. The service only needs the failure signal +
// a small preview, so we trim here at capture time.

import { enqueue } from "../batcher.ts"
import type { EventIn } from "../types.ts"

const PREVIEW_OK = 512
const PREVIEW_FAIL = 2048
const ERROR_LINE_MAX = 1024

const truncate = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n)}…[+${s.length - n}b]` : s

const looksLikeError = /(\b(error|failed|exception|traceback|fatal)\b)/i

const firstErrorLine = (raw: string): string => {
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    if (looksLikeError.test(t)) return t.slice(0, ERROR_LINE_MAX)
  }
  return (raw.split("\n").find((l) => l.trim()) ?? "").slice(0, ERROR_LINE_MAX)
}

const isOk = (output: string, metadata: Record<string, unknown>): boolean => {
  if (metadata && typeof metadata === "object") {
    if ("error" in metadata && metadata.error) return false
    const exit = (metadata as { exit?: unknown }).exit
    if (typeof exit === "number" && exit !== 0) return false
  }
  if (output.startsWith("Error:") || output.startsWith("error:")) return false
  return true
}

export const onToolAfter = async (
  input: { tool: string; sessionID: string; callID: string; args: any },
  output: { title?: string; output?: unknown; metadata?: any },
) => {
  if (!input.sessionID) return

  const raw = typeof output?.output === "string" ? output.output : ""
  const metadata = (output?.metadata ?? {}) as Record<string, unknown>
  const ok = isOk(raw, metadata)
  const cap = ok ? PREVIEW_OK : PREVIEW_FAIL

  const ev: EventIn = {
    run_id: input.sessionID,
    ts: Date.now(),
    type: "tool.execute.after",
    properties: {
      sessionID: input.sessionID,
      tool: input.tool,
      callID: input.callID,
      args: input.args,
      result: {
        title: output?.title,
        output_preview: truncate(raw, cap),
        output_size: raw.length,
        metadata,
        ok,
        error: ok
          ? null
          : (typeof metadata.error === "string" && metadata.error.length > 0
              ? metadata.error.slice(0, ERROR_LINE_MAX)
              : firstErrorLine(raw)),
      },
    },
  }
  enqueue(ev)
}

import { enqueue } from "../batcher.ts"
import { postFeedback, postOutcome } from "../client.ts"
import type { EventIn } from "../types.ts"

// Bus events that add no autopsy signal but flood the timeline / DB.
// Drop at the source so they never hit the network.
const NOISY_TYPES = new Set([
  "session.status",
  "session.updated",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "message.updated",
  "message.removed",
])

const isEmptyDiff = (props: Record<string, unknown>) => {
  const d = (props as { diff?: unknown }).diff
  if (d == null) return true
  if (Array.isArray(d) && d.length === 0) return true
  return false
}

// Entry for the `event` hook. opencode 1.x wraps the bus event in `{ event }`.
// We never block on the network — fire-and-forget through the batcher.
export const onEvent = async (
  input: { event: { type: string; properties: Record<string, unknown> } },
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  const e = input.event
  const props = (e.properties ?? {}) as { sessionID?: string; reply?: string; feedback?: string }
  const runId = props.sessionID
  if (!runId) return

  // permission.replied side-effect must run before the noise filter so
  // rejection feedback still flows even if we ever add it to NOISY_TYPES.
  if (e.type === "permission.replied" && props.reply === "reject") {
    await postOutcome(runId, "rejected", props.feedback)
    if (props.feedback) await postFeedback(runId, props.feedback)
  }

  if (NOISY_TYPES.has(e.type)) return
  if (e.type === "session.diff" && isEmptyDiff(e.properties ?? {})) return

  const ev: EventIn = {
    run_id: runId,
    project: ctx.project?.id,
    worktree: ctx.worktree,
    ts: Date.now(),
    type: e.type,
    properties: e.properties,
  }
  enqueue(ev)
}

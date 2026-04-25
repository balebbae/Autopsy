import { enqueue } from "../batcher.ts"
import type { EventIn } from "../types.ts"

// Entry for the `event` hook. opencode passes every bus event here.
// We never block on the network — fire-and-forget through the batcher.
export const onEvent = (
  e: { type: string; properties: Record<string, unknown> },
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  const runId = (e.properties as { sessionID?: string }).sessionID
  if (!runId) return
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

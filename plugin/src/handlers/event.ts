import { enqueue } from "../batcher.ts"
import { postFeedback, postOutcome } from "../client.ts"
import type { EventIn } from "../types.ts"

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

  const ev: EventIn = {
    run_id: runId,
    project: ctx.project?.id,
    worktree: ctx.worktree,
    ts: Date.now(),
    type: e.type,
    properties: e.properties,
  }
  enqueue(ev)

  // permission.replied is no longer a standalone hook in opencode 1.x; piggyback
  // on the bus event so the run-outcome side-effect still fires on rejection.
  if (e.type === "permission.replied" && props.reply === "reject") {
    await postOutcome(runId, "rejected", props.feedback)
    if (props.feedback) await postFeedback(runId, props.feedback)
  }
}

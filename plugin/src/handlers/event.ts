import { enqueue } from "../batcher.ts"
import { postFeedback, postOutcome } from "../client.ts"
import type { EventIn } from "../types.ts"

const FRUSTRATION_RE =
  /\b(shit|shitty|fuck|fucking|fucked|wtf|trash|garbage|terrible|horrible|awful|useless|stupid|idiot|dumb|crap|crappy|kill\s*(yourself|urself)|kys|this\s+sucks|worst|redo\s+(this|it|everything)|start\s+over|completely\s+wrong|totally\s+wrong|not\s+what\s+i\s+(asked|wanted|said))\b/i

// Track sessions where we already fired a frustration outcome so we don't spam.
const firedSessions = new Set<string>()

// Entry for the `event` hook. opencode 1.x wraps the bus event in `{ event }`.
// We never block on the network — fire-and-forget through the batcher.
export const onEvent = async (
  input: { event: { type: string; properties: Record<string, unknown> } },
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  const e = input.event
  const props = (e.properties ?? {}) as {
    sessionID?: string
    reply?: string
    feedback?: string
    part?: { type?: string; text?: string; time?: number }
  }
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
    await postOutcome(runId, "rejected", props.feedback as string | undefined)
    if (props.feedback) await postFeedback(runId, props.feedback as string)
  }

  // Auto-detect frustrated user messages and trigger the rejection pipeline.
  // User text parts have type=text and no "time" field.
  if (
    e.type === "message.part.updated" &&
    props.part?.type === "text" &&
    !("time" in (props.part ?? {})) &&
    props.part?.text &&
    FRUSTRATION_RE.test(props.part.text) &&
    !firedSessions.has(runId)
  ) {
    firedSessions.add(runId)
    const snippet = props.part.text.slice(0, 300)
    await postOutcome(runId, "rejected", snippet)
    await postFeedback(runId, snippet)
  }
}

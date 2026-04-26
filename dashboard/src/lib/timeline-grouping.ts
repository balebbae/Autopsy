// Group a run's events into "attempts" — one per user message turn.
//
// The mental model: the user's messages are the spine that drives the run
// forward. Each user message starts a new attempt; the agent's tool calls,
// file edits, and preflight signals belong to the attempt that contains them.
// An attempt's outcome is approved (next user message arrives normally),
// rejected (a frustrated message / explicit rejection lands inside it), or
// active (still running, no outcome yet).
//
// This helper is pure: it takes the same shapes the API already returns and
// produces a typed timeline structure both the Timeline and Branched views
// can render.
import type {
  PreflightHit,
  Rejection,
  Run,
  RunEvent,
  RunStatus,
} from "@/lib/api"

export type AttemptOutcome =
  | { kind: "approved"; ts: number }
  | { kind: "rejected"; ts: number; reason: string; failureMode: string | null }
  | { kind: "active"; ts: number }

export type ToolCall = {
  ts: number
  tool: string
  args?: Record<string, unknown>
  blocked?: boolean
}

export type FileEdit = {
  ts: number
  file: string
  action: string
}

export type Attempt = {
  index: number
  // The user message that opens this attempt. Null only for attempts that
  // start before any user message lands (rare, but possible if a run is
  // pre-seeded by a task description with no chat input yet).
  userMessage: { ts: number; text: string; frustrated?: boolean } | null
  startTs: number
  endTs: number
  preflight: PreflightHit[]
  toolCalls: ToolCall[]
  fileEdits: FileEdit[]
  outcome: AttemptOutcome
}

export type GroupedRun = {
  runId: string
  status: RunStatus
  task: string | null
  startedAt: number
  endedAt: number | null
  attempts: Attempt[]
}

type ChatMsgProps = {
  role?: unknown
  text?: unknown
  frustrated?: unknown
}

function readUserMessage(
  evt: RunEvent,
): { ts: number; text: string; frustrated: boolean } | null {
  if (evt.type !== "chat.message") return null
  const props = (evt.properties ?? {}) as ChatMsgProps
  if (props.role !== "user") return null
  const text = typeof props.text === "string" ? props.text : ""
  if (!text.trim()) return null
  return {
    ts: evt.ts,
    text,
    frustrated: props.frustrated === true,
  }
}

function readToolCall(evt: RunEvent): ToolCall | null {
  if (evt.type !== "tool.execute.before") return null
  const props = (evt.properties ?? {}) as { tool?: unknown; args?: unknown }
  const tool = typeof props.tool === "string" ? props.tool : "tool"
  return {
    ts: evt.ts,
    tool,
    args: (props.args as Record<string, unknown>) ?? undefined,
  }
}

function readFileEdit(evt: RunEvent): FileEdit | null {
  if (evt.type !== "file.edited") return null
  const props = (evt.properties ?? {}) as { file?: unknown; action?: unknown }
  const file = typeof props.file === "string" ? props.file : null
  if (!file) return null
  const action = typeof props.action === "string" ? props.action : "edited"
  return { ts: evt.ts, file, action }
}

/**
 * Group a Run into attempts keyed by user messages.
 *
 * Boundary rule: an attempt starts at user message N and ends just before
 * user message N+1 (or at the run's end for the last attempt).
 *
 * Outcome assignment:
 *   - any rejection landing inside the attempt window → rejected
 *   - last attempt + run.status="approved" with no rejection → approved
 *   - any earlier attempt with no rejection that was followed by another
 *     user message → approved (user moved on, treating it as accepted)
 *   - run.status="active" + no terminal rejection → active
 */
export function groupRunByAttempts(run: Run): GroupedRun {
  const events = [...(run.events ?? [])].sort((a, b) => a.ts - b.ts)
  const rejections = [...(run.rejections ?? [])].sort((a, b) => a.ts - b.ts)
  const preflight = [...(run.preflight_hits ?? [])].sort((a, b) => a.ts - b.ts)

  // 1. Find user-message events. They define attempt boundaries.
  const userMessages: Array<{
    ts: number
    text: string
    frustrated: boolean
  }> = []
  for (const evt of events) {
    const m = readUserMessage(evt)
    if (m) userMessages.push(m)
  }

  // Define attempt start times. If the run has events before the first user
  // message, those still belong to attempt 1 — we anchor that attempt to the
  // run start so nothing is dropped.
  type Boundary = {
    startTs: number
    endTs: number
    userMessage: { ts: number; text: string; frustrated: boolean } | null
  }
  const boundaries: Boundary[] = []
  if (userMessages.length === 0) {
    // No user messages at all — render the whole run as a single attempt.
    boundaries.push({
      startTs: run.started_at,
      endTs: run.ended_at ?? Number.POSITIVE_INFINITY,
      userMessage: null,
    })
  } else {
    // Pre-message activity belongs to attempt 1 if any exists.
    const firstUserTs = userMessages[0].ts
    const runStart = run.started_at
    const firstAttemptStart =
      runStart > 0 && runStart < firstUserTs ? runStart : firstUserTs
    boundaries.push({
      startTs: firstAttemptStart,
      endTs: userMessages[1]?.ts ?? run.ended_at ?? Number.POSITIVE_INFINITY,
      userMessage: userMessages[0],
    })
    for (let i = 1; i < userMessages.length; i++) {
      boundaries.push({
        startTs: userMessages[i].ts,
        endTs:
          userMessages[i + 1]?.ts ?? run.ended_at ?? Number.POSITIVE_INFINITY,
        userMessage: userMessages[i],
      })
    }
  }

  // 2. Bucket events / preflight / rejections into the right attempt.
  const attempts: Attempt[] = boundaries.map((b, i) => ({
    index: i + 1,
    userMessage: b.userMessage,
    startTs: b.startTs,
    endTs: b.endTs,
    preflight: [],
    toolCalls: [],
    fileEdits: [],
    outcome: { kind: "active", ts: b.endTs }, // overwritten below
  }))

  function findAttemptIndex(ts: number): number {
    // Last boundary whose startTs <= ts. Linear is fine; runs have small
    // attempt counts in practice.
    for (let i = attempts.length - 1; i >= 0; i--) {
      if (ts >= attempts[i].startTs) return i
    }
    return 0
  }

  for (const evt of events) {
    const tc = readToolCall(evt)
    if (tc) {
      attempts[findAttemptIndex(tc.ts)].toolCalls.push(tc)
      continue
    }
    const fe = readFileEdit(evt)
    if (fe) {
      attempts[findAttemptIndex(fe.ts)].fileEdits.push(fe)
    }
  }
  for (const hit of preflight) {
    attempts[findAttemptIndex(hit.ts)].preflight.push(hit)
  }

  const rejectionByAttempt = new Map<number, Rejection>()
  for (const rej of rejections) {
    const i = findAttemptIndex(rej.ts)
    // Keep the latest rejection per attempt. Rejections have already been
    // sorted ascending so a later one will overwrite.
    rejectionByAttempt.set(i, rej)
  }

  // 3. Compute outcomes.
  const lastIndex = attempts.length - 1
  for (let i = 0; i < attempts.length; i++) {
    const att = attempts[i]
    const rej = rejectionByAttempt.get(i)
    if (rej) {
      att.outcome = {
        kind: "rejected",
        ts: rej.ts,
        reason: rej.reason,
        failureMode: rej.failure_mode,
      }
      continue
    }
    if (i < lastIndex) {
      // User moved on to a new message without rejecting — treat as approved.
      att.outcome = { kind: "approved", ts: att.endTs }
      continue
    }
    // Last attempt: tied to run-level status.
    if (run.status === "approved") {
      att.outcome = {
        kind: "approved",
        ts: run.ended_at ?? att.endTs,
      }
    } else if (run.status === "rejected" || run.status === "aborted") {
      // Run ended in a terminal failure state but no rejection row landed in
      // this attempt window. Rare; surface as rejected with the run-level
      // reason if we have one.
      att.outcome = {
        kind: "rejected",
        ts: run.ended_at ?? att.endTs,
        reason: run.rejection_reason ?? `Run ${run.status}`,
        failureMode: null,
      }
    } else {
      att.outcome = { kind: "active", ts: att.endTs }
    }
  }

  return {
    runId: run.run_id,
    status: run.status,
    task: run.task,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    attempts,
  }
}

// Helpers used by both views.
export function attemptHadPreflightWarn(att: Attempt): boolean {
  return att.preflight.some((h) => !h.blocked)
}
export function attemptHadPreflightBlock(att: Attempt): boolean {
  return att.preflight.some((h) => h.blocked)
}
export function topPreflightHit(att: Attempt): PreflightHit | null {
  // Prefer a blocking hit over a warn-only one; otherwise the first.
  const blocked = att.preflight.find((h) => h.blocked)
  return blocked ?? att.preflight[0] ?? null
}

// Collapse repeated tool calls (same tool in a row) for compact display.
export function collapseToolCalls(
  calls: ToolCall[],
): Array<{ tool: string; count: number; ts: number }> {
  const out: Array<{ tool: string; count: number; ts: number }> = []
  for (const c of calls) {
    const prev = out[out.length - 1]
    if (prev && prev.tool === c.tool) {
      prev.count += 1
      continue
    }
    out.push({ tool: c.tool, count: 1, ts: c.ts })
  }
  return out
}

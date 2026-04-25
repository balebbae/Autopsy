import { enqueue, flush } from "../batcher.ts"
import { postFeedback, postRejection } from "../client.ts"
import { setLatestUserMessage } from "../last-task.ts"
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

// Per-session flag: whether we've already seen a non-empty diff. We use this
// to suppress *initial* empty diffs (before any change has been made) but
// allow empty diffs *after* a non-empty one through, because that signals
// the user reverted all prior changes — which the dashboard needs to show.
//
// Bounded LRU so long-running opencode processes that touch many sessions
// don't leak memory. 256 sessions is generous for any realistic workflow.
const SESSIONS_WITH_DIFF_LIMIT = 256
const sessionsWithDiff = new Set<string>()
const markSessionWithDiff = (runId: string) => {
  if (sessionsWithDiff.has(runId)) {
    // Move to the most-recently-used end so the oldest is evicted first.
    sessionsWithDiff.delete(runId)
    sessionsWithDiff.add(runId)
    return
  }
  sessionsWithDiff.add(runId)
  if (sessionsWithDiff.size > SESSIONS_WITH_DIFF_LIMIT) {
    const oldest = sessionsWithDiff.values().next().value
    if (oldest !== undefined) sessionsWithDiff.delete(oldest)
  }
}

// Bounded LRU of `${sessionID}:${permissionID}` keys we've already filed
// rejections for. opencode occasionally re-emits the same permission.replied
// event (e.g. on reconnect or session.updated cascades); this dedupes them
// so we don't spam the dashboard with duplicate rejection rows.
const FIRED_PERMISSIONS_LIMIT = 1024
const firedPermissions = new Set<string>()
const markPermissionFired = (key: string): boolean => {
  if (firedPermissions.has(key)) return false
  firedPermissions.add(key)
  if (firedPermissions.size > FIRED_PERMISSIONS_LIMIT) {
    const oldest = firedPermissions.values().next().value
    if (oldest !== undefined) firedPermissions.delete(oldest)
  }
  return true
}

// Words / phrases that strongly signal the user is unhappy with the
// agent's last action. Kept intentionally aggressive — we only fire once
// per session so false positives are bounded.
const FRUSTRATION_RE =
  /\b(shit|shitty|fuck|fucking|fucked|wtf|trash|garbage|terrible|horrible|awful|useless|stupid|idiot|dumb|crap|crappy|kill\s*(yourself|urself)|kys|this\s+sucks|worst|redo\s+(this|it|everything)|start\s+over|completely\s+wrong|totally\s+wrong|not\s+what\s+i\s+(asked|wanted|said)|that('?s| is)\s+(bad|wrong|broken|not\s+right|incorrect)|wh(y|at the hell|at the heck)\s+(did|are|is|would)\s+you|you\s+(broke|messed\s+up|ruined|fucked\s+up|screwed\s+up)|undo\s+(this|that|it)|revert\s+(this|that|it)|don'?t\s+do\s+that|do\s+not\s+do\s+that|stop\s+(it|that)|never\s+(do|did)\s+that|that('?s| is)\s+not\s+what|hate\s+(this|that|it))\b/i

// Track sessions where we already fired a frustration rejection so we don't spam.
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

  // --- Side-effects that must run BEFORE the noise filter ---

  if (e.type === "permission.replied" && props.reply === "reject") {
    // Persist the raw event *first* so the dashboard's timeline shows the
    // "Permission rejected" row immediately. If we POST the rejection
    // before flushing, the rejection record + classifier output land
    // before the underlying event row exists, and the SSE-driven UI looks
    // like nothing happened until the next refresh.
    enqueue({
      run_id: runId,
      project: ctx.project?.id,
      worktree: ctx.worktree,
      ts: Date.now(),
      type: e.type,
      properties: e.properties,
    })
    await flush()

    // Dedupe by permissionID so re-emitted events don't double-file. If
    // opencode doesn't include a permissionID for some reason, fall back
    // to the event timestamp so identical events in the same millisecond
    // still collapse, but legitimate distinct denials still go through.
    const permissionID =
      (props as { permissionID?: string; id?: string }).permissionID ??
      (props as { permissionID?: string; id?: string }).id ??
      `ts:${Date.now()}`
    const key = `${runId}:${permissionID}`
    if (markPermissionFired(key)) {
      await postRejection(runId, {
        reason: props.feedback || "User denied a permission request.",
        failure_mode: "user_permission_denied",
      })
      if (props.feedback) await postFeedback(runId, props.feedback as string)
    }
    return // already enqueued; don't double-record below
  }

  // Auto-detect frustrated user messages and file a rejection.
  // message.part.updated is in NOISY_TYPES (not persisted) but we still
  // scan it here. User text parts have type=text and no "time" field.
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
    // Same ordering: enqueue + flush before rejection POST so the user
    // message row exists when the dashboard refreshes.
    enqueue({
      run_id: runId,
      project: ctx.project?.id,
      worktree: ctx.worktree,
      ts: Date.now(),
      type: "chat.message",
      properties: { sessionID: runId, role: "user", text: snippet },
    })
    await flush()
    await postRejection(runId, {
      reason: snippet,
      failure_mode: "frustrated_user",
    })
    await postFeedback(runId, snippet)
  }

  // --- Noise filter: drop chatty events that add no signal ---
  // Exception: user text messages (type=text, no "time" field) are persisted
  // because the classifier needs them for sentiment analysis and LLM context.

  if (e.type === "message.part.updated") {
    const isUserText =
      props.part?.type === "text" &&
      props.part?.text?.trim() &&
      !("time" in (props.part ?? {}))
    if (!isUserText) return

    // Normalize into a single, clean `chat.message` event so the timeline
    // can render it as "User: ..." without sniffing nested shapes.
    const text = props.part!.text!.trim()
    enqueue({
      run_id: runId,
      project: ctx.project?.id,
      worktree: ctx.worktree,
      ts: Date.now(),
      type: "chat.message",
      properties: { sessionID: runId, role: "user", text },
    })
    if (text) setLatestUserMessage(text)
    return
  } else if (NOISY_TYPES.has(e.type)) {
    return
  }

  // `message.created` carries the canonical role+content for both user
  // and assistant turns when opencode emits it. Normalize it to the same
  // `chat.message` event shape so the timeline has one renderer for both.
  if (e.type === "message.created") {
    const norm = normalizeMessageEvent(runId, e.properties ?? {})
    if (norm) {
      enqueue({
        run_id: runId,
        project: ctx.project?.id,
        worktree: ctx.worktree,
        ts: Date.now(),
        type: "chat.message",
        properties: norm,
      })
      if (norm.role === "user" && typeof norm.text === "string") {
        setLatestUserMessage(norm.text)
      }
    }
    return
  }

  if (e.type === "session.diff") {
    const empty = isEmptyDiff(e.properties ?? {})
    if (empty && !sessionsWithDiff.has(runId)) return
    if (!empty) markSessionWithDiff(runId)
  }

  const ev: EventIn = {
    run_id: runId,
    project: ctx.project?.id,
    worktree: ctx.worktree,
    ts: Date.now(),
    type: e.type,
    properties: e.properties,
  }
  enqueue(ev)

  // Capture the latest user-message text for preflight enrichment (F8).
  const userText = extractUserText(e.type, e.properties ?? {})
  if (userText) setLatestUserMessage(userText)
}

// --- helpers ---------------------------------------------------------------

const USER_MESSAGE_EVENTS = new Set<string>([
  "message.created",
  "message.updated",
  "message.part.updated",
  "chat.user.message",
])

// Tries a handful of payload shapes empirically observed across opencode
// versions and returns the first non-empty user-authored text it finds.
// Returns null otherwise. Pure / no side-effects.
function extractUserText(type: string, props: Record<string, unknown>): string | null {
  if (!USER_MESSAGE_EVENTS.has(type)) return null

  // Shape #1: flat — { role: "user", content: "text" } or
  //                  { role: "user", text: "text" }
  const flatRole = asString(props["role"])
  if (flatRole === "user") {
    const direct = firstString(props["content"], props["text"])
    if (direct) return direct
    // Shape #1b: { role: "user", parts: [{ type: "text", text: "..." }, ...] }
    const fromParts = textFromParts(props["parts"])
    if (fromParts) return fromParts
  }

  // Shape #2: nested — { message: { role: "user", parts|content|text: ... } }
  const inner = asRecord(props["message"])
  if (inner) {
    const role = asString(inner["role"])
    if (role === "user") {
      const direct = firstString(inner["content"], inner["text"])
      if (direct) return direct
      const fromParts = textFromParts(inner["parts"])
      if (fromParts) return fromParts
    }
  }

  // Shape #3: part-updated — { part: { type: "text", text: "..." }, role?: "user", message?: {...} }
  // Only accept when we can confirm the surrounding message was user-authored,
  // otherwise we'd capture assistant deltas.
  if (type === "message.part.updated") {
    const partAuthor =
      flatRole ??
      asString(asRecord(props["message"])?.["role"]) ??
      asString(asRecord(props["part"])?.["role"])
    if (partAuthor === "user") {
      const part = asRecord(props["part"])
      if (part && asString(part["type"]) === "text") {
        const t = asString(part["text"])
        if (t && t.trim()) return t
      }
    }
  }

  return null
}

// Same shape coverage as `extractUserText` but emits a normalized
// `chat.message` payload regardless of role. Returns null when we can't
// confidently identify a role + non-empty text.
function normalizeMessageEvent(
  runId: string,
  props: Record<string, unknown>,
): { sessionID: string; role: "user" | "assistant"; text: string } | null {
  const flatRole = asString(props["role"])
  const flatText =
    firstString(props["content"], props["text"]) ?? textFromParts(props["parts"])
  if (flatRole && flatText) {
    const role = flatRole === "user" ? "user" : "assistant"
    return { sessionID: runId, role, text: flatText.trim() }
  }
  const inner = asRecord(props["message"])
  if (inner) {
    const role = asString(inner["role"])
    const text =
      firstString(inner["content"], inner["text"]) ??
      textFromParts(inner["parts"])
    if (role && text) {
      const r = role === "user" ? "user" : "assistant"
      return { sessionID: runId, role: r, text: text.trim() }
    }
  }
  return null
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function firstString(...vs: unknown[]): string | null {
  for (const v of vs) {
    const s = asString(v)
    if (s && s.trim()) return s
  }
  return null
}

// Walks `parts: [{ type: "text", text: "..." }, ...]` — the canonical opencode
// chat message shape — and returns the concatenated text (joined by newlines)
// or null if no text parts are present.
function textFromParts(v: unknown): string | null {
  if (!Array.isArray(v)) return null
  const chunks: string[] = []
  for (const item of v) {
    const rec = asRecord(item)
    if (!rec) continue
    if (asString(rec["type"]) !== "text") continue
    const t = asString(rec["text"])
    if (t && t.trim()) chunks.push(t)
  }
  if (chunks.length === 0) return null
  return chunks.join("\n")
}

import { enqueue } from "../batcher.ts"
import { postFeedback, postOutcome } from "../client.ts"
import { setLatestUserMessage } from "../last-task.ts"
import type { EventIn } from "../types.ts"

// Bus events that add no autopsy signal but flood the timeline / DB.
// Drop at the source so they never hit the network.
//
// session.updated is conditionally allowed: when it carries an updated
// info.title (opencode auto-generates a meaningful title after the first
// turn), we forward it so the service can refresh runs.task. Otherwise drop.
const NOISY_TYPES = new Set([
  "session.status",
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

const FRUSTRATION_RE =
  /\b(shit|shitty|fuck|fucking|fucked|wtf|trash|garbage|terrible|horrible|awful|useless|stupid|idiot|dumb|crap|crappy|kill\s*(yourself|urself)|kys|this\s+sucks|worst|redo\s+(this|it|everything)|start\s+over|completely\s+wrong|totally\s+wrong|not\s+what\s+i\s+(asked|wanted|said))\b/i

// Track sessions where we already fired a frustration outcome so we don't spam.
const firedSessions = new Set<string>()

// Lightweight typing for the slice of the opencode SDK client we use here.
// Avoids importing the full SDK types into the plugin build graph.
type OpencodeClientLike = {
  session?: {
    get?: (opts: { path: { id: string } }) => Promise<unknown> | unknown
  }
}

const isPlaceholderTitle = (title: string): boolean =>
  !title.trim() || title.trim().toLowerCase().startsWith("new session")

// Track sessions where we already pushed a forced title so we don't spam.
const forcedTitleSent = new Set<string>()

// Best-effort: fetch the current opencode session title and POST it as
// autopsy.task.set with force=true. Called on session.idle so we pick up
// opencode's auto-generated summary even if it never re-emitted session.updated.
const refreshSessionTitle = async (
  runId: string,
  client: OpencodeClientLike | undefined,
  ctx: { project?: { id?: string }; worktree?: string },
): Promise<void> => {
  if (!client?.session?.get) return
  if (forcedTitleSent.has(runId)) return
  try {
    const result: any = await client.session.get({ path: { id: runId } })
    // SDK returns either the data directly or wraps it under { data }.
    const sessionInfo = result?.data ?? result
    const title = typeof sessionInfo?.title === "string" ? sessionInfo.title : ""
    if (!title || isPlaceholderTitle(title)) return
    forcedTitleSent.add(runId)
    enqueue({
      run_id: runId,
      project: ctx.project?.id,
      worktree: ctx.worktree,
      ts: Date.now(),
      type: "autopsy.task.set",
      properties: { task: title, source: "session.title", force: true },
    })
  } catch {
    // Best-effort only; never block the bus.
  }
}

// Entry for the `event` hook. opencode 1.x wraps the bus event in `{ event }`.
// We never block on the network — fire-and-forget through the batcher.
export const onEvent = async (
  input: { event: { type: string; properties: Record<string, unknown> } },
  ctx: {
    project?: { id?: string }
    worktree?: string
    client?: OpencodeClientLike
  },
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

  // On session.idle (turn complete), refresh the run's display name from
  // opencode's session info. opencode auto-generates a meaningful title
  // after the first turn; this picks it up even if session.updated wasn't
  // emitted. Fire-and-forget; never blocks event delivery.
  if (e.type === "session.idle") {
    void refreshSessionTitle(runId, ctx.client, ctx)
  }

  if (e.type === "permission.replied" && props.reply === "reject") {
    await postOutcome(runId, "rejected", props.feedback)
    if (props.feedback) await postFeedback(runId, props.feedback as string)
  }

  // Auto-detect frustrated user messages and trigger the rejection pipeline.
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
    await postOutcome(runId, "rejected", snippet)
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
  } else if (e.type === "session.updated") {
    // Only forward when it carries a session info with a title — that's
    // when opencode is communicating an auto-generated session title we want
    // to surface as runs.task. Drop pure status updates.
    const info = (e.properties as { info?: { title?: unknown } })?.info
    const title = typeof info?.title === "string" ? info.title.trim() : ""
    if (!title) return
  } else if (NOISY_TYPES.has(e.type)) {
    return
  }

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

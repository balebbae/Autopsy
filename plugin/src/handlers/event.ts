import { enqueue } from "../batcher.ts"
import { postFeedback, postOutcome } from "../client.ts"
import { setLatestUserMessage } from "../last-task.ts"
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

  // Capture the latest user-message text for preflight enrichment (F8).
  //
  // opencode 1.x bus event names + payload shapes for chat messages are
  // version-specific and the SDK type definitions are not vendored in this
  // repo. The plan (plan.md:218) suggests `message.created` with
  // `properties.role === 'user'`; contracts/events.md:29 documents
  // `message.part.updated` is forwarded for timeline rendering. We accept any
  // of the plausible names and walk a couple of likely shapes — the first
  // non-empty `user` text wins. If opencode renames or restructures these
  // events this helper degrades gracefully (task falls back to "").
  const userText = extractUserText(e.type, e.properties ?? {})
  if (userText) setLatestUserMessage(userText)

  // permission.replied is no longer a standalone hook in opencode 1.x; piggyback
  // on the bus event so the run-outcome side-effect still fires on rejection.
  if (e.type === "permission.replied" && props.reply === "reject") {
    await postOutcome(runId, "rejected", props.feedback)
    if (props.feedback) await postFeedback(runId, props.feedback)
  }
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

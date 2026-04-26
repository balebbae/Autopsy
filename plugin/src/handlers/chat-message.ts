import { enqueue } from "../batcher.ts"
import { setLatestUserMessage } from "../last-task.ts"
import type { EventIn } from "../types.ts"

// `chat.message` fires every time a user sends a message in opencode. It is
// the most reliable signal for capturing user intent (no event-shape probing).
//
// We use it to:
//   1. Populate the in-memory latest-user-message buffer (preflight enrichment)
//   2. Emit a synthetic `autopsy.task.set` event so the service can label the
//      run with the user's actual prompt instead of opencode's placeholder
//      "New session - <timestamp>" title.
//
// We do NOT mark this as `force` — the assembler will only adopt this name
// when the run's current task is still a placeholder, so a later
// opencode-generated session title (forced) wins.

type ChatMessageInput = {
  sessionID: string
  agent?: string
  messageID?: string
}

type Part = { type?: string; text?: string }
type ChatMessageOutput = {
  message?: { role?: string }
  parts?: Part[]
}

const extractText = (parts: Part[] | undefined): string | null => {
  if (!Array.isArray(parts)) return null
  const chunks: string[] = []
  for (const p of parts) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) {
      chunks.push(p.text)
    }
  }
  if (chunks.length === 0) return null
  return chunks.join("\n").trim()
}

export const onChatMessage = async (
  input: ChatMessageInput,
  output: ChatMessageOutput,
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  const runId = input?.sessionID
  if (!runId) return

  const text = extractText(output?.parts)
  if (!text) return

  // Update preflight enrichment buffer immediately.
  setLatestUserMessage(text)

  // Emit a synthetic event so the service can refresh runs.task.
  const ev: EventIn = {
    run_id: runId,
    project: ctx.project?.id,
    worktree: ctx.worktree,
    ts: Date.now(),
    type: "autopsy.task.set",
    properties: {
      task: text,
      source: "chat.message",
      force: false,
    },
  }
  enqueue(ev)
}

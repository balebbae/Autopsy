import { enqueue } from "../batcher.ts"
import { preflight } from "../client.ts"
import { latestUserMessage, setLatestUserMessage } from "../last-task.ts"
import { showSystemInjectionToast, type OpencodeToastClient } from "../tui-toast.ts"

const DISSATISFACTION_PROMPT = `[Autopsy] You have a tool called autopsy_register_rejection. ONLY call it when the user is unambiguously dissatisfied with work YOU performed in the CURRENT session.

CALL the tool when ALL of these are true:
- You have already made one or more changes (edit/write/bash/etc.) in this session.
- The user's most recent message is directly criticizing one of those changes (e.g. "no, that's wrong, undo it", "your fix broke X", "you misunderstood, revert", "stop changing Y", "that's not what I asked for").
- After you ask what went wrong, the user confirms the issue is with YOUR work (not with pre-existing code or a new request).

DO NOT call the tool when:
- The user is reporting a bug or issue in code you have NOT modified this session (e.g. "there are issues with cmd/foo/bar.go:183", "this function has a bug", "Findings flagged X — please fix"). This is a normal task request, not a rejection.
- The user is asking for a new change, fix, refactor, or addition — even if they sound exasperated or use words like "broken", "issues", "wrong", "fix", or "please". Treat these as work to do.
- The user is sharing logs, errors, stack traces, lint output, or test failures without explicitly blaming your output.
- You have not made any tool calls or edits yet in this session — by definition you can't have caused frustration.
- The user's complaint is about a third party (CI, a teammate, another tool, the language, the framework).

Workflow:
1. Default to treating user input as a task description. Do the work first.
2. Only if the user is clearly rejecting your most recent change, briefly acknowledge it and ask exactly what went wrong.
3. Once the user confirms YOUR change was the problem, call autopsy_register_rejection with:
   - reason: the user's wording or a concise summary tied to your change.
   - failure_mode (optional): one of incomplete_schema_change, missing_test_coverage, frontend_backend_drift, regression, wrong_target, security_concern, performance_concern.
   - symptoms (optional): comma-separated specifics.

When in doubt, do NOT call the tool. False positives — recording normal bug reports as user frustration — are MUCH worse than missing a real rejection.`

// `experimental.chat.system.transform` runs once at the start of each chat
// turn, before the LLM is called. We use it to inject a preflight warning
// addendum into the system prompt array.
//
type OpencodeClientLike = OpencodeToastClient & {
  session?: {
    messages?: (opts: {
      path: { id: string }
      query?: { directory?: string; limit?: number }
    }) => Promise<unknown> | unknown
  }
}

type MessagePart = { type?: string; text?: string }
type SessionMessage = {
  info?: { role?: string }
  parts?: MessagePart[]
}

const SESSION_MESSAGES_TIMEOUT_MS = 150

const textFromParts = (parts: MessagePart[] | undefined): string | null => {
  if (!Array.isArray(parts)) return null
  const chunks: string[] = []
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      chunks.push(part.text)
    }
  }
  return chunks.length > 0 ? chunks.join("\n").trim() : null
}

const latestUserMessageFromSession = async (
  client: OpencodeClientLike | undefined,
  sessionID: string | undefined,
  directory: string | undefined,
): Promise<string | null> => {
  if (!client?.session?.messages || !sessionID) return null

  try {
    const result: any = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), SESSION_MESSAGES_TIMEOUT_MS)
      Promise.resolve(
        client.session!.messages!({
          path: { id: sessionID },
          query: { directory, limit: 20 },
        }),
      ).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        () => {
          clearTimeout(timer)
          resolve(null)
        },
      )
    })
    const messages = (result?.data ?? result) as SessionMessage[] | undefined
    if (!Array.isArray(messages)) return null

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i]
      if (msg?.info?.role !== "user") continue
      const text = textFromParts(msg.parts)
      if (text) return text
    }
  } catch {
    // Best-effort fallback only. If this races the opencode message store,
    // preflight remains fail-open and the tool-boundary check can still run.
  }

  return null
}

// NOTE: opencode's SDK does NOT pass `lastUserMessage` in this hook input
// (only `sessionID` and `model`). We first read the session-scoped buffer
// populated by `chat.message` / bus events. If hook ordering means the buffer
// is not ready yet, we fall back to the opencode session messages endpoint.
export const onSystemTransform = async (
  input: { sessionID?: string },
  output: { system: string[] },
  ctx: {
    project?: { id?: string }
    worktree?: string
    directory?: string
    client?: OpencodeClientLike
  },
) => {
  output.system.push(DISSATISFACTION_PROMPT)

  const systemCountBefore = output.system.length
  let taskSource = "buffer"
  let task = latestUserMessage(input.sessionID, { fallbackGlobal: false })
  if (!task) {
    task = await latestUserMessageFromSession(ctx.client, input.sessionID, ctx.directory)
    taskSource = "session.messages"
    if (task) setLatestUserMessage(task, input.sessionID)
  }
  if (!task) return

  const risk = await preflight({
    run_id: input.sessionID,
    task,
    project: ctx.project?.id,
    worktree: ctx.worktree,
  })
  if (!risk?.system_addendum) return

  output.system.push(risk.system_addendum)
  await showSystemInjectionToast(ctx.client, ctx.directory, input.sessionID, risk.system_addendum)

  // Record the injection so the dashboard timeline shows it.
  if (input.sessionID) {
    enqueue({
      run_id: input.sessionID,
      ts: Date.now(),
      type: "aag.system.injected",
      properties: {
        risk_level: risk.risk_level,
        similar_runs: risk.similar_runs,
        addendum_length: risk.system_addendum.length,
        system_count_before: systemCountBefore,
        system_count_after: output.system.length,
        task_source: taskSource,
        system_addendum: risk.system_addendum,
      },
    })
  }
}

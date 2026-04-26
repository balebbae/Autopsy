import { enqueue } from "../batcher.ts"
import { preflight } from "../client.ts"
import { latestUserMessage } from "../last-task.ts"

const DISSATISFACTION_PROMPT = `[Autopsy] You have a tool called autopsy_register_rejection. If the user expresses frustration or dissatisfaction with your changes (e.g. "this is wrong", "undo this", profanity, asking you to start over, or saying your output is bad), do the following:
1. Acknowledge their frustration briefly.
2. Ask what specifically went wrong or what they expected instead.
3. Once they explain, call autopsy_register_rejection with their reason, a failure_mode if you can identify one (incomplete_schema_change, missing_test_coverage, frontend_backend_drift, regression, wrong_target, security_concern, performance_concern, or other), and a comma-separated symptoms list if applicable.
Do NOT call the tool preemptively — only after the user has confirmed or explained the issue.`

// `experimental.chat.system.transform` runs once at the start of each chat
// turn, before the LLM is called. We use it to inject a preflight warning
// addendum into the system prompt array.
//
// NOTE: opencode's SDK does NOT pass `lastUserMessage` in the input object
// (only `sessionID` and `model`).  We read the buffered task from
// `latestUserMessage()` instead, which is populated by the `event` hook
// when it observes `chat.message` / `message.created` events.
export const onSystemTransform = async (
  input: { sessionID?: string },
  output: { system: string[] },
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  output.system.push(DISSATISFACTION_PROMPT)

  const task = latestUserMessage() ?? ""
  if (!task) return

  const risk = await preflight({
    run_id: input.sessionID,
    task,
    project: ctx.project?.id,
    worktree: ctx.worktree,
  })
  if (!risk?.system_addendum) return

  output.system.push(risk.system_addendum)

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
      },
    })
  }
}

import { preflight } from "../client.ts"

const DISSATISFACTION_PROMPT = `[Autopsy] You have a tool called autopsy_register_rejection. If the user expresses frustration or dissatisfaction with your changes (e.g. "this is wrong", "undo this", profanity, asking you to start over, or saying your output is bad), do the following:
1. Acknowledge their frustration briefly.
2. Ask what specifically went wrong or what they expected instead.
3. Once they explain, call autopsy_register_rejection with their reason, a failure_mode if you can identify one (incomplete_schema_change, missing_test_coverage, frontend_backend_drift, regression, wrong_target, security_concern, performance_concern, or other), and a comma-separated symptoms list if applicable.
Do NOT call the tool preemptively — only after the user has confirmed or explained the issue.`

// `experimental.chat.system.transform` runs once at the start of each chat
// turn, before the LLM is called. We use it to inject a preflight warning
// addendum into the system prompt array.
export const onSystemTransform = async (
  input: { sessionID: string; lastUserMessage?: string },
  output: { system: string[] },
) => {
  output.system.push(DISSATISFACTION_PROMPT)

  const task = input.lastUserMessage ?? ""
  if (!task) return

  const risk = await preflight({ run_id: input.sessionID, task })
  if (!risk?.system_addendum) return

  output.system.push(risk.system_addendum)
}

import { preflight } from "../client.ts"

// `experimental.chat.system.transform` runs once at the start of each chat
// turn, before the LLM is called. We use it to inject a preflight warning
// addendum into the system prompt array.
export const onSystemTransform = async (
  input: { sessionID: string; lastUserMessage?: string },
  output: { system: string[] },
) => {
  const task = input.lastUserMessage ?? ""
  if (!task) return

  const risk = await preflight({ run_id: input.sessionID, task })
  if (!risk?.system_addendum) return

  output.system.push(risk.system_addendum)
}

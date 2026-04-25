import { config } from "../config.ts"
import { preflight } from "../client.ts"
import { latestUserMessage } from "../last-task.ts"

// `tool.execute.before` runs synchronously in the agent path, so we keep the
// preflight call fast (bounded backend latency) and only invoke it for tools
// in config.preflightTools. Throwing aborts the tool call.
export const onToolBefore = async (
  input: { sessionID: string; tool: string },
  output: { args: Record<string, unknown> },
) => {
  if (!config.preflightTools.has(input.tool)) return

  const risk = await preflight({
    run_id: input.sessionID,
    // Sourced from the in-memory buffer populated by `onEvent` whenever a
    // user-authored chat message flows through the bus (see last-task.ts).
    // Falls back to "" if no user message has been observed yet this session.
    task: latestUserMessage() ?? "",
    tool: input.tool,
    args: output.args,
  })
  if (!risk) return

  if (risk.block) {
    const reason = risk.reason ?? "Autopsy blocked: similar past runs failed."
    throw new Error(reason)
  }
}

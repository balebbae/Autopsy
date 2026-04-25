import { config } from "../config.ts"
import { preflight } from "../client.ts"

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
    task: "",  // R1: enrich w/ latest user message via the SDK client if needed
    tool: input.tool,
    args: output.args,
  })
  if (!risk) return

  if (risk.block) {
    const reason = risk.reason ?? "Autopsy blocked: similar past runs failed."
    throw new Error(reason)
  }
}

import { postRejection } from "../client.ts"

// Factory that takes the opencode `tool` helper (dynamically imported in
// index.ts so bare-specifier resolution works from .opencode/node_modules).
//
// IMPORTANT: filing a rejection here does NOT end the thread. The opencode
// session keeps running so the agent can recover from the failure. A run
// only terminates when the user/dashboard explicitly calls /v1/runs/:id/outcome.
export const makeRejectionTool = (tool: any) =>
  tool({
    description:
      "Register that the user is dissatisfied with your changes. " +
      "Call this after asking the user what went wrong and receiving their explanation. " +
      "Provide the reason and any failure details. " +
      "The thread will continue after this call so you can attempt a fix.",
    args: {
      reason: tool.schema
        .string()
        .describe("Why the user rejected the changes — their own words or your summary"),
      failure_mode: tool.schema
        .string()
        .optional()
        .describe(
          "Category: incomplete_schema_change, missing_test_coverage, " +
          "frontend_backend_drift, regression, wrong_target, security_concern, " +
          "performance_concern, or other",
        ),
      symptoms: tool.schema
        .string()
        .optional()
        .describe(
          "Comma-separated list of specific issues, e.g. missing_migration,missing_test",
        ),
    },
    async execute(
      args: { reason: string; failure_mode?: string; symptoms?: string },
      context: { sessionID: string },
    ) {
      const runId = context.sessionID

      await postRejection(runId, {
        reason: args.reason,
        failure_mode: args.failure_mode,
        symptoms: args.symptoms,
      })

      const parts = [
        `Rejection recorded for session ${runId}. The thread is still active — keep going.`,
      ]
      if (args.failure_mode) parts.push(`Mode: ${args.failure_mode}`)
      if (args.symptoms) parts.push(`Symptoms: ${args.symptoms}`)

      return parts.join(" ")
    },
  })

// `tool.execute.before` runs synchronously in the agent path, so we keep the
// preflight call fast (bounded backend latency) and only invoke it for tools
// in config.preflight.tools.
//
// This handler is advisory-only:
//
//   1. It calls /v1/preflight with the current task + tool name + args so
//      the dashboard and graph can see that preflight fired.
//
//   2. It never throws, never mutates tool args, and never blocks a tool call,
//      even if the service returns block=true. The only model-facing preflight
//      effect is the hidden system addendum injected by handlers/system.ts.
//
//   3. risk_level !== "none" emits `aag.preflight.warned`; service-side
//      block=true is preserved as telemetry under `service_block`.
//
// Dedup: the service caches by (project, task) so consecutive calls for the
// same task return the same response. Without dedup we'd flood the timeline
// with identical "warned" events. We keep a bounded LRU keyed by
// (sessionID, tool, args-hash) so each distinct tool invocation logs at
// most once per warning level per session.

import { enqueue } from "../batcher.ts"
import { preflight } from "../client.ts"
import { config } from "../config.ts"
import { latestUserMessage } from "../last-task.ts"
import { cancelPostflight } from "../postflight.ts"
import type { OpencodeToastClient } from "../tui-toast.ts"
import type { EventIn } from "../types.ts"

// --- args fingerprint -----------------------------------------------------

// Stable JSON stringify with sorted object keys so {a:1,b:2} and {b:2,a:1}
// produce the same key. Keeps the dedup map honest across opencode args
// shapes that don't guarantee insertion order.
const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`
}

const ARGS_HASH_MAX = 256
const argsFingerprint = (args: Record<string, unknown> | undefined): string => {
  if (!args) return ""
  const s = stableStringify(args)
  return s.length > ARGS_HASH_MAX ? `${s.slice(0, ARGS_HASH_MAX)}…` : s
}

// --- per-(session,tool,args,level) dedup ---------------------------------

const FIRED_LIMIT = 1024
const fired = new Set<string>()
const markFired = (key: string): boolean => {
  if (fired.has(key)) return false
  fired.add(key)
  if (fired.size > FIRED_LIMIT) {
    const oldest = fired.values().next().value
    if (oldest !== undefined) fired.delete(oldest)
  }
  return true
}

// Test-only — clear the dedup state.
export const _resetToolBefore = (): void => {
  fired.clear()
}

// --- handler --------------------------------------------------------------

export const onToolBefore = async (
  input: { sessionID: string; tool: string },
  output: { args: Record<string, unknown> },
  ctx: { project?: { id?: string }; worktree?: string; directory?: string; client?: OpencodeToastClient },
) => {
  // The AI is about to run another tool — that means whatever `session.idle`
  // we may have just seen was transient (intermediate idle in an agentic
  // loop / subtask boundary / compaction pause), NOT the real end-of-turn.
  // Cancel any pending postflight timer; the next genuine `session.idle`
  // after the AI is fully done will reschedule. This guarantees postflight
  // never fires while the model is still actively working.
  if (input.sessionID) cancelPostflight(input.sessionID)

  if (config.preflight.disabled) return
  if (!config.preflight.tools.has(input.tool)) return

  const risk = await preflight({
    run_id: input.sessionID,
    // Sourced from the in-memory buffer populated by `onEvent` whenever a
    // user-authored chat message flows through the bus (see last-task.ts).
    // Falls back to "" if no user message has been observed yet this session.
    task: latestUserMessage(input.sessionID, { fallbackGlobal: false }) ?? "",
    project: ctx.project?.id,
    worktree: ctx.worktree,
    tool: input.tool,
    args: output.args,
  })
  if (!risk) return

  const argsHash = argsFingerprint(output.args)
  const baseProps = {
    sessionID: input.sessionID,
    tool: input.tool,
    args: output.args,
    risk_level: risk.risk_level,
    similar_runs: risk.similar_runs ?? [],
    missing_followups: risk.missing_followups ?? [],
    recommended_checks: risk.recommended_checks ?? [],
  }

  // Risk → telemetry only. Service-side block=true is advisory here so
  // preflight never changes the agent's tool execution path.
  // Skip "none" (no signal worth logging) and skip duplicates within a single
  // session for the same (tool, args, level).
  if (risk.risk_level === "none") return

  const dedupKey = `${input.sessionID}:${input.tool}:${argsHash}:${risk.risk_level}`
  if (!markFired(dedupKey)) return

  // No tool-scoped toast: per-tool risk toasts were noisy and duplicative
  // with the system-injection toast (which already surfaces the fix
  // patterns once per turn). The per-tool warning still lands as
  // telemetry below.

  const ev: EventIn = {
    run_id: input.sessionID,
    project: ctx.project?.id,
    worktree: ctx.worktree,
    ts: Date.now(),
    type: "aag.preflight.warned",
    properties: {
      ...baseProps,
      // Surface the LLM-synthesized addendum on the timeline so the
      // dashboard can render it as the reasoning for the warning.
      system_addendum: risk.system_addendum ?? null,
      service_block: risk.block === true,
      blocked: false,
    },
  }
  enqueue(ev)
}

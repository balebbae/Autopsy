// `tool.execute.before` runs synchronously in the agent path, so we keep the
// preflight call fast (bounded backend latency) and only invoke it for tools
// in config.preflight.tools. Throwing aborts the tool call.
//
// This handler implements **Option 2 (context injection at the tool boundary)**:
//
//   1. For mutating tools (edit/write/bash) — when the graph reports a
//      high-confidence past-failure match, the service returns
//      `block: true` and we throw a *rich rationale* that cites the
//      similar past run, the failure mode, and recommended fixes.
//      opencode surfaces the throw as a tool error; the model reads
//      the message on its next reasoning step and adapts.
//
//   2. For exploratory tools (read/grep) — we still call preflight so
//      the graph captures "agent attempted exploration X after past
//      similar failures" telemetry, but the service almost never sets
//      `block: true` for these (advisory-only).
//
//   3. Non-blocking risk (`risk_level !== "none"`) emits an
//      `aag.preflight.warned` timeline event but does NOT throw. Soft
//      per-turn warnings are handled by `experimental.chat.system.transform`
//      (Option 1), which has the right semantics for advisory text.
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
import type { EventIn, PreflightResponse } from "../types.ts"

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

// --- rationale builder ----------------------------------------------------

const REASON_MAX = 1200

// Compose a rich block message that the LLM will see when we throw.
// We prefer the LLM-synthesized `system_addendum` when present (it cites
// concrete files / fixes). Otherwise we fall back to assembling the
// structured fields ourselves.
export const buildBlockMessage = (risk: PreflightResponse): string => {
  const lines: string[] = ["[Autopsy] Blocking this tool call."]

  if (risk.reason && risk.reason.trim()) {
    lines.push(risk.reason.trim())
  }

  if (risk.system_addendum && risk.system_addendum.trim()) {
    lines.push(risk.system_addendum.trim())
  } else {
    if (risk.missing_followups && risk.missing_followups.length > 0) {
      lines.push(`Past failure modes: ${risk.missing_followups.slice(0, 3).join(", ")}.`)
    }
    if (risk.recommended_checks && risk.recommended_checks.length > 0) {
      lines.push(`Recommended fixes: ${risk.recommended_checks.slice(0, 3).join(", ")}.`)
    }
  }

  if (risk.similar_runs && risk.similar_runs.length > 0) {
    lines.push(`Similar past runs: ${risk.similar_runs.slice(0, 3).join(", ")}.`)
  }

  lines.push(
    "Reconsider — either address the failure mode above or rephrase the request to avoid the same pathway.",
  )

  const out = lines.join(" ")
  return out.length > REASON_MAX ? `${out.slice(0, REASON_MAX)}…` : out
}

// --- handler --------------------------------------------------------------

export const onToolBefore = async (
  input: { sessionID: string; tool: string },
  output: { args: Record<string, unknown> },
  ctx: { project?: { id?: string }; worktree?: string },
) => {
  if (config.preflight.disabled) return
  if (!config.preflight.tools.has(input.tool)) return

  const risk = await preflight({
    run_id: input.sessionID,
    // Sourced from the in-memory buffer populated by `onEvent` whenever a
    // user-authored chat message flows through the bus (see last-task.ts).
    // Falls back to "" if no user message has been observed yet this session.
    task: latestUserMessage() ?? "",
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

  if (risk.block) {
    const reason = buildBlockMessage(risk)

    // Emit the blocked event BEFORE throwing so the dashboard records the
    // intervention even if the throw bubbles into something that crashes
    // the rest of the handler chain. Block events are NOT deduped — every
    // block attempt is a real signal we want on the timeline.
    const ev: EventIn = {
      run_id: input.sessionID,
      project: ctx.project?.id,
      worktree: ctx.worktree,
      ts: Date.now(),
      type: "aag.preflight.blocked",
      properties: { ...baseProps, reason },
    }
    enqueue(ev)

    throw new Error(reason)
  }

  // Non-blocking risk → telemetry only. Skip "none" (no signal worth logging)
  // and skip duplicates within a single session for the same (tool, args, level).
  if (risk.risk_level === "none") return

  const dedupKey = `${input.sessionID}:${input.tool}:${argsHash}:${risk.risk_level}`
  if (!markFired(dedupKey)) return

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
    },
  }
  enqueue(ev)
}

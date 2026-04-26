// Comma-separated list of tool names that should trigger a postflight run.
// Anything that mutates files belongs here. We deliberately exclude `bash`
// to avoid feedback loops when the agent itself invokes a check command.
const parseToolList = (raw: string | undefined, fallback: string[]): Set<string> => {
  if (!raw) return new Set(fallback)
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return new Set(items.length > 0 ? items : fallback)
}

const parseInt10 = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const parseBool = (raw: string | undefined): boolean => {
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === "1" || v === "true" || v === "yes" || v === "on"
}

export const config = {
  url: process.env.AAG_URL ?? "http://localhost:4000",
  token: process.env.AAG_TOKEN,
  // Preflight knobs (see plugin/src/handlers/tool-before.ts). The default
  // tool set covers both *mutating* tools (where we may want to BLOCK) and
  // *exploratory* tools (where we mainly want to record warned-events that
  // feed the graph). Override with AAG_PREFLIGHT_TOOLS=edit,write,...
  preflight: {
    disabled: parseBool(process.env.AAG_PREFLIGHT_DISABLED),
    // Hard ceiling on the preflight HTTP call. The service has a TTL cache
    // so subsequent calls in the same turn are fast (≤5ms), but the first
    // uncached call does an embed + ANN + recursive hop. We cap at 800ms so
    // a degraded service never stalls the agent's hot path; on timeout we
    // fail open (treat as risk_level=none).
    timeoutMs: parseInt10(process.env.AAG_PREFLIGHT_TIMEOUT_MS, 800),
    tools: parseToolList(process.env.AAG_PREFLIGHT_TOOLS, [
      // Mutating — these can be blocked outright when the graph reports a
      // high-confidence past-failure match.
      "edit",
      "write",
      "bash",
      // Exploratory — we still call preflight on these so the graph can
      // record "agent attempted X exploration after similar past failures"
      // and surface warnings on the dashboard. The service's `block`
      // decision applies uniformly; for reads/greps it's almost always
      // false (advisory-only).
      "read",
      "grep",
    ]),
  },
  // Backwards-compat alias used by older callers. Prefer config.preflight.tools.
  get preflightTools(): Set<string> {
    return this.preflight.tools
  },
  // Postflight code-check suite (see plugin/src/postflight.ts). Triggered
  // after the listed tools modify files; debounce collapses a flurry of
  // edits into a single check run after the agent goes quiet.
  postflight: {
    disabled: parseBool(process.env.AAG_POSTFLIGHT_DISABLED),
    debounceMs: parseInt10(process.env.AAG_POSTFLIGHT_DEBOUNCE_MS, 3000),
    triggerTools: parseToolList(process.env.AAG_POSTFLIGHT_TOOLS, [
      "edit",
      "write",
      "multiedit",
      "patch",
    ]),
  },
}

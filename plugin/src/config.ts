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
  // Tools that warrant a preflight check before they run. Keep tight to avoid
  // adding latency on every read/grep call.
  preflightTools: new Set(["edit", "write", "bash"]),
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

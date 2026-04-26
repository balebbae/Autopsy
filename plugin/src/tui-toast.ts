import { config } from "./config.ts"

export type OpencodeToastClient = {
  tui?: {
    showToast?: (opts: {
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
      query?: { directory?: string }
    }) => Promise<unknown> | unknown
  }
}

type ToastKind = "tool" | "system"
type RiskLevel = "low" | "medium" | "high" | "none"

const TOAST_MAX = 420
const fired = new Set<string>()

const markFired = (key: string): boolean => {
  if (fired.has(key)) return false
  fired.add(key)
  if (fired.size > 256) {
    const oldest = fired.values().next().value
    if (oldest !== undefined) fired.delete(oldest)
  }
  return true
}

const enabledFor = (kind: ToastKind): boolean => {
  if (!config.preflight.tuiToast) return false
  const scope = config.preflight.tuiToastScope
  return scope === "both" || scope === kind
}

const clip = (text: string): string =>
  text.length > TOAST_MAX ? `${text.slice(0, TOAST_MAX)}...` : text

export const showSystemInjectionToast = async (
  client: OpencodeToastClient | undefined,
  directory: string | undefined,
  sessionID: string | undefined,
  addendum: string,
): Promise<void> => {
  if (!enabledFor("system") || !client?.tui?.showToast || !sessionID) return
  if (!markFired(`${sessionID}:system:${addendum}`)) return

  try {
    await client.tui.showToast({
      query: { directory },
      body: {
        title: "Autopsy guidance added",
        message: clip(`Added to hidden model context: ${addendum}`),
        variant: "warning",
        duration: config.preflight.tuiToastDurationMs,
      },
    })
  } catch {
    // Visibility aid only; never affect chat.
  }
}

export const showToolRiskToast = async (
  client: OpencodeToastClient | undefined,
  directory: string | undefined,
  input: {
    sessionID: string
    tool: string
    argsHash: string
    riskLevel: RiskLevel
    addendum?: string | null
    missingFollowups?: string[]
    recommendedChecks?: string[]
    similarRuns?: string[]
    reason?: string | null
  },
): Promise<void> => {
  if (!enabledFor("tool") || !client?.tui?.showToast) return
  if (input.riskLevel === "none") return

  const key = `${input.sessionID}:tool:${input.tool}:${input.argsHash}:${input.riskLevel}`
  if (!markFired(key)) return

  const details: string[] = []
  if (input.addendum?.trim()) details.push(input.addendum.trim())
  else if (input.reason?.trim()) details.push(input.reason.trim())
  if (input.missingFollowups?.length) {
    details.push(`Failure modes: ${input.missingFollowups.slice(0, 3).join(", ")}`)
  }
  if (input.recommendedChecks?.length) {
    details.push(`Checks: ${input.recommendedChecks.slice(0, 3).join(", ")}`)
  }
  if (input.similarRuns?.length) {
    details.push(`${input.similarRuns.length} similar run${input.similarRuns.length === 1 ? "" : "s"}`)
  }

  const title = `Autopsy ${input.riskLevel} risk: ${input.tool}`
  const message = details.length > 0 ? details.join(" ") : `Preflight risk before ${input.tool}.`

  try {
    await client.tui.showToast({
      query: { directory },
      body: {
        title,
        message: clip(message),
        variant: "warning",
        duration: config.preflight.tuiToastDurationMs,
      },
    })
  } catch {
    // Visibility aid only; never affect tool execution.
  }
}

// Test-only reset; do not call from production code paths.
export const _resetTuiToast = (): void => {
  fired.clear()
}

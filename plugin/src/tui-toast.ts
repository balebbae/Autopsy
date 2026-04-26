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

const clip = (text: string): string =>
  text.length > TOAST_MAX ? `${text.slice(0, TOAST_MAX)}...` : text

// The system-injection toast is the *only* preflight toast surfaced in
// the TUI. It fires once per turn when /v1/preflight produces a
// non-empty system addendum. Per-tool risk toasts were removed for
// being noisy and duplicative — the warned event still flows through
// the timeline as telemetry.
export const showSystemInjectionToast = async (
  client: OpencodeToastClient | undefined,
  directory: string | undefined,
  sessionID: string | undefined,
  addendum: string,
): Promise<void> => {
  if (!config.preflight.tuiToast || !client?.tui?.showToast || !sessionID) return
  if (!markFired(`${sessionID}:system:${addendum}`)) return

  // The service-side template emits the bulleted fix-pattern list
  // verbatim — surface it directly without any wrapper prose. The
  // dashboard run link is prepended (and excluded from clip()) so the
  // URL is always visible even when the addendum is long enough to be
  // truncated.
  const dashboardUrl = config.dashboardUrl?.replace(/\/+$/, "")
  const runLink = dashboardUrl ? `${dashboardUrl}/runs/${sessionID}` : null
  const message = runLink ? `→ ${runLink}\n${clip(addendum)}` : clip(addendum)

  try {
    await client.tui.showToast({
      query: { directory },
      body: {
        title: "Autopsy fix patterns",
        message,
        variant: "warning",
        duration: config.preflight.tuiToastDurationMs,
      },
    })
  } catch {
    // Visibility aid only; never affect chat.
  }
}

// Test-only reset; do not call from production code paths.
export const _resetTuiToast = (): void => {
  fired.clear()
}

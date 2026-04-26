import { config } from "./config.ts"
import type { EventIn, PreflightRequest, PreflightResponse } from "./types.ts"

const headers = () => ({
  "content-type": "application/json",
  ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
})

export const postEvents = (events: EventIn[]) =>
  fetch(`${config.url}/v1/events`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ events }),
  }).catch(() => {})

export const postOutcome = (
  runId: string,
  outcome: "approved" | "rejected" | "aborted",
  feedback?: string,
) =>
  fetch(`${config.url}/v1/runs/${runId}/outcome`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ outcome, feedback }),
  }).catch(() => {})

export const postFeedback = (runId: string, feedback: string) =>
  fetch(`${config.url}/v1/runs/${runId}/feedback`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ feedback, source: "plugin" }),
  }).catch(() => {})

export type RejectionPayload = {
  reason: string
  failure_mode?: string
  symptoms?: string
  ts?: number
}

// File a rejection against a still-active run. Unlike `postOutcome("rejected")`,
// this does NOT terminate the thread — the agent keeps going so it can recover
// from the failure. The dashboard renders all rejections on the timeline.
export const postRejection = (runId: string, body: RejectionPayload) =>
  fetch(`${config.url}/v1/runs/${runId}/rejections`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ source: "plugin", ...body }),
  }).catch(() => {})

// Bounded preflight call. `tool.execute.before` runs synchronously in the
// agent's hot path, so a degraded service must never stall the chat. We
// abort after `config.preflight.timeoutMs` and fail open (return null,
// caller treats as risk_level=none).
export const preflight = async (req: PreflightRequest): Promise<PreflightResponse | null> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.preflight.timeoutMs)
  try {
    const r = await fetch(`${config.url}/v1/preflight`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(req),
      signal: ctrl.signal,
    }).catch(() => null)
    if (!r || !r.ok) return null
    return (await r.json()) as PreflightResponse
  } finally {
    clearTimeout(timer)
  }
}

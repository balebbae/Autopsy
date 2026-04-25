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

export const preflight = async (req: PreflightRequest): Promise<PreflightResponse | null> => {
  const r = await fetch(`${config.url}/v1/preflight`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(req),
  }).catch(() => null)
  if (!r || !r.ok) return null
  return (await r.json()) as PreflightResponse
}

// Server-side fetch helpers for the AAG service.
// All endpoints are documented in /contracts/openapi.yaml.

const baseUrl = process.env.NEXT_PUBLIC_AAG_URL ?? "http://localhost:4000"

export type RunSummary = {
  run_id: string
  project: string | null
  worktree: string | null
  started_at: number
  ended_at: number | null
  status: "active" | "approved" | "rejected" | "aborted"
  task: string | null
  rejection_reason: string | null
  files_touched: number
  tool_calls: number
}

export type RunEvent = {
  event_id: string | null
  run_id: string
  ts: number
  type: string
  properties: Record<string, unknown>
}

export type Run = RunSummary & {
  events: RunEvent[]
  diffs: Array<{ captured_at: number | null; files: Array<Record<string, unknown>> }>
  failure_case: null | {
    failure_mode: string
    fix_pattern: string | null
    components: string[]
    change_patterns: string[]
    symptoms: Array<{ name: string; evidence: string[]; confidence: number }>
    summary: string | null
  }
}

const fetchNoStore = (path: string) =>
  fetch(`${baseUrl}${path}`, { cache: "no-store" })

export async function listRuns(): Promise<RunSummary[]> {
  const r = await fetchNoStore("/v1/runs")
  if (!r.ok) return []
  return r.json()
}

export async function getRun(runId: string): Promise<Run | null> {
  const r = await fetchNoStore(`/v1/runs/${runId}`)
  if (!r.ok) return null
  return r.json()
}

export const apiBaseUrl = baseUrl

// Server-side fetch helpers for the AAG service.
// All endpoints are documented in /contracts/openapi.yaml.

const baseUrl = process.env.NEXT_PUBLIC_AAG_URL ?? "http://localhost:4000"

export type RunStatus = "active" | "approved" | "rejected" | "aborted"

export type RunSummary = {
  run_id: string
  project: string | null
  worktree: string | null
  started_at: number
  ended_at: number | null
  status: RunStatus
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

export type DiffFile = {
  file: string
  status?: "added" | "modified" | "deleted" | "renamed" | string
  additions?: number
  deletions?: number
  patch?: string | null
}

export type DiffSnapshot = {
  captured_at: number | null
  files: DiffFile[]
}

export type FailureSymptom = {
  name: string
  evidence: string[]
  confidence: number
}

export type FailureCase = {
  failure_mode: string
  fix_pattern: string | null
  components: string[]
  change_patterns: string[]
  symptoms: FailureSymptom[]
  summary: string | null
  task_type?: string | null
}

export type Run = RunSummary & {
  events: RunEvent[]
  diffs: DiffSnapshot[]
  failure_case: FailureCase | null
}

export type GraphNodeType =
  | "Run"
  | "Task"
  | "File"
  | "Component"
  | "ChangePattern"
  | "Symptom"
  | "FailureMode"
  | "FixPattern"
  | "Outcome"

export type GraphNode = {
  id: string
  type: GraphNodeType | string
  name: string
  properties?: Record<string, unknown>
}

export type GraphEdge = {
  id: string
  source_id: string
  target_id: string
  type: string
  confidence?: number
  evidence_run_id?: string | null
  properties?: Record<string, unknown>
}

export type PreflightRequest = {
  task: string
  run_id?: string | null
  worktree?: string | null
  tool?: string | null
  args?: Record<string, unknown> | null
}

export type PreflightResponse = {
  risk_level: "none" | "low" | "medium" | "high"
  block?: boolean
  reason?: string | null
  similar_runs?: string[]
  missing_followups?: string[]
  recommended_checks?: string[]
  system_addendum?: string | null
}

const fetchNoStore = (path: string, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, { cache: "no-store", ...init })

export async function listRuns(): Promise<RunSummary[]> {
  try {
    const r = await fetchNoStore("/v1/runs")
    if (!r.ok) return []
    return r.json()
  } catch {
    return []
  }
}

export async function getRun(runId: string): Promise<Run | null> {
  try {
    const r = await fetchNoStore(`/v1/runs/${runId}`)
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export async function listGraphNodes(opts: { type?: string; limit?: number } = {}): Promise<
  GraphNode[]
> {
  const params = new URLSearchParams()
  if (opts.type) params.set("type", opts.type)
  if (opts.limit) params.set("limit", String(opts.limit))
  const qs = params.toString()
  try {
    const r = await fetchNoStore(`/v1/graph/nodes${qs ? `?${qs}` : ""}`)
    if (!r.ok) return []
    return r.json()
  } catch {
    return []
  }
}

export async function listGraphEdges(opts: {
  source_id?: string
  target_id?: string
  type?: string
  limit?: number
} = {}): Promise<GraphEdge[]> {
  const params = new URLSearchParams()
  if (opts.source_id) params.set("source_id", opts.source_id)
  if (opts.target_id) params.set("target_id", opts.target_id)
  if (opts.type) params.set("type", opts.type)
  if (opts.limit) params.set("limit", String(opts.limit))
  const qs = params.toString()
  try {
    const r = await fetchNoStore(`/v1/graph/edges${qs ? `?${qs}` : ""}`)
    if (!r.ok) return []
    return r.json()
  } catch {
    return []
  }
}

export async function postPreflight(req: PreflightRequest): Promise<PreflightResponse | null> {
  try {
    const r = await fetch(`${baseUrl}/v1/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      cache: "no-store",
    })
    if (!r.ok) return null
    return r.json()
  } catch {
    return null
  }
}

export const apiBaseUrl = baseUrl

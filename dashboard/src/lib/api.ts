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
  rejection_count: number
  files_touched: number
  tool_calls: number
  preflight_hit_count: number
  preflight_blocked_count: number
}

export type PreflightHit = {
  id: number
  run_id: string
  ts: number
  task: string
  risk_level: "low" | "medium" | "high"
  top_failure_score: number
  blocked: boolean
  tool: string | null
  args: Record<string, unknown> | null
  similar_runs: string[]
  top_failure_modes: { name: string; score: number }[]
  top_fix_patterns: { name: string; score: number }[]
  addendum: string | null
}

export type Rejection = {
  id: number
  run_id: string
  ts: number
  reason: string
  failure_mode: string | null
  symptoms: string | null
  source: "plugin" | "dashboard" | "manual"
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
  rejections: Rejection[]
  preflight_hits: PreflightHit[]
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

// Trace mode — returned by POST /v1/preflight/trace. Visualized in the
// dashboard's Retrieval view (3-stage Graph RAG walk).
export type AnnCandidate = {
  run_id: string
  distance: number
  // Raw run status. Now includes `active`/`aborted` because the modern
  // rejection flow keeps `status='active'` while bumping
  // `rejection_count` — preflight retrieval treats those as failure
  // candidates too via `bucket`. The dashboard should display the raw
  // status verbatim and use `bucket` for retrieval-bucket coloring.
  status: "rejected" | "approved" | "active" | "aborted"
  // Effective retrieval bucket. `failure` covers any run with one or
  // more filed rejections OR `status='rejected'`; `approved` is reserved
  // for clean approvals; `none` means the SQL filter let it through but
  // it doesn't contribute to scoring.
  bucket?: "failure" | "approved" | "none"
  project?: string | null
  age_days: number
  in_threshold: boolean
}

export type TraceEdge = {
  source_id: string
  target_id: string
  target_type: string
  target_name: string
  edge_type: string
  depth: number
  confidence: number
  decayed_confidence: number
  evidence_run_id?: string | null
  age_days: number
}

export type TraceAggregatedNode = {
  name: string
  type: "FailureMode" | "FixPattern" | "ChangePattern"
  raw_score: number
  final_score: number
  freq: number
}

export type PreflightTrace = {
  embed_provider: "stub" | "local" | "openai"
  vector_dim: number
  similarity_threshold: number
  half_life_days: number
  counter_weight: number
  max_hop_depth: number
  candidates: AnnCandidate[]
  rejected_roots: string[]
  approved_count: number
  dampening_factor: number
  edges: TraceEdge[]
  aggregated: TraceAggregatedNode[]
  addendum_source: "none" | "template" | "llm"
}

export type PreflightTraceResponse = {
  response: PreflightResponse
  trace: PreflightTrace
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

export async function postPreflightTrace(
  req: PreflightRequest,
): Promise<PreflightTraceResponse | null> {
  try {
    const r = await fetch(`${baseUrl}/v1/preflight/trace`, {
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

// Knowledge export / import. The full bundle shape lives in the service
// schemas; on the dashboard side we just need it as an opaque object we can
// hand back to /v1/graph/import.
export type GraphExportSource = {
  project: string | null
  source_label: string | null
  embed_provider: string | null
  embed_dim: number | null
}

export type GraphExportEmbedding = {
  entity_type: "task" | "failure" | "fix" | "run_summary"
  text: string
  vector: number[]
}

export type GraphExportSymptom = {
  name: string
  evidence: string[]
  confidence: number
  source: string | null
}

export type GraphExportCase = {
  source_run_id: string
  started_at: number
  ended_at: number | null
  status: "rejected" | "approved" | "aborted"
  task: string | null
  task_type: string | null
  failure_mode: string
  fix_pattern: string | null
  components: string[]
  change_patterns: string[]
  symptoms: GraphExportSymptom[]
  summary: string | null
  embeddings: GraphExportEmbedding[]
}

export type GraphExportBundle = {
  schema_version: number
  exported_at: number
  source: GraphExportSource
  cases: GraphExportCase[]
}

export type GraphImportResult = {
  cases_added: number
  cases_skipped: number
  embeddings_added: number
  embeddings_skipped: number
}

export async function fetchGraphExport(opts: {
  project?: string | null
  sourceLabel?: string | null
}): Promise<GraphExportBundle> {
  const params = new URLSearchParams()
  if (opts.project) params.set("project", opts.project)
  if (opts.sourceLabel) params.set("source_label", opts.sourceLabel)
  const qs = params.toString()
  const r = await fetch(`${baseUrl}/v1/graph/export${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
  })
  if (!r.ok) {
    throw new Error(`export failed: ${r.status} ${r.statusText}`)
  }
  return r.json()
}

export async function postGraphImport(
  bundle: unknown,
  opts: { sourceLabel?: string | null } = {},
): Promise<GraphImportResult> {
  const params = new URLSearchParams()
  if (opts.sourceLabel) params.set("source_label", opts.sourceLabel)
  const qs = params.toString()
  const r = await fetch(`${baseUrl}/v1/graph/import${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bundle),
    cache: "no-store",
  })
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`
    try {
      const body = await r.json()
      if (body?.detail) detail = String(body.detail)
    } catch {
      // body wasn't JSON; keep the status text
    }
    throw new Error(detail)
  }
  return r.json()
}

export const apiBaseUrl = baseUrl

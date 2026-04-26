// Mirrors the relevant pieces of contracts/openapi.yaml. Hand-written for now;
// regenerate via `bunx openapi-typescript ../contracts/openapi.yaml` later if
// you want strict drift detection.

export type EventIn = {
  event_id?: string
  run_id: string
  project?: string | null
  worktree?: string | null
  ts: number
  type: string
  properties: Record<string, unknown>
}

export type PreflightRequest = {
  run_id?: string | null
  task: string
  project?: string | null
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

"""Preflight request/response schemas."""

from typing import Any, Literal

from pydantic import BaseModel, Field

RiskLevel = Literal["none", "low", "medium", "high"]


class PreflightRequest(BaseModel):
    run_id: str | None = None
    task: str
    project: str | None = None
    worktree: str | None = None
    tool: str | None = None
    args: dict[str, Any] | None = None


class PreflightResponse(BaseModel):
    risk_level: RiskLevel = "none"
    block: bool = False
    reason: str | None = None
    similar_runs: list[str] = Field(default_factory=list)
    missing_followups: list[str] = Field(default_factory=list)
    recommended_checks: list[str] = Field(default_factory=list)
    system_addendum: str | None = None


# =========================================================================
# Trace mode — returns the same response plus a structured walk through the
# pipeline (ANN candidates, traversed edges, aggregation rows). Used by the
# dashboard's "Retrieval" view to visualize Graph RAG end-to-end. Off the
# hot path: this lives behind a separate endpoint (POST /v1/preflight/trace)
# and bypasses cache / hit persistence so each call always reproduces the
# full pipeline.
# =========================================================================


class AnnCandidate(BaseModel):
    """One row from the vector ANN stage. Returned in distance order."""

    run_id: str
    distance: float
    status: Literal["rejected", "approved"]
    project: str | None = None
    age_days: float
    # True iff the candidate cleared the SIMILARITY_THRESHOLD and was
    # forwarded into the graph stage. Below-threshold rows are returned
    # for visualization but contribute nothing to the score.
    in_threshold: bool


class TraceEdge(BaseModel):
    """One edge visited in the recursive CTE.

    Each row is a single (source_node, target_node) hop with the per-hop
    decayed confidence (`confidence * exp(-age_days / half_life)`). The
    dashboard renders these as the typed graph walk Run -> Symptom ->
    FailureMode -> FixPattern.
    """

    source_id: str
    target_id: str
    target_type: str
    target_name: str
    edge_type: str
    depth: int
    confidence: float
    decayed_confidence: float
    evidence_run_id: str | None = None
    age_days: float


class TraceAggregatedNode(BaseModel):
    """One node in the post-aggregation bucket. Pre-dampening scores."""

    name: str
    type: Literal["FailureMode", "FixPattern", "ChangePattern"]
    raw_score: float
    final_score: float  # after dampening (only differs for FailureMode)
    freq: int  # COUNT(DISTINCT evidence_run_id)


class PreflightTrace(BaseModel):
    """Structured intermediate output of the preflight pipeline."""

    embed_provider: str
    vector_dim: int
    similarity_threshold: float
    half_life_days: float
    counter_weight: float
    max_hop_depth: int
    candidates: list[AnnCandidate] = Field(default_factory=list)
    rejected_roots: list[str] = Field(default_factory=list)
    approved_count: int = 0
    dampening_factor: float = 1.0
    edges: list[TraceEdge] = Field(default_factory=list)
    aggregated: list[TraceAggregatedNode] = Field(default_factory=list)
    addendum_source: Literal["none", "template", "llm"] = "none"


class PreflightTraceResponse(BaseModel):
    """Full trace + the would-be PreflightResponse for the same request."""

    response: PreflightResponse
    trace: PreflightTrace

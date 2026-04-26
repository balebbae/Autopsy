"""Run / diff / outcome / failure-case schemas."""

from typing import Any, Literal

from pydantic import BaseModel, Field

from aag.schemas.events import EventIn

RunStatus = Literal["active", "inactive", "approved", "rejected", "aborted"]
DiffStatus = Literal["added", "modified", "deleted", "renamed"]


class DiffSnapshotFile(BaseModel):
    file: str
    status: DiffStatus
    additions: int = 0
    deletions: int = 0
    patch: str | None = None


class DiffSnapshot(BaseModel):
    captured_at: int | None = None
    files: list[DiffSnapshotFile]


class OutcomeIn(BaseModel):
    outcome: Literal["approved", "rejected", "aborted"]
    feedback: str | None = None


class FeedbackIn(BaseModel):
    feedback: str
    source: Literal["plugin", "dashboard", "manual"] = "manual"


class Symptom(BaseModel):
    name: str
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.5
    source: str | None = None


class FailureCaseOut(BaseModel):
    run_id: str
    task_type: str | None = None
    failure_mode: str
    fix_pattern: str | None = None
    components: list[str] = Field(default_factory=list)
    change_patterns: list[str] = Field(default_factory=list)
    symptoms: list[Symptom] = Field(default_factory=list)
    summary: str | None = None


class RejectionIn(BaseModel):
    """Recorded by the plugin (or dashboard) when a failure is filed against
    a still-active thread. Does NOT terminate the run."""

    reason: str
    failure_mode: str | None = None
    symptoms: str | None = None
    ts: int | None = None
    source: Literal["plugin", "dashboard", "manual"] = "plugin"


class RejectionOut(BaseModel):
    id: int
    run_id: str
    ts: int
    reason: str
    failure_mode: str | None = None
    symptoms: str | None = None
    source: Literal["plugin", "dashboard", "manual"] = "plugin"


class RunSummary(BaseModel):
    run_id: str
    project: str | None = None
    worktree: str | None = None
    started_at: int
    ended_at: int | None = None
    status: RunStatus
    task: str | None = None
    rejection_reason: str | None = None
    rejection_count: int = 0
    files_touched: int = 0
    tool_calls: int = 0
    # Aggregate counters surfaced on the runs list so the dashboard can
    # render the green "Autopsy fired" badge without a per-row roundtrip.
    preflight_hit_count: int = 0
    preflight_blocked_count: int = 0


class PreflightHitOut(BaseModel):
    """One persisted call into /v1/preflight that returned non-none risk.

    Surfaced on the run detail so the dashboard can render a "Autopsy
    caught something" badge + a per-hit detail panel showing exactly
    what the agent's system prompt was augmented with.
    """

    id: int
    run_id: str
    ts: int
    task: str
    risk_level: Literal["low", "medium", "high"]
    top_failure_score: float
    blocked: bool = False
    tool: str | None = None
    args: dict[str, Any] | None = None
    similar_runs: list[str] = Field(default_factory=list)
    top_failure_modes: list[dict[str, Any]] = Field(default_factory=list)
    top_fix_patterns: list[dict[str, Any]] = Field(default_factory=list)
    addendum: str | None = None


class RunOut(RunSummary):
    events: list[EventIn] = Field(default_factory=list)
    diffs: list[DiffSnapshot] = Field(default_factory=list)
    failure_case: FailureCaseOut | None = None
    rejections: list[RejectionOut] = Field(default_factory=list)
    preflight_hits: list[PreflightHitOut] = Field(default_factory=list)

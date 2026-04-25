"""Run / diff / outcome / failure-case schemas."""

from typing import Literal

from pydantic import BaseModel, Field

from aag.schemas.events import EventIn

RunStatus = Literal["active", "approved", "rejected", "aborted"]
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


class FailureCaseOut(BaseModel):
    run_id: str
    task_type: str | None = None
    failure_mode: str
    fix_pattern: str | None = None
    components: list[str] = Field(default_factory=list)
    change_patterns: list[str] = Field(default_factory=list)
    symptoms: list[Symptom] = Field(default_factory=list)
    summary: str | None = None


class RunSummary(BaseModel):
    run_id: str
    project: str | None = None
    worktree: str | None = None
    started_at: int
    ended_at: int | None = None
    status: RunStatus
    task: str | None = None
    rejection_reason: str | None = None
    files_touched: int = 0
    tool_calls: int = 0


class RunOut(RunSummary):
    events: list[EventIn] = Field(default_factory=list)
    diffs: list[DiffSnapshot] = Field(default_factory=list)
    failure_case: FailureCaseOut | None = None

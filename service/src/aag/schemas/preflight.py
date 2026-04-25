"""Preflight request/response schemas."""

from typing import Any, Literal

from pydantic import BaseModel, Field

RiskLevel = Literal["none", "low", "medium", "high"]


class PreflightRequest(BaseModel):
    run_id: str | None = None
    task: str
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

"""Graph node/edge response schemas."""

from typing import Any

from pydantic import BaseModel, Field


class GraphNodeOut(BaseModel):
    id: str
    type: str
    name: str
    properties: dict[str, Any] = Field(default_factory=dict)


class GraphEdgeOut(BaseModel):
    id: int
    source_id: str
    target_id: str
    type: str
    confidence: float = 0.5
    evidence_run_id: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)

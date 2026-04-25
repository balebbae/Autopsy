"""Event ingestion schemas."""

from typing import Any

from pydantic import BaseModel, Field


class EventIn(BaseModel):
    event_id: str | None = None
    run_id: str
    project: str | None = None
    worktree: str | None = None
    ts: int
    type: str
    properties: dict[str, Any] = Field(default_factory=dict)


class EventBatch(BaseModel):
    events: list[EventIn]

"""Pydantic v2 request/response schemas. Mirror contracts/openapi.yaml."""

from aag.schemas.events import EventBatch, EventIn
from aag.schemas.graph import GraphEdgeOut, GraphNodeOut
from aag.schemas.preflight import PreflightRequest, PreflightResponse
from aag.schemas.runs import (
    DiffSnapshot,
    DiffSnapshotFile,
    FailureCaseOut,
    OutcomeIn,
    RunOut,
    RunSummary,
    Symptom,
)

__all__ = [
    "EventIn",
    "EventBatch",
    "RunSummary",
    "RunOut",
    "DiffSnapshot",
    "DiffSnapshotFile",
    "OutcomeIn",
    "FailureCaseOut",
    "Symptom",
    "PreflightRequest",
    "PreflightResponse",
    "GraphNodeOut",
    "GraphEdgeOut",
]

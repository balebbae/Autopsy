"""Pydantic v2 request/response schemas. Mirror contracts/openapi.yaml."""

from aag.schemas.events import EventBatch, EventIn
from aag.schemas.graph import (
    ExportBundle,
    ExportCase,
    ExportEmbedding,
    ExportSource,
    ExportSymptom,
    GraphEdgeOut,
    GraphNodeOut,
    ImportResult,
)
from aag.schemas.preflight import (
    AnnCandidate,
    PreflightRequest,
    PreflightResponse,
    PreflightTrace,
    PreflightTraceResponse,
    TraceAggregatedNode,
    TraceEdge,
)
from aag.schemas.runs import (
    DiffSnapshot,
    DiffSnapshotFile,
    FailureCaseOut,
    OutcomeIn,
    PreflightHitOut,
    RejectionIn,
    RejectionOut,
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
    "RejectionIn",
    "RejectionOut",
    "FailureCaseOut",
    "PreflightHitOut",
    "Symptom",
    "PreflightRequest",
    "PreflightResponse",
    "PreflightTrace",
    "PreflightTraceResponse",
    "AnnCandidate",
    "TraceEdge",
    "TraceAggregatedNode",
    "GraphNodeOut",
    "GraphEdgeOut",
    "ExportBundle",
    "ExportCase",
    "ExportEmbedding",
    "ExportSource",
    "ExportSymptom",
    "ImportResult",
]

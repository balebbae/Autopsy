"""Preflight HTTP routes.

POST ``/preflight``
    Hot-path: returns ``PreflightResponse`` with cache + persistence.

POST ``/preflight/trace``
    Operator-facing: returns the same response plus a structured trace of
    the pipeline (ANN candidates, traversed edges, aggregation rows). Used
    by the dashboard's Retrieval view to visualize Graph RAG end-to-end.
    Bypasses cache and ``preflight_hits`` persistence so each call re-runs
    the full pipeline.
"""

from __future__ import annotations

from fastapi import APIRouter

from aag.deps import SessionDep
from aag.graph.traversal import preflight as do_preflight
from aag.graph.traversal import preflight_trace as do_preflight_trace
from aag.schemas import (
    PreflightRequest,
    PreflightResponse,
    PreflightTraceResponse,
)

router = APIRouter()


@router.post(
    "/preflight",
    response_model=PreflightResponse,
    response_model_exclude_none=True,
)
async def preflight(req: PreflightRequest, session: SessionDep) -> PreflightResponse:
    return await do_preflight(session, req)


@router.post(
    "/preflight/trace",
    response_model=PreflightTraceResponse,
)
async def preflight_trace(
    req: PreflightRequest,
    session: SessionDep,
) -> PreflightTraceResponse:
    return await do_preflight_trace(session, req)

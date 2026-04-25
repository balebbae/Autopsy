"""POST /v1/preflight — risk + warnings for a new task."""

from __future__ import annotations

from fastapi import APIRouter

from aag.deps import SessionDep
from aag.graph.traversal import preflight as do_preflight
from aag.schemas import PreflightRequest, PreflightResponse

router = APIRouter()


@router.post(
    "/preflight",
    response_model=PreflightResponse,
    response_model_exclude_none=True,
)
async def preflight(req: PreflightRequest, session: SessionDep) -> PreflightResponse:
    return await do_preflight(session, req)

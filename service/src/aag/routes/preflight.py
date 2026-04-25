"""POST /v1/preflight — risk + warnings for a new task.

Stub returns no risk by default. R3 fills in:
  1. Embed input.task (aag.graph.embeddings.embed)
  2. ANN over `embeddings` for similar tasks/failures
  3. Traverse `graph_edges` 2 hops from those Runs
  4. Aggregate failure modes + missing followups + recommended checks
"""

from __future__ import annotations

from fastapi import APIRouter

from aag.deps import SessionDep
from aag.schemas import PreflightRequest, PreflightResponse

router = APIRouter()


@router.post("/preflight", response_model=PreflightResponse)
async def preflight(req: PreflightRequest, session: SessionDep) -> PreflightResponse:
    # TODO(R3): replace with real retrieval + traversal.
    # from aag.graph.traversal import preflight as do_preflight
    # return await do_preflight(session, req)
    return PreflightResponse()

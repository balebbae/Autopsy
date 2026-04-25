"""Read-side: vector ANN + 2-hop graph traversal -> PreflightResponse.

R3: implement preflight(session, req) that:
  1. embed(req.task) via aag.graph.embeddings.embed
  2. SELECT entity_id, vector <=> :v AS dist FROM embeddings
       WHERE entity_type='task' ORDER BY vector <=> :v LIMIT :k;
  3. For each similar Run, recursive CTE 2 hops over graph_edges
  4. Aggregate target FailureMode/FixPattern by frequency * confidence
  5. Compose system_addendum string
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from aag.schemas.preflight import PreflightRequest, PreflightResponse


async def preflight(session: AsyncSession, req: PreflightRequest) -> PreflightResponse:
    # TODO(R3): replace with real retrieval.
    return PreflightResponse()

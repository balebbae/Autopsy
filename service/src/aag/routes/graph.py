"""GET /v1/graph/nodes, GET /v1/graph/edges — graph inspection."""

from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import select

from aag.deps import SessionDep
from aag.models import GraphEdge, GraphNode
from aag.schemas import GraphEdgeOut, GraphNodeOut

router = APIRouter()

ALLOWED_NODE_TYPES = {
    "Run",
    "Task",
    "File",
    "Component",
    "ChangePattern",
    "Symptom",
    "FailureMode",
    "FixPattern",
    "Outcome",
}


@router.get("/graph/nodes", response_model=list[GraphNodeOut])
async def list_nodes(
    session: SessionDep,
    type: str | None = Query(None, description="Filter by node type"),
    limit: int = Query(200, ge=1, le=1000),
) -> list[GraphNodeOut]:
    stmt = select(GraphNode).order_by(GraphNode.created_at.desc()).limit(limit)
    if type is not None:
        # Accept any type; unknown types just return [].
        stmt = stmt.where(GraphNode.type == type)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        GraphNodeOut(id=n.id, type=n.type, name=n.name, properties=n.properties or {}) for n in rows
    ]


@router.get("/graph/edges", response_model=list[GraphEdgeOut])
async def list_edges(
    session: SessionDep,
    source_id: str | None = Query(None),
    target_id: str | None = Query(None),
    type: str | None = Query(None),
    limit: int = Query(500, ge=1, le=2000),
) -> list[GraphEdgeOut]:
    stmt = select(GraphEdge).order_by(GraphEdge.created_at.desc()).limit(limit)
    if source_id is not None:
        stmt = stmt.where(GraphEdge.source_id == source_id)
    if target_id is not None:
        stmt = stmt.where(GraphEdge.target_id == target_id)
    if type is not None:
        stmt = stmt.where(GraphEdge.type == type)
    rows = (await session.execute(stmt)).scalars().all()
    return [
        GraphEdgeOut(
            id=e.id,
            source_id=e.source_id,
            target_id=e.target_id,
            type=e.type,
            confidence=e.confidence,
            evidence_run_id=e.evidence_run_id,
            properties=e.properties or {},
        )
        for e in rows
    ]

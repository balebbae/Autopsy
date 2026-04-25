"""Graph node/edge inspection routes for the dashboard."""

from fastapi import APIRouter, Query
from sqlalchemy import select

from aag.deps import SessionDep
from aag.models.graph import GraphEdge, GraphNode
from aag.schemas.graph import GraphEdgeOut, GraphNodeOut

router = APIRouter()


@router.get("/graph/nodes", response_model=list[GraphNodeOut])
async def list_graph_nodes(
    db: SessionDep,
    type: str | None = Query(None, description="Filter by node type"),
    limit: int = Query(200, le=1000),
) -> list[GraphNodeOut]:
    """List graph nodes, optionally filtered by type."""
    stmt = select(GraphNode)
    if type:
        stmt = stmt.where(GraphNode.type == type)
    stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [
        GraphNodeOut(
            id=r.id,
            type=r.type,
            name=r.name,
            properties=r.properties or {},
        )
        for r in rows
    ]


@router.get("/graph/edges", response_model=list[GraphEdgeOut])
async def list_graph_edges(
    db: SessionDep,
    source_id: str | None = Query(None, description="Filter by source node ID"),
    target_id: str | None = Query(None, description="Filter by target node ID"),
    type: str | None = Query(None, description="Filter by edge type"),
    limit: int = Query(500, le=2000),
) -> list[GraphEdgeOut]:
    """List graph edges, optionally filtered."""
    stmt = select(GraphEdge)
    if source_id:
        stmt = stmt.where(GraphEdge.source_id == source_id)
    if target_id:
        stmt = stmt.where(GraphEdge.target_id == target_id)
    if type:
        stmt = stmt.where(GraphEdge.type == type)
    stmt = stmt.limit(limit)
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [
        GraphEdgeOut(
            id=r.id,
            source_id=r.source_id,
            target_id=r.target_id,
            type=r.type,
            confidence=r.confidence,
            evidence_run_id=r.evidence_run_id,
            properties=r.properties or {},
        )
        for r in rows
    ]

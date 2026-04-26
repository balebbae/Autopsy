"""GET /v1/graph/nodes, GET /v1/graph/edges — graph inspection.

Plus knowledge export / import:
  - ``GET /v1/graph/export``  → ExportBundle (JSON, downloadable)
  - ``POST /v1/graph/import`` → ImportResult (counts)
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy import select

from aag.deps import SessionDep
from aag.graph.export_import import BundleError, export_bundle, import_bundle
from aag.models import GraphEdge, GraphNode
from aag.schemas import ExportBundle, GraphEdgeOut, GraphNodeOut, ImportResult

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


@router.get("/graph/export")
async def export_knowledge(
    session: SessionDep,
    project: str | None = Query(None, description="Filter to a single source project"),
    source_label: str | None = Query(
        None,
        description="Label embedded in the bundle so importers can namespace shadow runs",
    ),
) -> JSONResponse:
    """Build a downloadable knowledge bundle.

    Returns the bundle as JSON with ``Content-Disposition: attachment`` so a
    raw browser hit (or curl with ``-OJ``) saves it as a file. The dashboard
    fetches it XHR-style and triggers its own ``a[download]`` click for a
    nicer filename.
    """
    bundle = await export_bundle(session, project=project, source_label=source_label)
    filename = "aag-knowledge.json"
    if source_label or project:
        slug = (source_label or project or "export").replace("/", "_")
        filename = f"aag-knowledge-{slug}.json"
    return JSONResponse(
        content=bundle,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post(
    "/graph/import",
    response_model=ImportResult,
    status_code=status.HTTP_200_OK,
)
async def import_knowledge(
    bundle: ExportBundle,
    session: SessionDep,
    source_label: str | None = Query(
        None,
        description="Override the source label used to namespace shadow runs",
    ),
) -> ImportResult:
    """Materialize a knowledge bundle into the local graph.

    Idempotent: re-importing the same bundle is a no-op (skip-on-conflict).
    Returns counts so the caller can render a toast.
    """
    try:
        # Pydantic already validated structure; pass through as a dict so the
        # importer can keep its tolerant attribute-access for unknown fields.
        counts = await import_bundle(
            session,
            bundle.model_dump(mode="json"),
            source_label_override=source_label,
        )
    except BundleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ImportResult(**counts)

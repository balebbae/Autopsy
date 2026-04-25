"""Upsert nodes and edges from a FailureCase + extracted entities.

R3: implement write(run_id, failure_case, extracted) that produces nodes:
  Run, Task, File, Component, ChangePattern, Symptom, FailureMode, FixPattern, Outcome
and edges:
  ATTEMPTED, TOUCHED, BELONGS_TO, HAD_CHANGE_PATTERN, EMITTED_SYMPTOM,
  INDICATES, RESOLVED_BY, RESULTED_IN
each tagged with evidence_run_id and a confidence float.
"""

from __future__ import annotations

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from aag.models import GraphEdge, GraphNode


async def upsert_node(
    session: AsyncSession,
    *,
    type: str,
    name: str,
    properties: dict | None = None,
) -> str:
    node_id = f"{type}:{name}"
    stmt = (
        pg_insert(GraphNode)
        .values(id=node_id, type=type, name=name, properties=properties or {})
        .on_conflict_do_update(
            index_elements=["id"],
            set_={"properties": properties or {}},
        )
    )
    await session.execute(stmt)
    return node_id


async def upsert_edge(
    session: AsyncSession,
    *,
    source_id: str,
    target_id: str,
    type: str,
    confidence: float = 0.5,
    evidence_run_id: str | None = None,
    properties: dict | None = None,
) -> None:
    stmt = (
        pg_insert(GraphEdge)
        .values(
            source_id=source_id,
            target_id=target_id,
            type=type,
            confidence=confidence,
            evidence_run_id=evidence_run_id,
            properties=properties or {},
        )
        .on_conflict_do_nothing(
            index_elements=["source_id", "target_id", "type", "evidence_run_id"]
        )
    )
    await session.execute(stmt)

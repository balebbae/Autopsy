"""Upsert nodes and edges from a FailureCase + extracted entities.

R3: implement write(run_id, failure_case, extracted) that produces nodes:
  Run, Task, File, Component, ChangePattern, Symptom, FailureMode, FixPattern, Outcome
and edges:
  ATTEMPTED, TOUCHED, BELONGS_TO, HAD_CHANGE_PATTERN, EMITTED_SYMPTOM,
  INDICATES, RESOLVED_BY, RESULTED_IN
each tagged with evidence_run_id and a confidence float.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from aag.analyzer.extractor import extract_components
from aag.models import GraphEdge, GraphNode

if TYPE_CHECKING:
    from aag.analyzer.extractor import Extraction
    from aag.models import Run
    from aag.schemas.runs import FailureCaseOut


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


async def write(
    session: AsyncSession,
    *,
    run: Run,
    failure_case: FailureCaseOut,
    extraction: Extraction,
) -> None:
    """Upsert the full node + edge graph for a single run.

    Caller owns the transaction (we only `flush`, never `commit`). Idempotent:
    re-running with the same inputs produces no duplicate edges thanks to the
    `(source_id, target_id, type, evidence_run_id)` unique constraint and
    `on_conflict_do_nothing` in `upsert_edge`.
    """
    run_id = run.run_id

    # --- Run node + Task node -------------------------------------------------
    run_node = await upsert_node(
        session,
        type="Run",
        name=run_id,
        properties={
            "status": run.status,
            "started_at": run.started_at,
            "ended_at": run.ended_at,
            "task": run.task,
        },
    )

    task_name = extraction.task_type or "unknown"
    task_node = await upsert_node(
        session,
        type="Task",
        name=task_name,
        properties={"task": run.task or ""},
    )
    await upsert_edge(
        session,
        source_id=run_node,
        target_id=task_node,
        type="ATTEMPTED",
        confidence=1.0,
        evidence_run_id=run_id,
    )

    # --- Files + Components ---------------------------------------------------
    component_nodes: dict[str, str] = {}
    for component in extraction.components:
        component_nodes[component] = await upsert_node(
            session,
            type="Component",
            name=component,
            properties={},
        )

    for path in extraction.files:
        file_node = await upsert_node(session, type="File", name=path, properties={})
        await upsert_edge(
            session,
            source_id=run_node,
            target_id=file_node,
            type="TOUCHED",
            confidence=1.0,
            evidence_run_id=run_id,
        )

        per_file_components = extract_components([path])
        if per_file_components:
            comp_name = per_file_components[0]
            comp_node = component_nodes.get(comp_name)
            if comp_node is None:
                comp_node = await upsert_node(
                    session,
                    type="Component",
                    name=comp_name,
                    properties={},
                )
                component_nodes[comp_name] = comp_node
            await upsert_edge(
                session,
                source_id=file_node,
                target_id=comp_node,
                type="BELONGS_TO",
                confidence=1.0,
                evidence_run_id=run_id,
            )

    # --- Change patterns ------------------------------------------------------
    # Skip change_patterns whose name duplicates a Symptom — the current
    # classifier seeds change_patterns from `[s.name for s in symptoms]`, which
    # would materialize a redundant ChangePattern node for every Symptom and
    # clutter the graph. Only emit ChangePattern nodes for names that are NOT
    # also symptom names; this preserves the schema for a future diff-derived
    # change-pattern detector (e.g. "added_field", "renamed_function") without
    # producing visual duplicates today.
    symptom_names = {s.name for s in failure_case.symptoms}
    for cp in extraction.change_patterns:
        if cp in symptom_names:
            continue
        cp_node = await upsert_node(session, type="ChangePattern", name=cp, properties={})
        await upsert_edge(
            session,
            source_id=run_node,
            target_id=cp_node,
            type="HAD_CHANGE_PATTERN",
            confidence=1.0,
            evidence_run_id=run_id,
        )

    # --- Symptoms + FailureMode + FixPattern ----------------------------------
    failure_mode_node = await upsert_node(
        session,
        type="FailureMode",
        name=failure_case.failure_mode,
        properties={},
    )

    for symptom in failure_case.symptoms:
        symptom_node = await upsert_node(
            session,
            type="Symptom",
            name=symptom.name,
            properties={
                "evidence": symptom.evidence,
                "confidence": symptom.confidence,
            },
        )
        await upsert_edge(
            session,
            source_id=run_node,
            target_id=symptom_node,
            type="EMITTED_SYMPTOM",
            confidence=symptom.confidence,
            evidence_run_id=run_id,
        )
        await upsert_edge(
            session,
            source_id=symptom_node,
            target_id=failure_mode_node,
            type="INDICATES",
            confidence=symptom.confidence,
            evidence_run_id=run_id,
        )

    if failure_case.fix_pattern:
        fix_node = await upsert_node(
            session,
            type="FixPattern",
            name=failure_case.fix_pattern,
            properties={},
        )
        await upsert_edge(
            session,
            source_id=failure_mode_node,
            target_id=fix_node,
            type="RESOLVED_BY",
            confidence=0.8,
            evidence_run_id=run_id,
        )

    # --- Outcome --------------------------------------------------------------
    outcome_node = await upsert_node(session, type="Outcome", name=run.status, properties={})
    await upsert_edge(
        session,
        source_id=run_node,
        target_id=outcome_node,
        type="RESULTED_IN",
        confidence=1.0,
        evidence_run_id=run_id,
    )

    await session.flush()

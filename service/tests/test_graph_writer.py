"""Integration tests for the graph writer orchestrator (`aag.graph.write`).

These tests talk to the local Postgres (assumed running per AGENTS.md). If the
DB isn't reachable, the entire module is skipped so the suite stays green for
contributors without infra running.
"""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import delete, select

from aag.analyzer.extractor import Extraction
from aag.config import get_settings
from aag.db import sessionmaker
from aag.graph import write
from aag.models import GraphEdge, GraphNode, Run
from aag.schemas.runs import FailureCaseOut, Symptom


def _db_reachable() -> bool:
    url = urlparse(get_settings().database_url.replace("+asyncpg", ""))
    host = url.hostname or "localhost"
    port = url.port or 5432
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _db_reachable(),
    reason="Postgres not reachable on localhost:5432",
)


def _make_failure_case(
    run_id: str,
    *,
    fix_pattern: str | None = "regenerate_types",
) -> FailureCaseOut:
    return FailureCaseOut(
        run_id=run_id,
        task_type="feature_addition",
        failure_mode="incomplete_schema_change",
        fix_pattern=fix_pattern,
        components=["profile"],
        # Mix: "schema_field_addition" duplicates a Symptom (should be
        # skipped by the writer's symptom-dedup); "added_field" is a real,
        # non-overlapping diff pattern that should still produce a node.
        change_patterns=["schema_field_addition", "added_field"],
        symptoms=[
            Symptom(name="schema_field_addition", evidence=["+preferredName"], confidence=0.8),
            Symptom(name="missing_migration", evidence=["no migration file"], confidence=0.7),
        ],
    )


def _make_extraction(run_id: str) -> Extraction:
    return Extraction(
        run_id=run_id,
        task="Add preferredName to user profile API and UI",
        task_type="feature_addition",
        files=[
            "src/profile/profile.service.ts",
            "src/profile/user.serializer.ts",
            "src/auth/login.ts",
        ],
        components=["profile", "auth"],
        tool_calls=[],
        errors=[],
        change_patterns=["schema_field_addition", "added_field"],
        failure_mode="incomplete_schema_change",
        fix_pattern="regenerate_types",
        symptoms=[],
    )


@pytest_asyncio.fixture
async def run_id() -> AsyncIterator[str]:
    """Insert a Run row, yield its id, and clean it up after the test.

    Cascade deletes on `runs.run_id` clean up the related graph nodes/edges
    that reference it via `evidence_run_id`. Nodes themselves are global, but
    we also remove any nodes whose ids contain this run_id (i.e. the `Run:<id>`
    node) so the dev DB stays tidy.
    """
    rid = f"test-graph-writer-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            Run(
                run_id=rid,
                project="test",
                worktree="/tmp/test",
                task="Add preferredName to user profile API and UI",
                started_at=int(time() * 1000),
                ended_at=int(time() * 1000),
                status="rejected",
            )
        )
        await session.commit()

    try:
        yield rid
    finally:
        async with sm() as session:
            # Drop the Run node explicitly; cascading FK on graph_edges will
            # remove edges that pointed at it. Other nodes (Symptom, etc.) are
            # global and intentionally retained so other tests can share them.
            await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{rid}"))
            await session.execute(delete(Run).where(Run.run_id == rid))
            await session.commit()


async def test_write_creates_all_node_types(run_id: str) -> None:
    sm = sessionmaker()
    async with sm() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        await write(
            session,
            run=run,
            failure_case=_make_failure_case(run_id),
            extraction=_make_extraction(run_id),
        )
        await session.commit()

    # Scope assertions to nodes reachable via edges tagged with this run_id —
    # `graph_nodes` is global and may contain leftovers from other tests.
    async with sm() as session:
        edge_rows = (
            (await session.execute(select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)))
            .scalars()
            .all()
        )
        endpoint_ids = {e.source_id for e in edge_rows} | {e.target_id for e in edge_rows}
        node_rows = (
            await session.execute(
                select(GraphNode.type, GraphNode.name).where(GraphNode.id.in_(endpoint_ids))
            )
        ).all()

    pairs = {(t, n) for t, n in node_rows}

    assert ("Run", run_id) in pairs
    assert ("Task", "feature_addition") in pairs
    assert ("File", "src/profile/profile.service.ts") in pairs
    assert ("File", "src/profile/user.serializer.ts") in pairs
    assert ("File", "src/auth/login.ts") in pairs
    assert ("Component", "profile") in pairs
    assert ("Component", "auth") in pairs
    # "schema_field_addition" is also a Symptom name — the writer must skip
    # it as a ChangePattern node to avoid the duplicate-concept clutter.
    assert ("ChangePattern", "schema_field_addition") not in pairs
    # A non-overlapping change_pattern still becomes its own node.
    assert ("ChangePattern", "added_field") in pairs
    assert ("Symptom", "schema_field_addition") in pairs
    assert ("Symptom", "missing_migration") in pairs
    assert ("FailureMode", "incomplete_schema_change") in pairs
    assert ("FixPattern", "regenerate_types") in pairs
    assert ("Outcome", "rejected") in pairs


async def test_write_creates_expected_edges(run_id: str) -> None:
    sm = sessionmaker()
    fc = _make_failure_case(run_id)
    extraction = _make_extraction(run_id)

    async with sm() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        await write(session, run=run, failure_case=fc, extraction=extraction)
        await session.commit()

    async with sm() as session:
        edges = (
            (await session.execute(select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)))
            .scalars()
            .all()
        )

    edge_types = {e.type for e in edges}
    expected_types = {
        "ATTEMPTED",
        "TOUCHED",
        "BELONGS_TO",
        "HAD_CHANGE_PATTERN",
        "EMITTED_SYMPTOM",
        "INDICATES",
        "RESOLVED_BY",
        "RESULTED_IN",
    }
    assert expected_types.issubset(edge_types)

    # Every edge attributed to this run.
    assert all(e.evidence_run_id == run_id for e in edges)

    # ATTEMPTED Run -> Task
    attempted = [e for e in edges if e.type == "ATTEMPTED"]
    assert any(
        e.source_id == f"Run:{run_id}" and e.target_id == "Task:feature_addition" for e in attempted
    )

    # TOUCHED — one per file.
    touched_targets = {e.target_id for e in edges if e.type == "TOUCHED"}
    assert "File:src/profile/profile.service.ts" in touched_targets
    assert "File:src/profile/user.serializer.ts" in touched_targets
    assert "File:src/auth/login.ts" in touched_targets

    # BELONGS_TO — file -> component.
    belongs_to = {(e.source_id, e.target_id) for e in edges if e.type == "BELONGS_TO"}
    assert ("File:src/profile/profile.service.ts", "Component:profile") in belongs_to
    assert ("File:src/auth/login.ts", "Component:auth") in belongs_to

    # EMITTED_SYMPTOM confidence matches symptom confidence.
    emitted = {e.target_id: e for e in edges if e.type == "EMITTED_SYMPTOM"}
    assert emitted["Symptom:schema_field_addition"].confidence == pytest.approx(0.8)
    assert emitted["Symptom:missing_migration"].confidence == pytest.approx(0.7)

    # INDICATES Symptom -> FailureMode
    indicates = {(e.source_id, e.target_id) for e in edges if e.type == "INDICATES"}
    assert (
        "Symptom:schema_field_addition",
        "FailureMode:incomplete_schema_change",
    ) in indicates

    # RESOLVED_BY FailureMode -> FixPattern (confidence 0.8)
    resolved = [e for e in edges if e.type == "RESOLVED_BY"]
    assert any(
        e.source_id == "FailureMode:incomplete_schema_change"
        and e.target_id == "FixPattern:regenerate_types"
        and e.confidence == pytest.approx(0.8)
        for e in resolved
    )

    # RESULTED_IN Run -> Outcome
    resulted = [e for e in edges if e.type == "RESULTED_IN"]
    assert any(
        e.source_id == f"Run:{run_id}" and e.target_id == "Outcome:rejected" for e in resulted
    )


async def test_write_is_idempotent(run_id: str) -> None:
    sm = sessionmaker()
    fc = _make_failure_case(run_id)
    extraction = _make_extraction(run_id)

    async def _count() -> tuple[int, int]:
        async with sm() as session:
            edge_rows = (
                (
                    await session.execute(
                        select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)
                    )
                )
                .scalars()
                .all()
            )
            node_rows = (await session.execute(select(GraphNode))).scalars().all()
        return len(node_rows), len(edge_rows)

    async with sm() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        await write(session, run=run, failure_case=fc, extraction=extraction)
        await session.commit()

    nodes_after_first, edges_after_first = await _count()

    async with sm() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        await write(session, run=run, failure_case=fc, extraction=extraction)
        await session.commit()

    nodes_after_second, edges_after_second = await _count()

    assert edges_after_first == edges_after_second, "edges should not duplicate"
    assert nodes_after_first == nodes_after_second, "nodes should not duplicate"


async def test_write_skips_fix_pattern_when_none(run_id: str) -> None:
    sm = sessionmaker()
    fc = _make_failure_case(run_id, fix_pattern=None)
    extraction = _make_extraction(run_id)
    extraction.fix_pattern = None

    async with sm() as session:
        run = (await session.execute(select(Run).where(Run.run_id == run_id))).scalar_one()
        await write(session, run=run, failure_case=fc, extraction=extraction)
        await session.commit()

    async with sm() as session:
        edges = (
            (await session.execute(select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)))
            .scalars()
            .all()
        )

    assert not any(e.type == "RESOLVED_BY" for e in edges), (
        "no RESOLVED_BY edges should exist when fix_pattern is None"
    )

    # The FixPattern node from this run must not have been created. Other
    # parallel tests may have inserted FixPattern nodes globally — we only
    # verify there's no edge from this run pointing at one.
    fix_targets = {e.target_id for e in edges if e.target_id.startswith("FixPattern:")}
    assert not fix_targets

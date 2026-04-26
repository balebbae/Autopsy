"""Integration tests for ``aag.workers.finalizer.on_run_complete``.

Exercises the full classifier → graph writer → embeddings pipeline against
a live Postgres (per AGENTS.md). If the DB isn't reachable, the entire
module is skipped so the suite stays green for contributors without infra.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import sessionmaker
from aag.models import (
    Artifact,
    Embedding,
    FailureCase,
    GraphEdge,
    GraphNode,
    Run,
    RunEvent,
)
from aag.workers.finalizer import on_run_complete


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


async def _make_rejected_schema_run(session: AsyncSession, run_id: str) -> None:
    """Insert a rejected run + a tool.execute.after event + a session.diff
    artifact that mirrors `contracts/fixtures/run-rejected-schema.json`.

    The diff adds a `preferredName?: string` field to a TS interface and does
    NOT touch any migration files, so the classifier should fire both
    `schema_field_addition` and `missing_migration` symptoms and pick
    `incomplete_schema_change` as the failure mode.
    """
    now = int(time() * 1000)
    session.add(
        Run(
            run_id=run_id,
            project="autopsy-tests",
            worktree="/tmp/autopsy-tests",
            task="Add preferredName to user profile API and UI",
            started_at=now,
            ended_at=now,
            status="rejected",
            rejection_reason="Missed migration and frontend types.",
        )
    )
    session.add(
        RunEvent(
            event_id=f"{run_id}-evt-edit",
            run_id=run_id,
            ts=now,
            type="tool.execute.after",
            properties={
                "sessionID": run_id,
                "tool": "edit",
                "args": {"filePath": "src/profile/profile.service.ts"},
                "result": {
                    "diff": {
                        "path": "src/profile/profile.service.ts",
                        "oldText": ("interface UserProfile {\n  id: string;\n  email: string;\n}"),
                        "newText": (
                            "interface UserProfile {\n"
                            "  id: string;\n"
                            "  email: string;\n"
                            "  preferredName?: string;\n"
                            "}"
                        ),
                    }
                },
            },
        )
    )
    session.add(
        Artifact(
            run_id=run_id,
            kind="diff",
            captured_at=now,
            content={
                "files": [
                    {
                        "file": "src/profile/profile.service.ts",
                        "status": "modified",
                        "additions": 1,
                        "deletions": 0,
                        "patch": (
                            "@@ -3,3 +3,4 @@\n"
                            "   id: string;\n"
                            "   email: string;\n"
                            "+  preferredName?: string;\n"
                        ),
                    }
                ]
            },
        )
    )


async def _cleanup(run_id: str) -> None:
    """Remove rows specific to this run.

    `runs.run_id` cascades to run_events / artifacts / failure_cases /
    graph_edges. graph_nodes are global; we drop only the ones whose ids
    are unique to this run (Run:<id>). Other nodes (FailureMode,
    Symptom, Component, etc.) are intentionally retained — they're
    idempotent and shared across tests.
    """
    sm = sessionmaker()
    async with sm() as session:
        await session.execute(delete(Embedding).where(Embedding.entity_id == run_id))
        await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def test_on_run_complete_full_pipeline() -> None:
    run_id = f"test-finalizer-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _make_rejected_schema_run(session, run_id)
        await session.commit()

    try:
        await on_run_complete(run_id)

        async with sm() as session:
            fc = await session.get(FailureCase, run_id)
            assert fc is not None, "FailureCase row should be created"
            assert fc.failure_mode == "incomplete_schema_change"

            node_rows = (await session.execute(select(GraphNode.type, GraphNode.name))).all()
            node_pairs = {(t, n) for t, n in node_rows}
            assert ("Run", run_id) in node_pairs
            # task name is the inferred task_type ("feature_addition").
            assert ("Task", "feature_addition") in node_pairs
            assert ("File", "src/profile/profile.service.ts") in node_pairs
            assert ("FailureMode", "incomplete_schema_change") in node_pairs
            assert any(t == "Symptom" for t, _ in node_pairs)

            edges = (
                (
                    await session.execute(
                        select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)
                    )
                )
                .scalars()
                .all()
            )
            assert len(edges) > 0
            assert any(
                e.type == "ATTEMPTED"
                and e.source_id == f"Run:{run_id}"
                and e.target_id == "Task:feature_addition"
                for e in edges
            )

            emb_count = (
                await session.execute(
                    select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
                )
            ).scalar_one()
            # task, failure, fix, run_summary — all four populated for this run.
            assert emb_count >= 3
    finally:
        await _cleanup(run_id)


async def test_on_run_complete_no_symptoms() -> None:
    """An approved run with no diffs should produce no analyzer output."""
    run_id = f"test-finalizer-{uuid4().hex[:8]}"
    sm = sessionmaker()
    now = int(time() * 1000)
    async with sm() as session:
        session.add(
            Run(
                run_id=run_id,
                project="autopsy-tests",
                worktree="/tmp/autopsy-tests",
                task="Refactor utility helper",
                started_at=now,
                ended_at=now,
                status="approved",
            )
        )
        await session.commit()

    try:
        await on_run_complete(run_id)

        async with sm() as session:
            fc = await session.get(FailureCase, run_id)
            assert fc is None

            run_node = (
                await session.execute(select(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
            ).scalar_one_or_none()
            assert run_node is None

            edge_count = (
                await session.execute(
                    select(func.count())
                    .select_from(GraphEdge)
                    .where(GraphEdge.evidence_run_id == run_id)
                )
            ).scalar_one()
            assert edge_count == 0

            emb_count = (
                await session.execute(
                    select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
                )
            ).scalar_one()
            assert emb_count == 0
    finally:
        await _cleanup(run_id)


async def test_on_run_complete_embeddings_failure_does_not_wipe_graph(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: an embeddings failure must not roll back graph evidence.

    Pre-fix, the graph writer and embeddings writer shared one transaction;
    a missing optional ML dep at the embeddings step caused a rollback that
    wiped all the just-written Run/File/Component nodes and run-tagged edges.
    """

    async def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated missing embeddings backend")

    monkeypatch.setattr("aag.workers.finalizer.gembed.write_for", _boom)

    run_id = f"test-finalizer-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _make_rejected_schema_run(session, run_id)
        await session.commit()

    try:
        # Should not raise even though embeddings step throws.
        await on_run_complete(run_id)

        async with sm() as session:
            fc = await session.get(FailureCase, run_id)
            assert fc is not None, "FailureCase must survive embeddings failure"

            run_node = (
                await session.execute(select(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
            ).scalar_one_or_none()
            assert run_node is not None, "Run node must survive embeddings failure"

            edges = (
                (
                    await session.execute(
                        select(GraphEdge).where(GraphEdge.evidence_run_id == run_id)
                    )
                )
                .scalars()
                .all()
            )
            assert len(edges) > 0, (
                "Run-tagged edges must survive an embeddings failure — "
                "this is the bug the fix addresses."
            )

            # Embeddings deliberately failed, so none should be present.
            emb_count = (
                await session.execute(
                    select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
                )
            ).scalar_one()
            assert emb_count == 0
    finally:
        await _cleanup(run_id)


async def test_on_run_complete_missing_run() -> None:
    """A run_id that doesn't exist should be a no-op (no raise, no rows)."""
    run_id = f"test-finalizer-missing-{uuid4().hex[:8]}"

    # Should not raise.
    await on_run_complete(run_id)

    sm = sessionmaker()
    async with sm() as session:
        fc = await session.get(FailureCase, run_id)
        assert fc is None

        run_node = (
            await session.execute(select(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        ).scalar_one_or_none()
        assert run_node is None

        emb_count = (
            await session.execute(
                select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
            )
        ).scalar_one()
        assert emb_count == 0

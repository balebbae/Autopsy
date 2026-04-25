"""Integration tests for ``aag.graph.traversal.preflight``.

Mirrors the live-Postgres pattern in ``test_graph_writer.py`` /
``test_finalizer.py``. The tests seed a minimal failure pipeline directly
through SQLAlchemy + the finalizer (no HTTP), so they don't need the
service to be running — only the database.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import sessionmaker
from aag.graph.traversal import preflight
from aag.models import (
    Artifact,
    Embedding,
    FailureCase,
    GraphNode,
    Run,
    RunEvent,
)
from aag.schemas.preflight import PreflightRequest, PreflightResponse
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


SCHEMA_TASK = "Add preferredName to user profile API and UI"


async def _seed_rejected_schema_run(session: AsyncSession, run_id: str) -> None:
    """Insert a rejected run that the analyzer will classify as
    ``incomplete_schema_change`` with a ``regenerate_types`` fix.

    Mirrors ``_make_rejected_schema_run`` in ``test_finalizer.py``.
    """
    now = int(time() * 1000)
    session.add(
        Run(
            run_id=run_id,
            project="autopsy-tests",
            worktree="/tmp/autopsy-tests",
            task=SCHEMA_TASK,
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
                        "oldText": "interface UserProfile {\n  id: string;\n  email: string;\n}",
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
    sm = sessionmaker()
    async with sm() as session:
        await session.execute(delete(Embedding).where(Embedding.entity_id == run_id))
        await session.execute(delete(FailureCase).where(FailureCase.run_id == run_id))
        await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def _seed_one() -> str:
    """Drive a synthetic rejected run through the finalizer pipeline.

    Returns the run_id (caller is responsible for ``_cleanup``).
    """
    run_id = f"test-traversal-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _seed_rejected_schema_run(session, run_id)
        await session.commit()
    await on_run_complete(run_id)
    return run_id


async def test_preflight_empty_task_safe() -> None:
    """Empty task → defaults, no SQL queries (function returns early)."""
    sm = sessionmaker()
    async with sm() as session:
        resp = await preflight(session, PreflightRequest(task=""))
    assert resp == PreflightResponse()
    assert resp.risk_level == "none"
    assert resp.system_addendum is None
    assert resp.similar_runs == []


async def test_preflight_with_no_match() -> None:
    """A task whose embedding doesn't clear the similarity threshold should
    return ``risk_level='none'`` with empty buckets — even if seeded data
    exists for unrelated tasks.
    """
    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        # The stub embedder is sha256-derived; unrelated strings yield
        # cosine distance ~1.0, well above the 0.6 threshold.
        unrelated = (
            "completely unrelated subject about astronomy and "
            "the orbital mechanics of distant binary systems"
        )
        async with sm() as session:
            resp = await preflight(session, PreflightRequest(task=unrelated))
        assert resp.risk_level == "none"
        assert resp.similar_runs == []
        assert resp.missing_followups == []
        assert resp.recommended_checks == []
        assert resp.system_addendum is None
    finally:
        await _cleanup(run_id)


async def test_preflight_finds_similar_run() -> None:
    """Identical task text → cosine distance 0 → must surface the seeded run,
    its FailureMode, and a non-empty system addendum.
    """
    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        async with sm() as session:
            resp = await preflight(session, PreflightRequest(task=SCHEMA_TASK))

        assert resp.risk_level != "none"
        assert run_id in resp.similar_runs
        assert "incomplete_schema_change" in resp.missing_followups
        assert resp.system_addendum is not None
        assert "incomplete_schema_change" in resp.system_addendum
        # The seeded fix is "regenerate_types" → it should appear in the
        # recommended checks list.
        assert "regenerate_types" in resp.recommended_checks
    finally:
        await _cleanup(run_id)


async def test_preflight_returns_none_for_unrelated_task() -> None:
    """Stub embedder doesn't model semantic similarity, but unrelated SHA
    digests are nearly orthogonal; the function should run without error
    and return ``none`` (or at worst ``low``).
    """
    sm = sessionmaker()
    async with sm() as session:
        resp = await preflight(session, PreflightRequest(task="What is the weather today?"))
    # Allow ``low`` as a defensive fallback if a hash collision sneaks
    # under the threshold; the important property is that the function
    # doesn't blow up and returns a well-typed response.
    assert resp.risk_level in {"none", "low"}

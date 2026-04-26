"""End-to-end "demo loop" integration test.

Exercises the full flow described in ``docs/demo-script.md``:

  1. Seed a rejected run (matching ``contracts/fixtures/run-rejected-schema.json``).
  2. POST ``/v1/runs/{id}/outcome`` with a rejected outcome + feedback. This
     fires the finalizer pipeline (classifier → graph writer → embeddings).
  3. Assert the analyzer populated ``failure_cases``, ``graph_nodes`` and
     ``embeddings``.
  4. POST ``/v1/preflight`` with the same task text. Assert the seeded run
     surfaces as similar, the response includes the failure mode in its
     system addendum, and ``risk_level`` is non-trivial.
  5. Cleanup all rows specific to this run.

If Postgres isn't reachable the module is skipped, matching the rest of
the integration test suite.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.main import app
from aag.models import (
    Artifact,
    Embedding,
    FailureCase,
    GraphNode,
    Run,
    RunEvent,
)


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


def _async_client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _seed_rejected_schema_run(session: AsyncSession, run_id: str) -> None:
    """Insert a Run + tool.execute.after event + diff artifact mirroring the
    ``run-rejected-schema`` fixture. Status starts as ``active`` — the demo
    loop will flip it to ``rejected`` via the outcome route.
    """
    now = int(time() * 1000)
    session.add(
        Run(
            run_id=run_id,
            project="autopsy-demo",
            worktree="/tmp/autopsy-demo",
            task=SCHEMA_TASK,
            started_at=now,
            status="active",
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
        await session.execute(delete(Embedding).where(Embedding.entity_id.like(f"{run_id}%")))
        await session.execute(delete(FailureCase).where(FailureCase.run_id == run_id))
        await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def test_demo_loop_full() -> None:
    run_id = f"test-demo-{uuid4().hex[:8]}"

    # 1. Seed the run + diff directly in the DB.
    sm = sessionmaker()
    async with sm() as session:
        await _seed_rejected_schema_run(session, run_id)
        await session.commit()

    try:
        # 2. POST outcome=rejected via HTTP. This triggers the finalizer
        #    inline (see ``aag.routes.runs.post_outcome`` → ``on_run_complete``).
        async with _async_client() as ac:
            resp = await ac.post(
                f"/v1/runs/{run_id}/outcome",
                json={
                    "outcome": "rejected",
                    "feedback": "Missed the migration and didn't regenerate the frontend types.",
                },
            )
        assert resp.status_code == 204

        # 3. Verify the finalizer wrote the expected rows.
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "rejected"
            assert run.rejection_reason and "migration" in run.rejection_reason

            fc = await session.get(FailureCase, run_id)
            assert fc is not None, "failure_case row should exist post-finalizer"
            assert fc.failure_mode == "incomplete_schema_change"

            run_node = (
                await session.execute(select(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
            ).scalar_one_or_none()
            assert run_node is not None

            node_types = (await session.execute(select(GraphNode.type).distinct())).scalars().all()
            # The graph should have at minimum these node kinds populated
            # globally; this run contributes Run/Task/Symptom/FailureMode.
            for required in ("Run", "Task", "Symptom", "FailureMode"):
                assert required in node_types, f"missing {required} graph node"

            emb_count = (
                await session.execute(
                    select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
                )
            ).scalar_one()
            assert emb_count >= 3, f"expected >=3 embeddings for run, got {emb_count}"

        # 4. POST preflight with a near-identical task; the seeded run should
        #    surface as similar with a non-trivial risk level.
        async with _async_client() as ac:
            pf = await ac.post("/v1/preflight", json={"task": SCHEMA_TASK})
        assert pf.status_code == 200
        body = pf.json()
        assert body["risk_level"] != "none"
        assert run_id in body["similar_runs"]
        assert "incomplete_schema_change" in body["missing_followups"]
        addendum = body.get("system_addendum")
        assert isinstance(addendum, str) and addendum
        # Addendum is now a bulleted list of fix patterns — the top
        # recommended check must appear verbatim.
        assert body["recommended_checks"], "expected at least one recommended check"
        assert body["recommended_checks"][0] in addendum
    finally:
        # 5. Cleanup everything tied to this run.
        await _cleanup(run_id)
        await dispose()

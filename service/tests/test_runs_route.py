"""Integration tests for the ``/v1/runs`` route handlers.

Covers list/get plus the diff/outcome/feedback POST endpoints. Drives the
real route handlers + assembler + finalizer pipeline against a live
Postgres. Skipped when the DB isn't reachable.

Uses ``httpx.AsyncClient`` with ``ASGITransport`` so route execution and
DB verification share the test's event loop.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.main import app
from aag.models import Artifact, Embedding, FailureCase, GraphNode, Run, RunEvent


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


def _async_client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://test")


async def _insert_run(
    session: AsyncSession,
    *,
    run_id: str,
    project: str = "test-runs-route",
    status: str = "active",
    started_at: int | None = None,
) -> None:
    session.add(
        Run(
            run_id=run_id,
            project=project,
            worktree="/tmp/test-runs-route",
            task="t",
            started_at=started_at if started_at is not None else int(time() * 1000),
            status=status,
        )
    )


async def _cleanup_runs(run_ids: list[str]) -> None:
    sm = sessionmaker()
    async with sm() as session:
        for rid in run_ids:
            await session.execute(delete(Embedding).where(Embedding.entity_id == rid))
            await session.execute(delete(FailureCase).where(FailureCase.run_id == rid))
            await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{rid}"))
            await session.execute(delete(Run).where(Run.run_id == rid))
        await session.commit()


async def test_list_runs_empty() -> None:
    """``GET /v1/runs`` always returns a list (may be non-empty due to seed)."""
    async with _async_client() as ac:
        resp = await ac.get("/v1/runs")
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)


async def test_list_runs_filters_by_project() -> None:
    project = f"test-runs-route-{uuid4().hex[:8]}"
    run_id = f"test-runs-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id, project=project)
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.get("/v1/runs", params={"project": project})
        assert resp.status_code == 200
        body = resp.json()
        assert isinstance(body, list)
        assert len(body) == 1
        assert body[0]["run_id"] == run_id
        assert body[0]["project"] == project
    finally:
        await _cleanup_runs([run_id])
        await dispose()


async def test_list_runs_filters_by_status() -> None:
    project = f"test-runs-route-{uuid4().hex[:8]}"
    active_id = f"test-runs-act-{uuid4().hex[:8]}"
    approved_id = f"test-runs-app-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=active_id, project=project, status="active")
        await _insert_run(session, run_id=approved_id, project=project, status="approved")
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.get("/v1/runs", params={"project": project, "status": "approved"})
        assert resp.status_code == 200
        body = resp.json()
        ids = {r["run_id"] for r in body}
        assert ids == {approved_id}
    finally:
        await _cleanup_runs([active_id, approved_id])
        await dispose()


async def test_list_runs_respects_limit() -> None:
    project = f"test-runs-route-{uuid4().hex[:8]}"
    base = int(time() * 1000)
    ids = [f"test-runs-lim-{uuid4().hex[:8]}" for _ in range(3)]
    sm = sessionmaker()
    async with sm() as session:
        for i, rid in enumerate(ids):
            await _insert_run(session, run_id=rid, project=project, started_at=base + i)
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.get("/v1/runs", params={"project": project, "limit": 2})
        assert resp.status_code == 200
        body = resp.json()
        assert len(body) == 2
        # All returned rows should be from the unique project.
        assert all(r["project"] == project for r in body)
    finally:
        await _cleanup_runs(ids)
        await dispose()


async def test_get_run_404_when_missing() -> None:
    async with _async_client() as ac:
        resp = await ac.get("/v1/runs/does-not-exist-xxx")
    assert resp.status_code == 404


async def test_get_run_returns_assembled_data() -> None:
    run_id = f"test-runs-get-{uuid4().hex[:8]}"
    now = int(time() * 1000)
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id)
        session.add(
            RunEvent(
                event_id=f"{run_id}-e1",
                run_id=run_id,
                ts=now,
                type="session.created",
                properties={"sessionID": run_id},
            )
        )
        session.add(
            RunEvent(
                event_id=f"{run_id}-e2",
                run_id=run_id,
                ts=now + 10,
                type="tool.execute.after",
                properties={"sessionID": run_id, "tool": "edit"},
            )
        )
        session.add(
            Artifact(
                run_id=run_id,
                kind="diff",
                captured_at=now + 20,
                content={
                    "files": [
                        {
                            "file": "a.ts",
                            "status": "modified",
                            "additions": 1,
                            "deletions": 0,
                            "patch": "+x\n",
                        }
                    ]
                },
            )
        )
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.get(f"/v1/runs/{run_id}")
        assert resp.status_code == 200
        body = resp.json()
        assert body["run_id"] == run_id
        assert isinstance(body["events"], list)
        assert len(body["events"]) == 2
        assert isinstance(body["diffs"], list)
        assert len(body["diffs"]) == 1
        assert body["diffs"][0]["files"][0]["file"] == "a.ts"
        assert body["failure_case"] is None
    finally:
        await _cleanup_runs([run_id])
        await dispose()


async def test_post_diff_attaches_artifact() -> None:
    run_id = f"test-runs-diff-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id)
        await session.commit()

    snapshot = {
        "captured_at": int(time() * 1000),
        "files": [
            {
                "file": "src/x.ts",
                "status": "modified",
                "additions": 2,
                "deletions": 1,
                "patch": "@@ -1 +1,2 @@\n",
            },
            {
                "file": "src/y.ts",
                "status": "added",
                "additions": 5,
                "deletions": 0,
                "patch": "@@ -0,0 +1,5 @@\n",
            },
        ],
    }

    try:
        async with _async_client() as ac:
            resp = await ac.post(f"/v1/runs/{run_id}/diff", json=snapshot)
        assert resp.status_code == 204

        sm = sessionmaker()
        async with sm() as session:
            arts = (
                (
                    await session.execute(
                        select(Artifact)
                        .where(Artifact.run_id == run_id)
                        .where(Artifact.kind == "diff")
                    )
                )
                .scalars()
                .all()
            )
            assert len(arts) == 1
            assert len(arts[0].content["files"]) == 2

            run = await session.get(Run, run_id)
            assert run is not None
            assert run.files_touched >= 2
    finally:
        await _cleanup_runs([run_id])
        await dispose()


async def test_post_diff_404_for_missing_run() -> None:
    snapshot = {
        "captured_at": 0,
        "files": [{"file": "x.ts", "status": "modified"}],
    }
    async with _async_client() as ac:
        resp = await ac.post("/v1/runs/does-not-exist-xxx/diff", json=snapshot)
    assert resp.status_code == 404


async def test_post_outcome_marks_run() -> None:
    run_id = f"test-runs-out-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id, status="active")
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.post(f"/v1/runs/{run_id}/outcome", json={"outcome": "approved"})
        assert resp.status_code == 204

        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "approved"
            assert run.ended_at is not None
    finally:
        await _cleanup_runs([run_id])
        await dispose()


async def test_post_outcome_with_feedback_sets_rejection_reason() -> None:
    run_id = f"test-runs-out-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id, status="active")
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.post(
                f"/v1/runs/{run_id}/outcome",
                json={"outcome": "rejected", "feedback": "missed the migration"},
            )
        assert resp.status_code == 204

        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "rejected"
            assert run.rejection_reason == "missed the migration"
    finally:
        await _cleanup_runs([run_id])
        await dispose()


async def test_post_feedback_updates_rejection_reason() -> None:
    run_id = f"test-runs-fb-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _insert_run(session, run_id=run_id, status="rejected")
        await session.commit()

    try:
        async with _async_client() as ac:
            resp = await ac.post(
                f"/v1/runs/{run_id}/feedback",
                json={"feedback": "later thought", "source": "manual"},
            )
        assert resp.status_code == 204

        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.rejection_reason == "later thought"
    finally:
        await _cleanup_runs([run_id])
        await dispose()

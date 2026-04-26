"""Integration tests for ``POST /v1/events``.

Drives events through the real ingestion assembler against a live Postgres.
If the DB isn't reachable, the entire module is skipped so the suite stays
green for contributors without infra running.

Uses ``httpx.AsyncClient`` with ``ASGITransport`` rather than the sync
``TestClient`` so the route handler and the verification queries share the
test's event loop (avoiding "Future attached to a different loop" hazards
when the same engine pool is touched twice).
"""

from __future__ import annotations

import asyncio
import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import delete, func, select

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.main import app
from aag.models import Artifact, Run, RunEvent


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


async def _delete_run(run_id: str) -> None:
    """Delete a run row; FK cascades remove run_events and artifacts."""
    sm = sessionmaker()
    async with sm() as session:
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def test_post_events_creates_run_row() -> None:
    run_id = f"test-events-{uuid4().hex[:8]}"
    project = f"test-events-proj-{uuid4().hex[:6]}"
    worktree = "/tmp/test-events"
    now = int(time() * 1000)
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "project": project,
                "worktree": worktree,
                "ts": now,
                "type": "session.created",
                "properties": {
                    "sessionID": run_id,
                    "info": {
                        "id": run_id,
                        "title": "demo task",
                        "directory": worktree,
                    },
                },
            }
        ]
    }

    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202, resp.text
        assert resp.json() == {"accepted": 1}

        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.run_id == run_id
            assert run.project == project
            assert run.worktree == worktree
            assert run.task == "demo task"
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_post_events_idempotent_on_event_id() -> None:
    run_id = f"test-events-{uuid4().hex[:8]}"
    now = int(time() * 1000)
    event_id = f"{run_id}-evt-dup"
    body = {
        "events": [
            {
                "event_id": event_id,
                "run_id": run_id,
                "project": "test-events",
                "worktree": "/tmp/test-events",
                "ts": now,
                "type": "session.created",
                "properties": {
                    "sessionID": run_id,
                    "info": {"id": run_id, "title": "dup", "directory": "/tmp/test-events"},
                },
            }
        ]
    }

    try:
        async with _async_client() as ac:
            r1 = await ac.post("/v1/events", json=body)
            r2 = await ac.post("/v1/events", json=body)
        assert r1.status_code == 202
        assert r2.status_code == 202
        assert r1.json() == {"accepted": 1}
        # Second batch is a no-op because (run_id, event_id) already exists.
        assert r2.json() == {"accepted": 0}

        sm = sessionmaker()
        async with sm() as session:
            count = (
                await session.execute(
                    select(func.count())
                    .select_from(RunEvent)
                    .where(RunEvent.run_id == run_id)
                    .where(RunEvent.event_id == event_id)
                )
            ).scalar_one()
            assert count == 1
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_post_events_appends_run_events() -> None:
    run_id = f"test-events-{uuid4().hex[:8]}"
    t0 = int(time() * 1000)
    t1 = t0 + 100
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "project": "test-events",
                "worktree": "/tmp/test-events",
                "ts": t0,
                "type": "session.created",
                "properties": {
                    "sessionID": run_id,
                    "info": {"id": run_id, "title": "two evts", "directory": "/tmp/test-events"},
                },
            },
            {
                "event_id": f"{run_id}-evt-002",
                "run_id": run_id,
                "ts": t1,
                "type": "tool.execute.after",
                "properties": {
                    "sessionID": run_id,
                    "tool": "edit",
                    "args": {"filePath": "src/foo.ts"},
                    "result": {},
                },
            },
        ]
    }

    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202
        assert resp.json() == {"accepted": 2}

        sm = sessionmaker()
        async with sm() as session:
            rows = (
                (
                    await session.execute(
                        select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.ts)
                    )
                )
                .scalars()
                .all()
            )
            assert len(rows) == 2
            assert rows[0].type == "session.created"
            assert rows[1].type == "tool.execute.after"
            assert rows[0].ts == t0
            assert rows[1].ts == t1
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_post_events_creates_diff_artifact_from_session_diff() -> None:
    """``session.diff`` events with a ``diff`` array create a kind='diff' artifact.

    Confirmed by reading ``aag.ingestion.assembler.apply_event_side_effects``:
    when ``ev.type == SESSION_DIFF`` and ``properties.diff`` is non-empty, an
    Artifact row is added with ``content={"files": diffs}``.
    """
    run_id = f"test-events-{uuid4().hex[:8]}"
    t0 = int(time() * 1000)
    t1 = t0 + 50

    diff_files = [
        {
            "file": "src/profile/profile.service.ts",
            "status": "modified",
            "additions": 1,
            "deletions": 0,
            "patch": "@@ -1 +1,2 @@\n+preferredName?: string;\n",
        }
    ]
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "project": "test-events",
                "worktree": "/tmp/test-events",
                "ts": t0,
                "type": "session.created",
                "properties": {
                    "sessionID": run_id,
                    "info": {"id": run_id, "title": "diff", "directory": "/tmp/test-events"},
                },
            },
            {
                "event_id": f"{run_id}-evt-002",
                "run_id": run_id,
                "ts": t1,
                "type": "session.diff",
                "properties": {
                    "sessionID": run_id,
                    "diff": diff_files,
                },
            },
        ]
    }

    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202

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
            content = arts[0].content
            assert "files" in content
            assert len(content["files"]) == 1
            assert content["files"][0]["file"] == diff_files[0]["file"]

            # files_touched aggregate updated by the assembler.
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.files_touched >= 1
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_post_events_persists_empty_session_diff() -> None:
    """Empty ``session.diff`` arrays must still create a kind='diff' artifact.

    opencode emits cumulative session.diff snapshots; an empty array after a
    non-empty one means "all prior changes were reverted". If we drop the
    empty snapshot, the dashboard's latest-snapshot view stays stuck on the
    last non-empty diff and looks like edits never went away.
    """
    run_id = f"test-events-{uuid4().hex[:8]}"
    t0 = int(time() * 1000)
    t1 = t0 + 50
    t2 = t1 + 50

    diff_files = [
        {
            "file": "meow.html",
            "status": "added",
            "additions": 1,
            "deletions": 0,
            "patch": "@@ +1 @@\n+meow\n",
        }
    ]
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "ts": t0,
                "type": "session.created",
                "properties": {
                    "sessionID": run_id,
                    "info": {"id": run_id, "title": "revert", "directory": "/tmp/x"},
                },
            },
            {
                "event_id": f"{run_id}-evt-002",
                "run_id": run_id,
                "ts": t1,
                "type": "session.diff",
                "properties": {"sessionID": run_id, "diff": diff_files},
            },
            {
                "event_id": f"{run_id}-evt-003",
                "run_id": run_id,
                "ts": t2,
                "type": "session.diff",
                "properties": {"sessionID": run_id, "diff": []},
            },
        ]
    }

    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202

        sm = sessionmaker()
        async with sm() as session:
            arts = (
                (
                    await session.execute(
                        select(Artifact)
                        .where(Artifact.run_id == run_id)
                        .where(Artifact.kind == "diff")
                        .order_by(Artifact.captured_at)
                    )
                )
                .scalars()
                .all()
            )
            assert len(arts) == 2
            assert arts[0].content == {"files": diff_files}
            assert arts[1].content == {"files": []}
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_post_events_empty_batch() -> None:
    async with _async_client() as ac:
        resp = await ac.post("/v1/events", json={"events": []})
    assert resp.status_code == 202
    assert resp.json() == {"accepted": 0}


async def test_permission_reject_does_not_terminate_run() -> None:
    """``permission.replied=reject`` no longer flips status to ``rejected``.

    The plugin files a rejection via POST /v1/runs/:id/rejections; the
    assembler should leave the run as ``active`` so the thread keeps
    streaming and the agent can recover.
    """
    run_id = f"test-events-{uuid4().hex[:8]}"
    now = int(time() * 1000)
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "ts": now,
                "type": "session.created",
                "properties": {"sessionID": run_id, "info": {"id": run_id}},
            },
            {
                "event_id": f"{run_id}-evt-002",
                "run_id": run_id,
                "ts": now + 1000,
                "type": "permission.replied",
                "properties": {"sessionID": run_id, "reply": "reject"},
            },
        ]
    }
    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202
        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "active", "permission.reject must not end the run"
            assert run.ended_at is None
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_concurrent_batches_for_same_run_dont_conflict() -> None:
    """Two POST /v1/events for the same brand-new run_id, fired in parallel,
    must both return 202 — no runs_pkey UniqueViolation.

    The plugin's fire-and-forget batcher routinely flushes two batches
    within a few ms when a new opencode session starts (session.created in
    one batch, session.idle / tool events in the next). Each request gets
    its own AsyncSession; before the fix, both would miss session.get(Run),
    both would session.add(Run(...)), and the second's autoflush would blow
    up with `duplicate key value violates unique constraint "runs_pkey"`.
    """
    run_id = f"test-events-{uuid4().hex[:8]}"
    project = f"test-events-proj-{uuid4().hex[:6]}"
    worktree = "/tmp/test-events"
    t0 = int(time() * 1000)

    def _batch(suffix: str, ts: int, ev_type: str) -> dict:
        return {
            "events": [
                {
                    "event_id": f"{run_id}-evt-{suffix}",
                    "run_id": run_id,
                    "project": project,
                    "worktree": worktree,
                    "ts": ts,
                    "type": ev_type,
                    "properties": {
                        "sessionID": run_id,
                        "info": {
                            "id": run_id,
                            "title": "concurrent",
                            "directory": worktree,
                        },
                    },
                }
            ]
        }

    try:
        async with _async_client() as ac:
            r1, r2 = await asyncio.gather(
                ac.post("/v1/events", json=_batch("001", t0, "session.created")),
                ac.post("/v1/events", json=_batch("002", t0 + 5, "session.idle")),
            )
        assert r1.status_code == 202, r1.text
        assert r2.status_code == 202, r2.text

        sm = sessionmaker()
        async with sm() as session:
            count = (
                await session.execute(
                    select(func.count()).select_from(Run).where(Run.run_id == run_id)
                )
            ).scalar_one()
            assert count == 1
            ev_count = (
                await session.execute(
                    select(func.count()).select_from(RunEvent).where(RunEvent.run_id == run_id)
                )
            ).scalar_one()
            assert ev_count == 2
    finally:
        await _delete_run(run_id)
        await dispose()


async def test_session_idle_then_activity_clears_ended_at() -> None:
    """Idle sets ``ended_at``, but a subsequent non-idle event clears it.

    Before this change, an idle marker would stick on an active run and the
    dashboard would show "Ended Xs ago" while events kept streaming in.
    """
    run_id = f"test-events-{uuid4().hex[:8]}"
    now = int(time() * 1000)
    body = {
        "events": [
            {
                "event_id": f"{run_id}-evt-001",
                "run_id": run_id,
                "ts": now,
                "type": "session.created",
                "properties": {"sessionID": run_id, "info": {"id": run_id}},
            },
            {
                "event_id": f"{run_id}-evt-002",
                "run_id": run_id,
                "ts": now + 500,
                "type": "session.idle",
                "properties": {"sessionID": run_id},
            },
        ]
    }
    try:
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body)
        assert resp.status_code == 202
        sm = sessionmaker()
        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "active"
            assert run.ended_at == now + 500

        # Now drive a permission.asked event (non-idle activity).
        body2 = {
            "events": [
                {
                    "event_id": f"{run_id}-evt-003",
                    "run_id": run_id,
                    "ts": now + 1000,
                    "type": "permission.asked",
                    "properties": {"sessionID": run_id},
                },
            ]
        }
        async with _async_client() as ac:
            resp = await ac.post("/v1/events", json=body2)
        assert resp.status_code == 202

        async with sm() as session:
            run = await session.get(Run, run_id)
            assert run is not None
            assert run.status == "active"
            assert run.ended_at is None, "non-idle activity should clear the stale idle marker"
    finally:
        await _delete_run(run_id)
        await dispose()

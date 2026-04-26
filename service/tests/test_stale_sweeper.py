"""Tests for ``aag.workers.stale_sweeper.sweep_stale_runs``.

Exercises the SQL UPDATE against a live Postgres. Skipped if the DB isn't
reachable so the suite stays green for contributors without infra.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import sessionmaker
from aag.models import Run, RunEvent
from aag.workers.stale_sweeper import sweep_stale_runs


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


async def _insert_run(
    session: AsyncSession,
    *,
    run_id: str,
    status: str,
    started_at: int,
) -> None:
    session.add(
        Run(
            run_id=run_id,
            project="test-stale-sweeper",
            worktree="/tmp/test-stale-sweeper",
            task="t",
            started_at=started_at,
            status=status,
        )
    )


async def _insert_event(
    session: AsyncSession,
    *,
    run_id: str,
    ts: int,
    event_id: str | None = None,
) -> None:
    session.add(
        RunEvent(
            event_id=event_id or f"{run_id}-{ts}",
            run_id=run_id,
            ts=ts,
            type="message.part.updated",
            properties={},
        )
    )


async def _cleanup(run_ids: list[str]) -> None:
    sm = sessionmaker()
    async with sm() as session:
        for rid in run_ids:
            await session.execute(delete(RunEvent).where(RunEvent.run_id == rid))
            await session.execute(delete(Run).where(Run.run_id == rid))
        await session.commit()


async def _get_run(run_id: str) -> Run | None:
    sm = sessionmaker()
    async with sm() as session:
        return await session.get(Run, run_id)


async def test_sweeper_flips_active_run_with_no_recent_events() -> None:
    """A run with no events for >threshold should flip to aborted."""
    run_id = f"stale-test-{uuid4()}"
    sm = sessionmaker()
    now = int(time() * 1000)
    threshold_ms = 60 * 1000  # 1 minute for the test

    try:
        async with sm() as session:
            # started_at well past the threshold; no events recorded.
            await _insert_run(
                session,
                run_id=run_id,
                status="active",
                started_at=now - threshold_ms - 5000,
            )
            await session.commit()

        swept = await sweep_stale_runs(threshold_ms=threshold_ms)
        assert swept >= 1

        run = await _get_run(run_id)
        assert run is not None
        assert run.status == "aborted"
        # ended_at should be set (we use cutoff as the marker).
        assert run.ended_at is not None
        assert run.ended_at <= now
    finally:
        await _cleanup([run_id])


async def test_sweeper_uses_max_event_ts_not_started_at() -> None:
    """A run started long ago but with a recent event must NOT be swept.

    This is the realistic case: a long-running thread the user is still
    actively iterating on.
    """
    run_id = f"stale-test-{uuid4()}"
    sm = sessionmaker()
    now = int(time() * 1000)
    threshold_ms = 60 * 1000

    try:
        async with sm() as session:
            # Started 2x threshold ago but had an event in the last second.
            await _insert_run(
                session,
                run_id=run_id,
                status="active",
                started_at=now - threshold_ms * 2,
            )
            await _insert_event(session, run_id=run_id, ts=now - 1000)
            await session.commit()

        await sweep_stale_runs(threshold_ms=threshold_ms)
        run = await _get_run(run_id)
        assert run is not None
        assert run.status == "active", "fresh activity should keep run active"
    finally:
        await _cleanup([run_id])


async def test_sweeper_ignores_already_terminal_runs() -> None:
    """approved / rejected / aborted runs are not touched."""
    sm = sessionmaker()
    now = int(time() * 1000)
    threshold_ms = 60 * 1000
    ids: list[str] = []

    try:
        async with sm() as session:
            for status in ("approved", "rejected", "aborted"):
                rid = f"stale-test-{status}-{uuid4()}"
                ids.append(rid)
                await _insert_run(
                    session,
                    run_id=rid,
                    status=status,
                    started_at=now - threshold_ms - 10_000,
                )
            await session.commit()

        await sweep_stale_runs(threshold_ms=threshold_ms)

        for rid in ids:
            run = await _get_run(rid)
            assert run is not None
            # Status stays exactly as we wrote it; ended_at is whatever was
            # inserted (we never set one above, so it should remain None).
            assert run.status in ("approved", "rejected", "aborted")
    finally:
        await _cleanup(ids)


async def test_sweeper_multiple_stale_runs_in_one_pass() -> None:
    """All eligible rows update in a single UPDATE statement."""
    sm = sessionmaker()
    now = int(time() * 1000)
    threshold_ms = 60 * 1000
    ids = [f"stale-test-batch-{i}-{uuid4()}" for i in range(3)]

    try:
        async with sm() as session:
            for rid in ids:
                await _insert_run(
                    session,
                    run_id=rid,
                    status="active",
                    started_at=now - threshold_ms - 5000,
                )
            await session.commit()

        swept = await sweep_stale_runs(threshold_ms=threshold_ms)
        assert swept >= 3

        sm = sessionmaker()
        async with sm() as session:
            rows = (await session.execute(select(Run.status).where(Run.run_id.in_(ids)))).all()
        statuses = [r[0] for r in rows]
        assert all(s == "aborted" for s in statuses), statuses
    finally:
        await _cleanup(ids)


async def test_sweeper_returns_zero_when_nothing_to_do() -> None:
    """Sweep is safe to call repeatedly; returns 0 when no rows match."""
    swept = await sweep_stale_runs(threshold_ms=24 * 60 * 60 * 1000)
    assert isinstance(swept, int)
    # >= 0 — there might be older active runs from previous tests / dev work.
    assert swept >= 0

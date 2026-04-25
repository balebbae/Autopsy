"""Tests for ``aag.graph.embeddings.write_for``.

Talks to the local Postgres assumed running per AGENTS.md (see
``contracts/db-schema.sql`` for the schema). If the DB isn't reachable,
the entire module is skipped so the suite stays green for contributors
without infra running.
"""

from __future__ import annotations

import socket
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from sqlalchemy import delete, func, select

from aag.config import get_settings
from aag.db import sessionmaker
from aag.graph.embeddings import embed, write_for
from aag.models import Embedding, Run
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


def _make_run(run_id: str, *, task: str | None = "Add user authentication") -> Run:
    return Run(
        run_id=run_id,
        project="autopsy-tests",
        worktree=None,
        task=task,
        started_at=0,
        ended_at=None,
        status="active",
    )


def _make_failure_case(
    run_id: str,
    *,
    failure_mode: str = "incomplete_schema_change",
    fix_pattern: str | None = "add migration before model change",
    change_patterns: list[str] | None = None,
    symptoms: list[Symptom] | None = None,
) -> FailureCaseOut:
    return FailureCaseOut(
        run_id=run_id,
        task_type="schema_change",
        failure_mode=failure_mode,
        fix_pattern=fix_pattern,
        components=["models/user.py"],
        change_patterns=(
            ["model_without_migration"] if change_patterns is None else change_patterns
        ),
        symptoms=(
            [Symptom(name="missing_migration", evidence=["alembic/"], confidence=0.9)]
            if symptoms is None
            else symptoms
        ),
        summary=None,
    )


async def _cleanup(run_id: str) -> None:
    sm = sessionmaker()
    async with sm() as session:
        # `embeddings` has no FK to runs; clean explicitly first.
        await session.execute(delete(Embedding).where(Embedding.entity_id == run_id))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def _insert_run(run: Run) -> None:
    sm = sessionmaker()
    async with sm() as session:
        session.add(run)
        await session.commit()


async def _embedding_rows(run_id: str) -> list[Embedding]:
    sm = sessionmaker()
    async with sm() as session:
        result = await session.execute(select(Embedding).where(Embedding.entity_id == run_id))
        return list(result.scalars().all())


async def _embedding_count(run_id: str) -> int:
    sm = sessionmaker()
    async with sm() as session:
        result = await session.execute(
            select(func.count()).select_from(Embedding).where(Embedding.entity_id == run_id)
        )
        return int(result.scalar_one())


async def test_write_for_creates_all_rows() -> None:
    run_id = f"test-embeddings-{uuid4().hex[:8]}"
    run = _make_run(run_id)
    failure = _make_failure_case(run_id)

    await _insert_run(run)
    try:
        sm = sessionmaker()
        async with sm() as session:
            await write_for(session, failure_case=failure, run=run)
            await session.commit()

        rows = await _embedding_rows(run_id)
        assert len(rows) == 4

        by_type = {r.entity_type: r for r in rows}
        assert set(by_type) == {"task", "failure", "fix", "run_summary"}
        assert by_type["task"].text == "Add user authentication"
        assert by_type["failure"].text == "incomplete_schema_change: missing_migration"
        assert by_type["fix"].text == "add migration before model change"
        assert (
            by_type["run_summary"].text
            == "Add user authentication | incomplete_schema_change | model_without_migration"
        )
        for row in rows:
            assert len(row.vector) == get_settings().embed_dim
    finally:
        await _cleanup(run_id)


async def test_write_for_skips_empty_fix_pattern() -> None:
    run_id = f"test-embeddings-{uuid4().hex[:8]}"
    run = _make_run(run_id)
    failure = _make_failure_case(run_id, fix_pattern=None)

    await _insert_run(run)
    try:
        sm = sessionmaker()
        async with sm() as session:
            await write_for(session, failure_case=failure, run=run)
            await session.commit()

        rows = await _embedding_rows(run_id)
        types = {r.entity_type for r in rows}
        assert types == {"task", "failure", "run_summary"}
        assert "fix" not in types
    finally:
        await _cleanup(run_id)


async def test_write_for_idempotent() -> None:
    run_id = f"test-embeddings-{uuid4().hex[:8]}"
    run = _make_run(run_id)
    failure_v1 = _make_failure_case(run_id, fix_pattern="first fix")
    failure_v2 = _make_failure_case(run_id, fix_pattern="second fix")

    await _insert_run(run)
    try:
        sm = sessionmaker()
        async with sm() as session:
            await write_for(session, failure_case=failure_v1, run=run)
            await session.commit()
        count_after_first = await _embedding_count(run_id)

        async with sm() as session:
            await write_for(session, failure_case=failure_v2, run=run)
            await session.commit()
        count_after_second = await _embedding_count(run_id)

        assert count_after_first == 4
        assert count_after_second == 4

        rows = await _embedding_rows(run_id)
        by_type = {r.entity_type: r for r in rows}
        assert by_type["fix"].text == "second fix"
        # vectors should reflect the second write
        expected = await embed("second fix")
        assert list(by_type["fix"].vector) == pytest.approx(expected)
    finally:
        await _cleanup(run_id)


async def test_write_for_skips_blank_task() -> None:
    run_id = f"test-embeddings-{uuid4().hex[:8]}"
    # Blank task → `task` row is skipped. With also-blank failure_mode and
    # change_patterns, run_summary joins to "" and is skipped too.
    run = _make_run(run_id, task="")
    failure = _make_failure_case(
        run_id,
        failure_mode="",
        change_patterns=[],
        symptoms=[],
        fix_pattern="some fix",
    )

    await _insert_run(run)
    try:
        sm = sessionmaker()
        async with sm() as session:
            await write_for(session, failure_case=failure, run=run)
            await session.commit()

        rows = await _embedding_rows(run_id)
        types = {r.entity_type for r in rows}
        assert "task" not in types
        assert "run_summary" not in types
        # `failure` text becomes ": " which strips to ":" — non-blank → written.
        # `fix` is non-blank → written.
        assert "fix" in types
    finally:
        await _cleanup(run_id)

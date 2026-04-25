"""Translate raw events into the runs/run_events/artifacts tables.

Pure functions over the DB session — no FastAPI, no HTTP. Called from
routes.events on every batch.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from aag.models import Artifact, Run, RunEvent
from aag.schemas.events import EventIn

# opencode event names we care about for run-level state transitions.
SESSION_CREATED = "session.created"
SESSION_UPDATED = "session.updated"
SESSION_IDLE = "session.idle"
SESSION_DIFF = "session.diff"
TOOL_AFTER = "tool.execute.after"
PERMISSION_REPLIED = "permission.replied"


async def upsert_run(session: AsyncSession, ev: EventIn) -> Run:
    """Ensure a runs row exists; populate from session.created when possible."""
    existing = await session.get(Run, ev.run_id)
    if existing is not None:
        if ev.type == SESSION_CREATED:
            info = ev.properties.get("info") or {}
            existing.task = existing.task or info.get("title")
            existing.worktree = existing.worktree or info.get("directory") or ev.worktree
        return existing

    info = ev.properties.get("info") or {}
    run = Run(
        run_id=ev.run_id,
        project=ev.project,
        worktree=ev.worktree or info.get("directory"),
        task=info.get("title"),
        started_at=ev.ts,
        status="active",
    )
    session.add(run)
    return run


async def insert_event(session: AsyncSession, ev: EventIn) -> bool:
    """Idempotent insert on (run_id, event_id). Returns True if new."""
    stmt = (
        pg_insert(RunEvent)
        .values(
            event_id=ev.event_id,
            run_id=ev.run_id,
            ts=ev.ts,
            type=ev.type,
            properties=ev.properties,
        )
        .on_conflict_do_nothing(index_elements=["run_id", "event_id"])
        .returning(RunEvent.id)
    )
    result = await session.execute(stmt)
    return result.first() is not None


async def apply_event_side_effects(session: AsyncSession, ev: EventIn) -> None:
    """Update aggregates on the runs row + persist diffs as artifacts."""
    run = await session.get(Run, ev.run_id)
    if run is None:
        return

    if ev.type == TOOL_AFTER:
        run.tool_calls += 1
        diff = (ev.properties.get("result") or {}).get("diff")
        if diff:
            session.add(
                Artifact(
                    run_id=ev.run_id,
                    kind="diff",
                    captured_at=ev.ts,
                    content=diff,
                )
            )
            run.files_touched += 1

    elif ev.type == SESSION_DIFF:
        diffs = ev.properties.get("diff") or []
        if diffs:
            session.add(
                Artifact(
                    run_id=ev.run_id,
                    kind="diff",
                    captured_at=ev.ts,
                    content={"files": diffs},
                )
            )
            run.files_touched = max(run.files_touched, len(diffs))

    elif ev.type == PERMISSION_REPLIED and ev.properties.get("reply") == "reject":
        run.status = "rejected"
        run.ended_at = run.ended_at or ev.ts

    elif ev.type == SESSION_IDLE and run.status == "active":
        run.ended_at = run.ended_at or ev.ts


async def list_run_events(session: AsyncSession, run_id: str) -> list[RunEvent]:
    stmt = select(RunEvent).where(RunEvent.run_id == run_id).order_by(RunEvent.ts)
    return list((await session.execute(stmt)).scalars())


async def list_run_artifacts(
    session: AsyncSession, run_id: str, kind: str | None = None
) -> list[Artifact]:
    stmt = select(Artifact).where(Artifact.run_id == run_id)
    if kind is not None:
        stmt = stmt.where(Artifact.kind == kind)
    stmt = stmt.order_by(Artifact.captured_at)
    return list((await session.execute(stmt)).scalars())


def event_to_dict(ev: RunEvent) -> dict[str, Any]:
    return {
        "event_id": ev.event_id,
        "run_id": ev.run_id,
        "ts": ev.ts,
        "type": ev.type,
        "properties": ev.properties,
    }

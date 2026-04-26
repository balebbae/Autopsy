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
        # Persist *every* session.diff snapshot, including empty ones. opencode
        # emits cumulative diffs (relative to session start), so an empty
        # snapshot after a non-empty one means "all prior changes were
        # reverted". Dropping empties left the dashboard showing stale state.
        session.add(
            Artifact(
                run_id=ev.run_id,
                kind="diff",
                captured_at=ev.ts,
                content={"files": diffs},
            )
        )
        if diffs:
            run.files_touched = max(run.files_touched, len(diffs))

    elif ev.type == SESSION_IDLE and run.status == "active":
        # Mark the *current* idle time, but never as a terminal end. The
        # plugin / dashboard explicitly call /v1/runs/:id/outcome to end a
        # run; opencode's session.idle is just "no activity right now" and
        # frequently un-idles when the user sends another message. We
        # overwrite (not "or") so a fresher idle replaces the stale one,
        # and any non-idle event below clears it.
        run.ended_at = ev.ts

    # Any non-idle event on an active run means the thread is doing work
    # again — wipe the previous idle marker so the dashboard doesn't keep
    # showing "Ended Xs ago" while events are still streaming in.
    if run.status == "active" and ev.type != SESSION_IDLE and run.ended_at is not None:
        run.ended_at = None

    # Note: permission.replied=reject is *not* terminal anymore. The plugin
    # files a rejection via POST /v1/runs/:id/rejections (which records the
    # row, bumps rejection_count, and triggers the analyzer) without
    # changing run.status. The thread keeps streaming so the agent can
    # recover from the failure.


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

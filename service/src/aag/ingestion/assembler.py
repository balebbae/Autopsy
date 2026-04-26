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
# Plugin-emitted synthetic event for explicitly setting the run's display name.
# Properties: { task: str, force?: bool }
AUTOPSY_TASK_SET = "autopsy.task.set"

# Max length of a derived task name from a user message.
_TASK_NAME_MAX_LEN = 120


def _is_placeholder_task(task: str | None) -> bool:
    """opencode's default session title is 'New session - <ISO timestamp>'."""
    if not task:
        return True
    t = task.strip()
    return not t or t.lower().startswith("new session")


def _derive_task_name(text: str) -> str:
    """First line, truncated, suitable for the runs table."""
    first_line = text.splitlines()[0].strip()
    if len(first_line) <= _TASK_NAME_MAX_LEN:
        return first_line
    return first_line[: _TASK_NAME_MAX_LEN - 1].rstrip() + "…"


async def upsert_run(session: AsyncSession, ev: EventIn) -> Run:
    """Ensure a runs row exists; populate from session.created when possible.

    Also refreshes the task name from later events:
      - session.updated: pick up opencode's auto-generated title
      - autopsy.task.set: explicit task name from the plugin

    Concurrency: the plugin batches events fire-and-forget, so two POST
    /v1/events for the same run_id can be in flight simultaneously. Each
    request gets its own AsyncSession; a naive ORM check-then-add races at
    autoflush time and one side blows up with runs_pkey UniqueViolation. We
    use INSERT ... ON CONFLICT DO NOTHING for the first-write so Postgres
    serializes the conflict, then session.get to load the row (ours or the
    one the concurrent txn just committed) for the field-merge updates.
    """
    existing = await session.get(Run, ev.run_id)
    if existing is None:
        info = ev.properties.get("info") or {}
        # If an autopsy.task.set arrives before session.created, still record
        # the task so the dashboard never displays a missing/placeholder name.
        initial_task: str | None = info.get("title")
        if ev.type == AUTOPSY_TASK_SET:
            candidate = ev.properties.get("task")
            if isinstance(candidate, str) and candidate.strip():
                initial_task = _derive_task_name(candidate)
        await session.execute(
            pg_insert(Run)
            .values(
                run_id=ev.run_id,
                project=ev.project,
                worktree=ev.worktree or info.get("directory"),
                task=initial_task,
                started_at=ev.ts,
                status="active",
            )
            .on_conflict_do_nothing(index_elements=["run_id"])
        )
        existing = await session.get(Run, ev.run_id)
        if existing is None:
            # Should be impossible: we just inserted (or it pre-existed
            # under a concurrent txn that's now visible to us).
            raise RuntimeError(f"upsert_run: failed to load run {ev.run_id}")

    if ev.type == SESSION_CREATED:
        info = ev.properties.get("info") or {}
        existing.task = existing.task or info.get("title")
        existing.worktree = existing.worktree or info.get("directory") or ev.worktree
    elif ev.type == SESSION_UPDATED:
        info = ev.properties.get("info") or {}
        new_title = info.get("title")
        # Refresh title if opencode generated a real one (non-placeholder).
        if new_title and not _is_placeholder_task(new_title):
            existing.task = new_title
    elif ev.type == AUTOPSY_TASK_SET:
        new_task = ev.properties.get("task")
        if isinstance(new_task, str) and new_task.strip():
            # `force=True` means this came from a high-fidelity source
            # (e.g. opencode's auto-generated session.title) — always
            # override. Otherwise only upgrade away from a placeholder.
            forced = bool(ev.properties.get("force"))
            if forced or _is_placeholder_task(existing.task):
                existing.task = _derive_task_name(new_task)
    return existing


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

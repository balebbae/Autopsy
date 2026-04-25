"""Runs CRUD + diff + outcome + feedback."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from aag.deps import SessionDep
from aag.ingestion import assembler
from aag.models import Artifact, FailureCase, Run
from aag.schemas import (
    DiffSnapshot,
    FailureCaseOut,
    OutcomeIn,
    RunOut,
    RunSummary,
    Symptom,
)
from aag.schemas.events import EventIn
from aag.schemas.runs import FeedbackIn

router = APIRouter()


def _normalize_diff_files(content: dict) -> list[dict]:
    """Diff artifacts come from two shapes:

    1. session.diff:        {"files": [{file, status, additions, deletions, patch}]}
    2. tool.execute.after:  {"path": ..., "oldText": ..., "newText": ...}

    Normalize both to the AAG DiffSnapshotFile shape.
    """
    if "files" in content:
        return list(content["files"])
    if "path" in content:
        return [
            {
                "file": content["path"],
                "status": "modified",
                "patch": None,
            }
        ]
    return []


def _summary_from(run: Run) -> RunSummary:
    return RunSummary(
        run_id=run.run_id,
        project=run.project,
        worktree=run.worktree,
        started_at=run.started_at,
        ended_at=run.ended_at,
        status=run.status,  # type: ignore[arg-type]
        task=run.task,
        rejection_reason=run.rejection_reason,
        files_touched=run.files_touched,
        tool_calls=run.tool_calls,
    )


@router.get("/runs", response_model=list[RunSummary])
async def list_runs(
    session: SessionDep,
    project: str | None = Query(None),
    status_filter: str | None = Query(None, alias="status"),
    limit: int = Query(50, le=200),
) -> list[RunSummary]:
    stmt = select(Run).order_by(Run.started_at.desc()).limit(limit)
    if project is not None:
        stmt = stmt.where(Run.project == project)
    if status_filter is not None:
        stmt = stmt.where(Run.status == status_filter)
    runs = (await session.execute(stmt)).scalars()
    return [_summary_from(r) for r in runs]


@router.get("/runs/{run_id}", response_model=RunOut)
async def get_run(run_id: str, session: SessionDep) -> RunOut:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")

    events = await assembler.list_run_events(session, run_id)
    diffs_raw = await assembler.list_run_artifacts(session, run_id, kind="diff")
    fc = await session.get(FailureCase, run_id)

    diffs: list[DiffSnapshot] = []
    for a in diffs_raw:
        files = _normalize_diff_files(a.content or {})
        diffs.append(DiffSnapshot.model_validate({"captured_at": a.captured_at, "files": files}))

    failure = (
        FailureCaseOut(
            run_id=fc.run_id,
            task_type=fc.task_type,
            failure_mode=fc.failure_mode,
            fix_pattern=fc.fix_pattern,
            components=list(fc.components or []),
            change_patterns=list(fc.change_patterns or []),
            symptoms=[Symptom.model_validate(s) for s in (fc.symptoms or [])],
            summary=fc.summary,
        )
        if fc is not None
        else None
    )

    return RunOut(
        **_summary_from(run).model_dump(),
        events=[EventIn(**assembler.event_to_dict(e)) for e in events],
        diffs=diffs,
        failure_case=failure,
    )


@router.post("/runs/{run_id}/diff", status_code=status.HTTP_204_NO_CONTENT)
async def attach_diff(run_id: str, snapshot: DiffSnapshot, session: SessionDep) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    session.add(
        Artifact(
            run_id=run_id,
            kind="diff",
            captured_at=snapshot.captured_at or 0,
            content={"files": [f.model_dump() for f in snapshot.files]},
        )
    )
    run.files_touched = max(run.files_touched, len(snapshot.files))
    await session.commit()


@router.post("/runs/{run_id}/outcome", status_code=status.HTTP_204_NO_CONTENT)
async def post_outcome(run_id: str, body: OutcomeIn, session: SessionDep) -> None:
    """Mark the final outcome of a run.

    Triggering the analyzer is intentionally lazy here — R3 wires
    `aag.workers.finalizer.on_run_complete(run_id)` to be awaited or
    scheduled (asyncio.create_task) once analyzer/graph are ready.
    """
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    run.status = body.outcome
    if body.feedback:
        run.rejection_reason = body.feedback
    if run.ended_at is None:
        from time import time

        run.ended_at = int(time() * 1000)
    await session.commit()

    # R3: hook the finalizer here.
    # from aag.workers.finalizer import on_run_complete
    # await on_run_complete(run_id)


@router.post("/runs/{run_id}/feedback", status_code=status.HTTP_204_NO_CONTENT)
async def post_feedback(run_id: str, body: FeedbackIn, session: SessionDep) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    run.rejection_reason = body.feedback
    await session.commit()

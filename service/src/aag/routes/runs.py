"""Runs CRUD + diff + outcome + feedback."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import case, func, select

from aag.deps import SessionDep
from aag.ingestion import assembler
from aag.models import Artifact, FailureCase, PreflightHit, Rejection, Run
from aag.schemas import (
    DiffSnapshot,
    FailureCaseOut,
    OutcomeIn,
    PreflightHitOut,
    RejectionIn,
    RejectionOut,
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


def _summary_from(
    run: Run,
    *,
    preflight_hit_count: int = 0,
    preflight_blocked_count: int = 0,
) -> RunSummary:
    return RunSummary(
        run_id=run.run_id,
        project=run.project,
        worktree=run.worktree,
        started_at=run.started_at,
        ended_at=run.ended_at,
        status=run.status,  # type: ignore[arg-type]
        task=run.task,
        rejection_reason=run.rejection_reason,
        rejection_count=run.rejection_count or 0,
        files_touched=run.files_touched,
        tool_calls=run.tool_calls,
        preflight_hit_count=preflight_hit_count,
        preflight_blocked_count=preflight_blocked_count,
    )


def _rejection_to_out(r: Rejection) -> RejectionOut:
    return RejectionOut(
        id=r.id,
        run_id=r.run_id,
        ts=r.ts,
        reason=r.reason,
        failure_mode=r.failure_mode,
        symptoms=r.symptoms,
        source=r.source,  # type: ignore[arg-type]
    )


def _preflight_hit_to_out(h: PreflightHit) -> PreflightHitOut:
    return PreflightHitOut(
        id=h.id,
        run_id=h.run_id,
        ts=h.ts,
        task=h.task,
        risk_level=h.risk_level,  # type: ignore[arg-type]
        top_failure_score=h.top_failure_score,
        blocked=h.blocked,
        tool=h.tool,
        args=h.args,
        similar_runs=list(h.similar_runs or []),
        top_failure_modes=list(h.top_failure_modes or []),
        top_fix_patterns=list(h.top_fix_patterns or []),
        addendum=h.addendum,
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
    runs = list((await session.execute(stmt)).scalars())
    if not runs:
        return []

    # Single GROUP BY to avoid an N+1 over preflight_hits when rendering the
    # runs overview (which wants the green "Autopsy fired" badge per row).
    run_ids = [r.run_id for r in runs]
    pf_rows = (
        await session.execute(
            select(
                PreflightHit.run_id,
                func.count(PreflightHit.id).label("hits"),
                func.sum(case((PreflightHit.blocked.is_(True), 1), else_=0)).label("blocked"),
            )
            .where(PreflightHit.run_id.in_(run_ids))
            .group_by(PreflightHit.run_id)
        )
    ).all()
    counts: dict[str, tuple[int, int]] = {
        row.run_id: (int(row.hits or 0), int(row.blocked or 0)) for row in pf_rows
    }

    return [
        _summary_from(
            r,
            preflight_hit_count=counts.get(r.run_id, (0, 0))[0],
            preflight_blocked_count=counts.get(r.run_id, (0, 0))[1],
        )
        for r in runs
    ]


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

    rejections_raw = (
        await session.execute(
            select(Rejection).where(Rejection.run_id == run_id).order_by(Rejection.ts)
        )
    ).scalars()
    rejections = [_rejection_to_out(r) for r in rejections_raw]

    hits_raw = list(
        (
            await session.execute(
                select(PreflightHit).where(PreflightHit.run_id == run_id).order_by(PreflightHit.ts)
            )
        ).scalars()
    )
    preflight_hits = [_preflight_hit_to_out(h) for h in hits_raw]
    blocked_count = sum(1 for h in hits_raw if h.blocked)

    summary = _summary_from(
        run,
        preflight_hit_count=len(preflight_hits),
        preflight_blocked_count=blocked_count,
    )
    return RunOut(
        **summary.model_dump(),
        events=[EventIn(**assembler.event_to_dict(e)) for e in events],
        diffs=diffs,
        failure_case=failure,
        rejections=rejections,
        preflight_hits=preflight_hits,
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

    from aag.workers.finalizer import on_run_complete

    await on_run_complete(run_id)


@router.post("/runs/{run_id}/feedback", status_code=status.HTTP_204_NO_CONTENT)
async def post_feedback(run_id: str, body: FeedbackIn, session: SessionDep) -> None:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    run.rejection_reason = body.feedback
    await session.commit()


@router.get("/runs/{run_id}/rejections", response_model=list[RejectionOut])
async def list_rejections(run_id: str, session: SessionDep) -> list[RejectionOut]:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    rows = (
        await session.execute(
            select(Rejection).where(Rejection.run_id == run_id).order_by(Rejection.ts)
        )
    ).scalars()
    return [_rejection_to_out(r) for r in rows]


@router.post(
    "/runs/{run_id}/rejections",
    response_model=RejectionOut,
    status_code=status.HTTP_201_CREATED,
)
async def post_rejection(run_id: str, body: RejectionIn, session: SessionDep) -> RejectionOut:
    """Record a rejection (filed failure) on a still-active run.

    Unlike `/outcome`, this endpoint does NOT terminate the thread or set
    `ended_at`. The run keeps accumulating events; the dashboard renders
    each rejection as a distinct entry on the timeline. The latest rejection
    reason is mirrored onto `Run.rejection_reason` for back-compat.
    """
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")

    from time import time

    ts = body.ts if body.ts is not None else int(time() * 1000)
    row = Rejection(
        run_id=run_id,
        ts=ts,
        reason=body.reason,
        failure_mode=body.failure_mode,
        symptoms=body.symptoms,
        source=body.source,
    )
    session.add(row)

    # Atomic increment via SQL expression to avoid read-modify-write races
    # when multiple rejections land near-concurrently on the same run.
    run.rejection_count = Run.rejection_count + 1  # type: ignore[assignment]
    run.rejection_reason = body.reason
    await session.commit()
    await session.refresh(row)
    await session.refresh(run)

    # Per-rejection analyzer + graph write. Run as a background task so the
    # plugin's fire-and-forget POST returns 201 immediately — gemma + graph
    # write can take several seconds and we don't want to block on them.
    # Failures inside the task are logged by the worker itself.
    import asyncio

    from aag.workers.finalizer import on_rejection_filed

    asyncio.create_task(on_rejection_filed(run_id, reason=body.reason))

    return _rejection_to_out(row)

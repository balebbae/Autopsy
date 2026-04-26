"""Run-end → analyzer → graph writer → embedder.

Called from aag.routes.runs.post_outcome after the run status is committed.
Uses its own session so the analysis is independent of the request transaction.
"""

from __future__ import annotations

import logging

from aag.analyzer import classifier
from aag.analyzer.extractor import extract
from aag.db import sessionmaker
from aag.graph import embeddings as gembed
from aag.graph import writer as gwriter
from aag.models import FailureCase, Run
from aag.schemas.runs import FailureCaseOut

log = logging.getLogger(__name__)


def _failure_case_row(fc: FailureCaseOut) -> FailureCase:
    """Build a `FailureCase` ORM row from a classifier `FailureCaseOut`.

    Centralized so the finalizer + per-rejection paths can't drift on
    the column list.
    """
    return FailureCase(
        run_id=fc.run_id,
        task_type=fc.task_type,
        failure_mode=fc.failure_mode,
        fix_pattern=fc.fix_pattern,
        components=fc.components,
        change_patterns=fc.change_patterns,
        symptoms=[s.model_dump() for s in fc.symptoms],
        summary=fc.summary,
    )


async def on_rejection_filed(run_id: str, *, reason: str) -> None:
    """Per-rejection analyzer + graph write.

    Unlike `on_run_complete`, this fires while the thread is still active —
    the run is NOT terminated. The classifier is forced into the 'rejected'
    code path so the rejection rule and reason are used as evidence even
    though Run.status is still 'active'.

    The aggregate FailureCase row is upserted to reflect the latest
    classification snapshot. Graph edges are upserted idempotently.

    Designed to be fire-and-forget (called via `asyncio.create_task`), so any
    uncaught exception is logged here rather than bubbling into the asyncio
    "task exception was never retrieved" warning.
    """
    try:
        async with sessionmaker()() as session:
            try:
                ctx, fc = await classifier.classify(
                    session,
                    run_id,
                    force_rejected=True,
                    rejection_reason_override=reason,
                )
            except Exception:  # noqa: BLE001
                log.exception("run %s: classifier failed for rejection", run_id)
                return

            if ctx is None or fc is None:
                log.info("run %s: rejection filed but no classification produced", run_id)
                return

            await session.merge(_failure_case_row(fc))

            try:
                run = await session.get(Run, run_id)
                if run is not None:
                    extraction = extract(ctx, fc)
                    await gwriter.write(session, run=run, failure_case=fc, extraction=extraction)
                    await gembed.write_for(session, failure_case=fc, run=run, extraction=extraction)
            except Exception:  # noqa: BLE001
                log.exception("run %s: graph/embedding step failed for rejection", run_id)
                await session.rollback()
                await session.merge(_failure_case_row(fc))

            await session.commit()
            log.info("run %s: rejection classified as %s", run_id, fc.failure_mode)
    except Exception:  # noqa: BLE001
        log.exception("run %s: unhandled error in on_rejection_filed", run_id)


async def on_run_complete(run_id: str) -> None:
    async with sessionmaker()() as session:
        try:
            ctx, fc = await classifier.classify(session, run_id)
        except Exception:  # noqa: BLE001
            log.exception("run %s: classifier failed", run_id)
            return

        if ctx is None:
            log.info("run %s: not found", run_id)
            return
        if fc is None:
            log.info("run %s: no failure symptoms detected", run_id)
            return

        # Persist FailureCase.
        await session.merge(_failure_case_row(fc))

        # Graph + embeddings — separated so a failure in one doesn't block the other.
        run = await session.get(Run, run_id)
        if run is not None:
            extraction = extract(ctx, fc)
            try:
                await gwriter.write(session, run=run, failure_case=fc, extraction=extraction)
                await session.flush()
            except Exception:  # noqa: BLE001
                log.exception("run %s: graph writer failed", run_id)
                await session.rollback()
                await session.merge(_failure_case_row(fc))
            try:
                await gembed.write_for(session, failure_case=fc, run=run, extraction=extraction)
            except Exception:  # noqa: BLE001
                log.exception("run %s: embedding step failed (graph still saved)", run_id)

        await session.commit()

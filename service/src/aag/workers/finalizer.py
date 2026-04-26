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

log = logging.getLogger(__name__)


def _failure_case_row(fc) -> FailureCase:  # type: ignore[no-untyped-def]
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


async def on_run_complete(run_id: str) -> None:
    """Classify a finalized run, then write FailureCase, graph evidence, and
    embeddings as **three independent transactions**.

    Splitting the writes ensures a failure in a later step (most commonly the
    embeddings step missing its optional ML deps) cannot roll back the work
    of an earlier step. Graph evidence in particular must survive an
    embeddings failure so the dashboard's per-run failure-graph view stays
    populated.
    """
    sm = sessionmaker()

    # 1) Classify (read-only) and persist FailureCase.
    async with sm() as session:
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

        await session.merge(_failure_case_row(fc))
        await session.commit()

    # 2) Graph evidence. Independent transaction: failures here do not
    # affect the FailureCase row already committed above, and successes
    # here are not undone by a later embeddings failure.
    async with sm() as session:
        try:
            run = await session.get(Run, run_id)
            if run is not None:
                extraction = extract(ctx, fc)
                await gwriter.write(session, run=run, failure_case=fc, extraction=extraction)
                await session.commit()
        except Exception:  # noqa: BLE001
            log.exception("run %s: graph write failed", run_id)
            await session.rollback()

    # 3) Embeddings. Best-effort: never propagate failures.
    async with sm() as session:
        try:
            run = await session.get(Run, run_id)
            if run is not None:
                await gembed.write_for(session, failure_case=fc, run=run)
                await session.commit()
        except Exception:  # noqa: BLE001
            log.exception("run %s: embeddings write failed (non-fatal)", run_id)
            await session.rollback()

    log.info("run %s: classified as %s", run_id, fc.failure_mode)

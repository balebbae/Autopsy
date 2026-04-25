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
        row = FailureCase(
            run_id=fc.run_id,
            task_type=fc.task_type,
            failure_mode=fc.failure_mode,
            fix_pattern=fc.fix_pattern,
            components=fc.components,
            change_patterns=fc.change_patterns,
            symptoms=[s.model_dump() for s in fc.symptoms],
            summary=fc.summary,
        )
        await session.merge(row)

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
                row = FailureCase(
                    run_id=fc.run_id,
                    task_type=fc.task_type,
                    failure_mode=fc.failure_mode,
                    fix_pattern=fc.fix_pattern,
                    components=fc.components,
                    change_patterns=fc.change_patterns,
                    symptoms=[s.model_dump() for s in fc.symptoms],
                    summary=fc.summary,
                )
                await session.merge(row)
            try:
                await gembed.write_for(session, failure_case=fc, run=run)
            except Exception:  # noqa: BLE001
                log.exception("run %s: embedding step failed (graph still saved)", run_id)

        await session.commit()
        log.info("run %s: classified as %s", run_id, fc.failure_mode)

"""Run-end → analyzer → graph writer → embedder.

Called from aag.routes.runs.post_outcome after the run status is committed.
Uses its own session so the analysis is independent of the request transaction.
"""

from __future__ import annotations

import logging

from aag.analyzer.classifier import classify
from aag.db import sessionmaker
from aag.models import FailureCase

log = logging.getLogger(__name__)


async def on_run_complete(run_id: str) -> None:
    async with sessionmaker()() as session:
        fc = await classify(session, run_id)
        if fc is None:
            log.info("run %s: no failure symptoms detected", run_id)
            return

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
        await session.commit()
        log.info("run %s: classified as %s", run_id, fc.failure_mode)

        # TODO(R3): graph writer + embeddings
        # await graph.writer.write(session, fc, extraction)
        # await graph.embeddings.write_for(session, fc)

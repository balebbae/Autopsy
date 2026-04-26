"""Stale-run sweeper.

Defense-in-depth for the case where the plugin lost the race and never
posted a final outcome. Examples:

  - opencode was force-killed (SIGKILL, terminal closed, laptop crashed)
    before it could emit ``server.instance.disposed``.
  - The plugin emitted the event but the service was offline at that
    moment and the fire-and-forget POST landed in /dev/null.
  - The plugin process itself crashed before flushing.

In all of these the run sits in ``status='active'`` forever, the dashboard
keeps rendering "Live", and the autopsy graph never gets the run-end signal
to dedupe noisy past-runs from new preflight queries.

This sweeper runs in-process as an asyncio task spawned from
``aag.main.lifespan``. Once a minute (default) it runs a single SQL
``UPDATE`` that flips every ``active`` run with no recent events to
``aborted``. We intentionally do **not** trigger the analyzer
(``on_run_complete``) — by definition we're flipping these runs late and
the per-rejection analyzer chain has already produced any useful failure
cases during the run itself.
"""

from __future__ import annotations

import asyncio
import logging
from time import time

from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError

from aag.db import sessionmaker
from aag.models import Run, RunEvent

log = logging.getLogger(__name__)

# Defaults match `Settings` so tests / callers that bypass the lifespan
# get the same numbers as production. Keep these in sync.
DEFAULT_THRESHOLD_MS = 30 * 60 * 1000  # 30 min
DEFAULT_INTERVAL_MS = 60 * 1000  # 1 min


async def sweep_stale_runs(threshold_ms: int = DEFAULT_THRESHOLD_MS) -> int:
    """Flip every ``active`` run with no recent events to ``aborted``.

    "Recent" means we observed an event for the run more recently than
    ``now - threshold_ms``. Runs with no events at all (just a row from
    the very first ingest call) fall back to ``runs.started_at`` so a
    fully empty stuck run still gets cleaned up.

    Returns the number of rows updated. Caller logs.
    """
    cutoff = int(time() * 1000) - threshold_ms

    # We compute "last activity" as MAX(run_events.ts) joined to runs,
    # falling back to ``runs.started_at`` when the run has zero events.
    # `runs.ended_at` is unreliable here because the assembler clears it
    # on any non-idle event mid-run, so a chatty active run would always
    # appear ``ended_at IS NULL``.
    last_event_subq = (
        select(
            RunEvent.run_id,
            func.max(RunEvent.ts).label("last_ts"),
        )
        .group_by(RunEvent.run_id)
        .subquery()
    )

    # NB: SQLAlchemy 2.x correlated update with LEFT JOIN expressed via
    # scalar subquery so the UPDATE...FROM stays well-formed across
    # postgres minor versions. Reads cleaner as a CTE if you need to
    # debug it.
    last_ts_for_run = (
        select(func.coalesce(last_event_subq.c.last_ts, Run.started_at))
        .where(last_event_subq.c.run_id == Run.run_id)
        .correlate(Run)
        .scalar_subquery()
    )

    stmt = (
        update(Run)
        .where(Run.status == "active")
        .where(
            func.coalesce(
                last_ts_for_run,
                Run.started_at,
            )
            < cutoff
        )
        .values(status="aborted", ended_at=cutoff)
    )

    sm = sessionmaker()
    async with sm() as session:
        try:
            result = await session.execute(stmt)
            await session.commit()
        except SQLAlchemyError:
            log.exception("stale_sweeper: UPDATE failed; rolling back")
            await session.rollback()
            return 0
    swept = result.rowcount or 0
    if swept:
        log.info("stale_sweeper: flipped %d active run(s) to aborted", swept)
    return swept


async def run_periodic(
    *,
    threshold_ms: int = DEFAULT_THRESHOLD_MS,
    interval_ms: int = DEFAULT_INTERVAL_MS,
) -> None:
    """Long-running task: sweep on a fixed interval until cancelled.

    This is the entry point spawned from ``aag.main.lifespan``. The task
    is cancelled on shutdown (``CancelledError`` is allowed to propagate).
    All other exceptions are caught and logged so a transient DB blip
    doesn't kill the sweeper for the rest of the process lifetime.
    """
    log.info(
        "stale_sweeper: starting (threshold=%dms interval=%dms)",
        threshold_ms,
        interval_ms,
    )
    # Sleep first so a freshly-booted service doesn't sweep before the
    # plugin has had a chance to send any events. Also gives the lifespan
    # init_schema call a clean window to finish.
    while True:
        try:
            await asyncio.sleep(interval_ms / 1000)
            await sweep_stale_runs(threshold_ms)
        except asyncio.CancelledError:
            log.info("stale_sweeper: cancelled, exiting")
            raise
        except Exception:  # noqa: BLE001
            # Never propagate — we want the sweeper to outlive transient
            # DB outages or anything else weird.
            log.exception("stale_sweeper: tick failed; will retry next interval")

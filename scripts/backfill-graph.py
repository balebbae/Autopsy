#!/usr/bin/env python3
"""Re-finalize every run that doesn't yet have failure-graph evidence.

Use this after fixing a finalizer regression (e.g. embeddings rollback) to
backfill graph nodes/edges for runs that were classified but lost their
graph writes. Idempotent — safe to re-run.

Usage:
    cd service && uv run python ../scripts/backfill-graph.py [--all]

By default we only retrigger runs whose status is rejected/approved/aborted
AND have zero graph_edges with evidence_run_id == run_id. Pass --all to
retrigger every finalized run regardless of current evidence.
"""

from __future__ import annotations

import asyncio
import sys

from sqlalchemy import delete, select

from aag.db import sessionmaker
from aag.models import GraphEdge, GraphNode, Run
from aag.workers.finalizer import on_run_complete

FINALIZED = ("rejected", "approved", "aborted")


async def main(force_all: bool = False) -> int:
    sm = sessionmaker()
    async with sm() as session:
        runs = (await session.execute(select(Run).where(Run.status.in_(FINALIZED)))).scalars().all()
        if not force_all:
            with_evidence = {
                r
                for (r,) in (
                    await session.execute(
                        select(GraphEdge.evidence_run_id).where(
                            GraphEdge.evidence_run_id.is_not(None)
                        )
                    )
                ).all()
            }
            target_ids = [r.run_id for r in runs if r.run_id not in with_evidence]
        else:
            target_ids = [r.run_id for r in runs]

    if not target_ids:
        print("nothing to backfill — every finalized run already has graph evidence")
        return 0

    print(f"backfilling {len(target_ids)} run(s)…")
    for rid in target_ids:
        print(f"  → {rid} (wiping previous evidence first)")
        # Delete all graph evidence attributed to this run before re-writing,
        # so re-runs are idempotent (replace) rather than additive (append).
        async with sm() as session:
            await session.execute(
                delete(GraphEdge).where(GraphEdge.evidence_run_id == rid)
            )
            await session.execute(
                delete(GraphNode).where(GraphNode.id == f"Run:{rid}")
            )
            await session.commit()
        try:
            await on_run_complete(rid)
        except Exception as exc:  # noqa: BLE001
            print(f"    !! failed: {exc!r}", file=sys.stderr)
    print("done.")
    return 0


if __name__ == "__main__":
    force_all = "--all" in sys.argv[1:]
    raise SystemExit(asyncio.run(main(force_all=force_all)))

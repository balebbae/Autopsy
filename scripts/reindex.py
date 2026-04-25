#!/usr/bin/env python3
"""Re-run the finalizer pipeline (classify → graph writer → embed) for
every existing run that has a ``failure_cases`` row.

Idempotent thanks to the upserts in writer.py and embeddings.py:

  - graph nodes upsert on ``id``
  - graph edges upsert on ``(source_id, target_id, type, evidence_run_id)``
  - embeddings upsert on ``(entity_type, entity_id)``

Use after improving the classifier or extending the embedding surface
(Phase 4 added ``patch`` / ``error`` rows; running this script
backfills them for runs that were finalized under the old pipeline).

Usage:
    cd service && uv run python ../scripts/reindex.py
    cd service && uv run python ../scripts/reindex.py --only-missing
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import select, text

from aag.db import dispose, sessionmaker
from aag.models import Embedding, FailureCase
from aag.workers.finalizer import on_run_complete


async def _count_embeddings() -> int:
    sm = sessionmaker()
    async with sm() as session:
        return int(
            (await session.execute(text("SELECT COUNT(*) FROM embeddings"))).scalar_one()
        )


async def _runs_to_reindex(only_missing: bool) -> list[str]:
    sm = sessionmaker()
    async with sm() as session:
        if only_missing:
            # Runs that have a FailureCase but no `task` embedding row.
            sql = text(
                """
                SELECT fc.run_id
                FROM failure_cases fc
                LEFT JOIN embeddings e
                    ON e.entity_type = 'task' AND e.entity_id = fc.run_id
                WHERE e.entity_id IS NULL
                ORDER BY fc.created_at
                """
            )
            rows = (await session.execute(sql)).all()
            return [r[0] for r in rows]

        rows = (
            await session.execute(select(FailureCase.run_id).order_by(FailureCase.created_at))
        ).all()
        return [r[0] for r in rows]


async def main(only_missing: bool) -> None:
    before = await _count_embeddings()
    run_ids = await _runs_to_reindex(only_missing)
    print(f"reindexing {len(run_ids)} runs (only_missing={only_missing})")
    print(f"embeddings before: {before}")

    failures = 0
    for i, run_id in enumerate(run_ids, 1):
        try:
            await on_run_complete(run_id)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"[{i}/{len(run_ids)}] {run_id}: FAILED ({exc})")
            continue
        if i % 20 == 0 or i == len(run_ids):
            print(f"[{i}/{len(run_ids)}] ok")

    after = await _count_embeddings()
    print(f"embeddings after:  {after}  (delta {after - before:+d})")
    if failures:
        print(f"{failures} runs failed; see logs above")
    await dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--only-missing",
        action="store_true",
        help="Skip runs that already have a 'task' embedding row.",
    )
    args = parser.parse_args()
    asyncio.run(main(only_missing=args.only_missing))

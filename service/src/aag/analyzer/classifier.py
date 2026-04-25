"""Aggregate rule outputs into a FailureCase.

R3: implement classify(run_id) -> FailureCaseOut by:
  1. Loading run + events + diffs from DB
  2. Running every rule in aag.analyzer.rules
  3. Merging symptoms; picking the highest-confidence FailureMode
  4. Looking up a fix pattern per (failure_mode, change_pattern)
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from aag.schemas.runs import FailureCaseOut


async def classify(session: AsyncSession, run_id: str) -> FailureCaseOut | None:
    # TODO(R3): replace with real rule pipeline.
    return None

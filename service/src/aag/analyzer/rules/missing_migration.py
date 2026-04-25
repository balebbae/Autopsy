"""Symptom: schema_field_addition present but migrations/** untouched."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

MIGRATION_PATH_RE = re.compile(r"(?:^|/)migrations?/|/migrate/|\.migration\.", re.IGNORECASE)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    has_migration = any(MIGRATION_PATH_RE.search(f) for f in ctx.files)
    if has_migration:
        return None

    from aag.analyzer.rules.schema_change import check as schema_check

    if schema_check(ctx) is None:
        return None

    return Symptom(
        name="missing_migration",
        evidence=["schema field added but no migration file in changed files"],
        confidence=0.7,
    )

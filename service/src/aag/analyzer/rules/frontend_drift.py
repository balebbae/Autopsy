"""Symptom: backend types changed, generated frontend types not regenerated."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

BACKEND_TYPE_RE = re.compile(
    r"(?:models?|schemas?|serializers?|types?)\.(?:py|ts)$"
    r"|\.model\.py$|\.schema\.ts$|schema\.prisma$",
    re.IGNORECASE,
)

GENERATED_RE = re.compile(
    r"/generated/|\.gen\.\w+$|\.generated\.\w+$|__generated__|/codegen/",
    re.IGNORECASE,
)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    backend_type_files = [f for f in ctx.files if BACKEND_TYPE_RE.search(f)]
    if not backend_type_files:
        return None

    generated_files = [f for f in ctx.files if GENERATED_RE.search(f)]
    if generated_files:
        return None

    return Symptom(
        name="frontend_type_drift",
        evidence=[
            f"backend types changed in {f} with no generated types updated"
            for f in backend_type_files[:5]
        ],
        confidence=0.6,
    )

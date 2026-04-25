"""Symptom extraction from the user's rejection reason text.

The rejection reason is the strongest signal we have — it's the user directly
telling us what went wrong. Parse it for known failure patterns and emit
high-confidence symptoms.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"migrat", re.IGNORECASE), "missing_migration"),
    (re.compile(r"test|spec|coverage", re.IGNORECASE), "missing_test"),
    (
        re.compile(r"frontend.type|generated.type|type.gen|regen", re.IGNORECASE),
        "frontend_type_drift",
    ),
    (re.compile(r"schema|field|column|model.change", re.IGNORECASE), "schema_field_addition"),
    (re.compile(r"broke|break|regress|fail", re.IGNORECASE), "regression"),
    (re.compile(r"wrong file|wrong place|incorrect", re.IGNORECASE), "wrong_target"),
    (re.compile(r"security|auth|token|credential|secret", re.IGNORECASE), "security_concern"),
    (re.compile(r"performance|slow|timeout|memory", re.IGNORECASE), "performance_concern"),
]


def check(ctx: RunContext) -> list[Symptom]:
    from aag.schemas.runs import Symptom

    if not ctx.rejection_reason:
        return []

    reason = ctx.rejection_reason
    symptoms: list[Symptom] = []

    for pattern, symptom_name in PATTERNS:
        if pattern.search(reason):
            symptoms.append(
                Symptom(
                    name=symptom_name,
                    evidence=[f"rejection reason: {reason[:200]}"],
                    confidence=0.9,
                )
            )

    return symptoms

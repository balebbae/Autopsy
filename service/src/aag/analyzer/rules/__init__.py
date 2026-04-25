"""Individual deterministic rules.

Standard rules export `check(run_ctx) -> Symptom | None`.
The rejection_reason rule exports `check(run_ctx) -> list[Symptom]`.
"""

from aag.analyzer.rules import (
    frontend_drift,
    missing_migration,
    missing_test,
    rejection_reason,
    schema_change,
    sentiment,
)

ALL_RULES = [schema_change, missing_migration, missing_test, frontend_drift, sentiment]

REJECTION_RULE = rejection_reason

"""Individual deterministic rules. Each rule exports `check(run_ctx) -> Symptom | None`."""

from aag.analyzer.rules import frontend_drift, missing_migration, missing_test, schema_change

ALL_RULES = [schema_change, missing_migration, missing_test, frontend_drift]

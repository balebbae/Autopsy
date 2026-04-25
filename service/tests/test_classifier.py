"""Tests for the failure classifier rules and pipeline."""

from aag.analyzer.classifier import (
    RunContext,
    _extract_components,
    _infer_task_type,
    _inline_diff,
    _pick_failure_mode,
)
from aag.analyzer.rules import (
    ALL_RULES,
    frontend_drift,
    missing_migration,
    missing_test,
    schema_change,
)
from aag.schemas.runs import Symptom


def _fixture_context() -> RunContext:
    """RunContext matching contracts/fixtures/run-rejected-schema.json."""
    return RunContext(
        run_id="fixture-run-rejected-schema-001",
        task="Add preferredName to user profile API and UI",
        status="rejected",
        rejection_reason="Missed the database migration and didn't regenerate the frontend types.",
        files=[
            "src/profile/profile.service.ts",
            "src/profile/user.serializer.ts",
        ],
        patches={
            "src/profile/profile.service.ts": (
                "@@ -3,3 +3,4 @@\n   id: string;\n   email: string;\n+  preferredName?: string;\n"
            ),
            "src/profile/user.serializer.ts": (
                "@@ -1 +1 @@\n-fields: ['id', 'email']\n+fields: ['id', 'email', 'preferredName']\n"
            ),
        },
        events=[],
    )


class TestSchemaChangeRule:
    def test_detects_field_addition(self):
        ctx = _fixture_context()
        result = schema_change.check(ctx)
        assert result is not None
        assert result.name == "schema_field_addition"
        assert result.confidence == 0.8
        assert any("preferredName" in e for e in result.evidence)

    def test_no_match_on_plain_code(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="approved",
            rejection_reason=None,
            files=["src/utils.ts"],
            patches={"src/utils.ts": "+console.log('hello')"},
        )
        assert schema_change.check(ctx) is None


class TestMissingMigrationRule:
    def test_fires_when_schema_changed_no_migration(self):
        ctx = _fixture_context()
        result = missing_migration.check(ctx)
        assert result is not None
        assert result.name == "missing_migration"

    def test_does_not_fire_with_migration_present(self):
        ctx = _fixture_context()
        ctx.files.append("db/migrations/001_add_preferred_name.sql")
        assert missing_migration.check(ctx) is None


class TestMissingTestRule:
    def test_fires_when_no_tests(self):
        ctx = _fixture_context()
        result = missing_test.check(ctx)
        assert result is not None
        assert result.name == "missing_test"

    def test_does_not_fire_with_test_file(self):
        ctx = _fixture_context()
        ctx.files.append("src/profile/profile.service.test.ts")
        assert missing_test.check(ctx) is None


class TestFrontendDriftRule:
    def test_fires_on_backend_type_change(self):
        ctx = _fixture_context()
        result = frontend_drift.check(ctx)
        assert result is not None
        assert result.name == "frontend_type_drift"

    def test_does_not_fire_with_generated_types(self):
        ctx = _fixture_context()
        ctx.files.append("src/generated/api-types.ts")
        assert frontend_drift.check(ctx) is None


class TestClassifierHelpers:
    def test_pick_failure_mode(self):
        symptoms = [
            Symptom(name="schema_field_addition", confidence=0.8),
            Symptom(name="missing_migration", confidence=0.7),
            Symptom(name="missing_test", confidence=0.5),
        ]
        mode = _pick_failure_mode(symptoms)
        assert mode == "incomplete_schema_change"

    def test_extract_components(self):
        files = ["src/profile/profile.service.ts", "src/profile/user.serializer.ts"]
        assert _extract_components(files) == ["profile"]

    def test_extract_components_multiple(self):
        files = ["src/profile/a.ts", "src/auth/b.ts"]
        assert _extract_components(files) == ["profile", "auth"]

    def test_infer_task_type_feature(self):
        assert _infer_task_type("Add preferredName to user profile") == "feature_addition"

    def test_infer_task_type_fix(self):
        assert _infer_task_type("Fix login bug") == "bug_fix"

    def test_infer_task_type_none(self):
        assert _infer_task_type(None) is None

    def test_inline_diff(self):
        old = "a\nb\nc"
        new = "a\nb\nc\nd"
        result = _inline_diff(old, new)
        assert "+d" in result


class TestAllRulesOnFixture:
    def test_fixture_produces_expected_output(self):
        ctx = _fixture_context()
        symptoms = []
        for rule in ALL_RULES:
            result = rule.check(ctx)
            if result is not None:
                symptoms.append(result)

        symptom_names = {s.name for s in symptoms}
        assert "schema_field_addition" in symptom_names
        assert "missing_migration" in symptom_names
        assert "missing_test" in symptom_names

        mode = _pick_failure_mode(symptoms)
        assert mode == "incomplete_schema_change"

        components = _extract_components(ctx.files)
        assert "profile" in components

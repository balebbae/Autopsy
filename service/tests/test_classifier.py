"""Tests for the failure classifier rules and pipeline."""

from aag.analyzer.classifier import (
    RunContext,
    _infer_task_type,
    _inline_diff,
    _pick_failure_mode,
)
from aag.analyzer.extractor import extract_components
from aag.analyzer.rules import (
    ALL_RULES,
    REJECTION_RULE,
    frontend_drift,
    missing_migration,
    missing_test,
    schema_change,
    sentiment,
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
        assert extract_components(files) == ["profile"]

    def test_extract_components_multiple(self):
        files = ["src/profile/a.ts", "src/auth/b.ts"]
        assert extract_components(files) == ["profile", "auth"]

    def test_infer_task_type_feature(self):
        assert _infer_task_type("Add preferredName to user profile") == "feature_addition"

    def test_infer_task_type_fix(self):
        assert _infer_task_type("Fix login bug") == "bug_fix"

    def test_infer_task_type_none(self):
        assert _infer_task_type(None) is None

    def test_change_patterns_dedupe_preserves_order(self):
        # Multiple rules can emit symptoms with the same name (e.g. the
        # baseline frontend_drift rule plus a REJECTION_RULE-derived
        # symptom). The classifier must dedupe so downstream consumers
        # (embeddings text, FailureCase row, dashboard render) don't see
        # repeats — and must keep first-seen order.
        symptoms = [
            Symptom(name="frontend_type_drift", confidence=0.8),
            Symptom(name="missing_test", confidence=0.5),
            Symptom(name="frontend_type_drift", confidence=0.6),
        ]
        change_patterns = list(dict.fromkeys(s.name for s in symptoms))
        assert change_patterns == ["frontend_type_drift", "missing_test"]

    def test_inline_diff(self):
        old = "a\nb\nc"
        new = "a\nb\nc\nd"
        result = _inline_diff(old, new)
        assert "+d" in result


class TestRejectionReasonRule:
    def test_detects_migration_in_reason(self):
        ctx = _fixture_context()
        results = REJECTION_RULE.check(ctx)
        names = {s.name for s in results}
        assert "missing_migration" in names
        assert all(s.confidence == 0.9 for s in results)

    def test_detects_multiple_signals(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="rejected",
            rejection_reason="Missing tests and the migration is wrong",
        )
        results = REJECTION_RULE.check(ctx)
        names = {s.name for s in results}
        assert "missing_test" in names
        assert "missing_migration" in names

    def test_no_match_without_reason(self):
        ctx = RunContext(run_id="r1", task=None, status="rejected", rejection_reason=None)
        assert REJECTION_RULE.check(ctx) == []

    def test_no_match_on_generic_reason(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="rejected",
            rejection_reason="I don't like it",
        )
        assert REJECTION_RULE.check(ctx) == []

    def test_security_concern(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="rejected",
            rejection_reason="This exposes the auth token in the response",
        )
        results = REJECTION_RULE.check(ctx)
        names = {s.name for s in results}
        assert "security_concern" in names


class TestAllRulesOnFixture:
    def test_fixture_produces_expected_output(self):
        ctx = _fixture_context()
        symptoms = []
        for rule in ALL_RULES:
            result = rule.check(ctx)
            if result is not None:
                symptoms.append(result)
        symptoms.extend(REJECTION_RULE.check(ctx))

        symptom_names = {s.name for s in symptoms}
        assert "schema_field_addition" in symptom_names
        assert "missing_migration" in symptom_names
        assert "missing_test" in symptom_names

        mode = _pick_failure_mode(symptoms)
        assert mode == "incomplete_schema_change"

        components = extract_components(ctx.files)
        assert "profile" in components


class TestRejectedRunWithNoSymptoms:
    def test_rejected_run_still_produces_baseline(self):
        """Permission rejections may have zero rule-based symptoms but should
        still produce a FailureCaseOut so Gemma can analyze them."""
        ctx = RunContext(
            run_id="r1",
            task="Add dark mode toggle",
            status="rejected",
            rejection_reason=None,
            files=[],
            patches={},
            events=[],
            user_messages=["add a dark mode toggle"],
        )
        symptoms: list[Symptom] = []
        for rule in ALL_RULES:
            result = rule.check(ctx)
            if result is not None:
                symptoms.append(result)
        symptoms.extend(REJECTION_RULE.check(ctx))
        assert len(symptoms) == 0

        is_rejected = ctx.status == "rejected"
        assert is_rejected
        # Previously this would have returned None

    def test_non_rejected_with_no_symptoms_returns_nothing(self):
        ctx = RunContext(
            run_id="r1",
            task="refactor utils",
            status="in_progress",
            rejection_reason=None,
        )
        symptoms: list[Symptom] = []
        for rule in ALL_RULES:
            result = rule.check(ctx)
            if result is not None:
                symptoms.append(result)
        symptoms.extend(REJECTION_RULE.check(ctx))
        assert len(symptoms) == 0
        is_rejected = ctx.status == "rejected"
        assert not is_rejected


class TestSentimentRule:
    def test_detects_profanity(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["this is shit, redo it"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert result.name == "user_frustration"
        assert result.confidence >= 0.6

    def test_detects_strong_negative(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["revert all of this"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert result.name == "user_frustration"

    def test_scales_confidence_with_multiple(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["wtf is this", "this sucks", "are you serious"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert result.confidence >= 0.8

    def test_no_match_on_neutral(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["looks good, ship it"],
        )
        assert sentiment.check(ctx) is None

    def test_no_match_on_empty(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=[],
        )
        assert sentiment.check(ctx) is None

    def test_detects_thats_wrong(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["that's wrong, the endpoint should return a list"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert result.name == "user_frustration"
        assert any("rejection:" in e for e in result.evidence)

    def test_detects_doesnt_work(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["this doesn't work, the tests are failing"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_still_broken(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["it's still broken after your change"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_no_comma_at_start(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["no, do something else"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert any("dissatisfaction:" in e for e in result.evidence)

    def test_detects_nope(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["nope"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_try_again(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["try again with the correct import path"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_why_did_you(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["why did you delete that function?"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_you_missed(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["you forgot to add the import statement"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_not_quite(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["not quite, the return type should be Optional"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_detects_i_didnt_ask(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["I didn't ask for that refactor"],
        )
        result = sentiment.check(ctx)
        assert result is not None

    def test_mild_signals_accumulate(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["nope", "try again", "you missed the edge case"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert len(result.evidence) == 3
        assert result.confidence >= 0.6

    def test_mixed_tiers_accumulate(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["that's wrong", "this is garbage"],
        )
        result = sentiment.check(ctx)
        assert result is not None
        assert result.confidence >= 0.8

    def test_no_false_positive_on_no_problem(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="in_progress",
            rejection_reason=None,
            user_messages=["no problem, looks great"],
        )
        assert sentiment.check(ctx) is None

    def test_picks_user_dissatisfaction_mode(self):
        symptoms = [
            Symptom(name="user_frustration", confidence=0.8),
        ]
        mode = _pick_failure_mode(symptoms)
        assert mode == "user_dissatisfaction"

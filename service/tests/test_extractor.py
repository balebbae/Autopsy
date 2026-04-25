"""Tests for the entity extractor."""

from aag.analyzer.classifier import RunContext
from aag.analyzer.extractor import Extraction, extract
from aag.schemas.runs import FailureCaseOut, Symptom


def _fixture_context() -> RunContext:
    return RunContext(
        run_id="fixture-run-rejected-schema-001",
        task="Add preferredName to user profile API and UI",
        status="rejected",
        rejection_reason="Missed the database migration.",
        files=[
            "src/profile/profile.service.ts",
            "src/profile/user.serializer.ts",
        ],
        patches={
            "src/profile/profile.service.ts": "+  preferredName?: string;\n",
            "src/profile/user.serializer.ts": "+fields: ['id', 'email', 'preferredName']\n",
        },
        events=[
            {
                "type": "tool.execute.after",
                "ts": 1714000005500,
                "properties": {
                    "tool": "edit",
                    "args": {"filePath": "src/profile/profile.service.ts"},
                    "result": {"diff": {"path": "src/profile/profile.service.ts"}},
                },
            },
            {
                "type": "tool.execute.after",
                "ts": 1714000006500,
                "properties": {
                    "tool": "edit",
                    "args": {"filePath": "src/profile/user.serializer.ts"},
                    "result": {"diff": {"path": "src/profile/user.serializer.ts"}},
                },
            },
            {
                "type": "tool.execute.after",
                "ts": 1714000008000,
                "properties": {
                    "tool": "bash",
                    "args": {"command": "npm test"},
                    "result": {"exitCode": 1, "stderr": "Error: test suite failed"},
                },
            },
        ],
    )


def _fixture_failure_case() -> FailureCaseOut:
    return FailureCaseOut(
        run_id="fixture-run-rejected-schema-001",
        task_type="feature_addition",
        failure_mode="incomplete_schema_change",
        fix_pattern="Add database migration and regenerate types after schema changes",
        components=["profile"],
        change_patterns=["schema_field_addition", "missing_migration"],
        symptoms=[
            Symptom(name="schema_field_addition", evidence=["+ preferredName"], confidence=0.8),
            Symptom(name="missing_migration", evidence=["no migration file"], confidence=0.7),
        ],
        summary="Missed the database migration.",
    )


class TestExtract:
    def test_with_failure_case(self):
        ctx = _fixture_context()
        fc = _fixture_failure_case()
        result = extract(ctx, fc)

        assert isinstance(result, Extraction)
        assert result.run_id == "fixture-run-rejected-schema-001"
        assert result.task_type == "feature_addition"
        assert result.failure_mode == "incomplete_schema_change"
        assert result.fix_pattern is not None
        assert "schema_field_addition" in result.change_patterns
        assert len(result.symptoms) == 2

    def test_without_failure_case(self):
        ctx = _fixture_context()
        result = extract(ctx, None)

        assert result.failure_mode is None
        assert result.fix_pattern is None
        assert result.change_patterns == []
        assert result.symptoms == []

    def test_files_preserved(self):
        ctx = _fixture_context()
        result = extract(ctx, None)
        assert result.files == [
            "src/profile/profile.service.ts",
            "src/profile/user.serializer.ts",
        ]

    def test_components_extracted(self):
        ctx = _fixture_context()
        result = extract(ctx, None)
        assert result.components == ["profile"]

    def test_tool_calls_collected(self):
        ctx = _fixture_context()
        result = extract(ctx, None)
        assert "edit" in result.tool_calls
        assert "bash" in result.tool_calls

    def test_tool_calls_deduplicated(self):
        ctx = _fixture_context()
        result = extract(ctx, None)
        assert result.tool_calls.count("edit") == 1

    def test_errors_from_stderr(self):
        ctx = _fixture_context()
        result = extract(ctx, None)
        assert len(result.errors) == 1
        assert "test suite failed" in result.errors[0]

    def test_errors_from_exit_code(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="rejected",
            rejection_reason=None,
            events=[
                {
                    "type": "tool.execute.after",
                    "ts": 1,
                    "properties": {
                        "tool": "bash",
                        "result": {"exitCode": 127, "stdout": "command not found"},
                    },
                },
            ],
        )
        result = extract(ctx, None)
        assert len(result.errors) == 1
        assert "command not found" in result.errors[0]

    def test_no_errors_on_success(self):
        ctx = RunContext(
            run_id="r1",
            task=None,
            status="approved",
            rejection_reason=None,
            events=[
                {
                    "type": "tool.execute.after",
                    "ts": 1,
                    "properties": {"tool": "edit", "result": {}},
                },
            ],
        )
        result = extract(ctx, None)
        assert result.errors == []

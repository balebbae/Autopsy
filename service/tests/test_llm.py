"""Tests for the Gemma LLM classification enhancer."""

from aag.analyzer.classifier import RunContext
from aag.analyzer.llm import (
    LLMClassification,
    _build_prompt,
    _parse_response,
    merge_llm_result,
)
from aag.schemas.runs import FailureCaseOut, Symptom


def _test_ctx() -> RunContext:
    return RunContext(
        run_id="r1",
        task="Make the pickle image clickable",
        status="rejected",
        rejection_reason="the pickle isn't clickable dipshit",
        files=["src/pickle.html"],
        patches={"src/pickle.html": "+<img src='pickle.png'>"},
        events=[],
        user_messages=["make pickle clickable", "the pickle isn't clickable dipshit"],
    )


def _test_baseline() -> FailureCaseOut:
    return FailureCaseOut(
        run_id="r1",
        task_type="feature_addition",
        failure_mode="missing_test_coverage",
        fix_pattern="Add tests",
        components=["pickle"],
        change_patterns=["missing_test"],
        symptoms=[Symptom(name="missing_test", confidence=0.5)],
        summary="missing_test",
    )


class TestPromptConstruction:
    def test_includes_task(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "Make the pickle image clickable" in prompt

    def test_includes_rejection_reason(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "pickle isn't clickable" in prompt

    def test_includes_files(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "src/pickle.html" in prompt

    def test_includes_patches(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "pickle.png" in prompt

    def test_includes_user_messages(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "make pickle clickable" in prompt

    def test_includes_baseline(self):
        prompt = _build_prompt(_test_ctx(), _test_baseline())
        assert "missing_test_coverage" in prompt
        assert "missing_test" in prompt

    def test_no_baseline(self):
        prompt = _build_prompt(_test_ctx(), None)
        assert "Rule-Based Analysis" not in prompt

    def test_empty_context(self):
        ctx = RunContext(run_id="r1", task=None, status="rejected", rejection_reason=None)
        prompt = _build_prompt(ctx, None)
        assert "Unknown" in prompt

    def test_truncates_long_patches(self):
        ctx = _test_ctx()
        ctx.patches = {f"file{i}.ts": "x" * 500 for i in range(10)}
        prompt = _build_prompt(ctx, None)
        assert len(prompt) < 10000

    def test_includes_tool_errors(self):
        ctx = _test_ctx()
        ctx.events = [
            {
                "type": "tool.execute.after",
                "properties": {"result": {"error": "ENOENT: no such file"}},
            }
        ]
        prompt = _build_prompt(ctx, None)
        assert "ENOENT" in prompt


class TestResponseParsing:
    def test_valid_json(self):
        text = '{"failure_mode": "ui_bug", "summary": "No click handler", "confidence": 0.9}'
        result = _parse_response(text)
        assert result is not None
        assert result.failure_mode == "ui_bug"
        assert result.summary == "No click handler"
        assert result.confidence == 0.9

    def test_json_with_markdown_fences(self):
        text = '```json\n{"failure_mode": "ui_bug", "summary": "test", "confidence": 0.8}\n```'
        result = _parse_response(text)
        assert result is not None
        assert result.failure_mode == "ui_bug"

    def test_invalid_json(self):
        assert _parse_response("not json at all") is None

    def test_json_with_thinking_preamble(self):
        text = (
            '* Constraint 1: Only valid JSON.\n'
            '* The object is valid.\n\n'
            '{"failure_mode": "ui_bug", "summary": "test", "confidence": 0.8}'
        )
        result = _parse_response(text)
        assert result is not None
        assert result.failure_mode == "ui_bug"

    def test_json_buried_in_reasoning(self):
        text = (
            'Let me analyze this.\n\n'
            '`{"failure_mode": "test"}`\n'
            '{"failure_mode": "real_answer", "summary": "found it", "confidence": 0.9}'
        )
        result = _parse_response(text)
        assert result is not None
        assert result.failure_mode == "real_answer"

    def test_missing_failure_mode(self):
        assert _parse_response('{"summary": "something"}') is None

    def test_with_symptoms(self):
        text = (
            '{"failure_mode": "ui_bug", "summary": "test", "confidence": 0.8, '
            '"symptoms": [{"name": "missing_handler", "evidence": "no onclick", "confidence": 0.85}]}'
        )
        result = _parse_response(text)
        assert result is not None
        assert len(result.symptoms) == 1
        assert result.symptoms[0]["name"] == "missing_handler"

    def test_empty_string(self):
        assert _parse_response("") is None

    def test_with_fix_pattern(self):
        text = '{"failure_mode": "x", "summary": "y", "confidence": 0.5, "fix_pattern": "do Z"}'
        result = _parse_response(text)
        assert result is not None
        assert result.fix_pattern == "do Z"


class TestMergeLogic:
    def test_llm_overrides_when_higher_confidence(self):
        baseline = _test_baseline()
        llm = LLMClassification(
            failure_mode="ui_interaction_bug",
            summary="Pickle image needs onclick handler",
            confidence=0.85,
            symptoms=[
                {"name": "missing_click_handler", "evidence": "no onclick", "confidence": 0.85}
            ],
        )
        merged = merge_llm_result(baseline, llm)
        assert merged.failure_mode == "ui_interaction_bug"
        assert "Pickle image" in merged.summary

    def test_baseline_preserved_when_llm_low_confidence(self):
        baseline = _test_baseline()
        llm = LLMClassification(
            failure_mode="other",
            summary="unclear",
            confidence=0.3,
        )
        merged = merge_llm_result(baseline, llm)
        assert merged.failure_mode == "missing_test_coverage"

    def test_llm_symptoms_appended(self):
        baseline = _test_baseline()
        llm = LLMClassification(
            failure_mode="ui_bug",
            summary="test",
            confidence=0.85,
            symptoms=[{"name": "missing_handler", "evidence": "no click", "confidence": 0.8}],
        )
        merged = merge_llm_result(baseline, llm)
        names = {s.name for s in merged.symptoms}
        assert "missing_test" in names
        assert "missing_handler" in names
        llm_syms = [s for s in merged.symptoms if s.source == "llm"]
        assert len(llm_syms) == 1

    def test_fix_pattern_from_llm(self):
        baseline = _test_baseline()
        llm = LLMClassification(
            failure_mode="x",
            summary="y",
            confidence=0.85,
            fix_pattern="Wrap images in button elements",
        )
        merged = merge_llm_result(baseline, llm)
        assert "button" in merged.fix_pattern

    def test_baseline_fix_preserved_when_llm_has_none(self):
        baseline = _test_baseline()
        llm = LLMClassification(failure_mode="x", summary="y", confidence=0.85)
        merged = merge_llm_result(baseline, llm)
        assert merged.fix_pattern == "Add tests"

    def test_change_patterns_extended(self):
        baseline = _test_baseline()
        llm = LLMClassification(
            failure_mode="x",
            summary="y",
            confidence=0.85,
            symptoms=[{"name": "new_symptom", "evidence": "e", "confidence": 0.7}],
        )
        merged = merge_llm_result(baseline, llm)
        assert "new_symptom" in merged.change_patterns
        assert "missing_test" in merged.change_patterns

    def test_run_id_preserved(self):
        baseline = _test_baseline()
        llm = LLMClassification(failure_mode="x", summary="y", confidence=0.85)
        merged = merge_llm_result(baseline, llm)
        assert merged.run_id == "r1"

    def test_empty_llm_symptoms(self):
        baseline = _test_baseline()
        llm = LLMClassification(failure_mode="x", summary="y", confidence=0.85)
        merged = merge_llm_result(baseline, llm)
        assert len(merged.symptoms) == len(baseline.symptoms)

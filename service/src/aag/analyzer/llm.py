"""Gemma-powered failure classification enhancer.

Sends RunContext + rule-based baseline to Gemma via Google AI Studio,
parses the structured JSON response, and returns an LLMClassification
that the classifier can merge with the deterministic baseline.

Falls back gracefully on any error — the rule-based pipeline always works.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from aag.config import get_settings

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import FailureCaseOut

log = logging.getLogger(__name__)

MAX_PATCH_CHARS = 2000
MAX_MESSAGES = 10
MAX_ERRORS = 5


@dataclass
class LLMClassification:
    failure_mode: str
    summary: str
    fix_pattern: str | None = None
    confidence: float = 0.5
    symptoms: list[dict] = field(default_factory=list)


SYSTEM_PROMPT = """\
You are a failure classifier for an AI coding agent. You MUST respond with ONLY a raw JSON object. \
No explanation, no markdown, no text before or after. Just the JSON object.

Context: You are analyzing sessions where a human user worked with an AI coding assistant. \
When the baseline says "permission_rejected", it means the USER MANUALLY DECLINED the agent's \
proposed action (e.g. clicking "reject" on a tool call). The user chose not to let the agent \
proceed — try to infer WHY from the tool calls, files, and messages. Do NOT classify this as \
an access control or auth issue.

Required JSON format:
{"failure_mode": "snake_case_category", "summary": "1-2 sentences", "symptoms": [{"name": "snake_case", "evidence": "brief", "confidence": 0.8}], "fix_pattern": "actionable advice", "confidence": 0.8}"""


def _build_prompt(ctx: RunContext, baseline: FailureCaseOut | None) -> str:
    parts: list[str] = []

    parts.append(f"## Task\n{ctx.task or 'Unknown'}")
    parts.append(f"## Rejection Reason\n{ctx.rejection_reason or 'None provided'}")

    if ctx.files:
        parts.append(f"## Files Changed\n{chr(10).join(ctx.files[:20])}")

    if ctx.patches:
        patch_text = ""
        for path, patch in ctx.patches.items():
            chunk = f"### {path}\n{patch}\n"
            if len(patch_text) + len(chunk) > MAX_PATCH_CHARS:
                patch_text += (
                    f"... ({len(ctx.patches) - len(patch_text.split('###')) + 1} more files)\n"
                )
                break
            patch_text += chunk
        if patch_text:
            parts.append(f"## Code Changes\n{patch_text}")

    if ctx.user_messages:
        msgs = ctx.user_messages[:MAX_MESSAGES]
        parts.append(f"## User Messages\n{chr(10).join(f'- {m[:300]}' for m in msgs)}")

    errors = _extract_errors(ctx)
    if errors:
        parts.append(f"## Tool Errors\n{chr(10).join(f'- {e}' for e in errors[:MAX_ERRORS])}")

    if baseline:
        symptom_lines = [f"- {s.name} ({s.confidence:.0%})" for s in baseline.symptoms]
        parts.append(
            f"## Rule-Based Analysis (baseline)\n"
            f"Failure mode: {baseline.failure_mode}\n"
            f"Symptoms:\n{chr(10).join(symptom_lines)}"
        )

    parts.append("Respond with ONLY the JSON object. No other text.")

    return "\n\n".join(parts)


def _extract_errors(ctx: RunContext) -> list[str]:
    errors: list[str] = []
    for ev in ctx.events:
        if ev.get("type") != "tool.execute.after":
            continue
        props = ev.get("properties") or {}
        result = props.get("result") or {}
        err = result.get("error")
        if isinstance(err, str) and err.strip():
            errors.append(err.strip()[:300])
            continue
        stderr = (result.get("stderr") or "").strip()
        if stderr:
            errors.append(stderr[:300])
            continue
        exit_code = result.get("exitCode")
        if exit_code is not None and exit_code != 0:
            errors.append(f"exit code {exit_code}")
    return errors


def _extract_json_object(text: str) -> dict | None:
    """Scan text for the last valid JSON object — Gemma often emits
    chain-of-thought reasoning before the actual JSON payload."""
    last = text.rfind("{")
    while last != -1:
        try:
            data = json.loads(text[last:])
            if isinstance(data, dict):
                return data
        except json.JSONDecodeError:
            pass
        last = text.rfind("{", 0, last)
    return None


def _parse_response(text: str) -> LLMClassification | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        data = _extract_json_object(text)
        if data is None:
            log.warning("Gemma returned non-JSON: %.200s", text)
            return None

    if not isinstance(data, dict) or "failure_mode" not in data:
        log.warning("Gemma response missing failure_mode: %s", data)
        return None

    return LLMClassification(
        failure_mode=str(data["failure_mode"]),
        summary=str(data.get("summary", "")),
        fix_pattern=data.get("fix_pattern"),
        confidence=float(data.get("confidence", 0.5)),
        symptoms=data.get("symptoms") or [],
    )


async def enhance_classification(
    ctx: RunContext,
    baseline: FailureCaseOut | None,
) -> LLMClassification | None:
    settings = get_settings()
    if settings.llm_provider == "none":
        return None

    if settings.llm_provider == "gemma":
        return await _call_gemma(ctx, baseline, settings)

    log.warning("unknown LLM_PROVIDER: %s", settings.llm_provider)
    return None


async def _call_gemma(ctx, baseline, settings) -> LLMClassification | None:
    try:
        import google.generativeai as genai  # type: ignore  # noqa: F811
    except ImportError:
        log.warning("google-generativeai not installed; pip install 'aag[gemma]'")
        return None

    if not settings.gemini_api_key:
        log.warning("GEMINI_API_KEY not set")
        return None

    try:
        genai.configure(api_key=settings.gemini_api_key)
        model = genai.GenerativeModel(
            model_name=settings.gemma_model,
            system_instruction=SYSTEM_PROMPT,
            generation_config=genai.GenerationConfig(
                response_mime_type="application/json",
                temperature=0.2,
            ),
        )

        prompt = _build_prompt(ctx, baseline)
        response = await model.generate_content_async(prompt)
        return _parse_response(response.text)
    except Exception:
        log.exception("Gemma classification failed")
        return None


def merge_llm_result(
    baseline: FailureCaseOut,
    llm: LLMClassification,
) -> FailureCaseOut:
    from aag.schemas.runs import FailureCaseOut as FC
    from aag.schemas.runs import Symptom

    top_rule_confidence = max((s.confidence for s in baseline.symptoms), default=0.0)

    failure_mode = baseline.failure_mode
    if llm.confidence > top_rule_confidence:
        failure_mode = llm.failure_mode

    llm_symptoms = [
        Symptom(
            name=s.get("name", "llm_finding"),
            evidence=[s.get("evidence", "")][:1] if s.get("evidence") else [],
            confidence=float(s.get("confidence", 0.5)),
            source="llm",
        )
        for s in llm.symptoms
        if isinstance(s, dict) and s.get("name")
    ]
    all_symptoms = list(baseline.symptoms) + llm_symptoms

    summary = llm.summary if llm.summary else baseline.summary
    fix_pattern = llm.fix_pattern if llm.fix_pattern else baseline.fix_pattern

    change_patterns = list(baseline.change_patterns)
    for s in llm_symptoms:
        if s.name not in change_patterns:
            change_patterns.append(s.name)

    return FC(
        run_id=baseline.run_id,
        task_type=baseline.task_type,
        failure_mode=failure_mode,
        fix_pattern=fix_pattern,
        components=baseline.components,
        change_patterns=change_patterns,
        symptoms=all_symptoms,
        summary=summary,
    )

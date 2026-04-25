"""Aggregate rule outputs into a FailureCase.

Loads run + events + diffs from DB, runs every rule in aag.analyzer.rules,
merges symptoms, picks the highest-confidence FailureMode, and returns
a FailureCaseOut (or None if no symptoms fire).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from aag.analyzer.extractor import extract_components
from aag.config import get_settings
from aag.ingestion.assembler import list_run_artifacts, list_run_events
from aag.models import Run
from aag.schemas.runs import FailureCaseOut, Symptom

SYMPTOM_TO_MODE: dict[str, str] = {
    "schema_field_addition": "incomplete_schema_change",
    "missing_migration": "incomplete_schema_change",
    "missing_test": "missing_test_coverage",
    "frontend_type_drift": "frontend_backend_drift",
    "regression": "regression",
    "wrong_target": "wrong_target",
    "security_concern": "security_concern",
    "performance_concern": "performance_concern",
    "user_frustration": "user_dissatisfaction",
}

MODE_TO_FIX: dict[str, str] = {
    "incomplete_schema_change": "Add database migration and regenerate types after schema changes",
    "missing_test_coverage": "Add or update tests covering the changed code paths",
    "frontend_backend_drift": "Regenerate frontend types after backend type changes",
    "regression": "Check for regressions in existing functionality before committing",
    "wrong_target": "Verify the correct files and locations before making changes",
    "security_concern": "Review changes for security implications",
    "performance_concern": "Profile and benchmark before and after the change",
    "user_dissatisfaction": "Address user feedback before continuing with changes",
}


@dataclass
class RunContext:
    run_id: str
    task: str | None
    status: str
    rejection_reason: str | None
    files: list[str] = field(default_factory=list)
    patches: dict[str, str] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    user_messages: list[str] = field(default_factory=list)
    assistant_messages: list[str] = field(default_factory=list)
    tool_commands: list[dict] = field(default_factory=list)


async def classify(
    session: AsyncSession, run_id: str
) -> tuple[RunContext | None, FailureCaseOut | None]:
    run = await session.get(Run, run_id)
    if run is None:
        return None, None

    ctx = await _build_context(session, run)

    from aag.analyzer.rules import ALL_RULES, REJECTION_RULE

    symptoms: list[Symptom] = []
    for rule in ALL_RULES:
        result = rule.check(ctx)
        if result is not None:
            symptoms.append(result)

    symptoms.extend(REJECTION_RULE.check(ctx))

    is_rejected = ctx.status == "rejected"

    if not symptoms and not is_rejected:
        return ctx, None

    if symptoms:
        failure_mode = _pick_failure_mode(symptoms)
        change_patterns = [s.name for s in symptoms]
        fix_pattern = MODE_TO_FIX.get(failure_mode)
        summary = ctx.rejection_reason or ", ".join(s.name for s in symptoms)
    else:
        failure_mode = "permission_rejected"
        change_patterns = []
        fix_pattern = None
        summary = ctx.rejection_reason or _build_rejection_summary(ctx)

    components = extract_components(ctx.files)

    baseline = FailureCaseOut(
        run_id=run_id,
        task_type=_infer_task_type(ctx.task),
        failure_mode=failure_mode,
        fix_pattern=fix_pattern,
        components=components,
        change_patterns=change_patterns,
        symptoms=symptoms,
        summary=summary,
    )

    settings = get_settings()
    if settings.llm_provider != "none":
        from aag.analyzer.llm import enhance_classification, merge_llm_result

        llm_result = await enhance_classification(ctx, baseline)
        if llm_result:
            baseline = merge_llm_result(baseline, llm_result)

    return ctx, baseline


async def _build_context(session: AsyncSession, run: Run) -> RunContext:
    events = await list_run_events(session, run.run_id)
    artifacts = await list_run_artifacts(session, run.run_id, kind="diff")

    files: list[str] = []
    patches: dict[str, str] = {}

    for art in artifacts:
        content = art.content or {}
        if "files" in content:
            for f in content["files"]:
                path = f.get("file", "")
                if path and path not in patches:
                    files.append(path)
                    patches[path] = f.get("patch", "")
        elif "path" in content:
            path = content["path"]
            if path and path not in patches:
                files.append(path)
                old = content.get("oldText", "")
                new = content.get("newText", "")
                patches[path] = _inline_diff(old, new)

    user_messages, assistant_messages, tool_commands = _extract_conversation(events)

    return RunContext(
        run_id=run.run_id,
        task=run.task,
        status=run.status,
        rejection_reason=run.rejection_reason,
        files=files,
        patches=patches,
        events=[{"type": e.type, "ts": e.ts, "properties": e.properties} for e in events],
        user_messages=user_messages,
        assistant_messages=assistant_messages,
        tool_commands=tool_commands,
    )


def _extract_conversation(
    events: list,
) -> tuple[list[str], list[str], list[dict]]:
    user_messages: list[str] = []
    assistant_messages: list[str] = []
    tool_commands: list[dict] = []

    for ev in events:
        props = ev.properties or {}

        if ev.type == "message.part.updated":
            part = props.get("part") or {}
            text = part.get("text", "")
            if not text or not text.strip():
                continue
            part_type = part.get("type", "")
            if part_type == "text":
                # opencode doesn't include a role field. User text parts lack
                # a "time" key; assistant text parts always have one.
                if "time" not in part:
                    user_messages.append(text.strip())
                else:
                    assistant_messages.append(text.strip())

        elif ev.type == "tool.execute.after":
            tool = props.get("tool", "")
            args = props.get("args") or {}
            result = props.get("result") or {}
            entry = {"tool": tool, **args}
            stderr = result.get("stderr", "")
            exit_code = result.get("exitCode")
            if stderr:
                entry["stderr"] = stderr[:500]
            if exit_code is not None and exit_code != 0:
                entry["exit_code"] = exit_code
            tool_commands.append(entry)

    return user_messages, assistant_messages, tool_commands


def _inline_diff(old: str, new: str) -> str:
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    old_stripped = {ln.rstrip("\n") for ln in old_lines}
    new_stripped = {ln.rstrip("\n") for ln in new_lines}
    result: list[str] = []
    for line in old_lines:
        if line.rstrip("\n") not in new_stripped:
            result.append(f"-{line.rstrip()}")
    for line in new_lines:
        if line.rstrip("\n") not in old_stripped:
            result.append(f"+{line.rstrip()}")
    return "\n".join(result)


def _pick_failure_mode(symptoms: list[Symptom]) -> str:
    mode_confidence: dict[str, float] = defaultdict(float)
    for s in symptoms:
        mode = SYMPTOM_TO_MODE.get(s.name, s.name)
        mode_confidence[mode] += s.confidence
    return max(mode_confidence, key=lambda m: mode_confidence[m])


def _infer_task_type(task: str | None) -> str | None:
    if not task:
        return None
    lower = task.lower()
    if any(w in lower for w in ("add", "create", "implement", "build", "new")):
        return "feature_addition"
    if any(w in lower for w in ("fix", "bug", "patch", "repair")):
        return "bug_fix"
    if any(w in lower for w in ("refactor", "clean", "rename", "move")):
        return "refactoring"
    if any(w in lower for w in ("update", "upgrade", "bump", "change")):
        return "modification"
    return None


def _build_rejection_summary(ctx: RunContext) -> str:
    tools_used = [tc.get("tool", "") for tc in ctx.tool_commands if tc.get("tool")]
    failed = [
        tc.get("tool", "")
        for tc in ctx.tool_commands
        if tc.get("exit_code") or tc.get("stderr")
    ]
    parts: list[str] = []
    if tools_used:
        parts.append(f"User rejected after agent used: {', '.join(tools_used[:5])}")
    if failed:
        parts.append(f"Failed tools: {', '.join(failed[:3])}")
    if ctx.user_messages:
        last = ctx.user_messages[-1][:200]
        parts.append(f"Last user message: {last}")
    return ". ".join(parts) if parts else "User rejected a tool permission"

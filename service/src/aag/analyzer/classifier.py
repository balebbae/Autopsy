"""Aggregate rule outputs into a FailureCase.

Loads run + events + diffs from DB, runs every rule in aag.analyzer.rules,
merges symptoms, picks the highest-confidence FailureMode, and returns
a FailureCaseOut (or None if no symptoms fire).
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from aag.ingestion.assembler import list_run_artifacts, list_run_events
from aag.models import Run
from aag.schemas.runs import FailureCaseOut, Symptom

SYMPTOM_TO_MODE: dict[str, str] = {
    "schema_field_addition": "incomplete_schema_change",
    "missing_migration": "incomplete_schema_change",
    "missing_test": "missing_test_coverage",
    "frontend_type_drift": "frontend_backend_drift",
}

MODE_TO_FIX: dict[str, str] = {
    "incomplete_schema_change": "Add database migration and regenerate types after schema changes",
    "missing_test_coverage": "Add or update tests covering the changed code paths",
    "frontend_backend_drift": "Regenerate frontend types after backend type changes",
}

COMPONENT_SEGMENT_INDEX = 1


@dataclass
class RunContext:
    run_id: str
    task: str | None
    status: str
    rejection_reason: str | None
    files: list[str] = field(default_factory=list)
    patches: dict[str, str] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)


async def classify(session: AsyncSession, run_id: str) -> FailureCaseOut | None:
    run = await session.get(Run, run_id)
    if run is None:
        return None

    ctx = await _build_context(session, run)

    from aag.analyzer.rules import ALL_RULES

    symptoms: list[Symptom] = []
    for rule in ALL_RULES:
        result = rule.check(ctx)
        if result is not None:
            symptoms.append(result)

    if not symptoms:
        return None

    failure_mode = _pick_failure_mode(symptoms)
    change_patterns = [s.name for s in symptoms]
    components = _extract_components(ctx.files)
    fix_pattern = MODE_TO_FIX.get(failure_mode)
    summary = ctx.rejection_reason or ", ".join(s.name for s in symptoms)

    return FailureCaseOut(
        run_id=run_id,
        task_type=_infer_task_type(ctx.task),
        failure_mode=failure_mode,
        fix_pattern=fix_pattern,
        components=components,
        change_patterns=change_patterns,
        symptoms=symptoms,
        summary=summary,
    )


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

    return RunContext(
        run_id=run.run_id,
        task=run.task,
        status=run.status,
        rejection_reason=run.rejection_reason,
        files=files,
        patches=patches,
        events=[{"type": e.type, "ts": e.ts, "properties": e.properties} for e in events],
    )


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


def _extract_components(files: list[str]) -> list[str]:
    seen: set[str] = set()
    components: list[str] = []
    for path in files:
        parts = re.split(r"[/\\]", path)
        if len(parts) > COMPONENT_SEGMENT_INDEX:
            comp = parts[COMPONENT_SEGMENT_INDEX]
            if comp not in seen:
                seen.add(comp)
                components.append(comp)
    return components


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

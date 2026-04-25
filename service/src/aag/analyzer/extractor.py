"""Extract entities (Files, Components, ChangePatterns) from a Run.

Produces an Extraction dataclass that the graph writer can consume to create
nodes and edges. Combines raw run data (RunContext) with classifier output
(FailureCaseOut) into a single structured representation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import FailureCaseOut, Symptom

COMPONENT_SEGMENT_INDEX = 1

TOOL_AFTER = "tool.execute.after"

MAX_ERROR_LEN = 500


@dataclass
class Extraction:
    run_id: str
    task: str | None
    task_type: str | None
    files: list[str]
    components: list[str]
    tool_calls: list[str]
    errors: list[str]
    change_patterns: list[str]
    failure_mode: str | None
    fix_pattern: str | None
    symptoms: list[Symptom] = field(default_factory=list)


def extract(ctx: RunContext, failure_case: FailureCaseOut | None = None) -> Extraction:
    tool_calls = _collect_tool_calls(ctx.events)
    errors = _collect_errors(ctx.events)
    components = extract_components(ctx.files)

    if failure_case:
        return Extraction(
            run_id=ctx.run_id,
            task=ctx.task,
            task_type=failure_case.task_type,
            files=ctx.files,
            components=components,
            tool_calls=tool_calls,
            errors=errors,
            change_patterns=failure_case.change_patterns,
            failure_mode=failure_case.failure_mode,
            fix_pattern=failure_case.fix_pattern,
            symptoms=failure_case.symptoms,
        )

    return Extraction(
        run_id=ctx.run_id,
        task=ctx.task,
        task_type=None,
        files=ctx.files,
        components=components,
        tool_calls=tool_calls,
        errors=errors,
        change_patterns=[],
        failure_mode=None,
        fix_pattern=None,
    )


def extract_components(files: list[str]) -> list[str]:
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


def _collect_tool_calls(events: list[dict]) -> list[str]:
    seen: set[str] = set()
    tools: list[str] = []
    for ev in events:
        if ev.get("type") != TOOL_AFTER:
            continue
        props = ev.get("properties") or {}
        tool = props.get("tool")
        if tool and tool not in seen:
            seen.add(tool)
            tools.append(tool)
    return tools


def _collect_errors(events: list[dict]) -> list[str]:
    errors: list[str] = []
    for ev in events:
        if ev.get("type") != TOOL_AFTER:
            continue
        props = ev.get("properties") or {}
        result = props.get("result") or {}

        stderr = result.get("stderr", "")
        if stderr and stderr.strip():
            errors.append(stderr.strip()[:MAX_ERROR_LEN])
            continue

        exit_code = result.get("exitCode")
        if exit_code is not None and exit_code != 0:
            stdout = result.get("stdout", "")
            snippet = stdout.strip()[:MAX_ERROR_LEN] if stdout else f"exit code {exit_code}"
            errors.append(snippet)

    return errors

"""Extract entities (Files, Components, ChangePatterns) from a Run.

Produces an Extraction dataclass that the graph writer can consume to create
nodes and edges. Combines raw run data (RunContext) with classifier output
(FailureCaseOut) into a single structured representation.

Tool-output shape support:

* New (opencode 1.x via plugin/src/handlers/tool-after.ts):
    result = {title, output_preview, output_size, metadata, ok, error}
* Legacy (test fixtures, older recorders):
    result = {stderr, exitCode, stdout, diff}

Both are handled.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import FailureCaseOut, Symptom

COMPONENT_SEGMENT_INDEX = 1

TOOL_AFTER = "tool.execute.after"

MAX_ERROR_LEN = 500
MAX_TOOL_EXAMPLES = 5
MAX_ARG_SUMMARY_LEN = 200


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
    # Per-tool usage breakdown: { tool_name: {count, failures, examples[]} }.
    # Drives the knowledge graph's "what tools were used" texture.
    tool_usage: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Per-file diff text. Populated from the classifier's RunContext for
    # hybrid retrieval (Phase 4): each file's patch becomes its own
    # embedding row keyed ``patch:<run_id>:<path>``.
    patches: dict[str, str] = field(default_factory=dict)


def extract(ctx: RunContext, failure_case: FailureCaseOut | None = None) -> Extraction:
    tool_calls = _collect_tool_calls(ctx.events)
    errors = _collect_errors(ctx.events)
    tool_usage = _collect_tool_usage(ctx.events)
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
            tool_usage=tool_usage,
            patches=dict(ctx.patches),
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
        tool_usage=tool_usage,
        patches=dict(ctx.patches),
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


def _is_failure(result: dict) -> bool:
    """True when a tool.execute.after result represents a failure.

    Supports both the new plugin shape (`ok` boolean) and the legacy
    `{stderr, exitCode}` shape used by fixtures and older recorders.
    """
    if "ok" in result:
        return result.get("ok") is False
    if (result.get("stderr") or "").strip():
        return True
    exit_code = result.get("exitCode")
    return exit_code is not None and exit_code != 0


def _error_message(result: dict) -> str | None:
    """Extract a one-line error description from a failed result."""
    # New shape: plugin already chose a representative error line.
    err = result.get("error")
    if isinstance(err, str) and err.strip():
        return err.strip()[:MAX_ERROR_LEN]

    # Legacy: stderr → stdout snippet → exit code.
    stderr = (result.get("stderr") or "").strip()
    if stderr:
        return stderr[:MAX_ERROR_LEN]

    exit_code = result.get("exitCode")
    if exit_code is not None and exit_code != 0:
        stdout = (result.get("stdout") or "").strip()
        return (stdout or f"exit code {exit_code}")[:MAX_ERROR_LEN]

    # New-shape fallback when `error` was not set but ok=False.
    preview = (result.get("output_preview") or "").strip()
    if preview:
        return preview.splitlines()[0][:MAX_ERROR_LEN]

    return None


def _collect_errors(events: list[dict]) -> list[str]:
    errors: list[str] = []
    for ev in events:
        if ev.get("type") != TOOL_AFTER:
            continue
        props = ev.get("properties") or {}
        result = props.get("result") or {}
        if not _is_failure(result):
            continue
        msg = _error_message(result)
        if msg:
            errors.append(msg)
    return errors


def _summarize_args(tool: str, args: dict | None) -> str:
    """One-line, tool-specific summary of arguments for the knowledge graph.

    Examples:
        bash:  "pytest -q"
        edit:  "src/foo.py"
        grep:  "TODO"
    """
    if not args:
        return ""
    if tool == "bash":
        return str(args.get("command") or "")[:MAX_ARG_SUMMARY_LEN]
    if tool in ("edit", "write", "read"):
        path = args.get("filePath") or args.get("path") or ""
        return str(path)[:MAX_ARG_SUMMARY_LEN]
    if tool in ("grep", "glob"):
        return str(args.get("pattern") or "")[:MAX_ARG_SUMMARY_LEN]
    if tool == "webfetch":
        return str(args.get("url") or "")[:MAX_ARG_SUMMARY_LEN]
    return ""


def _collect_tool_usage(events: list[dict]) -> dict[str, dict[str, Any]]:
    usage: dict[str, dict[str, Any]] = {}
    for ev in events:
        if ev.get("type") != TOOL_AFTER:
            continue
        props = ev.get("properties") or {}
        tool = props.get("tool")
        if not tool:
            continue
        bucket = usage.setdefault(tool, {"count": 0, "failures": 0, "examples": []})
        bucket["count"] += 1
        result = props.get("result") or {}
        if _is_failure(result):
            bucket["failures"] += 1
        summary = _summarize_args(tool, props.get("args"))
        examples = bucket["examples"]
        if summary and summary not in examples and len(examples) < MAX_TOOL_EXAMPLES:
            examples.append(summary)
    return usage

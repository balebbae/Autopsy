#!/usr/bin/env python3
"""Demo benchmark: Opus 4.5 vs Opus 4.7 vs Opus 4.7 + Autopsy.

Replays fixture runs through the AAG service, measures timing, calls
preflight where appropriate, and prints a comparison table suitable for
a live judge demo.

The benchmark tells a three-act story:

  Act 1 — Opus 4.5 (baseline):
      4.5 is optimised for agentic coding (Cursor/Codex/Windsurf all
      trained on it). It completes the schema-change task correctly on
      the first try.

  Act 2 — Opus 4.7 without Autopsy:
      4.7 is smarter overall but not tuned for tool-use workflows. It
      edits the code but forgets the migration and frontend types → run
      is rejected. The failure is ingested and the graph learns.

  Act 3 — Opus 4.7 WITH Autopsy:
      Same model, same task.  This time the preflight injects a warning
      from the failure graph. 4.7 sees the addendum, does the migration
      and type regen, and the run passes.

Usage:
    make demo-benchmark          # full three-act run
    make demo-benchmark-quick    # skip seeding, assume graph is warm

Requires the service to be running at AAG_URL (default localhost:4000)
and the graph to be seeded (``make seed`` or ``make demo-prep``).
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")
FIXTURES = Path(__file__).resolve().parent.parent / "contracts" / "fixtures"
REPORT_OUT = Path(__file__).resolve().parent.parent / "benchmark-report.json"

# ── colour helpers ──────────────────────────────────────────────────────

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR", "") == ""


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _USE_COLOR else s


def _bold(s: str) -> str:
    return _c("1", s)


def _dim(s: str) -> str:
    return _c("2", s)


def _ok(s: str) -> str:
    return _c("32", s)


def _err(s: str) -> str:
    return _c("31", s)


def _warn(s: str) -> str:
    return _c("33", s)


def _cyan(s: str) -> str:
    return _c("36", s)


# ── data types ──────────────────────────────────────────────────────────

Outcome = Literal["approved", "rejected"]


@dataclass
class StepTiming:
    label: str
    elapsed_ms: float


@dataclass
class BenchResult:
    run_id: str
    model: str
    label: str
    outcome: Outcome
    tool_calls: int
    files_touched: int
    preflight_risk: str | None = None
    preflight_addendum: str | None = None
    preflight_block: bool = False
    total_ms: float = 0.0
    steps: list[StepTiming] = field(default_factory=list)
    error: str | None = None


# ── fixture loading ─────────────────────────────────────────────────────


def _load_fixture(name: str) -> dict:
    path = FIXTURES / name
    if not path.exists():
        raise FileNotFoundError(f"fixture not found: {path}")
    return json.loads(path.read_text())


# ── replay a fixture into the service ───────────────────────────────────


def _replay_events(
    client: httpx.Client,
    fixture: dict,
    *,
    delay_between: float = 0.0,
) -> tuple[int, float]:
    """POST each event, return (count, elapsed_ms)."""
    t0 = time.monotonic()
    count = 0
    for ev in fixture["events"]:
        resp = client.post("/v1/events", json={"events": [ev]})
        resp.raise_for_status()
        count += 1
        if delay_between > 0:
            time.sleep(delay_between)
    elapsed = (time.monotonic() - t0) * 1000
    return count, elapsed


def _post_outcome(
    client: httpx.Client,
    run_id: str,
    outcome: str,
    feedback: str | None,
) -> float:
    t0 = time.monotonic()
    body: dict[str, object] = {"outcome": outcome}
    if feedback:
        body["feedback"] = feedback
    resp = client.post(f"/v1/runs/{run_id}/outcome", json=body)
    resp.raise_for_status()
    return (time.monotonic() - t0) * 1000


def _call_preflight(
    client: httpx.Client,
    task: str,
    run_id: str | None = None,
) -> tuple[dict, float]:
    t0 = time.monotonic()
    body: dict[str, object] = {
        "task": task,
        "project": "demo-monorepo",
        "worktree": "/tmp/demo-monorepo",
    }
    if run_id:
        body["run_id"] = run_id
    resp = client.post("/v1/preflight", json=body, timeout=30.0)
    resp.raise_for_status()
    return resp.json(), (time.monotonic() - t0) * 1000


# ── individual benchmark acts ──────────────────────────────────────────


def _count_tool_calls(fixture: dict) -> int:
    return sum(
        1 for ev in fixture["events"] if ev["type"] in ("tool.execute.after", "tool.execute.before")
    )


def _count_files(fixture: dict) -> int:
    files: set[str] = set()
    for ev in fixture["events"]:
        if ev["type"] == "tool.execute.after":
            args = ev.get("properties", {}).get("args", {})
            fp = args.get("filePath")
            if fp:
                files.add(fp)
    return len(files)


def _task_from_fixture(fixture: dict) -> str:
    for ev in fixture["events"]:
        if ev["type"] == "session.created":
            return ev["properties"]["info"]["title"]
    return fixture.get("label", "unknown")


def run_act(
    client: httpx.Client,
    fixture_name: str,
    *,
    do_preflight: bool = False,
    act_number: int,
) -> BenchResult:
    fixture = _load_fixture(fixture_name)
    run_id = fixture["run_id"]
    model = fixture.get("model", "unknown")
    label = fixture.get("label", fixture_name)
    outcome: Outcome = fixture.get("outcome", "approved")
    feedback = fixture.get("feedback")
    task = _task_from_fixture(fixture)

    result = BenchResult(
        run_id=run_id,
        model=model,
        label=label,
        outcome=outcome,
        tool_calls=_count_tool_calls(fixture),
        files_touched=_count_files(fixture),
    )

    print()
    print(_bold(f"{'=' * 60}"))
    print(_bold(f"  ACT {act_number}: {label}"))
    print(_bold(f"{'=' * 60}"))
    print(_dim(f"  model: {model}"))
    print(_dim(f"  task:  {task!r}"))
    if fixture.get("description"):
        print(_dim(f"  why:   {fixture['description']}"))
    print()

    total_t0 = time.monotonic()

    # 1. Preflight (if applicable)
    if do_preflight:
        print(f"  {'[preflight]':<20}", end="", flush=True)
        try:
            pf_resp, pf_ms = _call_preflight(client, task, run_id)
            result.preflight_risk = pf_resp.get("risk_level", "none")
            result.preflight_addendum = pf_resp.get("system_addendum")
            result.preflight_block = bool(pf_resp.get("block"))
            result.steps.append(StepTiming("preflight", pf_ms))

            risk_color = _ok if result.preflight_risk == "none" else _warn
            if result.preflight_risk in ("high",):
                risk_color = _err
            print(
                f" risk={risk_color(result.preflight_risk or 'none')}"
                f"  block={result.preflight_block}"
                f"  {_dim(f'{pf_ms:.0f}ms')}"
            )
            if result.preflight_addendum:
                # Show first 120 chars of addendum for the demo
                preview = result.preflight_addendum[:120]
                if len(result.preflight_addendum) > 120:
                    preview += "..."
                print(f"  {'':20} {_cyan(preview)}")
        except Exception as exc:
            result.steps.append(StepTiming("preflight", 0))
            print(_err(f" error: {exc}"))

    # 2. Replay events
    print(f"  {'[replay events]':<20}", end="", flush=True)
    n_events, replay_ms = _replay_events(client, fixture)
    result.steps.append(StepTiming("replay_events", replay_ms))
    print(f" {n_events} events  {_dim(f'{replay_ms:.0f}ms')}")

    # 3. Post outcome (triggers analyzer)
    print(f"  {'[outcome]':<20}", end="", flush=True)
    outcome_ms = _post_outcome(client, run_id, outcome, feedback)
    result.steps.append(StepTiming("outcome", outcome_ms))
    outcome_str = _ok(outcome) if outcome == "approved" else _err(outcome)
    print(f" {outcome_str}  {_dim(f'{outcome_ms:.0f}ms')}")

    result.total_ms = (time.monotonic() - total_t0) * 1000

    # Summary line
    print()
    if outcome == "approved":
        print(_ok(f"  >>> PASS — {model} completed the task in {result.total_ms:.0f}ms"))
    else:
        print(_err(f"  >>> FAIL — {model} was rejected ({result.total_ms:.0f}ms wasted)"))
    if feedback:
        print(_dim(f"      feedback: {feedback!r}"))

    return result


# ── comparison table ────────────────────────────────────────────────────


def _print_comparison(results: list[BenchResult]) -> None:
    print()
    print(_bold(f"{'=' * 72}"))
    print(_bold("  BENCHMARK COMPARISON"))
    print(_bold(f"{'=' * 72}"))
    print()

    # Header
    hdr = f"  {'Model':<18} {'Outcome':<12} {'Tool Calls':<12} {'Files':<8} {'Time (ms)':<12} {'Preflight'}"
    print(_bold(hdr))
    print(f"  {'─' * 70}")

    for r in results:
        outcome_str = _ok("PASS") if r.outcome == "approved" else _err("FAIL")
        pf_str = "—"
        if r.preflight_risk is not None:
            pf_str = r.preflight_risk
            if r.preflight_risk in ("high", "medium"):
                pf_str = _warn(pf_str)
        print(
            f"  {r.model:<18} {outcome_str:<21} {r.tool_calls:<12} "
            f"{r.files_touched:<8} {r.total_ms:<12.0f} {pf_str}"
        )

    print(f"  {'─' * 70}")
    print()

    # Narrative summary
    rejected = [r for r in results if r.outcome == "rejected"]
    autopsy_run = next(
        (r for r in results if r.preflight_risk and r.preflight_risk != "none"),
        None,
    )

    if rejected and autopsy_run and autopsy_run.outcome == "approved":
        wasted = sum(r.total_ms for r in rejected)
        print(_bold("  Key Takeaway:"))
        print(f"  Without Autopsy, {rejected[0].model} wasted {wasted:.0f}ms on a rejected run.")
        print(f"  With Autopsy's preflight warning (risk={autopsy_run.preflight_risk}),")
        print(f"  the same model completed correctly in {autopsy_run.total_ms:.0f}ms.")
        if autopsy_run.preflight_addendum:
            print()
            print(_dim("  Autopsy injected this warning into the model's context:"))
            print(_cyan(f'  "{autopsy_run.preflight_addendum[:200]}..."'))
    print()


def _write_report(results: list[BenchResult]) -> None:
    report = {
        "benchmark": "opus-model-comparison",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "results": [],
    }
    for r in results:
        report["results"].append(
            {
                "run_id": r.run_id,
                "model": r.model,
                "label": r.label,
                "outcome": r.outcome,
                "tool_calls": r.tool_calls,
                "files_touched": r.files_touched,
                "total_ms": round(r.total_ms, 1),
                "preflight_risk": r.preflight_risk,
                "preflight_block": r.preflight_block,
                "preflight_addendum": r.preflight_addendum,
                "steps": [
                    {"label": s.label, "elapsed_ms": round(s.elapsed_ms, 1)} for s in r.steps
                ],
                "error": r.error,
            }
        )
    REPORT_OUT.write_text(json.dumps(report, indent=2) + "\n")
    print(_dim(f"  JSON report written to {REPORT_OUT}"))


# ── scenario definitions ───────────────────────────────────────────────

SCENARIOS: list[dict] = [
    {
        "fixture": "bench-opus45-pass.json",
        "do_preflight": False,
        "label": "Opus 4.5 baseline",
    },
    {
        "fixture": "bench-opus47-fail.json",
        "do_preflight": False,
        "label": "Opus 4.7 without Autopsy",
    },
    {
        "fixture": "bench-opus47-autopsy-pass.json",
        "do_preflight": True,
        "label": "Opus 4.7 WITH Autopsy",
    },
]


# ── multi-prompt repeatable test mode ──────────────────────────────────

REPEAT_PROMPTS: list[dict] = [
    {
        "task": "Add displayName to user profile API and UI",
        "label": "Schema field addition (displayName)",
    },
    {
        "task": "Add nickname to the user model",
        "label": "Schema field addition (nickname)",
    },
    {
        "task": "Extend the Order interface with a shipping address",
        "label": "Schema field addition (shippingAddress)",
    },
    {
        "task": "Add preferredName to user profile endpoint",
        "label": "Schema field addition (preferredName)",
    },
    {
        "task": "Refactor the authentication helper to use parseInt",
        "label": "Refactor without tests",
    },
]


def run_preflight_sweep(client: httpx.Client) -> None:
    """Fire the same / similar prompts through preflight to show retrieval."""
    print()
    print(_bold(f"{'=' * 72}"))
    print(_bold("  PREFLIGHT SWEEP — testing retrieval on repeated prompts"))
    print(_bold(f"{'=' * 72}"))
    print()
    print(
        _dim(
            "  Each prompt is sent to /v1/preflight. If the graph has a matching\n"
            "  failure, Autopsy returns a risk level and system addendum."
        )
    )
    print()

    hdr = f"  {'Prompt':<50} {'Risk':<10} {'Addendum?':<10} {'Time'}"
    print(_bold(hdr))
    print(f"  {'─' * 70}")

    for p in REPEAT_PROMPTS:
        task = p["task"]
        label = task[:47] + "..." if len(task) > 50 else task
        try:
            pf_resp, pf_ms = _call_preflight(client, task)
            risk = pf_resp.get("risk_level", "none")
            has_addendum = bool(pf_resp.get("system_addendum"))
            risk_str = risk
            if risk in ("high", "medium"):
                risk_str = _warn(risk)
            elif risk == "none":
                risk_str = _dim(risk)
            add_str = _ok("yes") if has_addendum else _dim("no")
            print(f"  {label:<50} {risk_str:<19} {add_str:<19} {_dim(f'{pf_ms:.0f}ms')}")
        except Exception as exc:
            print(f"  {label:<50} {_err('error'):<10} {str(exc)[:30]}")

    print(f"  {'─' * 70}")
    print()


# ── entrypoint ─────────────────────────────────────────────────────────


def main() -> int:
    skip_seed = "--quick" in sys.argv or "--skip-seed" in sys.argv
    sweep_only = "--sweep" in sys.argv

    print(_bold("\n  Agent Autopsy Graph — Demo Benchmark"))
    print(_bold("  Opus 4.5 vs 4.7 vs 4.7+Autopsy\n"))

    with httpx.Client(base_url=AAG_URL, timeout=30.0) as client:
        # Health check
        try:
            client.get("/v1/health").raise_for_status()
            print(_ok(f"  service OK at {AAG_URL}"))
        except Exception:
            print(_err(f"  service not reachable at {AAG_URL}"))
            print(_dim("  start it with: make service-dev"))
            return 1

        # Seed if needed
        if not skip_seed:
            print(_dim("\n  seeding graph (idempotent)..."))
            here = os.path.dirname(os.path.abspath(__file__))
            sys.path.insert(0, here)
            from seed import main as seed_main

            seed_rc = seed_main()
            if seed_rc != 0:
                print(_err("  seed failed"))
                return 1
            print(_ok("  graph seeded"))

        if sweep_only:
            run_preflight_sweep(client)
            return 0

        # Run the three acts
        results: list[BenchResult] = []
        for i, scenario in enumerate(SCENARIOS, 1):
            result = run_act(
                client,
                scenario["fixture"],
                do_preflight=scenario["do_preflight"],
                act_number=i,
            )
            results.append(result)

        # Print comparison
        _print_comparison(results)

        # Preflight sweep
        run_preflight_sweep(client)

        # Write JSON report
        _write_report(results)

    return 0


if __name__ == "__main__":
    sys.exit(main())

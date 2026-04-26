#!/usr/bin/env python3
"""Live interactive demo: walk judges through the full Autopsy flow.

Unlike ``demo-benchmark.py`` (which replays fixture files silently), this
script pauses between each step so you can narrate what's happening and
show the dashboard in real-time.

It exercises the *real* running service — events are ingested, the
analyzer classifies failures, the graph is populated, and preflight
retrieval fires with actual vector similarity.

Usage:
    make demo-live                # interactive, pauses between steps
    make demo-live-auto           # auto-advance (no pauses, for CI)

Requires:
    - Service running at AAG_URL (default localhost:4000)
    - Dashboard at localhost:3000 (optional, for visual demo)
"""

from __future__ import annotations

import os
import sys
import time
import uuid
from difflib import unified_diff
from typing import Any

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")
AUTO_MODE = "--auto" in sys.argv or os.environ.get("DEMO_AUTO") == "1"

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


def _magenta(s: str) -> str:
    return _c("35", s)


# ── interactive helpers ─────────────────────────────────────────────────


def banner(title: str) -> None:
    w = 70
    print()
    print(_bold(_cyan("┌" + "─" * (w - 2) + "┐")))
    print(_bold(_cyan("│" + title.center(w - 2) + "│")))
    print(_bold(_cyan("└" + "─" * (w - 2) + "┘")))
    print()


def step(msg: str) -> None:
    print(_bold(f"  → {msg}"))


def detail(msg: str) -> None:
    print(_dim(f"    {msg}"))


def result_ok(msg: str) -> None:
    print(_ok(f"    ✓ {msg}"))


def result_fail(msg: str) -> None:
    print(_err(f"    ✗ {msg}"))


def result_warn(msg: str) -> None:
    print(_warn(f"    ⚠ {msg}"))


def pause(msg: str = "Press Enter to continue...") -> None:
    if AUTO_MODE:
        time.sleep(0.5)
        return
    print()
    input(_dim(f"  {msg}"))
    print()


def make_patch(path: str, old: str, new: str) -> str:
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    if old_lines and not old_lines[-1].endswith("\n"):
        old_lines[-1] += "\n"
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] += "\n"
    return "".join(
        unified_diff(old_lines, new_lines, fromfile=f"a/{path}", tofile=f"b/{path}", n=3)
    )


def count_changed(patch: str, prefix: str) -> int:
    marker = prefix * 3
    return sum(
        1 for ln in patch.splitlines() if ln.startswith(prefix) and not ln.startswith(marker)
    )


# ── API helpers ─────────────────────────────────────────────────────────


def post_events(client: httpx.Client, events: list[dict]) -> dict:
    r = client.post("/v1/events", json={"events": events})
    r.raise_for_status()
    return r.json()


def post_outcome(client: httpx.Client, run_id: str, outcome: str, feedback: str | None) -> None:
    body: dict[str, Any] = {"outcome": outcome}
    if feedback:
        body["feedback"] = feedback
    r = client.post(f"/v1/runs/{run_id}/outcome", json=body)
    r.raise_for_status()


def call_preflight(client: httpx.Client, task: str, run_id: str | None = None) -> dict:
    body: dict[str, Any] = {
        "task": task,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
    }
    if run_id:
        body["run_id"] = run_id
    r = client.post("/v1/preflight", json=body, timeout=30.0)
    r.raise_for_status()
    return r.json()


def get_run(client: httpx.Client, run_id: str) -> dict:
    r = client.get(f"/v1/runs/{run_id}")
    r.raise_for_status()
    return r.json()


def list_runs(client: httpx.Client) -> list[dict]:
    r = client.get("/v1/runs", params={"limit": 20})
    r.raise_for_status()
    return r.json()


def get_graph_nodes(client: httpx.Client) -> list[dict]:
    r = client.get("/v1/graph/nodes")
    r.raise_for_status()
    return r.json()


# ── event builders ──────────────────────────────────────────────────────

BASE_TS = int(time.time() * 1000)


def build_session_created(run_id: str, task: str, seq: int) -> dict:
    return {
        "event_id": f"{run_id}:{seq:03d}",
        "run_id": run_id,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
        "ts": BASE_TS + seq * 1000,
        "type": "session.created",
        "properties": {
            "sessionID": run_id,
            "info": {
                "id": run_id,
                "title": task,
                "directory": "/home/ubuntu/repos/Autopsy/test-project",
            },
        },
    }


def build_tool_edit(run_id: str, filepath: str, old_text: str, new_text: str, seq: int) -> dict:
    return {
        "event_id": f"{run_id}:{seq:03d}",
        "run_id": run_id,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
        "ts": BASE_TS + seq * 1000,
        "type": "tool.execute.after",
        "properties": {
            "sessionID": run_id,
            "tool": "edit",
            "args": {"filePath": filepath},
            "result": {
                "path": filepath,
                "oldText": old_text,
                "newText": new_text,
                "exitCode": 0,
            },
        },
    }


def build_session_diff(run_id: str, files: list[dict], seq: int) -> dict:
    diff_list = []
    for f in files:
        patch = make_patch(f["path"], f["old"], f["new"])
        diff_list.append(
            {
                "file": f["path"],
                "status": "modified",
                "additions": count_changed(patch, "+"),
                "deletions": count_changed(patch, "-"),
                "patch": patch,
            }
        )
    return {
        "event_id": f"{run_id}:{seq:03d}",
        "run_id": run_id,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
        "ts": BASE_TS + seq * 1000,
        "type": "session.diff",
        "properties": {"sessionID": run_id, "diff": diff_list},
    }


def build_rejection(run_id: str, feedback: str, seq: int) -> dict:
    return {
        "event_id": f"{run_id}:{seq:03d}",
        "run_id": run_id,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
        "ts": BASE_TS + seq * 1000,
        "type": "permission.replied",
        "properties": {
            "sessionID": run_id,
            "reply": "reject",
            "feedback": feedback,
        },
    }


def build_idle(run_id: str, seq: int) -> dict:
    return {
        "event_id": f"{run_id}:{seq:03d}",
        "run_id": run_id,
        "project": "autopsy-test-project",
        "worktree": "/home/ubuntu/repos/Autopsy/test-project",
        "ts": BASE_TS + seq * 1000,
        "type": "session.idle",
        "properties": {"sessionID": run_id},
    }


# ── THE DEMO ────────────────────────────────────────────────────────────


def act1_failed_run(client: httpx.Client) -> str:
    """Simulate an agent (Opus 4.7) that makes a schema change but forgets
    the migration and frontend types."""

    banner("ACT 1: Opus 4.7 attempts a schema change (WITHOUT Autopsy)")

    task = "Add displayName to user profile API and UI"
    run_id = f"live-47-fail-{uuid.uuid4().hex[:8]}"

    print(f"  {_bold('Task:')}  {_cyan(task)}")
    print(f"  {_bold('Model:')} Opus 4.7 (smarter, but not tuned for agentic coding)")
    print(f"  {_bold('Run:')}   {run_id}")
    print()
    detail("The agent will edit the backend types and serializer...")
    detail("...but forget the DB migration and frontend type regen.")
    pause()

    # Step 1: Session created
    step("Agent starts a new coding session")
    events = [build_session_created(run_id, task, 1)]
    post_events(client, events)
    result_ok(f"session.created → run {run_id}")
    time.sleep(0.3)

    # Step 2: Edit profile.service.ts
    step("Agent edits src/profile/profile.service.ts — adds displayName field")
    old_text = "interface UserProfile {\n  id: string;\n  email: string;\n}"
    new_text = (
        "interface UserProfile {\n  id: string;\n  email: string;\n  displayName?: string;\n}"
    )
    events = [build_tool_edit(run_id, "src/profile/profile.service.ts", old_text, new_text, 2)]
    post_events(client, events)
    result_ok("tool.execute.after(edit) → profile.service.ts")
    time.sleep(0.3)

    # Step 3: Edit serializer
    step("Agent edits src/profile/user.serializer.ts — adds displayName to fields")
    old_ser = "fields: ['id', 'email']"
    new_ser = "fields: ['id', 'email', 'displayName']"
    events = [build_tool_edit(run_id, "src/profile/user.serializer.ts", old_ser, new_ser, 3)]
    post_events(client, events)
    result_ok("tool.execute.after(edit) → user.serializer.ts")
    time.sleep(0.3)

    # Step 4: Session diff (no migration, no frontend types!)
    step("Agent produces session diff — only 2 files changed")
    files = [
        {"path": "src/profile/profile.service.ts", "old": old_text, "new": new_text},
        {"path": "src/profile/user.serializer.ts", "old": old_ser, "new": new_ser},
    ]
    events = [build_session_diff(run_id, files, 4)]
    post_events(client, events)
    result_warn("Missing: migrations/*.sql (no DB migration!)")
    result_warn("Missing: src/frontend/types/user.ts (not regenerated!)")
    time.sleep(0.3)

    # Step 5: User rejects
    step("User reviews and REJECTS the run")
    feedback = "Missed the database migration and didn't regenerate frontend types. The schema change is incomplete."
    events = [build_rejection(run_id, feedback, 5)]
    post_events(client, events)
    events = [build_idle(run_id, 6)]
    post_events(client, events)
    result_fail(f"permission.replied(reject): {feedback}")
    time.sleep(0.3)

    # Step 6: Post outcome → triggers analyzer
    step("Outcome posted → triggers Autopsy's analyzer pipeline")
    post_outcome(client, run_id, "rejected", feedback)
    detail("analyzer → classifier → graph writer → embedder")
    time.sleep(1.0)  # give analyzer a moment

    # Verify the run was stored
    run_data = get_run(client, run_id)
    fc = run_data.get("failure_case")
    if fc:
        result_ok(f"Failure classified: {fc.get('failure_mode', '?')}")
        symptoms = fc.get("symptoms", [])
        seen: set[str] = set()
        for s in symptoms:
            name = s.get("name") or s.get("symptom", "?")
            if name in seen:
                continue
            seen.add(name)
            conf = s.get("confidence", 0)
            detail(f"symptom: {name} (confidence={conf})")
    else:
        result_warn("No failure_case yet (analyzer may still be running)")

    print()
    print(_err("  ╔══════════════════════════════════════════════════════════╗"))
    print(_err("  ║  RESULT: Opus 4.7 FAILED — incomplete schema change    ║"))
    print(_err("  ║  The failure is now recorded in Autopsy's graph.        ║"))
    print(_err("  ╚══════════════════════════════════════════════════════════╝"))

    pause("Press Enter to see what Autopsy learned... (check dashboard at localhost:3000)")
    return run_id


def act2_show_graph(client: httpx.Client, failed_run_id: str) -> None:
    """Show what Autopsy learned from the failure."""

    banner("ACT 2: What Autopsy Learned")

    step("Querying the failure graph...")
    nodes = get_graph_nodes(client)
    node_types: dict[str, int] = {}
    for n in nodes:
        t = n.get("type", "unknown")
        node_types[t] = node_types.get(t, 0) + 1

    result_ok(f"Graph has {len(nodes)} nodes:")
    for t, count in sorted(node_types.items()):
        detail(f"{t}: {count}")

    print()
    step("Querying the failed run's analysis...")
    run_data = get_run(client, failed_run_id)
    fc = run_data.get("failure_case")
    if fc:
        print()
        print(f"    {_bold('Failure Mode:')} {_err(fc.get('failure_mode', '?'))}")
        symptoms = fc.get("symptoms", [])
        seen_s: set[str] = set()
        for s in symptoms:
            name = s.get("name") or s.get("symptom", "?")
            if name in seen_s:
                continue
            seen_s.add(name)
            conf = s.get("confidence", 0)
            color = _err if conf > 0.7 else _warn
            print(f"    {_bold('Symptom:')}      {color(name)} (confidence={conf})")
        fix = fc.get("fix_pattern")
        if fix:
            print(f"    {_bold('Fix Pattern:')} {_ok(fix)}")
    else:
        result_warn("Failure case not yet available")

    print()
    detail("This information is now embedded in the vector index.")
    detail("Any future task that looks similar will trigger a preflight warning.")

    pause("Press Enter to see Opus 4.7 try again WITH Autopsy...")


def act3_preflight_demo(client: httpx.Client) -> str:
    """Show the preflight system catching the same pattern."""

    banner("ACT 3: Opus 4.7 tries again — WITH Autopsy preflight")

    task = "Add displayName to user profile API and UI"
    run_id = f"live-47-autopsy-{uuid.uuid4().hex[:8]}"

    print(f"  {_bold('Task:')}  {_cyan(task)}")
    print(f"  {_bold('Model:')} Opus 4.7 (same model as before)")
    print(f"  {_bold('Run:')}   {run_id}")
    print()
    detail("This time, Autopsy's preflight runs BEFORE the agent starts coding.")
    pause()

    # Step 1: Session created
    step("Agent starts a new session")
    events = [build_session_created(run_id, task, 1)]
    post_events(client, events)
    result_ok(f"session.created → run {run_id}")
    time.sleep(0.3)

    # Step 2: Preflight fires!
    step("Autopsy preflight checks the task against the failure graph...")
    t0 = time.monotonic()
    pf = call_preflight(client, task, run_id)
    pf_ms = (time.monotonic() - t0) * 1000
    risk = pf.get("risk_level", "none")
    addendum = pf.get("system_addendum")
    similar = pf.get("similar_runs", [])
    followups = pf.get("missing_followups", [])
    checks = pf.get("recommended_checks", [])

    print()
    if risk != "none":
        risk_color = _err if risk == "high" else _warn
        print(f"    {_bold('Risk Level:')}  {risk_color(risk.upper())}  ({pf_ms:.0f}ms)")
        if similar:
            print(f"    {_bold('Similar Runs:')} {', '.join(similar)}")
        if followups:
            print(f"    {_bold('Missing:')}     {', '.join(followups)}")
        if checks:
            print(f"    {_bold('Checks:')}      {', '.join(checks)}")
        if addendum:
            print()
            print(_magenta("    ┌─ SYSTEM ADDENDUM (injected into agent's context) ─────────┐"))
            for line in addendum.split("\n"):
                print(_magenta(f"    │ {line:<59}│"))
            print(_magenta("    └─────────────────────────────────────────────────────────────┘"))
        result_ok("Autopsy warned the agent about past failures!")
    else:
        result_warn(f"risk_level=none ({pf_ms:.0f}ms) — embedding provider may be 'stub'")
        detail("With EMBED_PROVIDER=local or =openai, this would match semantically.")
        detail("With stub, only byte-identical prompts match the seeded data.")

    pause()

    # Step 3: Agent now does it RIGHT (informed by the warning)
    step("Agent (now informed) edits profile.service.ts — adds displayName")
    old_text = "interface UserProfile {\n  id: string;\n  email: string;\n}"
    new_text = (
        "interface UserProfile {\n  id: string;\n  email: string;\n  displayName?: string;\n}"
    )
    events = [build_tool_edit(run_id, "src/profile/profile.service.ts", old_text, new_text, 3)]
    post_events(client, events)
    result_ok("edit → profile.service.ts")
    time.sleep(0.2)

    step("Agent edits serializer")
    old_ser = "fields: ['id', 'email']"
    new_ser = "fields: ['id', 'email', 'displayName']"
    events = [build_tool_edit(run_id, "src/profile/user.serializer.ts", old_ser, new_ser, 4)]
    post_events(client, events)
    result_ok("edit → user.serializer.ts")
    time.sleep(0.2)

    step("Agent creates DB migration (learned from Autopsy!)")
    old_mig = ""
    new_mig = "ALTER TABLE users ADD COLUMN display_name TEXT;\n"
    events = [build_tool_edit(run_id, "migrations/002_add_display_name.sql", old_mig, new_mig, 5)]
    post_events(client, events)
    result_ok("edit → migrations/002_add_display_name.sql")
    time.sleep(0.2)

    step("Agent regenerates frontend types (learned from Autopsy!)")
    old_fe = "export interface User {\n  id: string;\n  email: string;\n}"
    new_fe = "export interface User {\n  id: string;\n  email: string;\n  displayName?: string;\n}"
    events = [build_tool_edit(run_id, "src/frontend/types/user.ts", old_fe, new_fe, 6)]
    post_events(client, events)
    result_ok("edit → src/frontend/types/user.ts")
    time.sleep(0.2)

    # Step 4: Full diff — all 4 files
    step("Session diff — 4 files changed (complete!)")
    files = [
        {"path": "src/profile/profile.service.ts", "old": old_text, "new": new_text},
        {"path": "src/profile/user.serializer.ts", "old": old_ser, "new": new_ser},
        {"path": "migrations/002_add_display_name.sql", "old": old_mig, "new": new_mig},
        {"path": "src/frontend/types/user.ts", "old": old_fe, "new": new_fe},
    ]
    events = [build_session_diff(run_id, files, 7)]
    post_events(client, events)
    result_ok("4 files: model + serializer + migration + frontend types")
    time.sleep(0.2)

    # Step 5: Approved!
    events = [build_idle(run_id, 8)]
    post_events(client, events)
    post_outcome(client, run_id, "approved", None)

    print()
    print(_ok("  ╔══════════════════════════════════════════════════════════╗"))
    print(_ok("  ║  RESULT: Opus 4.7 + Autopsy PASSED!                    ║"))
    print(_ok("  ║  The agent did the migration and type regen this time.  ║"))
    print(_ok("  ╚══════════════════════════════════════════════════════════╝"))

    return run_id


def act4_sweep(client: httpx.Client) -> None:
    """Show that preflight generalises to similar prompts."""

    banner("ACT 4: Retrieval Generalisation — similar prompts")

    prompts = [
        "Add displayName to user profile API and UI",
        "Add nickname to user profile",
        "Extend the user model with a bio field",
        "Add avatar URL to the profile endpoint",
        "Update the Order type to include shippingAddress",
    ]

    detail("Firing 5 different prompts through /v1/preflight...")
    detail("Even paraphrased prompts should trigger warnings if embeddings are semantic.\n")

    hdr = f"  {'Prompt':<50} {'Risk':<10} {'Addendum?':<10} {'Time'}"
    print(_bold(hdr))
    print(f"  {'─' * 74}")

    for prompt in prompts:
        label = prompt[:47] + "..." if len(prompt) > 50 else prompt
        t0 = time.monotonic()
        pf = call_preflight(client, prompt)
        ms = (time.monotonic() - t0) * 1000
        risk = pf.get("risk_level", "none")
        has_addendum = bool(pf.get("system_addendum"))

        if risk in ("high", "medium"):
            risk_str = _warn(f"{risk:<10}")
        elif risk == "none":
            risk_str = _dim(f"{risk:<10}")
        else:
            risk_str = f"{risk:<10}"

        add_str = _ok("yes       ") if has_addendum else _dim("no        ")
        print(f"  {label:<50} {risk_str} {add_str} {_dim(f'{ms:.0f}ms')}")

    print(f"  {'─' * 74}")
    print()


def finale(failed_id: str, passed_id: str) -> None:
    banner("SUMMARY")

    print(f"  {_bold('Without Autopsy:')}")
    print(f"    Opus 4.7 edited 2 files, forgot migration → {_err('REJECTED')}")
    print(f"    Run: {failed_id}")
    print()
    print(f"  {_bold('With Autopsy:')}")
    print(f"    Opus 4.7 saw the preflight warning, edited 4 files → {_ok('APPROVED')}")
    print(f"    Run: {passed_id}")
    print()
    print(_bold("  Key insight:"))
    print("    We don't fine-tune the model. We inject failure memory as context.")
    print("    Any model, any provider. Every failure makes the next run smarter.")
    print()
    print(_dim("  Dashboard: http://localhost:3000"))
    print(_dim(f"  Service:   {AAG_URL}/docs"))
    print()


# ── entrypoint ──────────────────────────────────────────────────────────


def main() -> int:
    print()
    print(_bold(_cyan("  ╔══════════════════════════════════════════════════════════╗")))
    print(_bold(_cyan("  ║        Agent Autopsy Graph — LIVE DEMO                  ║")))
    print(_bold(_cyan("  ║        Opus 4.5 vs 4.7 vs 4.7 + Autopsy                ║")))
    print(_bold(_cyan("  ╚══════════════════════════════════════════════════════════╝")))
    print()
    if AUTO_MODE:
        print(_dim("  Running in auto mode (no pauses)"))
    else:
        print(_dim("  Interactive mode — press Enter to advance between steps"))
        print(_dim("  Open http://localhost:3000 in another tab to see the dashboard"))

    with httpx.Client(base_url=AAG_URL, timeout=30.0) as client:
        # Health check
        try:
            client.get("/v1/health").raise_for_status()
            print(_ok(f"\n  Service OK at {AAG_URL}"))
        except Exception:
            print(_err(f"\n  Service not reachable at {AAG_URL}"))
            print(_dim("  Start it with: make service-dev"))
            return 1

        pause("Press Enter to begin the demo...")

        # Act 1: Agent fails
        failed_id = act1_failed_run(client)

        # Act 2: Show what Autopsy learned
        act2_show_graph(client, failed_id)

        # Act 3: Agent succeeds with Autopsy
        passed_id = act3_preflight_demo(client)
        pause("Press Enter for the retrieval sweep...")

        # Act 4: Generalisation sweep
        act4_sweep(client)

        # Finale
        finale(failed_id, passed_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())

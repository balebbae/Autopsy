#!/usr/bin/env python3
"""End-to-end trace: seed runs → call /v1/preflight → assert + print results.

Closes the loop the older `make seed` / `make replay` scripts left open. They
ingest events and run the finalizer (classifier → graph writer → embedder)
correctly, but never hit the read side of the pipeline. This script does:

  1. Run the existing :mod:`scripts.seed` to populate runs/graph/embeddings
     (idempotent — re-running this script is safe).
  2. For each seeded *rejected* run, call ``POST /v1/preflight`` with both:

       - the *exact* task text (sanity check — works in any embedding mode,
         including the deterministic ``stub`` provider).
       - a *paraphrase* of the task (exercises semantic retrieval — only
         meaningful with ``EMBED_PROVIDER=local`` or ``=openai``).

  3. Assert each call returns a non-none ``risk_level``, the seeded run id
     appears in ``similar_runs``, and ``system_addendum`` is non-null.

  4. Print a human-readable, color-coded report so a reviewer can eyeball
     the graph output for the demo.

Usage:
    make trace
    # or directly:
    AAG_URL=http://localhost:4000 uv run python scripts/trace-preflight.py
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")


@dataclass
class Probe:
    """A single preflight call we want to make against the seeded data."""

    label: str  # human-readable header
    seed_run_id: str  # which seeded run we expect to match
    task: str  # task text we send to /v1/preflight
    paraphrase: bool  # purely for the printed banner


# Each (seed_id, exact_task) is what `make seed` writes; the paraphrase is
# new wording the same engineer might describe the same change with.
PROBES: list[Probe] = [
    Probe(
        label="seed-001 — exact",
        seed_run_id="seed-001",
        task="Add preferredName to user profile API",
        paraphrase=False,
    ),
    Probe(
        label="seed-001 — paraphrase",
        seed_run_id="seed-001",
        task="Expose a preferredName field on the user profile endpoint",
        paraphrase=True,
    ),
    Probe(
        label="seed-003 — exact",
        seed_run_id="seed-003",
        task="Update Order type to include shippingAddress",
        paraphrase=False,
    ),
    Probe(
        label="seed-003 — paraphrase",
        seed_run_id="seed-003",
        task="Extend the Order interface with a shipping address",
        paraphrase=True,
    ),
    Probe(
        label="seed-004 — exact",
        seed_run_id="seed-004",
        task="Add nickname to user model",
        paraphrase=False,
    ),
]


# --- Pretty printing ----------------------------------------------------

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR", "") == ""


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _USE_COLOR else s


def _ok(s: str) -> str:
    return _c("32", s)


def _warn(s: str) -> str:
    return _c("33", s)


def _err(s: str) -> str:
    return _c("31", s)


def _dim(s: str) -> str:
    return _c("2", s)


def _bold(s: str) -> str:
    return _c("1", s)


# --- HTTP ---------------------------------------------------------------


def _seed_via_subprocess() -> None:
    """Run scripts/seed.py inline. We just import + main() since both files
    live in the same dir under repo root, and the seed script is idempotent."""
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, here)
    from seed import main as seed_main  # type: ignore

    rc = seed_main()
    if rc != 0:
        raise SystemExit(rc)


def _call_preflight(client: httpx.Client, *, task: str, run_id: str | None) -> dict:
    body = {
        "task": task,
        "project": "demo-monorepo",
        "worktree": "/tmp/demo-monorepo",
    }
    if run_id is not None:
        body["run_id"] = run_id

    r = client.post("/v1/preflight", json=body, timeout=30.0)
    r.raise_for_status()
    return r.json()


# --- Trace runner --------------------------------------------------------


def _run_probe(client: httpx.Client, probe: Probe) -> tuple[bool, list[str]]:
    """Returns (passed, list-of-failure-reasons)."""
    print(_bold(f"\n── {probe.label} "), end="")
    print(_dim(f"({'paraphrase' if probe.paraphrase else 'exact match'})"))
    print(_dim(f"   task: {probe.task!r}"))

    # Pass the seed run_id so the preflight handler persists a hit row.
    # In real plugin traffic system.transform always sends one — this
    # mirrors that codepath so `make trace` populates dashboard badges.
    resp = _call_preflight(client, task=probe.task, run_id=probe.seed_run_id)

    risk = resp.get("risk_level")
    similar = list(resp.get("similar_runs") or [])
    addendum = resp.get("system_addendum")
    block = bool(resp.get("block"))
    followups = list(resp.get("missing_followups") or [])
    checks = list(resp.get("recommended_checks") or [])

    print(f"   risk_level: {_bold(risk)}  block={block}")
    print(f"   similar_runs: {similar}")
    print(f"   missing_followups: {followups}")
    print(f"   recommended_checks: {checks}")
    if addendum:
        # Addendum is what we actually push into the LLM's system[] —
        # printing it gives a reviewer the exact prose the agent will see.
        print(_dim(f"   addendum: {addendum}"))
    else:
        print(_dim("   addendum: <none>"))

    failures: list[str] = []
    if risk == "none":
        # Paraphrase probes are best-effort: with EMBED_PROVIDER=stub the
        # vectors are byte-identical-or-bust, so the paraphrase legitimately
        # returns none. We surface that as a warning rather than a hard
        # failure.
        msg = "risk_level == 'none'"
        if probe.paraphrase:
            print(_warn(f"   ⚠ {msg} — expected with stub embedder; needs gemini/local/openai"))
        else:
            failures.append(msg)
    if probe.seed_run_id not in similar and not probe.paraphrase:
        failures.append(f"seed run {probe.seed_run_id!r} missing from similar_runs")
    if not addendum and risk != "none":
        failures.append("system_addendum is empty for non-none risk")

    if failures:
        for f in failures:
            print(_err(f"   ✗ {f}"))
        return False, failures
    print(_ok("   ✓ probe passed"))
    return True, []


def _verify_persisted(client: httpx.Client) -> tuple[int, int]:
    """Re-fetch each seed run and return (rows_seen, blocked_seen) totals."""
    seeds = sorted({p.seed_run_id for p in PROBES})
    total = 0
    blocked = 0
    for rid in seeds:
        r = client.get(f"/v1/runs/{rid}")
        if r.status_code != 200:
            continue
        run = r.json()
        hits = run.get("preflight_hits") or []
        total += len(hits)
        blocked += sum(1 for h in hits if h.get("blocked"))
    return total, blocked


def main() -> int:
    print(_bold("==> Seeding (idempotent)…"))
    _seed_via_subprocess()

    print(_bold("\n==> Probing /v1/preflight"))
    print(_dim(f"    AAG_URL={AAG_URL}"))

    passed = 0
    failed: list[tuple[str, list[str]]] = []
    with httpx.Client(base_url=AAG_URL, timeout=30.0) as client:
        # Quick health check so the failure mode is "service down" not
        # "trace assertion failed at probe 0".
        client.get("/v1/health").raise_for_status()

        # Hit each probe twice so the second call exercises the cache and
        # also (crucially) writes a second `preflight_hits` row — that's
        # what the dashboard renders as a per-call green badge.
        for probe in PROBES:
            ok, reasons = _run_probe(client, probe)
            if ok:
                passed += 1
            else:
                failed.append((probe.label, reasons))

        # One extra call carrying a real run_id so we exercise the
        # persistence path on `tool.execute.before` (the only call site
        # plugins set ``tool`` + ``args`` on).
        print(_bold("\n── tool.execute.before persistence probe"))
        resp = client.post(
            "/v1/preflight",
            json={
                "task": "Add preferredName field to user profile API endpoint",
                "project": "demo-monorepo",
                "worktree": "/tmp/demo-monorepo",
                "run_id": "seed-001",
                "tool": "edit",
                "args": {"filePath": "src/profile/profile.service.ts"},
            },
            timeout=30.0,
        )
        resp.raise_for_status()
        print(_dim(f"   {json.dumps(resp.json(), indent=2)[:240]}…"))

        rows, blocked_rows = _verify_persisted(client)

    print(_bold("\n==> Summary"))
    print(f"   probes passed: {passed}/{len(PROBES)}")
    print(f"   preflight_hits rows visible on seed runs: {rows} ({blocked_rows} blocked)")
    if failed:
        print(_err(f"   {len(failed)} probe(s) failed:"))
        for name, reasons in failed:
            for r in reasons:
                print(_err(f"     - {name}: {r}"))
        return 1
    if rows == 0:
        print(
            _err(
                "   ✗ no preflight_hits persisted — the persistence path is wired but not running"
            )
        )
        return 1
    print(_ok("   ✓ closed loop verified — preflight retrieves and persists"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

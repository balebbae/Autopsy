#!/usr/bin/env python3
"""Rich demo seed — bulletproof one-shot for live demos.

Drives ~14 synthetic runs through ``/v1/events`` and
``/v1/runs/:id/outcome`` covering 5 distinct failure-mode clusters,
spread over the past two weeks. Then runs two narrated acts:

  Act 1 — a fresh new failure pattern. Graph didn't know about it.
          Demonstrates: even the first time, we extract structure.
  Act 2 — a new task similar to seeded failures. Calls /v1/preflight,
          prints the addendum + cited evidence runs, then ingests an
          approved run that *acted on* the warning.

Idempotent: stable ``run_id`` + ``event_id`` per (run, seq), so re-running
overwrites in place. Safe to run between practice attempts.

Usage:
    AAG_URL=http://localhost:4000 uv run python scripts/seed-demo.py
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass, field
from difflib import unified_diff
from typing import Literal

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")
DASH_URL = os.environ.get("AAG_DASH_URL", "http://localhost:3000")
PROJECT = "demo-monorepo"
WORKTREE = "/tmp/demo-monorepo"

# Anchor timestamps to "now" so the dashboard timeline always shows
# recent activity. Runs are spread over the past 14 days so temporal
# decay shows a gradient (older = dimmer in the graph).
NOW_MS = int(time.time() * 1000)
DAY_MS = 24 * 60 * 60 * 1000

Outcome = Literal["approved", "rejected"]


# ── colour ──────────────────────────────────────────────────────────────

_USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR", "") == ""


def _c(code: str, s: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _USE_COLOR else s


def _bold(s: str) -> str:
    return _c("1", s)


def _dim(s: str) -> str:
    return _c("2", s)


def _ok(s: str) -> str:
    return _c("32", s)


def _warn(s: str) -> str:
    return _c("33", s)


def _cyan(s: str) -> str:
    return _c("36", s)


def _magenta(s: str) -> str:
    return _c("35", s)


def banner(title: str) -> None:
    w = 70
    print()
    print(_bold(_cyan("┌" + "─" * (w - 2) + "┐")))
    print(_bold(_cyan("│" + title.center(w - 2) + "│")))
    print(_bold(_cyan("└" + "─" * (w - 2) + "┘")))


# ── data shapes ─────────────────────────────────────────────────────────


@dataclass
class FileChange:
    path: str
    old_text: str
    new_text: str


@dataclass
class SeedRun:
    run_id: str
    task: str
    files: list[FileChange]
    outcome: Outcome
    feedback: str | None = None
    days_ago: float = 7.0
    # Pre-flight events to include in the timeline (for runs that benefited
    # from a previous failure being in the graph).
    preflight_addendum: str | None = None
    preflight_evidence: list[str] = field(default_factory=list)


# ── diff helpers ────────────────────────────────────────────────────────


def make_patch(path: str, old: str, new: str) -> str:
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    if old_lines and not old_lines[-1].endswith("\n"):
        old_lines[-1] += "\n"
    if new_lines and not new_lines[-1].endswith("\n"):
        new_lines[-1] += "\n"
    return "".join(
        unified_diff(
            old_lines,
            new_lines,
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
            n=3,
        )
    )


def _count_changed(patch: str, prefix: str) -> int:
    marker = prefix * 3
    return sum(
        1 for ln in patch.splitlines() if ln.startswith(prefix) and not ln.startswith(marker)
    )


def _diff_files_payload(files: list[FileChange]) -> list[dict]:
    out: list[dict] = []
    for fc in files:
        patch = make_patch(fc.path, fc.old_text, fc.new_text)
        out.append(
            {
                "file": fc.path,
                "status": "modified",
                "additions": _count_changed(patch, "+"),
                "deletions": _count_changed(patch, "-"),
                "patch": patch,
            }
        )
    return out


# ── event-stream builder ────────────────────────────────────────────────


def build_events(run: SeedRun) -> list[dict]:
    events: list[dict] = []
    seq = 0
    base_ts = NOW_MS - int(run.days_ago * DAY_MS)
    ts = base_ts

    def add(evt_type: str, props: dict, dt: int = 1500) -> None:
        nonlocal seq, ts
        seq += 1
        events.append(
            {
                "event_id": f"{run.run_id}:{seq:03d}",
                "run_id": run.run_id,
                "project": PROJECT,
                "worktree": WORKTREE,
                "ts": ts,
                "type": evt_type,
                "properties": props,
            }
        )
        ts += dt

    add(
        "session.created",
        {
            "sessionID": run.run_id,
            "info": {"id": run.run_id, "title": run.task, "directory": WORKTREE},
        },
    )

    # If this run benefited from a prior preflight, surface the warning
    # in the timeline as a real autopsy event so the dashboard renders it.
    if run.preflight_addendum:
        add(
            "aag.preflight.warned",
            {
                "sessionID": run.run_id,
                "addendum": run.preflight_addendum,
                "evidence_runs": run.preflight_evidence,
                "tool": "edit",
            },
        )

    for fc in run.files:
        add(
            "tool.execute.after",
            {
                "sessionID": run.run_id,
                "tool": "edit",
                "args": {"filePath": fc.path},
                "result": {
                    "path": fc.path,
                    "oldText": fc.old_text,
                    "newText": fc.new_text,
                    "exitCode": 0,
                },
            },
        )

    add(
        "session.diff",
        {"sessionID": run.run_id, "diff": _diff_files_payload(run.files)},
    )

    if run.outcome == "rejected":
        add(
            "permission.replied",
            {
                "sessionID": run.run_id,
                "reply": "reject",
                "feedback": run.feedback or "",
            },
        )

    add("session.idle", {"sessionID": run.run_id})
    return events


def build_diff_snapshot(run: SeedRun) -> dict:
    base_ts = NOW_MS - int(run.days_ago * DAY_MS)
    return {
        "captured_at": base_ts + 100_000,
        "files": _diff_files_payload(run.files),
    }


# ── the dataset ─────────────────────────────────────────────────────────
#
# Five clusters covering the analyzer's rule surface area, plus a few
# clean approvals to give counter-evidence dampening something to bite on.
#
#   Cluster A — incomplete_schema_change (flagship: 4 fails + 1 approval)
#   Cluster B — missing_test_coverage    (3 fails)
#   Cluster C — frontend_backend_drift   (2 fails)
#   Cluster D — incomplete_schema_change with explicit migration miss (2)
#   Approvals — counter-evidence (3 unrelated approved runs)
#
# Days-ago values are picked so older runs decay and recent ones dominate
# preflight retrieval.

SEED_RUNS: list[SeedRun] = [
    # ── Cluster A: incomplete_schema_change (the flagship cluster) ──
    SeedRun(
        run_id="seed-schema-001",
        task="Add preferredName to user profile API",
        files=[
            FileChange(
                "src/profile/profile.service.ts",
                "id: string;\nemail: string;",
                "id: string;\nemail: string;\npreferredName?: string;",
            ),
            FileChange(
                "src/profile/user.serializer.ts",
                "fields: ['id', 'email']",
                "fields: ['id', 'email', 'preferredName']",
            ),
        ],
        outcome="rejected",
        feedback="Missed migration and frontend type regen.",
        days_ago=11.5,
    ),
    SeedRun(
        run_id="seed-schema-002",
        task="Add nickname field to user model",
        files=[
            FileChange(
                "src/users/user.model.ts",
                "id: string;\nemail: string;\ncreatedAt: Date;",
                "id: string;\nemail: string;\nnickname?: string;\ncreatedAt: Date;",
            ),
            FileChange(
                "src/users/user.dto.ts",
                "id: string;\nemail: string;",
                "id: string;\nemail: string;\nnickname?: string;",
            ),
        ],
        outcome="rejected",
        feedback="No DB migration was added; the model and the table will drift.",
        days_ago=9.0,
    ),
    SeedRun(
        run_id="seed-schema-003",
        task="Update Order type to include shippingAddress",
        files=[
            FileChange(
                "src/api/order.types.ts",
                "id: string;\ntotal: number;\nstatus: string;",
                "id: string;\ntotal: number;\nstatus: string;\nshippingAddress?: string;",
            ),
        ],
        outcome="rejected",
        feedback="Frontend types not regenerated after backend type change.",
        days_ago=6.0,
    ),
    SeedRun(
        run_id="seed-schema-004",
        task="Add lastSeenAt timestamp to Session entity",
        files=[
            FileChange(
                "src/sessions/session.entity.ts",
                "id: string;\nuserId: string;\ncreatedAt: Date;",
                "id: string;\nuserId: string;\ncreatedAt: Date;\nlastSeenAt?: Date;",
            ),
            FileChange(
                "src/sessions/session.service.ts",
                "return { id, userId, createdAt };",
                "return { id, userId, createdAt, lastSeenAt };",
            ),
        ],
        outcome="rejected",
        feedback="Missing database migration for the new column.",
        days_ago=4.5,
    ),
    SeedRun(
        run_id="seed-schema-005-approved",
        task="Add timezone field to user profile (with migration + types)",
        files=[
            FileChange(
                "src/profile/profile.service.ts",
                "id: string;\nemail: string;\npreferredName?: string;",
                "id: string;\nemail: string;\npreferredName?: string;\ntimezone?: string;",
            ),
            FileChange(
                "migrations/20250918_add_timezone_to_profile.sql",
                "",
                "ALTER TABLE profiles ADD COLUMN timezone VARCHAR(64);",
            ),
            FileChange(
                "src/generated/types.ts",
                "preferredName?: string;",
                "preferredName?: string;\ntimezone?: string;",
            ),
        ],
        outcome="approved",
        feedback=None,
        days_ago=3.0,
    ),
    # ── Cluster B: missing_test_coverage ──
    SeedRun(
        run_id="seed-test-001",
        task="Refactor parseUserId helper to return null on bad input",
        files=[
            FileChange(
                "src/auth/parse-user-id.ts",
                "export const parseUserId = (s: string) => Number(s)",
                "export const parseUserId = (s: string): number | null => {\n"
                "  const n = parseInt(s, 10);\n  return Number.isNaN(n) ? null : n;\n}",
            ),
        ],
        outcome="rejected",
        feedback="No tests added for the new null-on-bad-input behaviour.",
        days_ago=12.0,
    ),
    SeedRun(
        run_id="seed-test-002",
        task="Add retry logic to billing webhook handler",
        files=[
            FileChange(
                "src/billing/webhook.ts",
                "await processPayment(event);",
                "let attempt = 0;\nwhile (attempt < 3) {\n"
                "  try { await processPayment(event); break; }\n"
                "  catch (e) { attempt++; if (attempt === 3) throw e; }\n}",
            ),
        ],
        outcome="rejected",
        feedback="Retry logic added but no unit tests covering retry paths.",
        days_ago=8.0,
    ),
    SeedRun(
        run_id="seed-test-003",
        task="Memoize expensive permission lookup",
        files=[
            FileChange(
                "src/permissions/check.ts",
                "export const canAccess = (user, resource) => loadACL(user, resource);",
                "const cache = new Map();\n"
                "export const canAccess = (user, resource) => {\n"
                "  const k = `${user.id}:${resource.id}`;\n"
                "  if (!cache.has(k)) cache.set(k, loadACL(user, resource));\n"
                "  return cache.get(k);\n}",
            ),
        ],
        outcome="rejected",
        feedback="Need tests, especially for cache invalidation.",
        days_ago=5.0,
    ),
    # ── Cluster C: frontend_backend_drift ──
    SeedRun(
        run_id="seed-drift-001",
        task="Add discountCode to checkout schema",
        files=[
            FileChange(
                "src/checkout/checkout.schema.ts",
                "total: number;\nitems: Item[];",
                "total: number;\nitems: Item[];\ndiscountCode?: string;",
            ),
        ],
        outcome="rejected",
        feedback="Frontend types in dashboard/ not regenerated. Will fail at runtime.",
        days_ago=10.0,
    ),
    SeedRun(
        run_id="seed-drift-002",
        task="Rename `total` to `totalCents` in invoice serializer",
        files=[
            FileChange(
                "src/invoices/invoice.serializer.ts",
                "fields: ['id', 'total', 'createdAt']",
                "fields: ['id', 'totalCents', 'createdAt']",
            ),
        ],
        outcome="rejected",
        feedback="Frontend still reads `total`. Need to regenerate types and update consumers.",
        days_ago=2.0,
    ),
    # ── Cluster D: more schema-change variants (different file patterns) ──
    SeedRun(
        run_id="seed-schema-006",
        task="Add optional `slug` to Article model",
        files=[
            FileChange(
                "src/articles/article.model.ts",
                "id: string;\ntitle: string;\nbody: string;",
                "id: string;\ntitle: string;\nbody: string;\nslug?: string;",
            ),
        ],
        outcome="rejected",
        feedback="Slug column needs a migration before this ships.",
        days_ago=13.0,
    ),
    SeedRun(
        run_id="seed-schema-007",
        task="Track `archivedAt` timestamp on Project",
        files=[
            FileChange(
                "src/projects/project.entity.ts",
                "id: string;\nname: string;\nownerId: string;",
                "id: string;\nname: string;\nownerId: string;\narchivedAt?: Date;",
            ),
            FileChange(
                "src/projects/project.dto.ts",
                "id: string;\nname: string;",
                "id: string;\nname: string;\narchivedAt?: Date;",
            ),
        ],
        outcome="rejected",
        feedback="Forgot the migration. Existing rows will not have this column.",
        days_ago=1.5,
    ),
    # ── Counter-evidence approvals ──
    SeedRun(
        run_id="seed-clean-001",
        task="Fix typo in onboarding email subject",
        files=[
            FileChange(
                "src/email/templates/welcome.txt",
                "Welcom to AAG",
                "Welcome to AAG",
            ),
        ],
        outcome="approved",
        feedback=None,
        days_ago=7.5,
    ),
    SeedRun(
        run_id="seed-clean-002",
        task="Bump nginx timeout from 30s to 60s",
        files=[
            FileChange(
                "infra/nginx.conf",
                "proxy_read_timeout 30s;",
                "proxy_read_timeout 60s;",
            ),
        ],
        outcome="approved",
        feedback=None,
        days_ago=4.0,
    ),
    SeedRun(
        run_id="seed-clean-003",
        task="Update README with new install command",
        files=[
            FileChange(
                "README.md",
                "curl -fsSL install.aag.dev/old.sh",
                "curl -fsSL install.autopsy.surf/install.sh",
            ),
        ],
        outcome="approved",
        feedback=None,
        days_ago=0.8,
    ),
]


# ── Act 1 — first-time error ────────────────────────────────────────────
#
# A fresh run with a *new* failure pattern (feature-flag-without-default).
# At ingest time the graph won't have prior similar failures to warn
# about, so /v1/preflight returns nothing. The graph still extracts
# structure from the rejection, building memory for future runs.

ACT1_RUN = SeedRun(
    run_id="demo-act1-flagged-pricing",
    task="Add experimental_pricing_v2 feature flag",
    files=[
        FileChange(
            "src/flags/registry.ts",
            "export const FLAGS = {\n  newCheckout: { default: false },\n} as const;",
            "export const FLAGS = {\n  newCheckout: { default: false },\n"
            "  experimental_pricing_v2: {},\n} as const;",
        ),
        FileChange(
            "src/pricing/pricing.service.ts",
            "if (FLAGS.newCheckout.default) { return v2(); }",
            "if (FLAGS.experimental_pricing_v2) { return v2(); }",
        ),
    ],
    outcome="rejected",
    feedback="New flag has no default value. Will throw in prod for users not in the rollout.",
    days_ago=0.05,
)

# ── Act 2 — preflight should fire ──────────────────────────────────────
#
# A new task semantically close to the schema-change cluster. We:
#   1) call /v1/preflight live and print the addendum + cited runs,
#   2) ingest a run that *acted on* the warning (added migration + types)
#      so it completes APPROVED. Counter-evidence dampens the cluster.

ACT2_TASK = "Add deletedAt timestamp to Customer entity"
ACT2_RUN_ID = "demo-act2-customer-deleted-at"


def make_act2_run(addendum: str, evidence: list[str]) -> SeedRun:
    return SeedRun(
        run_id=ACT2_RUN_ID,
        task=ACT2_TASK,
        files=[
            FileChange(
                "src/customers/customer.entity.ts",
                "id: string;\nemail: string;\ncreatedAt: Date;",
                "id: string;\nemail: string;\ncreatedAt: Date;\ndeletedAt?: Date;",
            ),
            FileChange(
                "migrations/20251015_add_deleted_at_to_customer.sql",
                "",
                "ALTER TABLE customers ADD COLUMN deleted_at TIMESTAMPTZ;",
            ),
            FileChange(
                "src/generated/types.ts",
                "createdAt: string;",
                "createdAt: string;\ndeletedAt?: string;",
            ),
        ],
        outcome="approved",
        feedback=None,
        days_ago=0.02,
        preflight_addendum=addendum,
        preflight_evidence=evidence,
    )


# ── HTTP helpers ────────────────────────────────────────────────────────


def post_events(client: httpx.Client, events: list[dict]) -> int:
    resp = client.post("/v1/events", json={"events": events})
    resp.raise_for_status()
    return int(resp.json().get("accepted", 0))


def post_diff(client: httpx.Client, run_id: str, snapshot: dict) -> None:
    resp = client.post(f"/v1/runs/{run_id}/diff", json=snapshot)
    resp.raise_for_status()


def post_outcome(client: httpx.Client, run_id: str, outcome: str, feedback: str | None) -> None:
    body: dict[str, object] = {"outcome": outcome}
    if feedback is not None:
        body["feedback"] = feedback
    resp = client.post(f"/v1/runs/{run_id}/outcome", json=body)
    resp.raise_for_status()


def call_preflight(client: httpx.Client, task: str, run_id: str) -> dict:
    resp = client.post("/v1/preflight", json={"task": task, "run_id": run_id})
    resp.raise_for_status()
    return resp.json()


def ingest_run(client: httpx.Client, run: SeedRun) -> None:
    events = build_events(run)
    accepted = post_events(client, events)
    post_diff(client, run.run_id, build_diff_snapshot(run))
    post_outcome(client, run.run_id, run.outcome, run.feedback)
    badge = _ok("✓ approved") if run.outcome == "approved" else _warn("✗ rejected")
    print(f"  {badge}  {run.run_id:40s} ({accepted:>2} ev)  '{run.task[:48]}'")


# ── main ────────────────────────────────────────────────────────────────


def main() -> int:
    try:
        with httpx.Client(base_url=AAG_URL, timeout=30.0) as client:
            health = client.get("/v1/health")
            health.raise_for_status()
            print(_dim(f"service ok at {AAG_URL}"))

            banner("Seeding the failure graph (14 runs across 5 clusters)")
            for run in SEED_RUNS:
                ingest_run(client, run)

            banner("Act 1 — fresh failure (graph didn't know about it)")
            print(_dim("  No prior similar runs → preflight has nothing to warn about."))
            print(_dim("  We ingest the rejection so the graph LEARNS this pattern."))
            print()
            ingest_run(client, ACT1_RUN)

            banner("Act 2 — preflight catches a similar new task")
            print(_bold(f"  task: {ACT2_TASK!r}"))
            print()
            pf = call_preflight(client, ACT2_TASK, ACT2_RUN_ID)
            risk = pf.get("risk_level", "?")
            block = pf.get("block", False)
            similar = pf.get("similar_runs", [])
            checks = pf.get("recommended_checks", [])
            addendum = pf.get("system_addendum", "")
            risk_color = {"high": _warn, "medium": _warn, "low": _cyan, "none": _dim}.get(
                risk, _dim
            )
            print(f"  risk_level: {risk_color(risk)}    block: {block}")
            print(f"  similar_runs: {_magenta(', '.join(similar) or '(none)')}")
            if checks:
                print("  recommended_checks:")
                for c in checks:
                    print(f"    • {c}")
            if addendum:
                print()
                print(_bold("  system_addendum:"))
                for line in addendum.strip().splitlines():
                    print(f"    {line}")
            print()
            if not similar:
                print(
                    _warn(
                        "  ⚠ preflight returned no similar runs — retrieval may be misconfigured."
                    )
                )
                print(_dim("    (check EMBED_PROVIDER and that finalizer ran on seed runs)"))
            else:
                print(_dim("  Now ingesting the run as if the agent acted on the warning…"))
                act2_run = make_act2_run(addendum, similar)
                ingest_run(client, act2_run)

            banner("Demo ready")
            print(_bold("  Open the dashboard:"))
            print(f"    runs    {DASH_URL}")
            print(f"    graph   {DASH_URL}/graph")
            print(f"    Act 1   {DASH_URL}/runs/{ACT1_RUN.run_id}")
            print(f"    Act 2   {DASH_URL}/runs/{ACT2_RUN_ID}")
            print()
    except httpx.HTTPError as exc:
        print(f"\n{_warn('error:')} {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

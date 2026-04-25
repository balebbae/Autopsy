#!/usr/bin/env python3
"""Seed the graph with synthetic failure cases via the public HTTP API.

Drives 5 distinct synthetic runs through ``/v1/events`` and
``/v1/runs/:id/outcome``. Each run exercises a different analyzer rule.
After running, the DB has populated ``failure_cases``, ``graph_nodes``,
``graph_edges``, and ``embeddings`` tables — ready for preflight retrieval.

The finalizer pipeline (``aag.workers.finalizer.on_run_complete``) is
fired automatically by ``POST /v1/runs/:id/outcome``.

Idempotent: ``event_id`` is stable per (run, sequence), the
``failure_cases`` row uses ``run_id`` as PK, embeddings use unique
``(entity_type, entity_id)``, and graph upserts ignore conflicts.

Usage:
    uv run python scripts/seed.py
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from difflib import unified_diff
from typing import Literal

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")
PROJECT = "demo-monorepo"
WORKTREE = "/tmp/demo-monorepo"
BASE_TS = 1_714_000_000_000

Outcome = Literal["approved", "rejected"]


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


def make_patch(path: str, old: str, new: str) -> str:
    """Return a unified-diff string for ``old`` → ``new`` on ``path``."""
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
    marker = prefix * 3  # skip the --- / +++ header lines
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


def build_events(run: SeedRun) -> list[dict]:
    """Build a deterministic, monotonically-timestamped event sequence."""
    events: list[dict] = []
    seq = 0
    ts = BASE_TS

    def add(evt_type: str, props: dict, dt: int = 1000) -> None:
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
            "info": {
                "id": run.run_id,
                "title": run.task,
                "directory": WORKTREE,
            },
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
    return {
        "captured_at": BASE_TS + 100_000,
        "files": _diff_files_payload(run.files),
    }


# NOTE: seed-003 + seed-004 file contents are intentionally expanded over
# multiple lines (vs. the one-liners in the original spec). The analyzer's
# ``schema_change`` rule only fires when (a) the file path matches its
# schema-file regex AND (b) some ``+`` line of the patch matches the
# field-addition regex (``^\+\s*\w+[\?!]?\s*[:=]``). With the spec's
# single-line ``export class UserDTO { ... }`` / ``export interface Order
# { ... }`` bodies, the only ``+`` line begins with ``export`` and never
# matches. Splitting onto multiple lines puts the new field on its own
# ``+  fieldName?: type;`` line and triggers the rule as intended.
SEED_RUNS: list[SeedRun] = [
    SeedRun(
        run_id="seed-001",
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
    ),
    SeedRun(
        run_id="seed-002",
        task="Refactor parseUserId helper",
        files=[
            FileChange(
                "src/auth/parse-user-id.ts",
                "export const parseUserId = (s) => Number(s)",
                "export const parseUserId = (s: string) => parseInt(s, 10)",
            ),
        ],
        outcome="rejected",
        feedback="No tests added.",
    ),
    SeedRun(
        run_id="seed-003",
        task="Update Order type to include shippingAddress",
        files=[
            FileChange(
                "src/api/order.types.ts",
                "export interface Order {\n  id: string;\n  total: number;\n}",
                "export interface Order {\n  id: string;\n  total: number;\n  shippingAddress?: string;\n}",
            ),
        ],
        outcome="rejected",
        feedback="Frontend types not regenerated.",
    ),
    SeedRun(
        run_id="seed-004",
        task="Add nickname to user model",
        files=[
            FileChange(
                "src/users/user.model.ts",
                "export class UserModel {\n  id: string;\n  email: string;\n}",
                "export class UserModel {\n  id: string;\n  email: string;\n  nickname?: string;\n}",
            ),
            FileChange(
                "src/users/user.dto.ts",
                "export class UserDTO {\n  id: string;\n  email: string;\n}",
                "export class UserDTO {\n  id: string;\n  email: string;\n  nickname?: string;\n}",
            ),
        ],
        outcome="rejected",
        feedback="Forgot DB migration.",
    ),
    SeedRun(
        run_id="seed-005",
        task="Fix typo in README",
        files=[
            FileChange(
                "README.md",
                "Welcom to AAG",
                "Welcome to AAG",
            ),
        ],
        outcome="approved",
        feedback=None,
    ),
    # Run 6 — Multi-symptom failure: schema_change + missing_migration +
    # missing_test + frontend_drift (4 symptoms).
    SeedRun(
        run_id="seed-006",
        task="Add email verification flow to user registration",
        files=[
            FileChange(
                "src/models/user.schema.ts",
                (
                    "export interface User {\n"
                    "  id: string;\n"
                    "  email: string;\n"
                    "  passwordHash: string;\n"
                    "}"
                ),
                (
                    "export interface User {\n"
                    "  id: string;\n"
                    "  email: string;\n"
                    "  passwordHash: string;\n"
                    "  verifiedEmail?: boolean;\n"
                    "  verificationToken?: string;\n"
                    "}"
                ),
            ),
            FileChange(
                "src/api/auth.ts",
                (
                    "import { Router } from 'express';\n"
                    "\n"
                    "const router = Router();\n"
                    "\n"
                    "router.post('/login', async (req, res) => {\n"
                    "  // login logic\n"
                    "});\n"
                    "\n"
                    "export default router;"
                ),
                (
                    "import { Router } from 'express';\n"
                    "\n"
                    "const router = Router();\n"
                    "\n"
                    "router.post('/login', async (req, res) => {\n"
                    "  // login logic\n"
                    "});\n"
                    "\n"
                    "router.post('/verify-email', async (req, res) => {\n"
                    "  const { token } = req.body;\n"
                    "  // verify email with token\n"
                    "  res.json({ verified: true });\n"
                    "});\n"
                    "\n"
                    "export default router;"
                ),
            ),
        ],
        outcome="rejected",
        feedback="Missing migration, no tests, and frontend types are stale",
    ),
    # Run 7 — Successful counter-example: agent "learned" and did everything
    # right (migration, tests, generated types).
    SeedRun(
        run_id="seed-007",
        task="Add displayName to user profile API and update frontend",
        files=[
            FileChange(
                "src/models/user.schema.ts",
                (
                    "export interface User {\n"
                    "  id: string;\n"
                    "  email: string;\n"
                    "  passwordHash: string;\n"
                    "  verifiedEmail?: boolean;\n"
                    "  verificationToken?: string;\n"
                    "}"
                ),
                (
                    "export interface User {\n"
                    "  id: string;\n"
                    "  email: string;\n"
                    "  passwordHash: string;\n"
                    "  verifiedEmail?: boolean;\n"
                    "  verificationToken?: string;\n"
                    "  displayName?: string;\n"
                    "}"
                ),
            ),
            FileChange(
                "migrations/020_add_display_name.sql",
                "",
                (
                    "ALTER TABLE users ADD COLUMN display_name TEXT;\n"
                    "CREATE INDEX idx_users_display_name ON users (display_name);\n"
                ),
            ),
            FileChange(
                "src/api/users.ts",
                (
                    "router.get('/:id', async (req, res) => {\n"
                    "  const user = await getUser(req.params.id);\n"
                    "  res.json(user);\n"
                    "});"
                ),
                (
                    "router.get('/:id', async (req, res) => {\n"
                    "  const user = await getUser(req.params.id);\n"
                    "  res.json({ ...user, displayName: user.displayName });\n"
                    "});"
                ),
            ),
            FileChange(
                "tests/users.test.ts",
                "",
                (
                    "describe('GET /api/users/:id', () => {\n"
                    "  it('should return displayName when set', async () => {\n"
                    "    const res = await request(app).get('/api/users/1');\n"
                    "    expect(res.body).toHaveProperty('displayName');\n"
                    "  });\n"
                    "});\n"
                ),
            ),
            FileChange(
                "generated/types.ts",
                ("export interface User {\n  id: string;\n  email: string;\n}"),
                (
                    "export interface User {\n"
                    "  id: string;\n"
                    "  email: string;\n"
                    "  displayName?: string;\n"
                    "}"
                ),
            ),
        ],
        outcome="approved",
        feedback=None,
    ),
    # Run 8 — User frustration rejection: sentiment/frustration rule trigger.
    SeedRun(
        run_id="seed-008",
        task="Refactor authentication middleware to use JWT",
        files=[
            FileChange(
                "src/middleware/auth.ts",
                (
                    "import { Request, Response, NextFunction } from 'express';\n"
                    "\n"
                    "export async function authMiddleware(\n"
                    "  req: Request,\n"
                    "  res: Response,\n"
                    "  next: NextFunction\n"
                    ") {\n"
                    "  const session = req.cookies['session_id'];\n"
                    "  if (!session) {\n"
                    "    return res.status(401).json({ error: 'Not authenticated' });\n"
                    "  }\n"
                    "  const user = await validateSession(session);\n"
                    "  if (!user) {\n"
                    "    return res.status(401).json({ error: 'Invalid session' });\n"
                    "  }\n"
                    "  req.user = user;\n"
                    "  next();\n"
                    "}"
                ),
                (
                    "import jwt from 'jsonwebtoken';\n"
                    "import { Request, Response, NextFunction } from 'express';\n"
                    "\n"
                    "const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';\n"
                    "\n"
                    "export async function authMiddleware(\n"
                    "  req: Request,\n"
                    "  res: Response,\n"
                    "  next: NextFunction\n"
                    ") {\n"
                    "  const token = req.headers.authorization?.split(' ')[1];\n"
                    "  if (!token) {\n"
                    "    return res.status(401).json({ error: 'No token provided' });\n"
                    "  }\n"
                    "  try {\n"
                    "    const decoded = jwt.verify(token, JWT_SECRET);\n"
                    "    req.user = decoded;\n"
                    "    next();\n"
                    "  } catch {\n"
                    "    return res.status(401).json({ error: 'Invalid token' });\n"
                    "  }\n"
                    "}"
                ),
            ),
        ],
        outcome="rejected",
        feedback=(
            "This is completely wrong, you broke the existing session handling. Undo everything."
        ),
    ),
]


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


def list_runs(client: httpx.Client) -> list[dict]:
    resp = client.get("/v1/runs", params={"limit": 200})
    resp.raise_for_status()
    return list(resp.json())


def _print_db_summary() -> None:
    """Best-effort DB summary; skipped if aag isn't importable."""
    try:
        import asyncio

        from sqlalchemy import func, select

        from aag.db import sessionmaker
        from aag.models import Embedding, GraphNode
    except Exception as exc:  # pragma: no cover - hard to test
        print(f"(skipping DB summary: {exc})")
        return

    async def _run() -> None:
        async with sessionmaker()() as session:
            nodes = await session.execute(
                select(GraphNode.type, func.count()).group_by(GraphNode.type)
            )
            embs = await session.execute(
                select(Embedding.entity_type, func.count()).group_by(Embedding.entity_type)
            )
            print("graph_nodes by type:", dict(nodes.all()))
            print("embeddings by entity_type:", dict(embs.all()))

    try:
        asyncio.run(_run())
    except Exception as exc:  # pragma: no cover
        print(f"(DB summary failed: {exc})")


def main() -> int:
    try:
        with httpx.Client(base_url=AAG_URL, timeout=30.0) as client:
            health = client.get("/v1/health")
            health.raise_for_status()
            print(f"service ok at {AAG_URL}")

            for run in SEED_RUNS:
                events = build_events(run)
                accepted = post_events(client, events)
                post_diff(client, run.run_id, build_diff_snapshot(run))
                post_outcome(client, run.run_id, run.outcome, run.feedback)
                print(f"  {run.run_id}: {accepted} new event(s), outcome={run.outcome}")

            runs = list_runs(client)
            seeded = [r for r in runs if r.get("run_id", "").startswith("seed-")]
            status_counts: dict[str, int] = {}
            for r in seeded:
                status_counts[r["status"]] = status_counts.get(r["status"], 0) + 1
            print(f"\nseeded {len(seeded)} runs: {status_counts}")
    except httpx.HTTPError as exc:
        print(f"error talking to {AAG_URL}: {exc}", file=sys.stderr)
        return 1

    _print_db_summary()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

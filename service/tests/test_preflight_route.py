"""Integration tests for the ``POST /v1/preflight`` route handler.

Mirrors the live-Postgres pattern used in ``test_traversal.py`` and
``test_finalizer.py``. Each test seeds a single rejected run through the
real finalizer pipeline (so embeddings + graph nodes get populated), then
exercises the route via the sync ``TestClient`` and cleans up afterwards.
"""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.models import (
    Artifact,
    Embedding,
    FailureCase,
    GraphNode,
    Run,
    RunEvent,
)
from aag.workers.finalizer import on_run_complete


def _db_reachable() -> bool:
    url = urlparse(get_settings().database_url.replace("+asyncpg", ""))
    host = url.hostname or "localhost"
    port = url.port or 5432
    try:
        with socket.create_connection((host, port), timeout=1.0):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _db_reachable(),
    reason="Postgres not reachable on localhost:5432",
)


SCHEMA_TASK = "Add preferredName to user profile API and UI"


async def _seed_rejected_schema_run(session: AsyncSession, run_id: str) -> None:
    """Insert a rejected run that the analyzer will classify as
    ``incomplete_schema_change`` with a ``regenerate_types`` fix.

    Mirrors ``_make_rejected_schema_run`` in ``test_finalizer.py``.
    """
    now = int(time() * 1000)
    session.add(
        Run(
            run_id=run_id,
            project="autopsy-tests",
            worktree="/tmp/autopsy-tests",
            task=SCHEMA_TASK,
            started_at=now,
            ended_at=now,
            status="rejected",
            rejection_reason="Missed migration and frontend types.",
        )
    )
    session.add(
        RunEvent(
            event_id=f"{run_id}-evt-edit",
            run_id=run_id,
            ts=now,
            type="tool.execute.after",
            properties={
                "sessionID": run_id,
                "tool": "edit",
                "args": {"filePath": "src/profile/profile.service.ts"},
                "result": {
                    "diff": {
                        "path": "src/profile/profile.service.ts",
                        "oldText": "interface UserProfile {\n  id: string;\n  email: string;\n}",
                        "newText": (
                            "interface UserProfile {\n"
                            "  id: string;\n"
                            "  email: string;\n"
                            "  preferredName?: string;\n"
                            "}"
                        ),
                    }
                },
            },
        )
    )
    session.add(
        Artifact(
            run_id=run_id,
            kind="diff",
            captured_at=now,
            content={
                "files": [
                    {
                        "file": "src/profile/profile.service.ts",
                        "status": "modified",
                        "additions": 1,
                        "deletions": 0,
                        "patch": (
                            "@@ -3,3 +3,4 @@\n"
                            "   id: string;\n"
                            "   email: string;\n"
                            "+  preferredName?: string;\n"
                        ),
                    }
                ]
            },
        )
    )


async def _cleanup(run_id: str) -> None:
    sm = sessionmaker()
    async with sm() as session:
        await session.execute(delete(Embedding).where(Embedding.entity_id.like(f"{run_id}%")))
        await session.execute(delete(FailureCase).where(FailureCase.run_id == run_id))
        await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


@pytest_asyncio.fixture
async def seeded_run_id() -> AsyncIterator[str]:
    """Drive a synthetic rejected run through the finalizer pipeline and
    yield its ``run_id``. Cleans up all rows specific to that run after
    the test, regardless of outcome.
    """
    run_id = f"test-preflight-route-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _seed_rejected_schema_run(session, run_id)
        await session.commit()
    await on_run_complete(run_id)
    # The sync TestClient runs the route on its own event loop (anyio's
    # BlockingPortal). Dispose the engine cached on *this* fixture's loop
    # so the route call gets a fresh engine bound to its own loop.
    await dispose()
    try:
        yield run_id
    finally:
        # Same loop hazard on teardown: the TestClient call cached the
        # engine on its portal loop, but this teardown runs on the
        # fixture's loop. Dispose first.
        await dispose()
        await _cleanup(run_id)


def test_preflight_empty_task(client: TestClient) -> None:
    """An empty ``task`` short-circuits to a default response."""
    resp = client.post("/v1/preflight", json={"task": ""})
    assert resp.status_code == 200
    body = resp.json()
    assert body["risk_level"] == "none"
    # ``response_model_exclude_none=True`` drops the optional null fields.
    assert "system_addendum" not in body
    assert "reason" not in body
    # Empty lists must still be present so the dashboard doesn't have to
    # null-check them.
    assert body["similar_runs"] == []
    assert body["missing_followups"] == []
    assert body["recommended_checks"] == []
    assert body["block"] is False


def test_preflight_finds_seeded_run(client: TestClient, seeded_run_id: str) -> None:
    """A task identical to the seeded run text → cosine distance 0 →
    the route surfaces the seeded run, its failure mode, and a
    non-empty system addendum. Scoped by project so historical fixture
    runs in other projects don't pollute the result.
    """
    resp = client.post(
        "/v1/preflight",
        json={"task": SCHEMA_TASK, "project": "autopsy-tests"},
    )
    assert resp.status_code == 200
    body = resp.json()

    assert body["risk_level"] != "none"
    assert seeded_run_id in body["similar_runs"]
    assert "incomplete_schema_change" in body["missing_followups"]
    addendum = body.get("system_addendum")
    assert isinstance(addendum, str) and addendum
    assert "incomplete_schema_change" in addendum
    # FastAPI validation against ``PreflightResponse`` — spot-check shape.
    assert isinstance(body["recommended_checks"], list)
    assert isinstance(body["block"], bool)


def test_preflight_unrelated_task_safe(client: TestClient, seeded_run_id: str) -> None:
    """A task very different from the seeded one shouldn't blow up and
    should yield a well-typed, low-risk response (the stub embedder is
    sha256-derived, so unrelated strings are ~orthogonal).
    """
    unrelated = (
        "completely unrelated subject about astronomy and the orbital "
        "mechanics of distant binary systems"
    )
    resp = client.post("/v1/preflight", json={"task": unrelated})
    assert resp.status_code == 200
    body = resp.json()
    assert body["risk_level"] in {"none", "low"}
    assert isinstance(body["similar_runs"], list)
    assert isinstance(body["missing_followups"], list)
    assert isinstance(body["recommended_checks"], list)


def test_preflight_request_validation(client: TestClient) -> None:
    """Missing required ``task`` field → 422 from FastAPI/Pydantic."""
    resp = client.post("/v1/preflight", json={})
    assert resp.status_code == 422


def test_preflight_trace_empty_task(client: TestClient) -> None:
    """Empty task short-circuits but still returns a typed trace shell."""
    resp = client.post("/v1/preflight/trace", json={"task": ""})
    assert resp.status_code == 200
    body = resp.json()
    assert body["response"]["risk_level"] == "none"
    trace = body["trace"]
    assert trace["candidates"] == []
    assert trace["edges"] == []
    assert trace["aggregated"] == []
    assert trace["embed_provider"] in {"stub", "local", "openai"}
    assert trace["vector_dim"] in {384, 1536}
    assert trace["max_hop_depth"] == 3
    assert 0.0 < trace["similarity_threshold"] <= 2.0
    assert trace["dampening_factor"] == 1.0


def test_preflight_trace_finds_seeded_run(
    client: TestClient,
    seeded_run_id: str,
) -> None:
    """End-to-end: trace surfaces the seeded run as an ANN candidate, the
    typed graph walk visits FailureMode + FixPattern nodes, and the
    aggregation matches the wire response.
    """
    resp = client.post(
        "/v1/preflight/trace",
        json={"task": SCHEMA_TASK, "project": "autopsy-tests"},
    )
    assert resp.status_code == 200
    body = resp.json()

    response = body["response"]
    trace = body["trace"]

    # Wire response identical to the non-trace endpoint shape.
    assert response["risk_level"] != "none"
    assert seeded_run_id in response["similar_runs"]
    assert "incomplete_schema_change" in response["missing_followups"]

    # ANN stage: candidate row for the seeded run, in-threshold.
    cand_run_ids = [c["run_id"] for c in trace["candidates"]]
    assert seeded_run_id in cand_run_ids
    seeded_cand = next(c for c in trace["candidates"] if c["run_id"] == seeded_run_id)
    assert seeded_cand["status"] == "rejected"
    assert seeded_cand["in_threshold"] is True
    assert 0.0 <= seeded_cand["distance"] < trace["similarity_threshold"]

    # Roots include the seeded run; trace walked at least one edge.
    assert seeded_run_id in trace["rejected_roots"]
    assert len(trace["edges"]) > 0

    # Each edge has the structural shape the dashboard expects. The walk
    # can visit any node type the writer emits (File, Symptom, FailureMode,
    # FixPattern, ChangePattern, Component, ...); only the aggregation
    # restricts to the three narrative types.
    for edge in trace["edges"]:
        assert isinstance(edge["target_type"], str) and edge["target_type"]
        assert isinstance(edge["target_name"], str) and edge["target_name"]
        assert 1 <= edge["depth"] <= trace["max_hop_depth"]
        assert 0.0 <= edge["confidence"] <= 1.0
        assert edge["decayed_confidence"] >= 0.0
        assert edge["age_days"] >= 0.0

    # The walk should reach at least one FailureMode (depth 2) — the
    # whole point of the pipeline.
    fm_edges = [e for e in trace["edges"] if e["target_type"] == "FailureMode"]
    assert len(fm_edges) > 0

    # Aggregation includes a FailureMode (the seed's classification).
    fm_names = [a["name"] for a in trace["aggregated"] if a["type"] == "FailureMode"]
    assert "incomplete_schema_change" in fm_names

    # Aggregated final scores agree with the wire response's
    # missing_followups (top FailureModes by score).
    fm_sorted = sorted(
        (a for a in trace["aggregated"] if a["type"] == "FailureMode"),
        key=lambda a: a["final_score"],
        reverse=True,
    )
    assert fm_sorted[0]["name"] == response["missing_followups"][0]


def test_preflight_trace_no_match(client: TestClient, seeded_run_id: str) -> None:
    """Wildly unrelated task → empty trace (no roots, no edges) but
    well-typed shell. Confirms graceful no-match path.
    """
    unrelated = (
        "completely unrelated subject about astronomy and the orbital "
        "mechanics of distant binary systems"
    )
    resp = client.post(
        "/v1/preflight/trace",
        json={"task": unrelated, "project": "autopsy-tests"},
    )
    assert resp.status_code == 200
    body = resp.json()
    trace = body["trace"]
    # Either no candidates cleared the threshold OR none were rejected.
    in_thresh_rejected = [
        c for c in trace["candidates"] if c["in_threshold"] and c["status"] == "rejected"
    ]
    assert in_thresh_rejected == []
    assert trace["rejected_roots"] == []
    assert trace["edges"] == []
    assert trace["aggregated"] == []

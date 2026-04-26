"""Integration tests for the knowledge export/import pipeline.

Exercises both the in-process functions (``aag.graph.export_import``) and the
HTTP endpoints (``GET /v1/graph/export``, ``POST /v1/graph/import``) end to
end. Skipped when Postgres is unreachable to keep the suite green for
contributors without infra running, matching the convention in
``test_graph_writer.py``.
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
from sqlalchemy import delete, select

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.graph.export_import import (
    SCHEMA_VERSION,
    BundleError,
    _imported_run_id,
    export_bundle,
    import_bundle,
)
from aag.models import Embedding, FailureCase, GraphEdge, GraphNode, Run


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


@pytest_asyncio.fixture
async def seeded_run() -> AsyncIterator[str]:
    """Seed a finalized Run + FailureCase + a couple of embeddings, yield
    the run_id, and clean everything up after."""
    rid = f"test-export-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            Run(
                run_id=rid,
                project="export-fixture",
                worktree="/tmp/test",
                task="Add preferredName to user profile API and UI",
                started_at=int(time() * 1000),
                ended_at=int(time() * 1000),
                status="rejected",
            )
        )
        await session.flush()
        session.add(
            FailureCase(
                run_id=rid,
                task_type="feature_addition",
                failure_mode="incomplete_schema_change",
                fix_pattern="regenerate_types",
                components=["profile"],
                change_patterns=["added_field"],
                symptoms=[
                    {
                        "name": "schema_field_addition",
                        "evidence": ["+preferredName"],
                        "confidence": 0.8,
                    },
                ],
                summary="Schema change without regenerate_types",
            )
        )
        # Two embeddings (task + failure) — enough to verify roundtrip.
        dim = get_settings().embed_dim
        session.add(
            Embedding(
                entity_type="task",
                entity_id=rid,
                text="add preferredname to user profile",
                vector=[0.0] * dim,
            )
        )
        session.add(
            Embedding(
                entity_type="failure",
                entity_id=rid,
                text="incomplete_schema_change: schema_field_addition",
                vector=[0.0] * dim,
            )
        )
        await session.commit()
    # Drop the engine so a sync TestClient running on its own event loop
    # gets a fresh asyncpg connection rather than the one bound to *this*
    # fixture's loop. Mirrors the pattern used in test_graph_routes.py.
    await dispose()

    try:
        yield rid
    finally:
        await dispose()
        sm = sessionmaker()
        async with sm() as session:
            # Cascade cleans up failure_cases via FK on runs; remove the
            # Run-scoped graph node and embeddings ourselves.
            await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{rid}"))
            await session.execute(delete(Embedding).where(Embedding.entity_id == rid))
            await session.execute(delete(Run).where(Run.run_id == rid))
            await session.commit()


@pytest_asyncio.fixture
async def cleanup_imports() -> AsyncIterator[list[str]]:
    """Track imported_run_ids created during a test and clean them up at
    teardown so re-runs of the test suite stay deterministic.

    Mirrors the dispose() dance in test_preflight_route.seeded_run_id: a
    sync TestClient runs FastAPI on its BlockingPortal loop; we dispose so
    the cleanup queries below get a fresh engine bound to this fixture's
    loop instead of the now-defunct portal loop.
    """
    created: list[str] = []
    try:
        yield created
    finally:
        await dispose()
        sm = sessionmaker()
        async with sm() as session:
            for rid in created:
                await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{rid}"))
                await session.execute(delete(Embedding).where(Embedding.entity_id == rid))
                await session.execute(delete(Run).where(Run.run_id == rid))
            await session.commit()


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


async def test_export_includes_seeded_case(seeded_run: str) -> None:
    sm = sessionmaker()
    async with sm() as session:
        bundle = await export_bundle(session, source_label="acme")

    assert bundle["schema_version"] == SCHEMA_VERSION
    assert bundle["source"]["source_label"] == "acme"
    assert bundle["source"]["embed_dim"] == get_settings().embed_dim

    matching = [c for c in bundle["cases"] if c["source_run_id"] == seeded_run]
    assert len(matching) == 1
    case = matching[0]
    assert case["failure_mode"] == "incomplete_schema_change"
    assert case["fix_pattern"] == "regenerate_types"
    assert case["status"] == "rejected"
    assert {s["name"] for s in case["symptoms"]} == {"schema_field_addition"}

    types = {e["entity_type"] for e in case["embeddings"]}
    assert types == {"task", "failure"}
    for emb in case["embeddings"]:
        assert len(emb["vector"]) == get_settings().embed_dim


async def test_export_filters_by_project(seeded_run: str) -> None:
    sm = sessionmaker()
    async with sm() as session:
        bundle = await export_bundle(session, project="export-fixture")
    assert any(c["source_run_id"] == seeded_run for c in bundle["cases"])

    async with sm() as session:
        bundle = await export_bundle(session, project="not-a-real-project")
    assert all(c["source_run_id"] != seeded_run for c in bundle["cases"])


async def test_export_excludes_previously_imported_shadow_runs() -> None:
    """A re-export must not include shadow runs from a previous import,
    otherwise re-importing into the same instance would stack
    `imported:newowner:imported:acme:imported:...` prefixes forever.
    """
    rid = f"imported:fixture:{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            Run(
                run_id=rid,
                project="imported:fixture",
                started_at=int(time() * 1000),
                ended_at=int(time() * 1000),
                status="rejected",
            )
        )
        await session.flush()
        session.add(
            FailureCase(
                run_id=rid,
                failure_mode="should_not_be_exported",
                fix_pattern=None,
                components=[],
                change_patterns=[],
                symptoms=[],
            )
        )
        await session.commit()
    try:
        async with sm() as session:
            bundle = await export_bundle(session)
        assert all(c["source_run_id"] != rid for c in bundle["cases"]), (
            "shadow run from a previous import leaked back into a new export"
        )
    finally:
        async with sm() as session:
            await session.execute(delete(Run).where(Run.run_id == rid))
            await session.commit()


async def test_export_skips_active_runs() -> None:
    """Active / aborted runs without a FailureCase shouldn't appear."""
    rid = f"test-active-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            Run(
                run_id=rid,
                project="export-fixture",
                started_at=int(time() * 1000),
                status="active",
            )
        )
        await session.commit()
    try:
        async with sm() as session:
            bundle = await export_bundle(session)
        assert all(c["source_run_id"] != rid for c in bundle["cases"])
    finally:
        async with sm() as session:
            await session.execute(delete(Run).where(Run.run_id == rid))
            await session.commit()


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


async def test_import_materializes_graph(
    seeded_run: str,
    cleanup_imports: list[str],
) -> None:
    sm = sessionmaker()
    async with sm() as session:
        bundle = await export_bundle(session, source_label="acme")

    imported_id = _imported_run_id("acme", seeded_run)
    cleanup_imports.append(imported_id)

    async with sm() as session:
        counts = await import_bundle(session, bundle)

    assert counts["cases_added"] >= 1
    # Re-export embeddings should land — task + failure for our seeded run.
    assert counts["embeddings_added"] >= 2

    async with sm() as session:
        run = await session.get(Run, imported_id)
        assert run is not None
        assert run.project == "imported:acme"
        assert run.status == "rejected"

        fc = await session.get(FailureCase, imported_id)
        assert fc is not None
        assert fc.failure_mode == "incomplete_schema_change"

        # Run graph node tagged so the dashboard can hide it.
        run_node = await session.get(GraphNode, f"Run:{imported_id}")
        assert run_node is not None
        assert run_node.properties.get("imported") is True
        assert run_node.properties.get("source_label") == "acme"

        # Knowledge nodes exist (they may already exist globally; verify the
        # import didn't fail to create them).
        fm_node = await session.get(GraphNode, "FailureMode:incomplete_schema_change")
        assert fm_node is not None

        # Edges from the imported Run reference the imported run_id.
        edges = (
            (
                await session.execute(
                    select(GraphEdge).where(GraphEdge.evidence_run_id == imported_id)
                )
            )
            .scalars()
            .all()
        )
        edge_types = {e.type for e in edges}
        assert {"ATTEMPTED", "EMITTED_SYMPTOM", "INDICATES", "RESOLVED_BY", "RESULTED_IN"}.issubset(
            edge_types
        )

        # Embeddings keyed to the imported run id.
        emb_rows = (
            (await session.execute(select(Embedding).where(Embedding.entity_id == imported_id)))
            .scalars()
            .all()
        )
        assert {e.entity_type for e in emb_rows} == {"task", "failure"}


async def test_import_is_idempotent(
    seeded_run: str,
    cleanup_imports: list[str],
) -> None:
    sm = sessionmaker()
    async with sm() as session:
        bundle = await export_bundle(session, source_label="acme")

    cleanup_imports.append(_imported_run_id("acme", seeded_run))

    async with sm() as session:
        first = await import_bundle(session, bundle)
    async with sm() as session:
        second = await import_bundle(session, bundle)

    assert first["cases_added"] >= 1
    assert second["cases_added"] == 0
    assert second["cases_skipped"] >= 1


async def test_import_rejects_dim_mismatch() -> None:
    settings = get_settings()
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": int(time() * 1000),
        "source": {
            "source_label": "acme",
            "embed_provider": "openai",
            "embed_dim": settings.embed_dim + 1,  # deliberately wrong
        },
        "cases": [
            {
                "source_run_id": "x",
                "failure_mode": "fm",
                "embeddings": [
                    {
                        "entity_type": "task",
                        "text": "x",
                        "vector": [0.0] * (settings.embed_dim + 1),
                    }
                ],
            }
        ],
    }
    sm = sessionmaker()
    async with sm() as session:
        with pytest.raises(BundleError):
            await import_bundle(session, bundle)


async def test_import_rejects_unknown_schema_version() -> None:
    sm = sessionmaker()
    async with sm() as session:
        with pytest.raises(BundleError):
            await import_bundle(
                session,
                {"schema_version": 999, "exported_at": 0, "cases": []},
            )


async def test_import_skips_malformed_cases(cleanup_imports: list[str]) -> None:
    """A case missing required fields is silently dropped, not a hard error."""
    bundle = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": int(time() * 1000),
        "source": {"source_label": "junk", "embed_dim": get_settings().embed_dim},
        "cases": [
            # missing failure_mode → skipped silently
            {"source_run_id": "junk-1"},
            {
                "source_run_id": "junk-good",
                "failure_mode": "minor_failure",
                "status": "rejected",
                "started_at": int(time() * 1000),
                "components": [],
                "symptoms": [],
                "embeddings": [],
            },
        ],
    }
    cleanup_imports.append(_imported_run_id("junk", "junk-good"))
    sm = sessionmaker()
    async with sm() as session:
        counts = await import_bundle(session, bundle)
    assert counts["cases_added"] == 1
    assert counts["cases_skipped"] == 1


# ---------------------------------------------------------------------------
# HTTP endpoints
# ---------------------------------------------------------------------------


def test_http_export_returns_bundle(
    client: TestClient,
    seeded_run: str,
) -> None:
    resp = client.get("/v1/graph/export", params={"source_label": "acme"})
    assert resp.status_code == 200
    cd = resp.headers.get("content-disposition", "")
    assert "attachment" in cd and "aag-knowledge" in cd
    bundle = resp.json()
    assert bundle["schema_version"] == SCHEMA_VERSION
    assert any(c["source_run_id"] == seeded_run for c in bundle["cases"])


def test_http_import_materializes_graph(
    client: TestClient,
    seeded_run: str,
    cleanup_imports: list[str],
) -> None:
    """Build a bundle in-process (so this test only makes one HTTP call)
    and POST it. Two TestClient calls in a single test body trip the
    BlockingPortal's loop reuse on some macOS/asyncpg combinations; the
    GET path is covered separately."""
    import asyncio

    async def _build_bundle() -> dict:
        sm = sessionmaker()
        async with sm() as session:
            bundle = await export_bundle(session, source_label="acme")
        # Dispose the engine bound to *this* run's loop so the TestClient
        # below doesn't try to reuse it from an already-closed loop.
        await dispose()
        return bundle

    bundle = asyncio.run(_build_bundle())
    assert any(c["source_run_id"] == seeded_run for c in bundle["cases"])

    cleanup_imports.append(_imported_run_id("acme", seeded_run))

    post = client.post("/v1/graph/import", json=bundle)
    assert post.status_code == 200, post.text
    counts = post.json()
    assert counts["cases_added"] >= 1


def test_http_import_dim_mismatch_returns_400(client: TestClient) -> None:
    settings = get_settings()
    bad = {
        "schema_version": SCHEMA_VERSION,
        "exported_at": 0,
        "source": {"embed_dim": settings.embed_dim + 1},
        "cases": [
            {
                "source_run_id": "x",
                "failure_mode": "fm",
                "embeddings": [
                    {
                        "entity_type": "task",
                        "text": "x",
                        "vector": [0.0] * (settings.embed_dim + 1),
                    }
                ],
            }
        ],
    }
    resp = client.post("/v1/graph/import", json=bad)
    assert resp.status_code == 400
    assert "embed_dim" in resp.json()["detail"]

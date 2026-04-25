"""Integration tests for /v1/graph/nodes and /v1/graph/edges.

These tests talk to the local Postgres (assumed running per AGENTS.md). If the
DB isn't reachable, the entire module is skipped so the suite stays green for
contributors without infra running.
"""

from __future__ import annotations

import socket
from collections.abc import AsyncIterator
from urllib.parse import urlparse
from uuid import uuid4

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from sqlalchemy import delete

from aag.config import get_settings
from aag.db import dispose, sessionmaker
from aag.models import GraphEdge, GraphNode


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
async def two_nodes() -> AsyncIterator[tuple[str, str]]:
    """Insert two FailureMode nodes with unique names; clean up after."""
    suffix = uuid4().hex[:10]
    node_a_id = f"FailureMode:test_route_a_{suffix}"
    node_b_id = f"FailureMode:test_route_b_{suffix}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            GraphNode(
                id=node_a_id,
                type="FailureMode",
                name=f"test_route_a_{suffix}",
                properties={"marker": suffix},
            )
        )
        session.add(
            GraphNode(
                id=node_b_id,
                type="FailureMode",
                name=f"test_route_b_{suffix}",
                properties={"marker": suffix},
            )
        )
        await session.commit()
    await dispose()

    try:
        yield node_a_id, node_b_id
    finally:
        await dispose()
        sm = sessionmaker()
        async with sm() as session:
            await session.execute(delete(GraphNode).where(GraphNode.id.in_([node_a_id, node_b_id])))
            await session.commit()


@pytest_asyncio.fixture
async def mixed_type_nodes() -> AsyncIterator[tuple[str, str, str]]:
    """Insert one FailureMode and one Component node with unique names."""
    suffix = uuid4().hex[:10]
    fm_id = f"FailureMode:test_mixed_fm_{suffix}"
    comp_id = f"Component:test_mixed_comp_{suffix}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(
            GraphNode(
                id=fm_id,
                type="FailureMode",
                name=f"test_mixed_fm_{suffix}",
                properties={},
            )
        )
        session.add(
            GraphNode(
                id=comp_id,
                type="Component",
                name=f"test_mixed_comp_{suffix}",
                properties={},
            )
        )
        await session.commit()
    await dispose()

    try:
        yield fm_id, comp_id, suffix
    finally:
        await dispose()
        sm = sessionmaker()
        async with sm() as session:
            await session.execute(delete(GraphNode).where(GraphNode.id.in_([fm_id, comp_id])))
            await session.commit()


@pytest_asyncio.fixture
async def edge_fixture() -> AsyncIterator[tuple[str, str, int]]:
    """Insert two nodes + one ATTEMPTED edge between them; clean up after."""
    suffix = uuid4().hex[:10]
    src_id = f"Run:test_edge_src_{suffix}"
    tgt_id = f"Task:test_edge_tgt_{suffix}"
    sm = sessionmaker()
    async with sm() as session:
        session.add(GraphNode(id=src_id, type="Run", name=f"test_edge_src_{suffix}", properties={}))
        session.add(
            GraphNode(id=tgt_id, type="Task", name=f"test_edge_tgt_{suffix}", properties={})
        )
        await session.flush()
        edge = GraphEdge(
            source_id=src_id,
            target_id=tgt_id,
            type="ATTEMPTED",
            confidence=0.9,
            evidence_run_id=None,
            properties={"marker": suffix},
        )
        session.add(edge)
        await session.commit()
        edge_id = edge.id
    await dispose()

    try:
        yield src_id, tgt_id, edge_id
    finally:
        await dispose()
        sm = sessionmaker()
        async with sm() as session:
            await session.execute(delete(GraphEdge).where(GraphEdge.id == edge_id))
            await session.execute(delete(GraphNode).where(GraphNode.id.in_([src_id, tgt_id])))
            await session.commit()


def test_list_nodes_no_filter(client: TestClient, two_nodes: tuple[str, str]) -> None:
    a_id, b_id = two_nodes
    resp = client.get("/v1/graph/nodes", params={"limit": 1000})
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    ids = {n["id"] for n in body}
    assert a_id in ids
    assert b_id in ids


def test_list_nodes_filter_by_type(
    client: TestClient, mixed_type_nodes: tuple[str, str, str]
) -> None:
    fm_id, comp_id, _suffix = mixed_type_nodes
    resp = client.get("/v1/graph/nodes", params={"type": "FailureMode", "limit": 1000})
    assert resp.status_code == 200
    body = resp.json()
    ids = {n["id"] for n in body}
    assert fm_id in ids
    assert comp_id not in ids
    # All returned rows are FailureMode.
    assert all(n["type"] == "FailureMode" for n in body)


def test_list_nodes_unknown_type_returns_empty(client: TestClient) -> None:
    resp = client.get("/v1/graph/nodes", params={"type": "DoesNotExist"})
    assert resp.status_code == 200
    assert resp.json() == []


def test_list_nodes_respects_limit(client: TestClient, two_nodes: tuple[str, str]) -> None:
    # two_nodes ensures at least 2 nodes exist; seeded data adds many more.
    resp = client.get("/v1/graph/nodes", params={"limit": 1})
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    assert len(body) == 1


def test_list_edges_filter_by_source(
    client: TestClient, edge_fixture: tuple[str, str, int]
) -> None:
    src_id, tgt_id, edge_id = edge_fixture
    resp = client.get("/v1/graph/edges", params={"source_id": src_id, "limit": 1000})
    assert resp.status_code == 200
    body = resp.json()
    assert isinstance(body, list)
    matching = [e for e in body if e["id"] == edge_id]
    assert len(matching) == 1
    e = matching[0]
    assert e["source_id"] == src_id
    assert e["target_id"] == tgt_id
    assert e["type"] == "ATTEMPTED"


def test_list_edges_filter_by_type(client: TestClient, edge_fixture: tuple[str, str, int]) -> None:
    _src, _tgt, edge_id = edge_fixture
    resp = client.get("/v1/graph/edges", params={"type": "ATTEMPTED", "limit": 2000})
    assert resp.status_code == 200
    body = resp.json()
    assert any(e["id"] == edge_id for e in body)
    assert all(e["type"] == "ATTEMPTED" for e in body)


def test_list_edges_filter_by_target(
    client: TestClient, edge_fixture: tuple[str, str, int]
) -> None:
    _src, tgt_id, edge_id = edge_fixture
    resp = client.get("/v1/graph/edges", params={"target_id": tgt_id, "limit": 1000})
    assert resp.status_code == 200
    body = resp.json()
    matching = [e for e in body if e["id"] == edge_id]
    assert len(matching) == 1
    assert matching[0]["target_id"] == tgt_id

"""Integration tests for ``GET /v1/runs/{run_id}/stream`` (SSE).

The endpoint subscribes to ``aag.ingestion.pubsub`` for the given run_id
and re-broadcasts events as Server-Sent Events. Both ``httpx.ASGITransport``
and ``fastapi.testclient.TestClient`` buffer SSE bodies (the request never
returns until the generator finishes, but the SSE generator is infinite),
so this module spins up a real uvicorn server in a background thread and
talks to it over loopback HTTP. That gives us a true streaming connection
and lets the test publish events through the in-process pubsub.

If Postgres isn't reachable the module is skipped — keeps parity with the
rest of the integration tests in this directory even though the route
itself doesn't touch the DB.
"""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from collections.abc import Iterator
from time import sleep
from urllib.parse import urlparse
from uuid import uuid4

import httpx
import pytest
import uvicorn

from aag.config import get_settings
from aag.ingestion import pubsub
from aag.main import app


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


def _free_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def _running_loop() -> asyncio.AbstractEventLoop:
    """Return the uvicorn server's loop by scanning live event loops.

    ``uvicorn.Server`` doesn't expose its loop publicly, so we walk gc to
    find the one that's currently running. There's exactly one running
    asyncio loop while the server thread is alive (the test runner itself
    runs sync test bodies, no loop in this thread).
    """
    import gc

    loops = [
        obj
        for obj in gc.get_objects()
        if isinstance(obj, asyncio.AbstractEventLoop) and obj.is_running()
    ]
    if not loops:
        raise RuntimeError("no running event loop found (uvicorn not started?)")
    return loops[0]


@pytest.fixture(scope="module")
def live_server() -> Iterator[str]:
    """Boot a uvicorn server on a random port for the duration of the module."""
    port = _free_port()
    config = uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=port,
        log_level="warning",
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    # Wait for startup.
    for _ in range(200):
        if server.started:
            break
        sleep(0.05)
    if not server.started:
        raise RuntimeError("uvicorn failed to start within 10s")

    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def _publish_threadsafe(run_id: str, event: dict) -> None:
    loop = _running_loop()
    fut = asyncio.run_coroutine_threadsafe(pubsub.publish(run_id, event), loop)
    fut.result(timeout=2)


def test_stream_returns_event_stream_content_type(live_server: str) -> None:
    """The SSE endpoint should advertise text/event-stream on connect."""
    run_id = f"test-stream-{uuid4().hex[:8]}"
    with httpx.stream(
        "GET",
        f"{live_server}/v1/runs/{run_id}/stream",
        timeout=httpx.Timeout(5.0, read=2.0),
    ) as resp:
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/event-stream")


def test_stream_receives_published_event(live_server: str) -> None:
    """A pubsub.publish for run X should be delivered to a stream on X."""
    run_id = f"test-stream-{uuid4().hex[:8]}"
    event = {
        "event_id": "e1",
        "run_id": run_id,
        "ts": 1714000000000,
        "type": "session.created",
        "properties": {"sessionID": run_id, "info": {"title": "stream-test"}},
    }

    received: list[dict] = []

    def _reader() -> None:
        with httpx.stream(
            "GET",
            f"{live_server}/v1/runs/{run_id}/stream",
            timeout=httpx.Timeout(10.0, read=5.0),
        ) as resp:
            assert resp.status_code == 200
            buffer: list[str] = []
            for line in resp.iter_lines():
                if line == "":
                    for b in buffer:
                        if b.startswith("data:"):
                            received.append(json.loads(b[len("data:") :].strip()))
                            return
                    buffer.clear()
                else:
                    buffer.append(line)

    reader_thread = threading.Thread(target=_reader, daemon=True)
    reader_thread.start()

    # Wait for the SSE generator to register a subscriber, then publish.
    for _ in range(100):
        if pubsub._subscribers.get(run_id):
            break
        sleep(0.05)
    assert pubsub._subscribers.get(run_id), "stream never subscribed"
    _publish_threadsafe(run_id, event)

    reader_thread.join(timeout=5)
    assert received, "reader thread never captured an event"
    payload = received[0]
    assert payload["run_id"] == run_id
    assert payload["type"] == "session.created"
    assert payload["event_id"] == "e1"


def test_stream_isolated_per_run_id(live_server: str) -> None:
    """Events published to run A must not appear on run B's stream."""
    run_a = f"test-stream-a-{uuid4().hex[:8]}"
    run_b = f"test-stream-b-{uuid4().hex[:8]}"
    event_a = {
        "event_id": "e-a",
        "run_id": run_a,
        "ts": 1,
        "type": "session.created",
        "properties": {},
    }

    received_a: list[dict] = []
    received_b: list[dict] = []

    def _reader(run_id: str, sink: list[dict], read_timeout: float) -> None:
        try:
            with httpx.stream(
                "GET",
                f"{live_server}/v1/runs/{run_id}/stream",
                timeout=httpx.Timeout(10.0, read=read_timeout),
            ) as resp:
                buffer: list[str] = []
                for line in resp.iter_lines():
                    if line == "":
                        for b in buffer:
                            if b.startswith("data:"):
                                sink.append(json.loads(b[len("data:") :].strip()))
                                return
                        buffer.clear()
                    else:
                        buffer.append(line)
        except (httpx.ReadTimeout, httpx.RemoteProtocolError):
            # Expected for the silent stream — no event ever arrives.
            return

    t_a = threading.Thread(target=_reader, args=(run_a, received_a, 5.0), daemon=True)
    t_b = threading.Thread(target=_reader, args=(run_b, received_b, 1.0), daemon=True)
    t_a.start()
    t_b.start()

    # Wait for both subscribers, then publish only for A.
    for _ in range(100):
        if pubsub._subscribers.get(run_a) and pubsub._subscribers.get(run_b):
            break
        sleep(0.05)
    assert pubsub._subscribers.get(run_a), "run A never subscribed"
    assert pubsub._subscribers.get(run_b), "run B never subscribed"
    _publish_threadsafe(run_a, event_a)

    t_a.join(timeout=6)
    t_b.join(timeout=3)

    assert len(received_a) == 1
    assert received_a[0]["run_id"] == run_a
    assert received_b == [], f"run B leaked an event from run A: {received_b!r}"

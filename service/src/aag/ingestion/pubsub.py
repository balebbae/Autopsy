"""Asyncio in-process pubsub. SSE consumers subscribe per run_id.

Single-process only (fine for hackathon). Replace with Postgres LISTEN/NOTIFY
or Redis pub/sub if you scale to multiple workers.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

_subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}
log = logging.getLogger(__name__)


async def publish(run_id: str, event: dict[str, Any]) -> None:
    queues = _subscribers.get(run_id, set())
    for q in queues:
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            # SSE is best-effort telemetry. A slow dashboard must not block
            # ingestion while a DB transaction is open; drop the stale event
            # and keep the stream moving.
            log.warning("pubsub subscriber queue full for run_id=%s; dropping event", run_id)


async def subscribe(run_id: str) -> AsyncIterator[dict[str, Any]]:
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1024)
    _subscribers.setdefault(run_id, set()).add(q)
    try:
        while True:
            yield await q.get()
    finally:
        subs = _subscribers.get(run_id)
        if subs is not None:
            subs.discard(q)
            if not subs:
                _subscribers.pop(run_id, None)

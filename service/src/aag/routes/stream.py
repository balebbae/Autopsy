"""GET /v1/runs/:id/stream — SSE re-broadcast of bus events for a run."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from fastapi import APIRouter
from sse_starlette.sse import EventSourceResponse

from aag.ingestion import pubsub

router = APIRouter()


@router.get("/runs/{run_id}/stream")
async def stream(run_id: str) -> EventSourceResponse:
    async def gen() -> AsyncIterator[dict[str, str]]:
        async for ev in pubsub.subscribe(run_id):
            yield {"event": ev.get("type", "message"), "data": json.dumps(ev)}

    return EventSourceResponse(gen())

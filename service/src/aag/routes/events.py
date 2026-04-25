"""POST /v1/events — batched ingestion from the opencode plugin."""

from __future__ import annotations

from fastapi import APIRouter, status

from aag.deps import SessionDep
from aag.ingestion import assembler, pubsub
from aag.schemas import EventBatch

router = APIRouter()


@router.post("/events", status_code=status.HTTP_202_ACCEPTED)
async def ingest(batch: EventBatch, session: SessionDep) -> dict[str, int]:
    accepted = 0
    for ev in batch.events:
        await assembler.upsert_run(session, ev)
        is_new = await assembler.insert_event(session, ev)
        if not is_new:
            continue
        await assembler.apply_event_side_effects(session, ev)
        accepted += 1
        await pubsub.publish(
            ev.run_id,
            {
                "event_id": ev.event_id,
                "run_id": ev.run_id,
                "ts": ev.ts,
                "type": ev.type,
                "properties": ev.properties,
            },
        )
    await session.commit()
    return {"accepted": accepted}

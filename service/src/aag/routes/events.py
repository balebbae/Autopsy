"""POST /v1/events — batched ingestion from the opencode plugin."""

from __future__ import annotations

from fastapi import APIRouter, status

from aag.deps import SessionDep
from aag.ingestion import assembler, pubsub
from aag.schemas import EventBatch

router = APIRouter()

# Per contracts/events.md: message.part.* deltas are too chatty to persist.
# Drop them at the door so the timeline stays useful. Also drop session.status
# (pure progress ping) and session.updated (no analyzer side-effects, fires
# many times per turn). The plugin already filters most of these; this is a
# belt-and-suspenders for older plugins or alternative recorders.
NOISY_TYPES = frozenset(
    {
        "session.status",
        "session.updated",
        "message.part.updated",
        "message.part.removed",
        "message.part.delta",
        "message.updated",
        "message.removed",
    }
)


@router.post("/events", status_code=status.HTTP_202_ACCEPTED)
async def ingest(batch: EventBatch, session: SessionDep) -> dict[str, int]:
    accepted = 0
    for ev in batch.events:
        if ev.type in NOISY_TYPES:
            continue
        # Empty session.diff snapshots (cumulative-from-session-start = no
        # net changes) used to be filtered here. They're now persisted
        # because they encode the "everything was reverted" signal that
        # the dashboard's latest-snapshot view depends on.
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

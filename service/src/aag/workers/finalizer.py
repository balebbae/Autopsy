"""Run-end → analyzer → graph writer → embedder.

R3 wires this in from aag.routes.runs.post_outcome.
"""

from __future__ import annotations


async def on_run_complete(run_id: str) -> None:
    # TODO(R3):
    # async with sessionmaker()() as session:
    #     fc = await classifier.classify(session, run_id)
    #     if fc is None:
    #         return
    #     await graph.writer.write(session, fc)
    #     await graph.embeddings.write_for(session, fc)
    #     await session.commit()
    return

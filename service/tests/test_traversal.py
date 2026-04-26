"""Integration tests for ``aag.graph.traversal.preflight``.

Mirrors the live-Postgres pattern in ``test_graph_writer.py`` /
``test_finalizer.py``. The tests seed a minimal failure pipeline directly
through SQLAlchemy + the finalizer (no HTTP), so they don't need the
service to be running — only the database.
"""

from __future__ import annotations

import socket
from time import time
from urllib.parse import urlparse
from uuid import uuid4

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.db import sessionmaker
from aag.graph.traversal import preflight
from aag.models import (
    Artifact,
    Embedding,
    FailureCase,
    GraphNode,
    PreflightHit,
    Run,
    RunEvent,
)
from aag.schemas.preflight import PreflightRequest, PreflightResponse
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
        # Phase 4 added patch/error embeddings keyed ``<run_id>:<suffix>``;
        # match on LIKE so they're removed too.
        await session.execute(delete(Embedding).where(Embedding.entity_id.like(f"{run_id}%")))
        await session.execute(delete(FailureCase).where(FailureCase.run_id == run_id))
        # PreflightHit has FK ON DELETE CASCADE on runs.run_id, but we
        # also delete in case the parent run is preserved (e.g. tests
        # seeding multiple hits and reusing the run).
        await session.execute(delete(PreflightHit).where(PreflightHit.run_id == run_id))
        await session.execute(delete(GraphNode).where(GraphNode.id == f"Run:{run_id}"))
        await session.execute(delete(Run).where(Run.run_id == run_id))
        await session.commit()


async def _seed_one() -> str:
    """Drive a synthetic rejected run through the finalizer pipeline.

    Returns the run_id (caller is responsible for ``_cleanup``).
    """
    run_id = f"test-traversal-{uuid4().hex[:8]}"
    sm = sessionmaker()
    async with sm() as session:
        await _seed_rejected_schema_run(session, run_id)
        await session.commit()
    await on_run_complete(run_id)
    return run_id


async def test_preflight_empty_task_safe() -> None:
    """Empty task → defaults, no SQL queries (function returns early)."""
    sm = sessionmaker()
    async with sm() as session:
        resp = await preflight(session, PreflightRequest(task=""))
    assert resp == PreflightResponse()
    assert resp.risk_level == "none"
    assert resp.system_addendum is None
    assert resp.similar_runs == []


async def test_preflight_with_no_match() -> None:
    """A task whose embedding doesn't clear the similarity threshold should
    return ``risk_level='none'`` with empty buckets — even if seeded data
    exists for unrelated tasks.
    """
    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        # The stub embedder is sha256-derived; unrelated strings yield
        # cosine distance ~1.0, well above the 0.6 threshold.
        unrelated = (
            "completely unrelated subject about astronomy and "
            "the orbital mechanics of distant binary systems"
        )
        async with sm() as session:
            resp = await preflight(session, PreflightRequest(task=unrelated))
        assert resp.risk_level == "none"
        assert resp.similar_runs == []
        assert resp.missing_followups == []
        assert resp.recommended_checks == []
        assert resp.system_addendum is None
    finally:
        await _cleanup(run_id)


async def test_preflight_finds_similar_run() -> None:
    """Identical task text → cosine distance 0 → must surface the seeded run,
    its FailureMode, and a non-empty system addendum.

    The request scopes by ``project='autopsy-tests'`` so we don't pick up
    historical fixture / replay data from other projects in the dev DB.
    """
    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        async with sm() as session:
            resp = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
            )

        assert resp.risk_level != "none"
        assert run_id in resp.similar_runs
        assert "incomplete_schema_change" in resp.missing_followups
        assert resp.system_addendum is not None
        assert "incomplete_schema_change" in resp.system_addendum
        # The rules-based classifier maps ``incomplete_schema_change`` to
        # this canonical fix string (see ``MODE_TO_FIX`` in classifier.py).
        assert any(
            "migration" in check.lower() and "regenerate" in check.lower()
            for check in resp.recommended_checks
        ), f"expected a migration/regenerate fix; got {resp.recommended_checks}"
    finally:
        await _cleanup(run_id)


async def test_preflight_returns_none_for_unrelated_task() -> None:
    """Stub embedder doesn't model semantic similarity, but unrelated SHA
    digests are nearly orthogonal; the function should run without error
    and return ``none`` (or at worst ``low``).
    """
    sm = sessionmaker()
    async with sm() as session:
        resp = await preflight(session, PreflightRequest(task="What is the weather today?"))
    # Allow ``low`` as a defensive fallback if a hash collision sneaks
    # under the threshold; the important property is that the function
    # doesn't blow up and returns a well-typed response.
    assert resp.risk_level in {"none", "low"}


async def test_preflight_scopes_by_project() -> None:
    """A preflight request scoped to a project that has no rejected runs
    must return ``none`` even when an identical-task rejected run exists
    in a different project.
    """
    run_id = await _seed_one()  # project='autopsy-tests'
    try:
        sm = sessionmaker()
        async with sm() as session:
            resp = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="some-other-project"),
            )
        assert resp.risk_level == "none"
        assert resp.similar_runs == []
        assert resp.system_addendum is None
    finally:
        await _cleanup(run_id)


async def _seed_approved_schema_run(session: AsyncSession, run_id: str) -> None:
    """Seed an ``approved`` run with the same task as the rejected one. We
    don't run it through the finalizer (approved runs don't produce
    FailureCases / graph edges) but we DO write an embedding so the ANN
    query picks it up as counter-evidence.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from aag.graph.embeddings import embed
    from aag.models import Embedding

    now = int(time() * 1000)
    session.add(
        Run(
            run_id=run_id,
            project="autopsy-tests",
            worktree="/tmp/autopsy-tests",
            task=SCHEMA_TASK,
            started_at=now,
            ended_at=now,
            status="approved",
        )
    )
    await session.flush()
    vec = await embed(SCHEMA_TASK)
    stmt = (
        pg_insert(Embedding)
        .values(entity_type="task", entity_id=run_id, text=SCHEMA_TASK, vector=vec)
        .on_conflict_do_update(
            index_elements=["entity_type", "entity_id"],
            set_={"text": SCHEMA_TASK, "vector": vec},
        )
    )
    await session.execute(stmt)


async def test_preflight_dampens_with_approved_counter_evidence() -> None:
    """One approved similar run should dampen (but not zero out) the score
    of an identically-tasked rejected run. With ``counter_weight=0.5`` the
    score is multiplied by 1/(1 + 0.5*1) = 2/3, so a single failure that
    might land at ``low`` stays at ``low`` or drops to ``none`` if borderline.
    """
    failed_id = await _seed_one()
    approved_id = f"test-traversal-approved-{uuid4().hex[:8]}"
    try:
        sm = sessionmaker()
        async with sm() as session:
            await _seed_approved_schema_run(session, approved_id)
            await session.commit()

        async with sm() as session:
            unscoped = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
            )

        # The failure mode is still surfaced (one rejected run is real
        # evidence) but the FailureMode score is dampened.
        assert "incomplete_schema_change" in unscoped.missing_followups
        # similar_runs only contains FAILED runs (approved are counter-
        # evidence, not surfaced as warnings).
        assert failed_id in unscoped.similar_runs
        assert approved_id not in unscoped.similar_runs
    finally:
        sm = sessionmaker()
        async with sm() as session:
            await session.execute(
                delete(Embedding).where(Embedding.entity_id.like(f"{approved_id}%"))
            )
            await session.execute(delete(Run).where(Run.run_id == approved_id))
            await session.commit()
        await _cleanup(failed_id)


async def test_preflight_temporal_decay() -> None:
    """A 90d-old edge contributes less to ``avg_conf`` than a fresh edge.
    With ``half_life=30`` days, the decay factor at 90 days is ``exp(-3) ≈
    0.05``; at 0 days it's 1.0. We seed two runs (same FailureMode), pin
    one's edge ``created_at`` 90d in the past, then check that the
    aggregated ``avg_conf`` is well below 1.0 (specifically, the average
    of 1.0 + ~0.05 = ~0.525, with both edges' confidence multiplied by the
    chained 0.7*1.0 path).
    """
    from sqlalchemy import text as sa_text
    from sqlalchemy import update

    from aag.graph.traversal import _HOP_SQL  # noqa: PLC0415
    from aag.models import GraphEdge

    fresh_id = await _seed_one()
    old_id = await _seed_one()
    try:
        # Push every edge linked to old_id back 90 days.
        sm = sessionmaker()
        async with sm() as session:
            await session.execute(
                update(GraphEdge)
                .where(GraphEdge.evidence_run_id == old_id)
                .values(created_at=sa_text("NOW() - INTERVAL '90 days'"))
            )
            await session.commit()

        # Fresh-only baseline for comparison.
        async with sm() as session:
            fresh_only = (
                await session.execute(
                    _HOP_SQL,
                    {
                        "roots": [f"Run:{fresh_id}"],
                        "run_ids": [fresh_id],
                        "max_depth": 3,
                        "half_life": 30.0,
                    },
                )
            ).all()
        fresh_fm = next(
            r
            for r in fresh_only
            if r.node_type == "FailureMode" and r.node_name == "incomplete_schema_change"
        )

        # Combined query (fresh + old) — old edges' decay should drop the avg.
        async with sm() as session:
            combined = (
                await session.execute(
                    _HOP_SQL,
                    {
                        "roots": [f"Run:{fresh_id}", f"Run:{old_id}"],
                        "run_ids": [fresh_id, old_id],
                        "max_depth": 3,
                        "half_life": 30.0,
                    },
                )
            ).all()
        combined_fm = next(
            r
            for r in combined
            if r.node_type == "FailureMode" and r.node_name == "incomplete_schema_change"
        )

        # Combined run sees more raw evidence (freq=2) but the avg_conf is
        # diluted by the 90d decay. We only assert dilution is non-trivial:
        # combined avg_conf < fresh-only avg_conf (since old contributes ~5%).
        assert int(combined_fm.freq) == 2
        assert combined_fm.avg_conf < fresh_fm.avg_conf, (
            f"expected decay to drop avg_conf below fresh-only "
            f"({fresh_fm.avg_conf:.3f}), got {combined_fm.avg_conf:.3f}"
        )
    finally:
        await _cleanup(fresh_id)
        await _cleanup(old_id)


async def test_preflight_uses_cache(monkeypatch) -> None:
    """Second call with identical (project, task) must hit the in-process
    TTL cache and skip the embed + DB queries.
    """
    from aag.graph import preflight_cache  # noqa: PLC0415

    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        async with sm() as session:
            first = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
            )
        assert run_id in first.similar_runs

        # Counter: zero embed + zero SQL on the second call.
        from aag.graph import traversal as _trav  # noqa: PLC0415

        embed_calls = {"n": 0}
        original_embed = _trav.embed

        async def _counted_embed(text: str):
            embed_calls["n"] += 1
            return await original_embed(text)

        monkeypatch.setattr(_trav, "embed", _counted_embed)
        async with sm() as session:
            second = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
            )
        assert embed_calls["n"] == 0, "cache hit should not re-embed"
        assert second.similar_runs == first.similar_runs
        assert second.system_addendum == first.system_addendum

        # Different project = different cache key → cold path runs again.
        async with sm() as session:
            await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="other"),
            )
        assert embed_calls["n"] == 1
    finally:
        preflight_cache.clear()
        await _cleanup(run_id)


async def test_preflight_block_knob(monkeypatch) -> None:
    """When ``PREFLIGHT_BLOCK_THRESHOLD`` is set and the top failure score
    exceeds it, the response must set ``block=True`` and a ``reason``.
    Default behaviour (threshold=None) is warnings-only.
    """
    from aag.config import get_settings  # noqa: PLC0415
    from aag.graph import preflight_cache  # noqa: PLC0415

    run_id = await _seed_one()
    try:
        # Default: warnings only.
        sm = sessionmaker()
        async with sm() as session:
            warn = await preflight(
                session,
                PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
            )
        assert warn.block is False
        assert warn.reason is None

        preflight_cache.clear()

        # Threshold below the smallest plausible score → must block.
        monkeypatch.setenv("PREFLIGHT_BLOCK_THRESHOLD", "0.01")
        get_settings.cache_clear()
        try:
            async with sm() as session:
                blocked = await preflight(
                    session,
                    PreflightRequest(task=SCHEMA_TASK, project="autopsy-tests"),
                )
            assert blocked.block is True
            assert blocked.reason and "incomplete_schema_change" in blocked.reason
        finally:
            monkeypatch.delenv("PREFLIGHT_BLOCK_THRESHOLD", raising=False)
            get_settings.cache_clear()
    finally:
        preflight_cache.clear()
        await _cleanup(run_id)


async def test_preflight_hybrid_retrieval_via_patch() -> None:
    """Phase 4 hybrid retrieval: with the stub embedder, exact match on
    a patch's text content should surface its run via the ``patch``
    entity_type ANN even when the request task is unrelated to the seeded
    task wording.
    """
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from aag.graph.embeddings import embed
    from aag.models import Embedding

    failed_id = await _seed_one()
    try:
        # Seed a synthetic patch embedding for the run with content we'll
        # query against. We don't go through write_for here because our
        # seeded run had a real patch from the fixture; we're testing
        # the SQL CASE/split_part path in _ANN_SQL specifically.
        patch_text = "@@ migration table-add columnX preferredName"
        sm = sessionmaker()
        async with sm() as session:
            vec = await embed(patch_text)
            stmt = (
                pg_insert(Embedding)
                .values(
                    entity_type="patch",
                    entity_id=f"{failed_id}:src/migrations/0001_add_preferred.sql",
                    text=patch_text,
                    vector=vec,
                )
                .on_conflict_do_update(
                    index_elements=["entity_type", "entity_id"],
                    set_={"text": patch_text, "vector": vec},
                )
            )
            await session.execute(stmt)
            await session.commit()

        # Query with text that matches the PATCH but not the task. The stub
        # embedder is a pure SHA-256 hash, so only exact strings match — so
        # we send the same patch text. In production with `local` /
        # `openai`, semantic similarity does the heavy lifting.
        sm = sessionmaker()
        async with sm() as session:
            resp = await preflight(
                session,
                PreflightRequest(task=patch_text, project="autopsy-tests"),
            )
        # The seeded failed run must surface even though its task wording
        # ("Add preferredName...") differs from the query text.
        assert failed_id in resp.similar_runs
    finally:
        await _cleanup(failed_id)


async def test_preflight_persists_hit_when_run_id_set() -> None:
    """Every /v1/preflight call that returns non-none risk for a run that
    actually exists must persist a row in ``preflight_hits``. The dashboard
    keys the green "Autopsy fired" badge off this table.
    """
    from sqlalchemy import select

    from aag.graph import preflight_cache  # noqa: PLC0415

    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        async with sm() as session:
            resp = await preflight(
                session,
                PreflightRequest(
                    task=SCHEMA_TASK,
                    project="autopsy-tests",
                    run_id=run_id,
                ),
            )
        assert resp.risk_level != "none"

        async with sm() as session:
            rows = list(
                (
                    await session.execute(select(PreflightHit).where(PreflightHit.run_id == run_id))
                ).scalars()
            )
        assert len(rows) == 1
        hit = rows[0]
        assert hit.risk_level == resp.risk_level
        assert hit.task == SCHEMA_TASK
        assert hit.blocked is False
        assert run_id in hit.similar_runs
        assert hit.addendum == resp.system_addendum
        assert hit.top_failure_modes, "expected at least one failure mode"
        # JSONB arrays come back as plain lists of dicts
        assert all("name" in fm and "score" in fm for fm in hit.top_failure_modes)
    finally:
        preflight_cache.clear()
        await _cleanup(run_id)


async def test_preflight_persists_hit_on_cache_hit() -> None:
    """Cache hits must also persist a row — the cache short-circuits the
    expensive graph work, but each agent-side call deserves its own
    ``preflight_hits`` row so the dashboard sees one badge per check.
    """
    from sqlalchemy import select

    from aag.graph import preflight_cache  # noqa: PLC0415

    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        # First call populates the cache + writes one row.
        async with sm() as session:
            await preflight(
                session,
                PreflightRequest(
                    task=SCHEMA_TASK,
                    project="autopsy-tests",
                    run_id=run_id,
                ),
            )

        # Second call should hit the cache (no embed) but still persist.
        async with sm() as session:
            await preflight(
                session,
                PreflightRequest(
                    task=SCHEMA_TASK,
                    project="autopsy-tests",
                    run_id=run_id,
                    tool="edit",
                    args={"filePath": "src/x.ts"},
                ),
            )

        async with sm() as session:
            rows = list(
                (
                    await session.execute(
                        select(PreflightHit)
                        .where(PreflightHit.run_id == run_id)
                        .order_by(PreflightHit.id)
                    )
                ).scalars()
            )
        assert len(rows) == 2
        # Second row should reflect the tool + args from the cache-hit call.
        assert rows[1].tool == "edit"
        assert rows[1].args == {"filePath": "src/x.ts"}
        # And both rows carry identical similar_runs / addendum (same cache).
        assert rows[0].similar_runs == rows[1].similar_runs
        assert rows[0].addendum == rows[1].addendum
    finally:
        preflight_cache.clear()
        await _cleanup(run_id)


async def test_preflight_does_not_double_count_evidence() -> None:
    """A run with two symptoms pointing at the same FailureMode should be
    counted once (``COUNT(DISTINCT evidence_run_id)``). The seeded run
    produces multiple symptoms via the analyzer; if dedup were broken,
    ``freq`` would inflate above the per-run-1 bound.
    """
    run_id = await _seed_one()
    try:
        sm = sessionmaker()
        async with sm() as session:
            # Run the raw aggregation directly to inspect ``freq``.
            from aag.graph.traversal import _HOP_SQL  # noqa: PLC0415

            rows = (
                await session.execute(
                    _HOP_SQL,
                    {
                        "roots": [f"Run:{run_id}"],
                        "run_ids": [run_id],
                        "max_depth": 3,
                        "half_life": 30.0,
                    },
                )
            ).all()
        failure_rows = [r for r in rows if r.node_type == "FailureMode"]
        assert failure_rows, "expected at least one FailureMode row"
        # Exactly one rejected run as the root → freq for any FailureMode
        # reachable from it must be 1, not 2 or 3.
        for r in failure_rows:
            assert int(r.freq) == 1, f"freq inflated for {r.node_name}: {r.freq}"
    finally:
        await _cleanup(run_id)

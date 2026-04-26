"""Read-side: vector ANN + multi-hop graph traversal -> PreflightResponse.

Implements ``preflight(session, req)``:

  1. Embed ``req.task`` via :func:`aag.graph.embeddings.embed`.
  2. ANN over the ``embeddings`` table (``entity_type='task'``) using pgvector
     cosine distance (``<=>``). Filtered by ``runs.status`` (rejected /
     approved only — never an in-flight ``active`` run) and optionally by
     ``runs.project`` so cross-project bleed-through is impossible.
  3. Split the candidates: ``rejected`` runs are roots for the failure
     traversal; ``approved`` runs become counter-evidence that dampens any
     FailureMode score sourced from a similar-but-successful task.
  4. For each rejected Run, recursive CTE up to ``MAX_HOP_DEPTH`` hops over
     ``graph_edges`` collecting reachable ``FailureMode`` / ``FixPattern`` /
     ``ChangePattern`` nodes. Confidence per-edge is multiplied along the
     hop, then weighted by an exponential temporal decay
     (``EXP(-age_days / half_life)``) so a 90d-old run contributes a fraction
     of the score of a 1d-old one.
  5. Aggregate by ``COUNT(DISTINCT evidence_run_id) * AVG(decayed_conf)``
     (DISTINCT to avoid double-counting a run that emitted two symptoms
     pointing at the same FailureMode), bucket by node type, then dampen
     each FailureMode score by ``1 / (1 + counter_weight * approved_count)``.
  6. Compose a markdown ``system_addendum`` plus structured fields.

Note on hop depth: the writer creates ``FixPattern`` nodes three edges away
from each ``Run`` (Run -EMITTED_SYMPTOM-> Symptom -INDICATES-> FailureMode
-RESOLVED_BY-> FixPattern). We therefore traverse three hops, not two as the
original F4 spec suggested, so ``recommended_checks`` is non-empty.
"""

from __future__ import annotations

import contextlib
import logging
import time

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.graph import preflight_cache, preflight_synth
from aag.graph.embeddings import embed
from aag.models import PreflightHit, Run
from aag.schemas.preflight import (
    AnnCandidate,
    PreflightRequest,
    PreflightResponse,
    PreflightTrace,
    PreflightTraceResponse,
    TraceAggregatedNode,
    TraceEdge,
)

log = logging.getLogger(__name__)

# Cosine distance threshold (0 = identical, 2 = opposite). Tuned for the stub
# embedder (sha256-derived random vectors → unrelated texts cluster around 1.0).
SIMILARITY_THRESHOLD = 0.6
# Top-K nearest neighbours from the ANN query. Bumped from 5 → 10 because we
# now keep ``approved`` runs in the candidate set for counter-evidence; the
# failure-run subset still wants headroom.
K = 10
# Max edges traversed from each similar Run. Three edges is the minimum needed
# to reach FixPattern via Run -> Symptom -> FailureMode -> FixPattern.
MAX_HOP_DEPTH = 3

# Risk bucket thresholds keyed off the per-FailureMode score after dampening.
# A single matched run contributes ~1.0 (freq=1, conf=1, decay≈1); 3+
# rejected runs converging on the same FailureMode push the score above 3.0.
RISK_HIGH_THRESHOLD = 3.0
RISK_MEDIUM_THRESHOLD = 1.5


def _vec_literal(vec: list[float]) -> str:
    """Render a vector as the pgvector text literal asyncpg can cast to ``vector``."""
    return "[" + ",".join(str(x) for x in vec) + "]"


# Hybrid ANN query: search both ``task`` AND ``patch`` rows and resolve them
# back to a single run_id. ``patch`` entity_ids are formatted ``<run_id>:<path>``
# (see ``embeddings.write_for``); we strip the suffix with split_part(...,1).
# Then aggregate per-run by min distance so a run that matches via two
# different patches still appears only once. Filter by status / project on
# the resolved run row.
_ANN_SQL = text(
    """
    WITH candidates AS (
        SELECT
            CASE
                WHEN e.entity_type = 'task' THEN e.entity_id
                ELSE split_part(e.entity_id, ':', 1)
            END AS run_id,
            e.entity_type,
            e.vector <=> CAST(:v AS vector) AS dist
        FROM embeddings e
        WHERE e.entity_type = ANY(:entity_types)
        ORDER BY e.vector <=> CAST(:v AS vector)
        LIMIT :k_inner
    ),
    per_run AS (
        SELECT run_id, MIN(dist) AS dist
        FROM candidates
        GROUP BY run_id
    )
    SELECT
        pr.run_id AS run_id,
        pr.dist AS dist,
        r.status AS status,
        r.project AS project,
        EXTRACT(EPOCH FROM (NOW() - r.created_at)) / 86400.0 AS age_days
    FROM per_run pr
    JOIN runs r ON r.run_id = pr.run_id
    WHERE r.status IN ('rejected', 'approved')
      AND (CAST(:project AS TEXT) IS NULL OR r.project = :project)
    ORDER BY pr.dist
    LIMIT :k
    """
)

# Entity types searched by the hybrid ANN. Patches let us find runs whose
# diffs structurally resemble the current task — a failure mode of vague
# task descriptions that the original ``task``-only query missed entirely.
_ANN_ENTITY_TYPES = ["task", "patch"]
# Inner LIMIT: pull more raw candidates than we'll return so the per-run
# aggregation has room to dedupe before the outer LIMIT clamps to K.
_ANN_INNER_LIMIT_FACTOR = 4

# Recursive hop with per-row temporal decay. The ``age_days`` column is taken
# from the *edge* ``created_at`` (i.e. when the evidence was recorded), not
# the Run's, so a stale edge from a long-running graph rebuild loses weight
# correctly. ``COUNT(DISTINCT evidence_run_id)`` avoids double-counting a Run
# that emits two symptoms indicating the same FailureMode.
#
# Crucially, every hop is restricted to ``evidence_run_id = ANY(:run_ids)``.
# This filters out:
#   - Edges with NULL ``evidence_run_id`` (orphans from runs deleted via
#     ``ON DELETE SET NULL`` — e.g. cleaned-up test data) which would
#     otherwise let the walk leak from a real run's Symptom node into
#     unrelated FixPattern siblings produced by long-deleted runs.
#   - Edges grounded in runs *outside* the ANN candidate set (e.g. wrong
#     project, status='active', or distance over threshold). Without this,
#     a sibling FailureMode edge from any historical run would surface as
#     part of the current task's risk.
_HOP_SQL = text(
    """
    WITH RECURSIVE hops AS (
        SELECT
            id::text AS source_id,
            target_id,
            type AS edge_type,
            confidence,
            evidence_run_id,
            created_at,
            1 AS depth
        FROM graph_edges
        WHERE source_id = ANY(:roots)
          AND evidence_run_id = ANY(:run_ids)

        UNION ALL

        SELECT
            h.target_id AS source_id,
            e.target_id,
            e.type AS edge_type,
            (h.confidence * e.confidence) AS confidence,
            e.evidence_run_id,
            e.created_at,
            h.depth + 1
        FROM graph_edges e
        JOIN hops h ON e.source_id = h.target_id
        WHERE h.depth < :max_depth
          AND e.evidence_run_id = ANY(:run_ids)
    )
    SELECT
        n.type AS node_type,
        n.name AS node_name,
        AVG(
            h.confidence
            * EXP(
                - GREATEST(EXTRACT(EPOCH FROM (NOW() - h.created_at)) / 86400.0, 0.0)
                / :half_life
            )
        )::float AS avg_conf,
        COUNT(DISTINCT h.evidence_run_id) AS freq
    FROM hops h
    JOIN graph_nodes n ON n.id = h.target_id
    WHERE n.type IN ('FailureMode', 'FixPattern', 'ChangePattern')
    GROUP BY n.type, n.name
    """
)


def _template_addendum(
    failure_modes: list[tuple[str, float]],
    missing_followups: list[str],
    recommended_checks: list[str],
) -> str | None:
    """Deterministic prose template — falls out of the retrieved subgraph
    without any LLM. Used as the default addendum and as the fallback when
    LLM synthesis is disabled / times out / fails.
    """
    if not failure_modes:
        return None
    parts = [f"⚠️ Similar past task failed with: **{failure_modes[0][0]}**."]
    if missing_followups:
        parts.append(f"Watch out for: {', '.join(missing_followups)}.")
    if recommended_checks:
        parts.append(f"Recommended checks: {', '.join(recommended_checks)}.")
    return " ".join(parts)


def _should_block(top_failure_score: float, threshold: float | None) -> bool:
    """Return ``True`` only when an explicit threshold is configured AND
    the top FailureMode score exceeds it. ``None`` (the default) keeps
    preflight in warnings-only mode.
    """
    if threshold is None:
        return False
    return top_failure_score >= threshold


async def preflight(session: AsyncSession, req: PreflightRequest) -> PreflightResponse:
    """Turn an incoming task into a risk assessment + system addendum.

    Pipeline:
      1. Cache lookup (``project`` + sha256(task)) — single chat turn often
         calls preflight twice (system.transform + tool.execute.before).
      2. Embed task, ANN over rejected/approved runs, run recursive hop.
      3. Counter-evidence dampening, score, bucket, sort.
      4. Compose addendum: template by default; optional LLM synthesizer
         when ``PREFLIGHT_LLM_ENABLED=true``, falling back to template on
         timeout/error.
      5. Optional block decision per ``PREFLIGHT_BLOCK_THRESHOLD``.
      6. Cache the response and return.
    """
    if not req.task or not req.task.strip():
        return PreflightResponse()

    settings = get_settings()

    cached = preflight_cache.get(req.project, req.task)
    if cached is not None:
        # Persist a hit row for the new run too, even though we're skipping
        # the graph work. Each call site (different run_id, possibly different
        # tool / args) deserves its own row in `preflight_hits` so the
        # dashboard sees one badge per agent-side check.
        if req.run_id and cached.response.risk_level != "none":
            await _persist_hit(
                session,
                req=req,
                risk_level=cached.response.risk_level,
                top_failure_score=cached.top_failure_score,
                blocked=cached.response.block,
                similar_runs=list(cached.response.similar_runs),
                failure_modes=cached.failure_modes,
                fix_patterns=cached.fix_patterns,
                addendum=cached.response.system_addendum,
            )
        return cached.response

    half_life = max(settings.preflight_half_life_days, 0.5)
    counter_weight = max(settings.preflight_counter_weight, 0.0)

    vec = await embed(req.task)

    rows = (
        await session.execute(
            _ANN_SQL,
            {
                "v": _vec_literal(vec),
                "k": K,
                "k_inner": K * _ANN_INNER_LIMIT_FACTOR,
                "entity_types": _ANN_ENTITY_TYPES,
                "project": req.project,
            },
        )
    ).all()

    failed: list[tuple[str, float]] = []
    approved_count = 0
    for row in rows:
        dist = float(row.dist)
        if dist >= SIMILARITY_THRESHOLD:
            continue
        if row.status == "rejected":
            failed.append((row.run_id, dist))
        elif row.status == "approved":
            approved_count += 1

    if not failed:
        # No similar failed runs. We still return ``none`` even when many
        # similar approved runs exist — counter-evidence without prior
        # failure isn't a warning, it's just past success.
        # NB: cached under a *short* TTL so a brand-new failure ingested
        # seconds after this call can still be retrieved by the next
        # preflight from the same turn / similar wording. The longer TTL
        # only applies to positive results, which don't go stale the same
        # way (more failures = stronger signal, not invalidation).
        resp = PreflightResponse(risk_level="none")
        preflight_cache.put(
            req.project,
            req.task,
            preflight_cache.CachedPreflight(response=resp),
            settings.preflight_negative_cache_ttl_s,
        )
        return resp

    failed_run_ids = [rid for rid, _ in failed]
    roots = [f"Run:{rid}" for rid in failed_run_ids]
    agg_rows = (
        await session.execute(
            _HOP_SQL,
            {
                "roots": roots,
                "run_ids": failed_run_ids,
                "max_depth": MAX_HOP_DEPTH,
                "half_life": half_life,
            },
        )
    ).all()

    # Counter-evidence dampening: each successful similar run halves the
    # failure score (with default counter_weight=0.5; two approveds reduce
    # by 2/3, etc). This stops "I did this exact thing successfully 5 times
    # but it once failed" tasks from screaming high-risk forever.
    dampening = 1.0 / (1.0 + counter_weight * approved_count)

    failure_modes: list[tuple[str, float]] = []
    fix_patterns: list[tuple[str, float]] = []
    change_patterns: list[tuple[str, float]] = []

    for row in agg_rows:
        score = float(row.freq) * float(row.avg_conf)
        if row.node_type == "FailureMode":
            failure_modes.append((row.node_name, score * dampening))
        elif row.node_type == "FixPattern":
            fix_patterns.append((row.node_name, score))
        else:  # ChangePattern
            change_patterns.append((row.node_name, score))

    failure_modes.sort(key=lambda x: x[1], reverse=True)
    fix_patterns.sort(key=lambda x: x[1], reverse=True)
    change_patterns.sort(key=lambda x: x[1], reverse=True)

    top_failure_score = failure_modes[0][1] if failure_modes else 0.0
    if top_failure_score >= RISK_HIGH_THRESHOLD:
        risk_level: str = "high"
    elif top_failure_score >= RISK_MEDIUM_THRESHOLD:
        risk_level = "medium"
    elif failure_modes:
        risk_level = "low"
    else:
        risk_level = "none"

    similar_runs = [rid for rid, _ in failed]
    missing_followups = [name for name, _ in failure_modes[:3]]
    recommended_checks = [name for name, _ in fix_patterns[:3]]

    addendum = _template_addendum(failure_modes, missing_followups, recommended_checks)

    if settings.preflight_llm_enabled and failure_modes:
        synthesized = await preflight_synth.synthesize(
            session=session,
            task=req.task,
            top_failure_modes=failure_modes,
            top_fix_patterns=fix_patterns,
            similar_run_ids=similar_runs,
        )
        if synthesized:
            addendum = synthesized

    block = _should_block(top_failure_score, settings.preflight_block_threshold)
    reason: str | None = None
    if block and failure_modes:
        reason = (
            f"Autopsy: similar past tasks failed with "
            f"{failure_modes[0][0]} (score {top_failure_score:.2f})."
        )

    resp = PreflightResponse(
        risk_level=risk_level,  # type: ignore[arg-type]
        block=block,
        reason=reason,
        similar_runs=similar_runs,
        missing_followups=missing_followups,
        recommended_checks=recommended_checks,
        system_addendum=addendum,
    )
    preflight_cache.put(
        req.project,
        req.task,
        preflight_cache.CachedPreflight(
            response=resp,
            top_failure_score=top_failure_score,
            failure_modes=list(failure_modes),
            fix_patterns=list(fix_patterns),
        ),
        settings.preflight_cache_ttl_s,
    )

    # Persist the hit so the dashboard can render an "Autopsy fired" badge on
    # the run row and we can measure preflight effectiveness over time. Only
    # write when we have a `run_id` (i.e. the call originated from a real
    # plugin event, not a standalone debug query) AND the run row already
    # exists (FK constraint). Rows from the cache hit branch are NOT
    # re-persisted — the original call already wrote one.
    if req.run_id and risk_level != "none":
        await _persist_hit(
            session,
            req=req,
            risk_level=risk_level,
            top_failure_score=top_failure_score,
            blocked=block,
            similar_runs=similar_runs,
            failure_modes=failure_modes,
            fix_patterns=fix_patterns,
            addendum=addendum,
        )

    return resp


async def _persist_hit(
    session: AsyncSession,
    *,
    req: PreflightRequest,
    risk_level: str,
    top_failure_score: float,
    blocked: bool,
    similar_runs: list[str],
    failure_modes: list[tuple[str, float]],
    fix_patterns: list[tuple[str, float]],
    addendum: str | None,
) -> None:
    """Insert a PreflightHit row. Best-effort: any DB error is logged and
    swallowed so a logging failure never breaks the preflight response.

    When the referenced run_id doesn't exist yet (common on the first turn —
    ``system.transform`` fires before the batcher has flushed
    ``session.created``), we insert a minimal stub run so the FK is
    satisfied.  The assembler's upsert will fill in the real metadata when
    the ``session.created`` event arrives moments later.
    """
    if req.run_id is None:
        return
    try:
        run = await session.get(Run, req.run_id)
        if run is None:
            run = Run(
                run_id=req.run_id,
                project=req.project,
                worktree=req.worktree,
                task=req.task,
                started_at=int(time.time() * 1000),
                status="active",
            )
            session.add(run)
            await session.flush()
        hit = PreflightHit(
            run_id=req.run_id,
            ts=int(time.time() * 1000),
            task=req.task,
            risk_level=risk_level,
            top_failure_score=float(top_failure_score),
            blocked=blocked,
            tool=req.tool,
            args=req.args,
            similar_runs=list(similar_runs),
            top_failure_modes=[
                {"name": name, "score": float(score)} for name, score in failure_modes[:5]
            ],
            top_fix_patterns=[
                {"name": name, "score": float(score)} for name, score in fix_patterns[:5]
            ],
            addendum=addendum,
        )
        session.add(hit)
        await session.commit()
    except Exception:
        log.exception("preflight: failed to persist hit for run_id=%s", req.run_id)
        with contextlib.suppress(Exception):
            await session.rollback()


# =========================================================================
# Trace mode — instrumented version of the preflight pipeline.
#
# Returns the same PreflightResponse alongside a structured PreflightTrace
# containing every intermediate the dashboard's Retrieval view needs to
# visualize Graph RAG: ANN candidates with distances, every edge visited in
# the recursive CTE, and the final aggregation rows.
#
# Bypasses the cache and the preflight_hits persistence step — each call
# always re-runs the full pipeline so the trace is reproducible. This is
# acceptable because the trace endpoint is operator-facing (debug /
# visualization) and never sits on the agent's critical path.
# =========================================================================

# Per-edge variant of the recursive CTE. Same walk as _HOP_SQL but returns
# every (source, target) hop instead of aggregating. The dashboard renders
# these as the typed graph walk.
_HOP_TRACE_SQL = text(
    """
    WITH RECURSIVE hops AS (
        SELECT
            CAST(source_id AS TEXT) AS source_id,
            target_id,
            type AS edge_type,
            confidence AS confidence,
            confidence AS chain_confidence,
            evidence_run_id,
            created_at,
            1 AS depth
        FROM graph_edges
        WHERE source_id = ANY(:roots)
          AND evidence_run_id = ANY(:run_ids)

        UNION ALL

        SELECT
            CAST(h.target_id AS TEXT) AS source_id,
            e.target_id,
            e.type AS edge_type,
            e.confidence AS confidence,
            (h.chain_confidence * e.confidence) AS chain_confidence,
            e.evidence_run_id,
            e.created_at,
            h.depth + 1
        FROM graph_edges e
        JOIN hops h ON e.source_id = h.target_id
        WHERE h.depth < :max_depth
          AND e.evidence_run_id = ANY(:run_ids)
    )
    SELECT
        h.source_id,
        h.target_id,
        n.type AS target_type,
        n.name AS target_name,
        h.edge_type,
        h.depth,
        h.confidence,
        h.chain_confidence,
        h.evidence_run_id,
        GREATEST(EXTRACT(EPOCH FROM (NOW() - h.created_at)) / 86400.0, 0.0) AS age_days
    FROM hops h
    JOIN graph_nodes n ON n.id = h.target_id
    ORDER BY h.depth, h.target_id
    """
)


async def preflight_trace(  # noqa: PLR0915
    session: AsyncSession,
    req: PreflightRequest,
) -> PreflightTraceResponse:
    """Run the preflight pipeline with full instrumentation.

    Mirrors :func:`preflight` but returns the intermediates instead of just
    the wire response. No caching, no persistence, no LLM addendum
    synthesis (the LLM call is non-deterministic — the trace would lie
    about its own output if we re-ran it). Templated addendum still runs
    so the response matches the production wire shape.
    """
    settings = get_settings()
    half_life = max(settings.preflight_half_life_days, 0.5)
    counter_weight = max(settings.preflight_counter_weight, 0.0)

    trace = PreflightTrace(
        embed_provider=settings.embed_provider,
        vector_dim=settings.embed_dim,
        similarity_threshold=SIMILARITY_THRESHOLD,
        half_life_days=half_life,
        counter_weight=counter_weight,
        max_hop_depth=MAX_HOP_DEPTH,
    )

    if not req.task or not req.task.strip():
        return PreflightTraceResponse(response=PreflightResponse(), trace=trace)

    # Stage 1 — vector ANN.
    vec = await embed(req.task)
    rows = (
        await session.execute(
            _ANN_SQL,
            {
                "v": _vec_literal(vec),
                "k": K,
                "k_inner": K * _ANN_INNER_LIMIT_FACTOR,
                "entity_types": _ANN_ENTITY_TYPES,
                "project": req.project,
            },
        )
    ).all()

    failed_run_ids: list[str] = []
    approved_count = 0
    for row in rows:
        dist = float(row.dist)
        in_threshold = dist < SIMILARITY_THRESHOLD
        if in_threshold:
            if row.status == "rejected":
                failed_run_ids.append(row.run_id)
            elif row.status == "approved":
                approved_count += 1
        trace.candidates.append(
            AnnCandidate(
                run_id=row.run_id,
                distance=dist,
                status=row.status,
                project=row.project,
                age_days=float(row.age_days),
                in_threshold=in_threshold,
            )
        )
    trace.rejected_roots = list(failed_run_ids)
    trace.approved_count = approved_count
    trace.dampening_factor = 1.0 / (1.0 + counter_weight * approved_count)

    if not failed_run_ids:
        return PreflightTraceResponse(response=PreflightResponse(), trace=trace)

    # Stage 2 — typed graph traversal, instrumented.
    roots = [f"Run:{rid}" for rid in failed_run_ids]
    edge_rows = (
        await session.execute(
            _HOP_TRACE_SQL,
            {
                "roots": roots,
                "run_ids": failed_run_ids,
                "max_depth": MAX_HOP_DEPTH,
            },
        )
    ).all()

    # Aggregate in Python so the per-edge trace and the score buckets
    # come from the exact same row set.
    from math import exp

    failure_modes_acc: dict[str, dict[str, float | set[str]]] = {}
    fix_patterns_acc: dict[str, dict[str, float | set[str]]] = {}
    change_patterns_acc: dict[str, dict[str, float | set[str]]] = {}

    for row in edge_rows:
        age_days = float(row.age_days)
        decayed = float(row.chain_confidence) * exp(-age_days / half_life)
        trace.edges.append(
            TraceEdge(
                source_id=row.source_id,
                target_id=row.target_id,
                target_type=row.target_type,
                target_name=row.target_name,
                edge_type=row.edge_type,
                depth=int(row.depth),
                confidence=float(row.confidence),
                decayed_confidence=decayed,
                evidence_run_id=row.evidence_run_id,
                age_days=age_days,
            )
        )

        bucket = None
        if row.target_type == "FailureMode":
            bucket = failure_modes_acc
        elif row.target_type == "FixPattern":
            bucket = fix_patterns_acc
        elif row.target_type == "ChangePattern":
            bucket = change_patterns_acc
        if bucket is None:
            continue
        slot = bucket.setdefault(row.target_name, {"sum": 0.0, "count": 0.0, "runs": set()})
        slot["sum"] = float(slot["sum"]) + decayed
        slot["count"] = float(slot["count"]) + 1.0
        runs = slot["runs"]
        if isinstance(runs, set) and row.evidence_run_id:
            runs.add(row.evidence_run_id)

    def _emit(
        acc: dict[str, dict[str, float | set[str]]],
        node_type: str,
        dampen: float,
    ) -> list[TraceAggregatedNode]:
        out: list[TraceAggregatedNode] = []
        for name, slot in acc.items():
            count = float(slot["count"])
            avg_conf = float(slot["sum"]) / count if count > 0 else 0.0
            runs = slot["runs"]
            freq = len(runs) if isinstance(runs, set) else 0
            raw = float(freq) * avg_conf
            out.append(
                TraceAggregatedNode(
                    name=name,
                    type=node_type,  # type: ignore[arg-type]
                    raw_score=raw,
                    final_score=raw * dampen,
                    freq=freq,
                )
            )
        out.sort(key=lambda n: n.final_score, reverse=True)
        return out

    fm = _emit(failure_modes_acc, "FailureMode", trace.dampening_factor)
    fp = _emit(fix_patterns_acc, "FixPattern", 1.0)
    cp = _emit(change_patterns_acc, "ChangePattern", 1.0)
    trace.aggregated = fm + fp + cp

    # Build the response from the same aggregates so the wire shape exactly
    # matches what /v1/preflight would return for this task.
    failure_modes = [(n.name, n.final_score) for n in fm]
    fix_patterns = [(n.name, n.final_score) for n in fp]

    top_failure_score = failure_modes[0][1] if failure_modes else 0.0
    if top_failure_score >= RISK_HIGH_THRESHOLD:
        risk_level: str = "high"
    elif top_failure_score >= RISK_MEDIUM_THRESHOLD:
        risk_level = "medium"
    elif failure_modes:
        risk_level = "low"
    else:
        risk_level = "none"

    similar_runs = list(failed_run_ids)
    missing_followups = [name for name, _ in failure_modes[:3]]
    recommended_checks = [name for name, _ in fix_patterns[:3]]
    addendum = _template_addendum(failure_modes, missing_followups, recommended_checks)
    if addendum is not None:
        trace.addendum_source = "template"

    block = _should_block(top_failure_score, settings.preflight_block_threshold)
    reason: str | None = None
    if block and failure_modes:
        reason = (
            f"Autopsy: similar past tasks failed with "
            f"{failure_modes[0][0]} (score {top_failure_score:.2f})."
        )

    response = PreflightResponse(
        risk_level=risk_level,  # type: ignore[arg-type]
        block=block,
        reason=reason,
        similar_runs=similar_runs,
        missing_followups=missing_followups,
        recommended_checks=recommended_checks,
        system_addendum=addendum,
    )
    return PreflightTraceResponse(response=response, trace=trace)

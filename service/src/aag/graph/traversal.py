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

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.graph import preflight_cache, preflight_synth
from aag.graph.embeddings import embed
from aag.schemas.preflight import PreflightRequest, PreflightResponse

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
        return cached

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
        resp = PreflightResponse(risk_level="none")
        preflight_cache.put(req.project, req.task, resp, settings.preflight_cache_ttl_s)
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
    preflight_cache.put(req.project, req.task, resp, settings.preflight_cache_ttl_s)
    return resp

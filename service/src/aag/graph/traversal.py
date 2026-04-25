"""Read-side: vector ANN + multi-hop graph traversal -> PreflightResponse.

Implements ``preflight(session, req)``:

  1. Embed ``req.task`` via :func:`aag.graph.embeddings.embed`.
  2. ANN over the ``embeddings`` table (``entity_type='task'``) using pgvector
     cosine distance (``<=>``).
  3. For each similar Run, recursive CTE up to ``MAX_HOP_DEPTH`` hops over
     ``graph_edges`` collecting reachable ``FailureMode`` / ``FixPattern`` /
     ``ChangePattern`` nodes.
  4. Aggregate by ``frequency * avg(confidence)`` and bucket by node type.
  5. Compose a markdown ``system_addendum`` plus structured fields.

Note on hop depth: the writer creates ``FixPattern`` nodes three edges away
from each ``Run`` (Run -EMITTED_SYMPTOM-> Symptom -INDICATES-> FailureMode
-RESOLVED_BY-> FixPattern). We therefore traverse three hops, not two as the
original F4 spec suggested, so ``recommended_checks`` is non-empty.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from aag.graph.embeddings import embed
from aag.schemas.preflight import PreflightRequest, PreflightResponse

# Cosine distance threshold (0 = identical, 2 = opposite). Tuned for the stub
# embedder (sha256-derived random vectors → unrelated texts cluster around 1.0).
SIMILARITY_THRESHOLD = 0.6
# Top-K nearest neighbours from the ANN query.
K = 5
# Max edges traversed from each similar Run. Three edges is the minimum needed
# to reach FixPattern via Run -> Symptom -> FailureMode -> FixPattern.
MAX_HOP_DEPTH = 3

# Risk bucket thresholds keyed off ``freq * avg_conf`` for the top FailureMode.
# A single matched run contributes ~1.0 (freq=1, conf=1); 3+ rejected runs
# converging on the same FailureMode push the score above 3.0.
RISK_HIGH_THRESHOLD = 3.0
RISK_MEDIUM_THRESHOLD = 1.5


def _vec_literal(vec: list[float]) -> str:
    """Render a vector as the pgvector text literal asyncpg can cast to ``vector``."""
    return "[" + ",".join(str(x) for x in vec) + "]"


_ANN_SQL = text(
    """
    SELECT entity_id, vector <=> CAST(:v AS vector) AS dist
    FROM embeddings
    WHERE entity_type = 'task'
    ORDER BY vector <=> CAST(:v AS vector)
    LIMIT :k
    """
)

_HOP_SQL = text(
    """
    WITH RECURSIVE hops AS (
        SELECT
            id::text AS source_id,
            target_id,
            type AS edge_type,
            confidence,
            1 AS depth
        FROM graph_edges
        WHERE source_id = ANY(:roots)

        UNION ALL

        SELECT
            h.target_id AS source_id,
            e.target_id,
            e.type AS edge_type,
            (h.confidence * e.confidence) AS confidence,
            h.depth + 1
        FROM graph_edges e
        JOIN hops h ON e.source_id = h.target_id
        WHERE h.depth < :max_depth
    )
    SELECT
        n.type AS node_type,
        n.name AS node_name,
        AVG(h.confidence)::float AS avg_conf,
        COUNT(*) AS freq
    FROM hops h
    JOIN graph_nodes n ON n.id = h.target_id
    WHERE n.type IN ('FailureMode', 'FixPattern', 'ChangePattern')
    GROUP BY n.type, n.name
    """
)


async def preflight(session: AsyncSession, req: PreflightRequest) -> PreflightResponse:
    """Turn an incoming task into a risk assessment + system addendum."""
    if not req.task or not req.task.strip():
        return PreflightResponse()

    vec = await embed(req.task)

    rows = (
        await session.execute(
            _ANN_SQL,
            {"v": _vec_literal(vec), "k": K},
        )
    ).all()

    similar: list[tuple[str, float]] = [
        (row.entity_id, float(row.dist)) for row in rows if float(row.dist) < SIMILARITY_THRESHOLD
    ]

    if not similar:
        return PreflightResponse(risk_level="none")

    roots = [f"Run:{rid}" for rid, _ in similar]
    agg_rows = (await session.execute(_HOP_SQL, {"roots": roots, "max_depth": MAX_HOP_DEPTH})).all()

    failure_modes: list[tuple[str, float]] = []
    fix_patterns: list[tuple[str, float]] = []
    change_patterns: list[tuple[str, float]] = []

    for row in agg_rows:
        score = float(row.freq) * float(row.avg_conf)
        bucket = (
            failure_modes
            if row.node_type == "FailureMode"
            else fix_patterns
            if row.node_type == "FixPattern"
            else change_patterns
        )
        bucket.append((row.node_name, score))

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

    similar_runs = [rid for rid, _ in similar]
    missing_followups = [name for name, _ in failure_modes[:3]]
    recommended_checks = [name for name, _ in fix_patterns[:3]]

    addendum: str | None = None
    if failure_modes:
        parts = [f"⚠️ Similar past task failed with: **{failure_modes[0][0]}**."]
        if missing_followups:
            parts.append(f"Watch out for: {', '.join(missing_followups)}.")
        if recommended_checks:
            parts.append(f"Recommended checks: {', '.join(recommended_checks)}.")
        addendum = " ".join(parts)

    return PreflightResponse(
        risk_level=risk_level,  # type: ignore[arg-type]
        block=False,
        reason=None,
        similar_runs=similar_runs,
        missing_followups=missing_followups,
        recommended_checks=recommended_checks,
        system_addendum=addendum,
    )

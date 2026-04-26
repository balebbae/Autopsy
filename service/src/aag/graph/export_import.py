"""Knowledge export / import.

The export bundle is **case-centric**: each entry is one historical
``FailureCase`` plus the embeddings that describe it. The bundle does NOT
ship raw events, diffs, file paths, worktrees, or any per-run trace data —
just the distilled knowledge an analyzer produced.

On import we materialize a minimal "shadow run" per case, keyed
``imported:<source_label>:<source_run_id>``, run the same graph writer the
finalizer uses, and copy embeddings over. This is what wires imported
knowledge into preflight: the ANN search joins ``embeddings → runs`` and
the recursive hop walk starts at ``Run:<id>`` graph nodes, so without the
shadow runs the imported failure modes would be visible in the graph
without ever powering retrieval.

Shadow runs carry ``project = imported:<source_label>`` so the dashboard
can filter them out of the runs list, and the Run / Task / Outcome graph
nodes the writer materializes carry ``properties.imported = true`` for the
same reason.
"""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from aag.analyzer.extractor import Extraction
from aag.config import get_settings
from aag.graph import writer as graph_writer
from aag.models import Embedding, FailureCase, Run
from aag.schemas.runs import FailureCaseOut, Symptom

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# Embedding entity types that travel with a case. ``patch`` and ``error``
# rows reference per-file content keyed ``<run_id>:<path>`` and would leak
# the source author's filesystem layout, so we deliberately don't ship them.
EXPORTABLE_EMBEDDING_TYPES = ("task", "failure", "fix", "run_summary")


def _imported_run_id(source_label: str, source_run_id: str) -> str:
    """Deterministic shadow run id. Same input → same id, so re-importing
    the same bundle is a no-op (the row already exists, importer skips it).
    """
    return f"imported:{source_label}:{source_run_id}"


async def export_bundle(
    session: AsyncSession,
    *,
    project: str | None = None,
    source_label: str | None = None,
) -> dict[str, Any]:
    """Build a knowledge bundle from finalized runs.

    Only ``rejected`` and ``approved`` runs with an attached ``FailureCase``
    are exported. ``project`` filters runs to a single project; ``None``
    means "everything I know". ``source_label`` is the string the importer
    will see and use to namespace shadow runs.
    """
    settings = get_settings()

    stmt = (
        select(Run, FailureCase)
        .join(FailureCase, FailureCase.run_id == Run.run_id)
        .where(Run.status.in_(("rejected", "approved")))
        # Exclude shadow runs from previous imports — re-exporting would
        # otherwise stack `imported:newowner:imported:acme:imported:...`
        # prefixes on every roundtrip.
        .where(~Run.run_id.like("imported:%"))
        .order_by(Run.started_at.asc())
    )
    if project is not None:
        stmt = stmt.where(Run.project == project)

    pairs = list((await session.execute(stmt)).all())

    if not pairs:
        return {
            "schema_version": SCHEMA_VERSION,
            "exported_at": int(time.time() * 1000),
            "source": {
                "project": project,
                "source_label": source_label,
                "embed_provider": settings.embed_provider,
                "embed_dim": settings.embed_dim,
            },
            "cases": [],
        }

    run_ids = [r.run_id for r, _ in pairs]

    # Single round trip for all embeddings rather than N+1 per case.
    emb_rows = (
        await session.execute(
            select(Embedding).where(
                Embedding.entity_id.in_(run_ids),
                Embedding.entity_type.in_(EXPORTABLE_EMBEDDING_TYPES),
            )
        )
    ).scalars()

    by_run: dict[str, list[dict[str, Any]]] = {}
    for e in emb_rows:
        by_run.setdefault(e.entity_id, []).append(
            {
                "entity_type": e.entity_type,
                "text": e.text,
                # pgvector hands us a numpy.ndarray of float32; coerce to
                # plain Python floats so the JSON encoder is happy.
                "vector": [float(x) for x in e.vector],
            }
        )

    cases: list[dict[str, Any]] = []
    for run, fc in pairs:
        cases.append(
            {
                "source_run_id": run.run_id,
                "started_at": run.started_at,
                "ended_at": run.ended_at,
                "status": run.status,
                "task": run.task,
                "task_type": fc.task_type,
                "failure_mode": fc.failure_mode,
                "fix_pattern": fc.fix_pattern,
                "components": list(fc.components or []),
                "change_patterns": list(fc.change_patterns or []),
                "symptoms": list(fc.symptoms or []),
                "summary": fc.summary,
                "embeddings": by_run.get(run.run_id, []),
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "exported_at": int(time.time() * 1000),
        "source": {
            "project": project,
            "source_label": source_label,
            "embed_provider": settings.embed_provider,
            "embed_dim": settings.embed_dim,
        },
        "cases": cases,
    }


class BundleError(ValueError):
    """Raised when an import bundle is malformed or incompatible."""


async def import_bundle(
    session: AsyncSession,
    bundle: dict[str, Any],
    *,
    source_label_override: str | None = None,
) -> dict[str, int]:
    """Materialize a knowledge bundle into the local graph.

    Idempotent — re-importing the same bundle adds nothing the second time.
    Local nodes / edges with conflicting keys win (skip-on-conflict). Returns
    counters the dashboard can render in a toast.
    """
    settings = get_settings()

    schema_version = bundle.get("schema_version")
    if schema_version != SCHEMA_VERSION:
        raise BundleError(f"unsupported schema_version={schema_version}; expected {SCHEMA_VERSION}")

    source = bundle.get("source") or {}
    source_label = (
        source_label_override or source.get("source_label") or source.get("project") or "unknown"
    )
    # Sanitize: source_label is interpolated into ``runs.run_id`` and node
    # ids. Keep it simple — alnum + dash + underscore only.
    source_label = (
        "".join(c if c.isalnum() or c in "-_" else "_" for c in source_label) or "unknown"
    )

    bundle_dim = source.get("embed_dim")
    has_embeddings = any(case.get("embeddings") for case in bundle.get("cases") or [])
    if has_embeddings and bundle_dim is not None and bundle_dim != settings.embed_dim:
        raise BundleError(
            f"embed_dim mismatch: bundle is {bundle_dim}-d "
            f"but local EMBED_PROVIDER expects {settings.embed_dim}-d. "
            "Re-export with the same provider, or strip embeddings before import."
        )

    counts = {
        "cases_added": 0,
        "cases_skipped": 0,
        "embeddings_added": 0,
        "embeddings_skipped": 0,
    }

    cases = bundle.get("cases") or []
    for raw_case in cases:
        added = await _import_one_case(
            session,
            raw_case,
            source_label=source_label,
            counts=counts,
        )
        if added:
            counts["cases_added"] += 1
        else:
            counts["cases_skipped"] += 1

    await session.commit()
    return counts


async def _import_one_case(
    session: AsyncSession,
    raw: dict[str, Any],
    *,
    source_label: str,
    counts: dict[str, int],
) -> bool:
    """Insert one case. Returns True if a new shadow run was created,
    False if the run was already present (idempotent re-import)."""
    source_run_id = raw.get("source_run_id")
    failure_mode = raw.get("failure_mode")
    if not source_run_id or not failure_mode:
        # Malformed entries are skipped silently — one bad row shouldn't
        # poison an otherwise valid bundle.
        return False

    imported_run_id = _imported_run_id(source_label, str(source_run_id))

    if await session.get(Run, imported_run_id) is not None:
        return False

    status = raw.get("status") or "rejected"
    if status not in ("rejected", "approved", "aborted"):
        # Treat anything else as ``rejected`` so preflight still benefits.
        status = "rejected"

    started_at = int(raw.get("started_at") or 0)
    ended_at_raw = raw.get("ended_at")
    ended_at = int(ended_at_raw) if ended_at_raw is not None else None

    task = raw.get("task")
    task_type = raw.get("task_type")
    fix_pattern = raw.get("fix_pattern")
    components = list(raw.get("components") or [])
    change_patterns = list(raw.get("change_patterns") or [])
    summary = raw.get("summary")

    raw_symptoms = raw.get("symptoms") or []
    symptoms: list[Symptom] = []
    for s in raw_symptoms:
        try:
            symptoms.append(Symptom.model_validate(s))
        except Exception:  # noqa: BLE001
            log.warning("import: skipped malformed symptom in run %s", source_run_id)

    run = Run(
        run_id=imported_run_id,
        project=f"imported:{source_label}",
        worktree=None,
        task=task,
        started_at=started_at,
        ended_at=ended_at,
        status=status,
        summary=summary,
        files_touched=0,
        tool_calls=0,
        rejection_count=0,
    )
    session.add(run)
    await session.flush()

    fc = FailureCase(
        run_id=imported_run_id,
        task_type=task_type,
        failure_mode=str(failure_mode),
        fix_pattern=fix_pattern,
        components=components,
        change_patterns=change_patterns,
        symptoms=[s.model_dump() for s in symptoms],
        summary=summary,
    )
    session.add(fc)
    await session.flush()

    failure_case_out = FailureCaseOut(
        run_id=imported_run_id,
        task_type=task_type,
        failure_mode=str(failure_mode),
        fix_pattern=fix_pattern,
        components=components,
        change_patterns=change_patterns,
        symptoms=symptoms,
        summary=summary,
    )
    extraction = Extraction(
        run_id=imported_run_id,
        task=task,
        task_type=task_type,
        files=[],  # not exported — paths are repo-specific
        components=components,
        tool_calls=[],
        errors=[],
        change_patterns=change_patterns,
        failure_mode=str(failure_mode),
        fix_pattern=fix_pattern,
        symptoms=symptoms,
        tool_usage={},
        patches={},
    )

    await graph_writer.write(
        session,
        run=run,
        failure_case=failure_case_out,
        extraction=extraction,
    )

    # Tag the materialized Run / Task / Outcome graph nodes so the dashboard
    # can hide them. ``upsert_node`` already wrote them with empty
    # properties; rather than threading a flag through writer.write (and
    # risk drift with the production path), we update properties for the
    # known imported ids here.
    await _tag_imported_nodes(
        session,
        run_node_id=f"Run:{imported_run_id}",
        source_label=source_label,
        source_run_id=str(source_run_id),
    )

    for emb in raw.get("embeddings") or []:
        entity_type = emb.get("entity_type")
        vector = emb.get("vector")
        text = emb.get("text") or ""
        if not entity_type or vector is None:
            counts["embeddings_skipped"] += 1
            continue
        stmt = (
            pg_insert(Embedding)
            .values(
                entity_type=entity_type,
                entity_id=imported_run_id,
                text=text,
                vector=list(vector),
            )
            .on_conflict_do_nothing(index_elements=["entity_type", "entity_id"])
        )
        result = await session.execute(stmt)
        if result.rowcount and result.rowcount > 0:
            counts["embeddings_added"] += 1
        else:
            counts["embeddings_skipped"] += 1

    return True


async def _tag_imported_nodes(
    session: AsyncSession,
    *,
    run_node_id: str,
    source_label: str,
    source_run_id: str,
) -> None:
    """Stamp the materialized Run node with ``imported = true`` so the
    dashboard can filter it. We only touch the Run node (not Task /
    Outcome) because those are shared across many runs and overwriting
    their properties on every import would clobber the deserved value.
    """
    from aag.models import GraphNode  # noqa: PLC0415

    node = await session.get(GraphNode, run_node_id)
    if node is None:
        return
    props = dict(node.properties or {})
    props["imported"] = True
    props["source_label"] = source_label
    props["source_run_id"] = source_run_id
    node.properties = props
    await session.flush()

"""Embedding provider abstraction.

Default 'stub' provider returns a deterministic hashed vector so the API
works without any model download. Switch to 'local' (sentence-transformers,
extra='ml') or 'openai' (extra='openai') by setting EMBED_PROVIDER.
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import TYPE_CHECKING

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings
from aag.models import Embedding, Run
from aag.schemas.runs import FailureCaseOut

if TYPE_CHECKING:
    from aag.analyzer.extractor import Extraction
    from aag.config import Settings

# Caps on patch / error indexing per run, so a noisy run with hundreds of
# tool calls doesn't blow up the embeddings table or hammer a paid embed API.
MAX_PATCHES_PER_RUN = 8
MAX_ERRORS_PER_RUN = 5
MAX_PATCH_TEXT = 2000
MAX_ERROR_TEXT = 800


def _stub_embed(text: str, dim: int) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    # cheap deterministic float vector in [-1, 1]
    raw = (digest * ((dim // len(digest)) + 1))[:dim]
    return [(b - 128) / 128.0 for b in raw]


_GEMINI_EMBED_MODEL = "models/gemini-embedding-001"


def _truncate_to_dim(vec: list[float], dim: int) -> list[float]:
    """Defensive truncation. ``gemini-embedding-001`` is a Matryoshka
    Representation Learning (MRL) model, so the leading ``dim`` components
    are still meaningful when the API returns more than we asked for.

    We pass ``output_dimensionality`` to the SDK so this normally never
    triggers, but if a future SDK / API change ignores the parameter, the
    pgvector(768) column would otherwise raise ``expected 768 dimensions,
    not 3072`` and silently drop every embedding write — which is exactly
    the regression that broke preflight retrieval before this fix. Better
    to truncate than to lose the row entirely.
    """
    if len(vec) > dim:
        return vec[:dim]
    return vec


async def _gemini_embed(texts: list[str], settings: Settings) -> list[float]:
    """Embed a single text via Google ``gemini-embedding-001``.

    The model returns 3072-d by default; we ask for ``settings.embed_dim``
    (768) via ``output_dimensionality`` so the result fits in the
    ``embeddings.vector(768)`` column. Truncation uses MRL, which keeps
    the leading dimensions semantically meaningful.

    NOTE: ``models/text-embedding-004`` (the original 768-d native model)
    was removed from the v1beta API, which is why we MRL-truncate the
    newer model rather than swapping back. Don't "simplify" by dropping
    ``output_dimensionality`` — the schema mismatch breaks every write.

    ``genai.embed_content`` is a *synchronous* HTTP call. Run it on a
    worker thread so we don't freeze the asyncio event loop. Preflight and
    finalizer work share the same loop as ingestion; a stalled loop can
    leave requests holding DB connections long enough to exhaust
    ``QueuePool`` under concurrency.
    """
    import google.generativeai as genai  # type: ignore

    def _call() -> dict:
        genai.configure(api_key=settings.gemini_api_key)
        return genai.embed_content(
            model=_GEMINI_EMBED_MODEL,
            content=texts[0],
            output_dimensionality=settings.embed_dim,
        )

    result = await asyncio.to_thread(_call)
    return _truncate_to_dim([float(x) for x in result["embedding"]], settings.embed_dim)


async def _gemini_embed_batch(texts: list[str], settings: Settings) -> list[list[float]]:
    """Batch-embed via Google ``gemini-embedding-001``.

    ``embed_content`` accepts a list of strings and returns a list of
    vectors in one round-trip (free tier: 1 500 req/min). Same MRL
    truncation as the single-text path.

    Same loop-freezing concern as ``_gemini_embed``: this is the
    finalizer's path, which is rarer than preflight but still serializes
    everything else if it runs on the loop thread. ``asyncio.to_thread``
    offloads the blocking SDK call.
    """
    import google.generativeai as genai  # type: ignore

    def _call() -> dict:
        genai.configure(api_key=settings.gemini_api_key)
        return genai.embed_content(
            model=_GEMINI_EMBED_MODEL,
            content=texts,
            output_dimensionality=settings.embed_dim,
        )

    result = await asyncio.to_thread(_call)
    vecs = result["embedding"]
    if texts and not isinstance(vecs[0], list):
        return [_truncate_to_dim([float(x) for x in vecs], settings.embed_dim)]
    return [_truncate_to_dim([float(x) for x in v], settings.embed_dim) for v in vecs]


async def embed(text: str) -> list[float]:
    """Single-text embedding. Use :func:`embed_batch` when you have N>1
    items — it amortizes the model overhead and is cheaper for paid APIs.
    """
    settings = get_settings()
    if settings.embed_provider == "stub":
        return _stub_embed(text, settings.embed_dim)

    if settings.embed_provider == "local":
        # _local_model() lazily imports sentence_transformers so the heavy
        # dep is not required when EMBED_PROVIDER is "stub" or "openai".
        # ``model.encode`` is CPU-bound and synchronous; offload to a thread
        # so the asyncio loop keeps servicing other preflight / events
        # requests while inference runs.
        model = _local_model(settings.embed_model)
        vec = await asyncio.to_thread(
            lambda: model.encode(text, normalize_embeddings=True).tolist()
        )
        return list(vec)

    if settings.embed_provider == "openai":
        from openai import AsyncOpenAI  # type: ignore

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        resp = await client.embeddings.create(model=settings.embed_model, input=text)
        return list(resp.data[0].embedding)

    if settings.embed_provider == "gemini":
        return await _gemini_embed([text], settings)

    raise ValueError(f"unknown EMBED_PROVIDER: {settings.embed_provider}")


async def embed_batch(texts: list[str]) -> list[list[float]]:
    """Batched embedding. Each provider does this in one call where it can.

    Empty input returns an empty list. Empty / whitespace-only entries are
    NOT filtered here — the caller is responsible for filtering before
    calling so list indices line up with the caller's metadata.
    """
    if not texts:
        return []
    settings = get_settings()

    if settings.embed_provider == "stub":
        return [_stub_embed(t, settings.embed_dim) for t in texts]

    if settings.embed_provider == "local":
        model = _local_model(settings.embed_model)
        vecs = await asyncio.to_thread(
            lambda: model.encode(texts, normalize_embeddings=True).tolist()
        )
        return [list(v) for v in vecs]

    if settings.embed_provider == "openai":
        from openai import AsyncOpenAI  # type: ignore

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        resp = await client.embeddings.create(model=settings.embed_model, input=texts)
        return [list(d.embedding) for d in resp.data]

    if settings.embed_provider == "gemini":
        return await _gemini_embed_batch(texts, settings)

    raise ValueError(f"unknown EMBED_PROVIDER: {settings.embed_provider}")


_local_cache: dict[str, object] = {}


def _local_model(name: str):
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "EMBED_PROVIDER=local requires the 'ml' extra. "
            "Install with `cd service && uv sync --extra ml`, or set "
            "EMBED_PROVIDER=stub in .env for byte-identical-only retrieval, "
            "or EMBED_PROVIDER=openai (with OPENAI_API_KEY) for hosted embeddings."
        ) from exc

    if name not in _local_cache:
        _local_cache[name] = SentenceTransformer(name)
    return _local_cache[name]


async def write_for(
    session: AsyncSession,
    *,
    failure_case: FailureCaseOut,
    run: Run,
    extraction: Extraction | None = None,
) -> None:
    """Compute and upsert embeddings for the run's retrievable surface.

    Always writes the four base entity types (``task``, ``failure``,
    ``fix``, ``run_summary``). When ``extraction`` is provided, additionally
    writes:

      - ``patch``: one row per touched file (up to ``MAX_PATCHES_PER_RUN``)
        with ``entity_id = "<run_id>:<path>"``. Lets retrieval find runs by
        structurally-similar diffs even when task wording differs.
      - ``error``: one row per distinct error string (up to
        ``MAX_ERRORS_PER_RUN``) with ``entity_id = "<run_id>:err:<idx>"``.
        Lets retrieval find runs that hit the same error class.

    The caller owns the transaction — this function does not commit.
    Texts whose ``.strip()`` is empty are skipped.
    """
    symptom_names = ", ".join(s.name for s in failure_case.symptoms)
    change_patterns = ", ".join(failure_case.change_patterns)

    items: list[tuple[str, str, str | None]] = [
        ("task", run.run_id, run.task or ""),
        ("failure", run.run_id, f"{failure_case.failure_mode}: {symptom_names}"),
        ("fix", run.run_id, failure_case.fix_pattern),
        (
            "run_summary",
            run.run_id,
            " | ".join(filter(None, [run.task, failure_case.failure_mode, change_patterns])),
        ),
    ]

    if extraction is not None:
        # Hybrid retrieval surface: patches are most useful for "I'm about
        # to touch the same file as a past failure". Truncate aggressively
        # — the embedder doesn't need the full 5KB diff to capture the
        # gist of the change.
        for path, patch in list(extraction.patches.items())[:MAX_PATCHES_PER_RUN]:
            if not patch:
                continue
            items.append(("patch", f"{run.run_id}:{path}", patch[:MAX_PATCH_TEXT]))

        for idx, err in enumerate(extraction.errors[:MAX_ERRORS_PER_RUN]):
            if not err or not err.strip():
                continue
            items.append(("error", f"{run.run_id}:err:{idx}", err[:MAX_ERROR_TEXT]))

    # Filter empties, batch-embed, and bulk upsert.
    rows = [(etype, eid, text) for etype, eid, text in items if text and text.strip()]
    if not rows:
        return

    vecs = await embed_batch([text for _, _, text in rows])
    for (etype, eid, text), vec in zip(rows, vecs, strict=True):
        stmt = (
            pg_insert(Embedding)
            .values(entity_type=etype, entity_id=eid, text=text, vector=vec)
            .on_conflict_do_update(
                index_elements=["entity_type", "entity_id"],
                set_={"text": text, "vector": vec},
            )
        )
        await session.execute(stmt)

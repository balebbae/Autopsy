"""Embedding provider abstraction.

Default 'stub' provider returns a deterministic hashed vector so the API
works without any model download. Switch to 'local' (sentence-transformers,
extra='ml') or 'openai' (extra='openai') by setting EMBED_PROVIDER.
"""

from __future__ import annotations

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


_GEMINI_EMBED_MODEL = "models/text-embedding-004"


async def _gemini_embed(texts: list[str], settings: Settings) -> list[float]:
    """Embed a single text via Google ``text-embedding-004`` (free-tier, 768-d)."""
    import google.generativeai as genai  # type: ignore

    genai.configure(api_key=settings.gemini_api_key)
    result = genai.embed_content(model=_GEMINI_EMBED_MODEL, content=texts[0])
    return [float(x) for x in result["embedding"]]


async def _gemini_embed_batch(texts: list[str], settings: Settings) -> list[list[float]]:
    """Batch-embed via Google ``text-embedding-004``.

    ``embed_content`` accepts a list of strings and returns a list of
    vectors in one round-trip (free tier: 1 500 req/min).
    """
    import google.generativeai as genai  # type: ignore

    genai.configure(api_key=settings.gemini_api_key)
    result = genai.embed_content(model=_GEMINI_EMBED_MODEL, content=texts)
    vecs = result["embedding"]
    if texts and not isinstance(vecs[0], list):
        return [[float(x) for x in vecs]]
    return [[float(x) for x in v] for v in vecs]


async def embed(text: str) -> list[float]:
    """Single-text embedding. Use :func:`embed_batch` when you have N>1
    items — it amortizes the model overhead and is cheaper for paid APIs.
    """
    settings = get_settings()
    if settings.embed_provider == "stub":
        return _stub_embed(text, settings.embed_dim)

    if settings.embed_provider == "local":
        # _local_model() lazily imports sentence_transformers so the heavy
        # dep isn't required when EMBED_PROVIDER is "stub" or "openai".
        model = _local_model(settings.embed_model)
        vec = model.encode(text, normalize_embeddings=True).tolist()
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
        vecs = model.encode(texts, normalize_embeddings=True).tolist()
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

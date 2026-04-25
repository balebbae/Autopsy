"""Embedding provider abstraction.

Default 'stub' provider returns a deterministic hashed vector so the API
works without any model download. Switch to 'local' (sentence-transformers,
extra='ml') or 'openai' (extra='openai') by setting EMBED_PROVIDER.
"""

from __future__ import annotations

import hashlib

from aag.config import get_settings


def _stub_embed(text: str, dim: int) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    # cheap deterministic float vector in [-1, 1]
    raw = (digest * ((dim // len(digest)) + 1))[:dim]
    return [(b - 128) / 128.0 for b in raw]


async def embed(text: str) -> list[float]:
    settings = get_settings()
    if settings.embed_provider == "stub":
        return _stub_embed(text, settings.embed_dim)

    if settings.embed_provider == "local":
        # Imported lazily so the heavy dep isn't required by default.
        from sentence_transformers import SentenceTransformer  # type: ignore

        model = _local_model(settings.embed_model)
        vec = model.encode(text, normalize_embeddings=True).tolist()
        return list(vec)

    if settings.embed_provider == "openai":
        from openai import AsyncOpenAI  # type: ignore

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        resp = await client.embeddings.create(model=settings.embed_model, input=text)
        return list(resp.data[0].embedding)

    raise ValueError(f"unknown EMBED_PROVIDER: {settings.embed_provider}")


_local_cache: dict[str, object] = {}


def _local_model(name: str):
    from sentence_transformers import SentenceTransformer  # type: ignore

    if name not in _local_cache:
        _local_cache[name] = SentenceTransformer(name)
    return _local_cache[name]

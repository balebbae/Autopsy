"""Tiny in-process TTL cache for ``PreflightResponse``.

Designed to absorb the duplicate calls a single chat turn naturally makes —
``experimental.chat.system.transform`` and the first
``tool.execute.before`` in the same turn typically share the same task
text — without paying for a second graph traversal (or a second LLM
synthesis call).

Scope: single uvicorn worker. If the service ever scales to multiple
workers, swap this for Redis or accept the hit. Cache key is
``(project, sha256(task)[:32])`` (128-bit hash for collision headroom)
so two projects with identical task text don't share results — preflight
retrieval is project-scoped (Phase 2).

Entries also carry the structured ``failure_modes`` / ``fix_patterns`` /
``top_failure_score`` we computed during the original call. The /v1/preflight
handler uses these on cache-hit to persist a ``preflight_hits`` row for the
new run without re-running the graph traversal.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from aag.schemas.preflight import PreflightResponse

_MAX_ENTRIES = 256


@dataclass
class CachedPreflight:
    """Public cache entry shape — what callers read out via :func:`get`.

    ``response`` is the wire-shape :class:`PreflightResponse` we'd return
    over the API. The other fields are extra structured data the persistence
    layer needs but the API doesn't surface (so they don't pollute the
    OpenAPI schema).
    """

    response: PreflightResponse
    top_failure_score: float = 0.0
    failure_modes: list[tuple[str, float]] = field(default_factory=list)
    fix_patterns: list[tuple[str, float]] = field(default_factory=list)


class _Entry:
    __slots__ = ("expires_at", "value")

    def __init__(self, value: CachedPreflight, expires_at: float) -> None:
        self.value = value
        self.expires_at = expires_at


# OrderedDict gives us O(1) FIFO eviction when we exceed _MAX_ENTRIES.
_cache: OrderedDict[str, _Entry] = OrderedDict()


def _key(project: str | None, task: str) -> str:
    digest = hashlib.sha256(task.encode("utf-8")).hexdigest()[:32]
    return f"{project or ''}|{digest}"


def get(project: str | None, task: str) -> CachedPreflight | None:
    """Return the cached entry for ``(project, task)`` or ``None``.

    Expired entries are evicted lazily on access. We don't run a sweep —
    the hot path stays branch-free.
    """
    k = _key(project, task)
    entry = _cache.get(k)
    if entry is None:
        return None
    if entry.expires_at < time.monotonic():
        _cache.pop(k, None)
        return None
    # Re-insert to mark this entry as recently used (LRU-ish on top of FIFO).
    _cache.move_to_end(k)
    return entry.value


def put(
    project: str | None,
    task: str,
    value: CachedPreflight,
    ttl_seconds: int,
) -> None:
    """Insert (or overwrite) the cached entry for ``(project, task)``.

    On overflow, evicts the oldest entry. ``ttl_seconds <= 0`` disables
    caching entirely (the caller should not reach put() in that case, but
    we no-op defensively).
    """
    if ttl_seconds <= 0:
        return
    k = _key(project, task)
    _cache[k] = _Entry(value, time.monotonic() + ttl_seconds)
    _cache.move_to_end(k)
    while len(_cache) > _MAX_ENTRIES:
        _cache.popitem(last=False)


def clear() -> None:
    """Drop every entry. Used by tests."""
    _cache.clear()

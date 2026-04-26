"""Phase 3 tests: preflight LLM synthesis + cache + block knob.

These tests don't require Postgres — they exercise the cache module and
the synthesizer's gating behaviour with the network call mocked. The
end-to-end traversal-with-synth path is covered indirectly via
``test_traversal.py`` (template fallback) since the dev environment
default is ``preflight_llm_enabled=False``.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from aag.graph import preflight_cache, preflight_synth, traversal
from aag.schemas.preflight import PreflightResponse


@pytest.fixture(autouse=True)
def _clear_cache():
    preflight_cache.clear()
    yield
    preflight_cache.clear()


def _wrap(resp: PreflightResponse) -> preflight_cache.CachedPreflight:
    """Wrap a PreflightResponse in the structured cache entry shape."""
    return preflight_cache.CachedPreflight(response=resp)


def test_cache_get_miss_returns_none():
    assert preflight_cache.get("proj", "task") is None


def test_cache_get_after_put_returns_value():
    resp = PreflightResponse(risk_level="low", system_addendum="hi")
    preflight_cache.put("proj", "task A", _wrap(resp), ttl_seconds=300)
    cached = preflight_cache.get("proj", "task A")
    assert cached is not None
    assert cached.response is resp


def test_cache_scopes_by_project():
    """Same task text in different projects must NOT share entries —
    Phase 2 made retrieval project-scoped.
    """
    resp_a = PreflightResponse(risk_level="high", system_addendum="A")
    resp_b = PreflightResponse(risk_level="none", system_addendum="B")
    preflight_cache.put("proj-a", "shared task", _wrap(resp_a), ttl_seconds=300)
    preflight_cache.put("proj-b", "shared task", _wrap(resp_b), ttl_seconds=300)
    cached_a = preflight_cache.get("proj-a", "shared task")
    cached_b = preflight_cache.get("proj-b", "shared task")
    assert cached_a is not None and cached_a.response is resp_a
    assert cached_b is not None and cached_b.response is resp_b


def test_cache_handles_none_project():
    resp = PreflightResponse(risk_level="medium")
    preflight_cache.put(None, "task", _wrap(resp), ttl_seconds=300)
    cached = preflight_cache.get(None, "task")
    assert cached is not None
    assert cached.response is resp


def test_cache_zero_ttl_is_noop():
    resp = PreflightResponse(risk_level="low")
    preflight_cache.put("proj", "task", _wrap(resp), ttl_seconds=0)
    assert preflight_cache.get("proj", "task") is None


def test_cache_expires():
    """Past expiry, the entry must be evicted on next read."""
    import time

    resp = PreflightResponse(risk_level="low")
    preflight_cache.put("proj", "task", _wrap(resp), ttl_seconds=300)
    # Force expiry by patching monotonic forward.
    with patch.object(time, "monotonic", return_value=time.monotonic() + 10_000):
        assert preflight_cache.get("proj", "task") is None


def test_cache_evicts_oldest_at_capacity():
    """LRU-ish eviction so the cache can't grow unboundedly."""
    # Drop _MAX_ENTRIES temporarily for a deterministic test.
    with patch.object(preflight_cache, "_MAX_ENTRIES", 3):
        for i in range(5):
            preflight_cache.put(
                "p",
                f"task-{i}",
                _wrap(PreflightResponse(risk_level="low")),
                ttl_seconds=300,
            )
        # Earliest two should be gone.
        assert preflight_cache.get("p", "task-0") is None
        assert preflight_cache.get("p", "task-1") is None
        # Most recent three retained.
        assert preflight_cache.get("p", "task-2") is not None
        assert preflight_cache.get("p", "task-3") is not None
        assert preflight_cache.get("p", "task-4") is not None


def test_cache_carries_structured_data_for_persistence():
    """The cache also stores top_failure_score / failure_modes / fix_patterns
    so the /v1/preflight handler can persist a hit row on cache-hit without
    re-running the graph traversal."""
    resp = PreflightResponse(risk_level="medium", system_addendum="x")
    entry = preflight_cache.CachedPreflight(
        response=resp,
        top_failure_score=2.4,
        failure_modes=[("incomplete_schema_change", 2.4)],
        fix_patterns=[("regenerate_types", 1.7)],
    )
    preflight_cache.put("proj", "task", entry, ttl_seconds=300)
    cached = preflight_cache.get("proj", "task")
    assert cached is not None
    assert cached.response is resp
    assert cached.top_failure_score == pytest.approx(2.4)
    assert cached.failure_modes == [("incomplete_schema_change", 2.4)]
    assert cached.fix_patterns == [("regenerate_types", 1.7)]


# --- block knob ----------------------------------------------------------


def test_should_block_default_never_blocks():
    assert traversal._should_block(99.0, threshold=None) is False


def test_should_block_above_threshold():
    assert traversal._should_block(2.5, threshold=2.0) is True


def test_should_block_below_threshold():
    assert traversal._should_block(1.9, threshold=2.0) is False


# --- synthesizer gating --------------------------------------------------


@pytest.mark.asyncio
async def test_synthesize_no_failure_modes_returns_none():
    out = await preflight_synth.synthesize(
        session=None,  # type: ignore[arg-type]
        task="anything",
        top_failure_modes=[],
        top_fix_patterns=[],
        similar_run_ids=[],
    )
    assert out is None


@pytest.mark.asyncio
async def test_synthesize_with_llm_disabled_returns_none(monkeypatch):
    """With LLM_PROVIDER=none, _call_gemma must early-return None and the
    synthesizer must propagate that so the caller falls back to template.
    """
    from aag.config import get_settings

    monkeypatch.setenv("LLM_PROVIDER", "none")
    get_settings.cache_clear()
    try:
        # Skip _fetch_patches by mocking it (no DB available in this test).
        with patch.object(preflight_synth, "_fetch_patches", AsyncMock(return_value=[])):
            out = await preflight_synth.synthesize(
                session=None,  # type: ignore[arg-type]
                task="add column",
                top_failure_modes=[("incomplete_schema_change", 2.0)],
                top_fix_patterns=[("regenerate types", 1.5)],
                similar_run_ids=["r1"],
            )
        assert out is None
    finally:
        monkeypatch.delenv("LLM_PROVIDER", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_synthesize_returns_llm_text_on_success(monkeypatch):
    """When _call_gemma returns text, synthesize() forwards it (after
    stripping any stray markdown fences)."""
    from aag.config import get_settings

    monkeypatch.setenv("LLM_PROVIDER", "gemma")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    get_settings.cache_clear()

    fake_text = (
        "```\nWatch the migrations folder; the past run forgot to "
        "regenerate types. Re-run codegen after editing the model.\n```"
    )
    try:
        with (
            patch.object(preflight_synth, "_fetch_patches", AsyncMock(return_value=[])),
            patch.object(preflight_synth, "_call_gemma", AsyncMock(return_value=fake_text)),
        ):
            out = await preflight_synth.synthesize(
                session=None,  # type: ignore[arg-type]
                task="add column",
                top_failure_modes=[("incomplete_schema_change", 2.0)],
                top_fix_patterns=[("regenerate types", 1.5)],
                similar_run_ids=["r1"],
            )
        assert out is not None
        # Markdown fences must be stripped.
        assert "```" not in out
        assert "migrations" in out
    finally:
        monkeypatch.delenv("LLM_PROVIDER", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_synthesize_returns_none_when_llm_returns_none(monkeypatch):
    """Timeout / parse error path: _call_gemma returns None →
    synthesize() returns None → caller falls back to template.
    """
    from aag.config import get_settings

    monkeypatch.setenv("LLM_PROVIDER", "gemma")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    get_settings.cache_clear()
    try:
        with (
            patch.object(preflight_synth, "_fetch_patches", AsyncMock(return_value=[])),
            patch.object(preflight_synth, "_call_gemma", AsyncMock(return_value=None)),
        ):
            out = await preflight_synth.synthesize(
                session=None,  # type: ignore[arg-type]
                task="add column",
                top_failure_modes=[("incomplete_schema_change", 2.0)],
                top_fix_patterns=[],
                similar_run_ids=[],
            )
        assert out is None
    finally:
        monkeypatch.delenv("LLM_PROVIDER", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_call_gemma_respects_timeout(monkeypatch):
    """A slow Gemma call must be aborted at the configured timeout, with
    None returned (so the caller falls back to template)."""
    from aag.config import get_settings

    monkeypatch.setenv("LLM_PROVIDER", "gemma")
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")
    monkeypatch.setenv("PREFLIGHT_LLM_TIMEOUT_MS", "50")
    get_settings.cache_clear()

    # Patch the genai import path so the inner _do() function actually
    # runs but blocks longer than the timeout.
    fake_genai = type(
        "FakeGenAI",
        (),
        {
            "configure": staticmethod(lambda **kw: None),
            "GenerationConfig": lambda **kw: kw,
        },
    )

    class FakeModel:
        def __init__(self, **kw):
            pass

        async def generate_content_async(self, prompt: str):
            await asyncio.sleep(2.0)  # >> 50ms timeout
            return type("R", (), {"text": "should never get here"})()

    fake_genai.GenerativeModel = FakeModel  # type: ignore[attr-defined]

    import sys

    monkeypatch.setitem(sys.modules, "google", type("g", (), {})())
    monkeypatch.setitem(sys.modules, "google.generativeai", fake_genai)
    try:
        out = await preflight_synth._call_gemma("prompt", "system")
        assert out is None
    finally:
        monkeypatch.delenv("LLM_PROVIDER", raising=False)
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.delenv("PREFLIGHT_LLM_TIMEOUT_MS", raising=False)
        get_settings.cache_clear()

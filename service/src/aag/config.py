"""Environment-driven settings for the AAG service."""

import logging
import sys
from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

# Vector dim per provider. The embeddings.vector column is sized from this at
# table-creation time, so flipping providers without `make embed-reset` will
# fail at insert. db.verify_vector_dim() catches the mismatch at startup.
PROVIDER_DIM: dict[str, int] = {"stub": 384, "local": 384, "openai": 1536}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # HTTP
    host: str = "0.0.0.0"
    port: int = 4000
    log_level: str = "info"

    # Postgres (asyncpg URL — note the "+asyncpg" driver hint)
    database_url: str = "postgresql+asyncpg://aag:aag@localhost:5432/aag"

    # Embeddings. Dim is derived from provider via the property below.
    embed_provider: Literal["stub", "local", "openai"] = "stub"
    embed_model: str = "sentence-transformers/all-MiniLM-L6-v2"

    # Optional API keys
    openai_api_key: str | None = None

    # LLM-assisted classification (Gemma via Google AI Studio)
    llm_provider: Literal["none", "gemma"] = "none"
    gemma_model: str = "gemma-3-12b-it"
    gemini_api_key: str | None = None

    # Auth
    aag_token: str = "devtoken"

    # Preflight retrieval tuning
    preflight_half_life_days: float = 30.0
    preflight_counter_weight: float = 0.5

    # Preflight synthesis (Phase 3): if enabled, run a fast LLM call to turn
    # the retrieved subgraph into a 2-3 sentence prose addendum. Falls back
    # to the deterministic template on timeout / API failure / no key.
    # Requires ``LLM_PROVIDER=gemma`` + ``GEMINI_API_KEY``.
    preflight_llm_enabled: bool = False
    preflight_llm_timeout_ms: int = 800

    # Preflight blocking (Phase 3): if set, ``tool.execute.before`` is
    # allowed to abort the tool when the top FailureMode score (after
    # dampening) exceeds this threshold. Default ``None`` = warnings only,
    # which matches the current safe default. Production opt-in.
    preflight_block_threshold: float | None = None

    # In-process TTL cache for preflight responses (project + task hash).
    # 5 minutes is short enough to pick up new graph data quickly while
    # absorbing the duplicate calls a single chat turn often makes
    # (system.transform + tool.execute.before).
    preflight_cache_ttl_s: int = 300

    # TTL for *negative* preflight results (``risk_level=none``). Held
    # much shorter than positive results so a brand-new run that gets
    # rejected immediately can be retrieved by the next turn — without
    # this knob, the first preflight call against an empty graph would
    # poison the cache for 5 minutes and hide all subsequent evidence.
    # Still long enough to absorb the same-turn duplicates that motivated
    # caching in the first place.
    preflight_negative_cache_ttl_s: int = 30

    # Stale-run sweeper. Flips ``active`` runs that haven't seen an event
    # in ``stale_run_threshold_ms`` to ``aborted`` so the dashboard
    # doesn't pin abandoned runs as "Live" forever. The plugin's
    # lifecycle handlers cover the graceful-exit path; this is the
    # safety net for SIGKILL / crashes / network drops.
    #
    # Threshold default is conservative: even a long human-thinking pause
    # rarely exceeds 30 minutes, and shorter values risk flipping a run
    # the user is actively (but slowly) iterating on.
    stale_run_threshold_ms: int = 30 * 60 * 1000  # 30 min
    stale_run_sweep_interval_ms: int = 60 * 1000  # 1 min
    stale_run_sweep_disabled: bool = False

    @property
    def embed_dim(self) -> int:
        return PROVIDER_DIM[self.embed_provider]


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    # Loud warning when stub is in use outside a test session — stub vectors
    # are sha256-derived noise, so retrieval only matches exact strings.
    if settings.embed_provider == "stub" and "pytest" not in sys.modules:
        logging.getLogger(__name__).warning(
            "EMBED_PROVIDER=stub: retrieval will only match exact strings. "
            "Set EMBED_PROVIDER=local for semantic similarity."
        )
    return settings

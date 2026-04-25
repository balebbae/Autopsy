"""Environment-driven settings for the AAG service."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


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

    # Embeddings
    embed_provider: Literal["stub", "local", "openai"] = "stub"
    embed_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    embed_dim: int = 384

    # Optional API keys
    openai_api_key: str | None = None

    # LLM-assisted classification (Gemma via Google AI Studio)
    llm_provider: Literal["none", "gemma"] = "none"
    gemma_model: str = "gemma-3-12b-it"
    gemini_api_key: str | None = None

    # Auth
    aag_token: str = "devtoken"


@lru_cache
def get_settings() -> Settings:
    return Settings()

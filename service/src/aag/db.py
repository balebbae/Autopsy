"""Async SQLAlchemy engine + session.

Engine creation is lazy so the service can boot without postgres reachable
(useful during hackathon iteration when someone forgets `make compose-up`).
"""

import logging
from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from aag.config import get_settings

log = logging.getLogger(__name__)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        _engine = create_async_engine(
            get_settings().database_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
        )
    return _engine


def sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(engine(), expire_on_commit=False)
    return _sessionmaker


async def get_session() -> AsyncIterator[AsyncSession]:
    async with sessionmaker()() as session:
        yield session


async def dispose() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _sessionmaker = None


async def verify_vector_dim() -> None:
    """Fail fast when EMBED_PROVIDER's expected dim doesn't match the live
    `embeddings.vector` column.

    Skipped silently if Postgres is unreachable so `make dev` without
    docker still boots. Skipped silently if the table doesn't exist yet
    (first boot; `db-schema.sql` will create it).
    """
    expected = get_settings().embed_dim
    try:
        async with sessionmaker()() as session:
            row = (
                await session.execute(
                    text(
                        "SELECT atttypmod FROM pg_attribute "
                        "WHERE attrelid = 'embeddings'::regclass "
                        "AND attname = 'vector'"
                    )
                )
            ).first()
    except SQLAlchemyError as exc:
        log.info("verify_vector_dim: skipped (%s)", exc.__class__.__name__)
        return
    if row is None:
        return  # table not created yet
    actual = int(row[0])
    if actual != expected:
        raise RuntimeError(
            f"embeddings.vector is {actual} dims but EMBED_PROVIDER expects {expected}. "
            "Run `make embed-reset` to drop and recreate the table (destructive)."
        )

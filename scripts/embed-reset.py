#!/usr/bin/env python3
"""Drop + recreate the `embeddings` table to match the configured EMBED_PROVIDER dim.

Destructive: existing vectors are lost.

Usage:
    cd service && uv run python ../scripts/embed-reset.py
"""

from __future__ import annotations

import asyncio

from sqlalchemy import text

from aag.config import get_settings
from aag.db import engine
from aag.models import Base, Embedding


async def main() -> None:
    settings = get_settings()
    eng = engine()
    async with eng.begin() as conn:
        await conn.execute(text("DROP TABLE IF EXISTS embeddings CASCADE"))
        await conn.run_sync(Embedding.__table__.create)
        # Re-create the ivfflat index that lives in db-schema.sql but not in
        # the SQLAlchemy model.
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS embeddings_vector_idx "
                "ON embeddings USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)"
            )
        )
    await eng.dispose()
    print(
        f"embeddings recreated with vector({settings.embed_dim}) "
        f"for EMBED_PROVIDER={settings.embed_provider}"
    )
    _ = Base  # keep the import — ensures all models are registered before create


if __name__ == "__main__":
    asyncio.run(main())

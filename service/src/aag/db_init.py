"""Idempotent schema bootstrap that runs on service startup.

The base schema (`contracts/db-schema.sql`) is mounted into postgres'
`docker-entrypoint-initdb.d/` so it only runs on *first* boot — i.e. when
the data volume is empty. That means contract changes (new tables, new
columns) never reach pre-existing dev databases unless someone manually
runs `make db-reset` or the SQL by hand.

Every statement in `db-schema.sql` is written to be idempotent
(`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN IF NOT EXISTS`), so re-running it on startup
is safe and fixes the silent-drift problem.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from sqlalchemy import text

from aag.db import engine

log = logging.getLogger(__name__)

# Walk up from this file (service/src/aag/db_init.py) to the repo root
# (4 parents) and into contracts/.
_SCHEMA_PATH = Path(__file__).resolve().parents[3] / "contracts" / "db-schema.sql"


def _split_statements(sql: str) -> list[str]:
    """Split a SQL script into statements on top-level semicolons.

    The schema has no DO/$$ blocks or functions, so a naive split is fine.
    Strips comments and blank statements.
    """
    # Strip line comments. Block comments (`/* */`) aren't used in this schema.
    no_line_comments = re.sub(r"--[^\n]*", "", sql)
    parts = [s.strip() for s in no_line_comments.split(";")]
    return [s for s in parts if s]


async def init_schema() -> None:
    """Apply contracts/db-schema.sql to the live database.

    Each statement is executed in its own transaction so a single failure
    (e.g. a column already added with a different type than the contract
    expects) doesn't poison the rest. Errors are logged and skipped — the
    service continues to start.

    No-op when the schema file isn't bundled (e.g. production deploys that
    only ship the wheel).
    """
    if not _SCHEMA_PATH.exists():
        log.info("init_schema: %s not found — skipping", _SCHEMA_PATH)
        return

    sql = _SCHEMA_PATH.read_text()
    statements = _split_statements(sql)

    eng = engine()
    applied = 0
    for stmt in statements:
        try:
            async with eng.begin() as conn:
                await conn.execute(text(stmt))
            applied += 1
        except Exception:  # noqa: BLE001
            log.warning(
                "init_schema: statement failed (continuing): %s",
                stmt.splitlines()[0][:120],
                exc_info=True,
            )
    log.info("init_schema: applied %d/%d statements", applied, len(statements))

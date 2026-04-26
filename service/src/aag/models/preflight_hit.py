"""preflight_hits — one row per /v1/preflight call that returned non-none risk.

Persisted so the dashboard can render an "Autopsy caught something" badge on
the run row, and so we can measure preflight effectiveness over time. The
addendum field stores the actual prose injected into the agent's system
prompt (or null when the addendum was empty / template-only).
"""

from datetime import datetime
from typing import Any

from sqlalchemy import ARRAY, REAL, BigInteger, Boolean, ForeignKey, Index, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from aag.models.base import Base


class PreflightHit(Base):
    __tablename__ = "preflight_hits"
    __table_args__ = (
        Index("preflight_hits_run_ts_idx", "run_id", "ts"),
        Index("preflight_hits_risk_idx", "risk_level"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        Text, ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False
    )
    ts: Mapped[int] = mapped_column(BigInteger, nullable=False)
    task: Mapped[str] = mapped_column(Text, nullable=False)
    risk_level: Mapped[str] = mapped_column(Text, nullable=False)
    top_failure_score: Mapped[float] = mapped_column(REAL, nullable=False)
    blocked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    tool: Mapped[str | None] = mapped_column(Text)
    args: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    similar_runs: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, default=list, server_default="{}"
    )
    top_failure_modes: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    top_fix_patterns: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, default=list, server_default="[]"
    )
    addendum: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

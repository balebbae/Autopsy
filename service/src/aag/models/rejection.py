"""rejections — one row per user-filed rejection during a thread.

A run may accumulate many rejections without ending. The run's terminal
status is only set when `/v1/runs/{run_id}/outcome` is explicitly called.
"""

from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from aag.models.base import Base


class Rejection(Base):
    __tablename__ = "rejections"
    __table_args__ = (Index("rejections_run_ts_idx", "run_id", "ts"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        Text, ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False
    )
    ts: Mapped[int] = mapped_column(BigInteger, nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    failure_mode: Mapped[str | None] = mapped_column(Text)
    symptoms: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text, nullable=False, default="plugin")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    run: Mapped["Run"] = relationship(back_populates="rejections")  # noqa: F821

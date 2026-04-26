"""runs / run_events / artifacts."""

from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Index, Integer, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.sql import func

from aag.models.base import Base


class Run(Base):
    __tablename__ = "runs"

    run_id: Mapped[str] = mapped_column(Text, primary_key=True)
    project: Mapped[str | None] = mapped_column(Text)
    worktree: Mapped[str | None] = mapped_column(Text)
    task: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    ended_at: Mapped[int | None] = mapped_column(BigInteger)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="active")
    rejection_reason: Mapped[str | None] = mapped_column(Text)
    rejection_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    files_touched: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    summary: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now())

    events: Mapped[list["RunEvent"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    artifacts: Mapped[list["Artifact"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    rejections: Mapped[list["Rejection"]] = relationship(  # noqa: F821
        back_populates="run", cascade="all, delete-orphan", order_by="Rejection.ts"
    )


class RunEvent(Base):
    __tablename__ = "run_events"
    __table_args__ = (
        UniqueConstraint("run_id", "event_id"),
        Index("run_events_run_ts_idx", "run_id", "ts"),
        Index("run_events_type_idx", "type"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_id: Mapped[str | None] = mapped_column(Text)
    run_id: Mapped[str] = mapped_column(
        Text, ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False
    )
    ts: Mapped[int] = mapped_column(BigInteger, nullable=False)
    type: Mapped[str] = mapped_column(Text, nullable=False)
    properties: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    run: Mapped[Run] = relationship(back_populates="events")


class Artifact(Base):
    __tablename__ = "artifacts"
    __table_args__ = (Index("artifacts_run_kind_idx", "run_id", "kind"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        Text, ForeignKey("runs.run_id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    captured_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    run: Mapped[Run] = relationship(back_populates="artifacts")

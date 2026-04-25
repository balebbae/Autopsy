"""failure_cases — analyzer output, one per analyzed run."""

from datetime import datetime

from sqlalchemy import ForeignKey, Index, Text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from aag.models.base import Base


class FailureCase(Base):
    __tablename__ = "failure_cases"
    __table_args__ = (Index("failure_cases_mode_idx", "failure_mode"),)

    run_id: Mapped[str] = mapped_column(
        Text, ForeignKey("runs.run_id", ondelete="CASCADE"), primary_key=True
    )
    task_type: Mapped[str | None] = mapped_column(Text)
    failure_mode: Mapped[str] = mapped_column(Text, nullable=False)
    fix_pattern: Mapped[str | None] = mapped_column(Text)
    components: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    change_patterns: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    symptoms: Mapped[list[dict]] = mapped_column(JSONB, default=list)
    summary: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

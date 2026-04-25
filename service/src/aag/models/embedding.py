"""embeddings — pgvector store for ANN retrieval."""

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.sql import func

from aag.config import get_settings
from aag.models.base import Base


class Embedding(Base):
    __tablename__ = "embeddings"
    __table_args__ = (UniqueConstraint("entity_type", "entity_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[str] = mapped_column(Text, nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    vector: Mapped[list[float]] = mapped_column(Vector(get_settings().embed_dim), nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

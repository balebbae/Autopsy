"""Graph node/edge response schemas."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class GraphNodeOut(BaseModel):
    id: str
    type: str
    name: str
    properties: dict[str, Any] = Field(default_factory=dict)


class GraphEdgeOut(BaseModel):
    id: int
    source_id: str
    target_id: str
    type: str
    confidence: float = 0.5
    evidence_run_id: str | None = None
    properties: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Knowledge export / import
# ---------------------------------------------------------------------------


class ExportEmbedding(BaseModel):
    entity_type: Literal["task", "failure", "fix", "run_summary"]
    text: str
    vector: list[float]


class ExportSymptom(BaseModel):
    name: str
    evidence: list[str] = Field(default_factory=list)
    confidence: float = 0.5
    source: str | None = None


class ExportCase(BaseModel):
    """One historical FailureCase, packaged for portability."""

    source_run_id: str
    started_at: int = 0
    ended_at: int | None = None
    status: Literal["rejected", "approved", "aborted"] = "rejected"
    task: str | None = None
    task_type: str | None = None
    failure_mode: str
    fix_pattern: str | None = None
    components: list[str] = Field(default_factory=list)
    change_patterns: list[str] = Field(default_factory=list)
    symptoms: list[ExportSymptom] = Field(default_factory=list)
    summary: str | None = None
    embeddings: list[ExportEmbedding] = Field(default_factory=list)


class ExportSource(BaseModel):
    project: str | None = None
    source_label: str | None = None
    embed_provider: str | None = None
    embed_dim: int | None = None


class ExportBundle(BaseModel):
    """Portable knowledge bundle. ``schema_version`` gates compatibility."""

    # Allow round-tripping unknown keys without dropping them — older servers
    # forward future fields conservatively rather than silently stripping.
    model_config = ConfigDict(extra="allow")

    schema_version: int
    exported_at: int
    source: ExportSource = Field(default_factory=ExportSource)
    cases: list[ExportCase] = Field(default_factory=list)


class ImportResult(BaseModel):
    cases_added: int = 0
    cases_skipped: int = 0
    embeddings_added: int = 0
    embeddings_skipped: int = 0

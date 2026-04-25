"""Detect schema-field-addition change patterns in the run's diffs."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

SCHEMA_FILE_RE = re.compile(
    r"\.schema\.ts$|\.model\.py$|schema\.prisma$|\.table\.ts$"
    r"|models?\.py$|serializer[s]?\.py$|types?\.ts$"
    r"|\.service\.ts$|\.entity\.ts$",
)

FIELD_ADDITION_RE = re.compile(
    r"^\+\s*"
    r"(?:"
    r"\w+[\?!]?\s*[:=]"  # TS/JS field: name?: type or name = value
    r"|[\w]+\s*:\s*Mapped"  # SQLAlchemy mapped column
    r"|[\w]+\s*=\s*(?:Column|Field|mapped_column)"  # Pydantic/SA field
    r"|[\w]+\s+\w+.*@(?:db\.|default)"  # Prisma field
    r")",
)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    evidence: list[str] = []

    for path, patch in ctx.patches.items():
        if not patch:
            continue
        is_schema_file = bool(SCHEMA_FILE_RE.search(path))
        has_type_context = "interface " in patch or "class " in patch or is_schema_file
        for line in patch.splitlines():
            if not line.startswith("+") or line.startswith("+++"):
                continue
            if has_type_context and FIELD_ADDITION_RE.match(line):
                evidence.append(f"{path}: {line.strip()}")

    if not evidence:
        return None

    return Symptom(
        name="schema_field_addition",
        evidence=evidence[:10],
        confidence=0.8,
    )

"""Symptom: production code changed, no test file changed."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

TEST_FILE_RE = re.compile(
    r"_test\.\w+$|\.test\.\w+$|\.spec\.\w+$|(?:^|/)tests?/|(?:^|/)__tests__/",
    re.IGNORECASE,
)

NON_SOURCE_RE = re.compile(
    r"\.(md|txt|json|yaml|yml|toml|cfg|ini|lock|csv)$|(?:^|/)\.|(^|/)README",
    re.IGNORECASE,
)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    source_files = [
        f for f in ctx.files if not TEST_FILE_RE.search(f) and not NON_SOURCE_RE.search(f)
    ]
    if not source_files:
        return None

    test_files = [f for f in ctx.files if TEST_FILE_RE.search(f)]
    if test_files:
        return None

    return Symptom(
        name="missing_test",
        evidence=[f"changed {f} with no test file" for f in source_files[:5]],
        confidence=0.5,
    )

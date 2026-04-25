"""Symptom: production code changed, no test file changed."""

from __future__ import annotations

# TODO(R3): if any non-test file changed and no path matches *_test.* or
# *.test.* or tests/**, emit symptom.

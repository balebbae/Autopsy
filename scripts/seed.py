#!/usr/bin/env python3
"""Seed the graph with synthetic failure cases via the public HTTP API.

R3 owns the actual seed content. This stub is here so `make seed` works
end-to-end day one.

Usage:
    uv run python scripts/seed.py
"""

from __future__ import annotations

import os

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")


def main() -> int:
    with httpx.Client(base_url=AAG_URL, timeout=10.0) as client:
        r = client.get("/v1/health")
        r.raise_for_status()
        print(f"service ok at {AAG_URL}")
    # TODO(R3): POST /v1/events for ~5 synthetic runs covering distinct
    # failure modes (incomplete_schema_change, missing_test, etc.) then
    # POST /v1/runs/:id/outcome=rejected with feedback to trigger the
    # analyzer + graph writer.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

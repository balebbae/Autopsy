#!/usr/bin/env python3
"""Replay a fixture file into POST /v1/events so the dashboard has data
without running opencode end-to-end. Useful for offline iteration.

Usage:
    uv run python scripts/replay-fixture.py contracts/fixtures/run-rejected-schema.json

The script also POSTs the fixture's `outcome` and `feedback` so the run is
finalized and the analyzer (when wired) will fire.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import httpx

AAG_URL = os.environ.get("AAG_URL", "http://localhost:4000")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: replay-fixture.py <path-to-fixture.json>", file=sys.stderr)
        return 2
    fixture = json.loads(Path(sys.argv[1]).read_text())

    with httpx.Client(base_url=AAG_URL, timeout=10.0) as client:
        # 1. Stream events
        for ev in fixture["events"]:
            r = client.post("/v1/events", json={"events": [ev]})
            r.raise_for_status()
        print(f"replayed {len(fixture['events'])} events for run {fixture['run_id']}")

        # 2. Finalize outcome (triggers analyzer once R3 wires it)
        outcome = fixture.get("outcome")
        if outcome:
            r = client.post(
                f"/v1/runs/{fixture['run_id']}/outcome",
                json={"outcome": outcome, "feedback": fixture.get("feedback")},
            )
            r.raise_for_status()
            print(f"set outcome={outcome}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

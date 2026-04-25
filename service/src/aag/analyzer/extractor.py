"""Extract entities (Files, Components, ChangePatterns) from a Run.

R3: implement extract(run) returning the inputs needed by aag.graph.writer.
A simple component heuristic: take the second path segment after the worktree
root (e.g. src/profile/* -> Component "profile"). Refine when needed.
"""

from __future__ import annotations

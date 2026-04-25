"""Detect user frustration from conversation messages.

Scans user_messages for profanity, insults, and strong negative sentiment.
This catches the "obvious" cases — the user explicitly saying the output is
bad. Subtler dissatisfaction is handled by the LLM-side system prompt
injection (see plugin/src/handlers/system.ts).
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from aag.analyzer.classifier import RunContext
    from aag.schemas.runs import Symptom

FRUSTRATION_RE = re.compile(
    r"""
    \b(
        shit|shitty|ass|fuck|fucked|fucking|wtf|wth
        |trash|garbage|terrible|horrible|awful|useless
        |stupid|idiot|dumb|crap|crappy
        |hate\s+this|this\s+sucks|worst|broken|ruined
        |kill\s+yourself|kys|redo\s+(this|it|everything)
        |start\s+over|throw\s+(this|it)\s+away
        |what\s+the\s+hell|are\s+you\s+serious
        |completely\s+wrong|totally\s+wrong
        |not\s+what\s+i\s+(asked|wanted|said|meant)
        |wrong\s+wrong\s+wrong|no\s+no\s+no
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

STRONG_NEGATIVE_RE = re.compile(
    r"""
    \b(
        revert|undo|roll\s*back|scrap\s+(this|it)
        |don'?t\s+touch|stop|abort|cancel
        |you\s+broke|you\s+ruined|you\s+messed
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    if not ctx.user_messages:
        return None

    evidence: list[str] = []

    for msg in ctx.user_messages:
        if FRUSTRATION_RE.search(msg):
            snippet = msg[:200]
            evidence.append(f"frustration: {snippet}")
        elif STRONG_NEGATIVE_RE.search(msg):
            snippet = msg[:200]
            evidence.append(f"negative directive: {snippet}")

    if not evidence:
        return None

    confidence = min(0.6 + 0.1 * len(evidence), 0.9)

    return Symptom(name="user_frustration", evidence=evidence, confidence=confidence)

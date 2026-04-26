"""Detect user dissatisfaction from conversation messages.

Scans user_messages across three tiers:
- Frustration: profanity, insults, harsh language
- Rejection: clear non-profane rejection, rollback, and correction signals
- Dissatisfaction: moderate displeasure, redirection, mild correction

Each tier contributes a different weight to the confidence score.
Subtler signals (tone, implication) are handled by the LLM-side system
prompt injection (see plugin/src/handlers/system.ts).
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

REJECTION_RE = re.compile(
    r"""
    \b(
        revert|undo|roll\s*back|scrap\s+(this|it)
        |don'?t\s+touch|stop|abort|cancel
        |you\s+broke|you\s+ruined|you\s+messed
        |that'?s\s+(wrong|incorrect|not\s+(right|correct|what))
        |this\s+is\s+(wrong|incorrect|bad|worse)
        |doesn'?t\s+work|didn'?t\s+work|not\s+working|won'?t\s+work
        |still\s+(broken|wrong|not\s+working|failing|bugged)
        |change\s+(it|this|that)\s+back|put\s+(it|this|that)\s+back
        |remove\s+(this|that|it|all\s+of)|take\s+(this|that|it)\s+out
        |get\s+rid\s+of
        |i\s+didn'?t\s+(ask|say|want|mean)\s+(for|that|this|you\s+to)
        |that\s+makes\s+no\s+sense|this\s+makes\s+no\s+sense
        |that'?s\s+not\s+even\s+close|way\s+off|missed\s+the\s+(point|mark)
        |you'?re\s+not\s+listening|read\s+my\s+message
        |i\s+already\s+(told|said|asked)\s+you
    )\b
    """,
    re.IGNORECASE | re.VERBOSE,
)

DISSATISFACTION_RE = re.compile(
    r"""
    (
        ^no[,!.]
        |^nope\b|^nah\b
        |\btry\s+again\b|\bdo\s+(it|this)\s+again\b
        |\bnot\s+(quite|exactly|really)\b|\bclose\s+but\b
        |\bwhy\s+did\s+you\b|\bwhy\s+would\s+you\b
        |\bnot\s+helpful\b|\bnot\s+(good|great)\b
        |\byou\s+missed\b|\byou\s+forgot\b|\byou\s+ignored\b
        |\bwhat\s+happened\s+to\b
        |\bplease\s+(don'?t|stop|remove|undo|revert|fix)\b
        |\bI\s+said\b.*\bnot\b
    )
    """,
    re.IGNORECASE | re.VERBOSE | re.MULTILINE,
)


def check(ctx: RunContext) -> Symptom | None:
    from aag.schemas.runs import Symptom

    if not ctx.user_messages:
        return None

    score = 0.0
    evidence: list[str] = []

    for msg in ctx.user_messages:
        if FRUSTRATION_RE.search(msg):
            snippet = msg[:200]
            evidence.append(f"frustration: {snippet}")
            score += 0.25
        elif REJECTION_RE.search(msg):
            snippet = msg[:200]
            evidence.append(f"rejection: {snippet}")
            score += 0.20
        elif DISSATISFACTION_RE.search(msg):
            snippet = msg[:200]
            evidence.append(f"dissatisfaction: {snippet}")
            score += 0.10

    if not evidence:
        return None

    confidence = min(0.4 + score, 0.95)

    return Symptom(name="user_frustration", evidence=evidence, confidence=confidence)

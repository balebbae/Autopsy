"""GET /v1/runs/:id/report — markdown autopsy report."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse

from aag.deps import SessionDep
from aag.models import FailureCase, Run

router = APIRouter()


@router.get("/runs/{run_id}/report", response_class=PlainTextResponse)
async def get_report(run_id: str, session: SessionDep) -> str:
    run = await session.get(Run, run_id)
    if run is None:
        raise HTTPException(404, "Run not found")

    fc = await session.get(FailureCase, run_id)

    lines = [
        f"# Autopsy Report: {run.run_id}",
        "",
        f"**Task**: {run.task or 'Unknown'}",
        f"**Status**: {run.status}",
        f"**Started**: {run.started_at}",
        f"**Ended**: {run.ended_at or 'N/A'}",
        "",
    ]

    if run.rejection_reason:
        lines.extend(
            [
                "## Rejection Reason",
                run.rejection_reason,
                "",
            ]
        )

    if fc:
        lines.extend(
            [
                "## Failure Analysis",
                "",
                f"**Failure Mode**: `{fc.failure_mode}`",
                f"**Fix Pattern**: {fc.fix_pattern or 'None identified'}",
                "",
            ]
        )

        if fc.symptoms:
            lines.extend(["### Symptoms", ""])
            for s in fc.symptoms:
                symptom = s if isinstance(s, dict) else s
                name = symptom.get("name", "unknown") if isinstance(symptom, dict) else str(symptom)
                confidence = symptom.get("confidence", 0) if isinstance(symptom, dict) else 0
                evidence = symptom.get("evidence", []) if isinstance(symptom, dict) else []
                lines.append(f"- **{name}** (confidence: {confidence:.0%})")
                for e in evidence[:3]:
                    lines.append(f"  - `{e}`")
            lines.append("")

        if fc.components:
            lines.extend(
                [
                    "### Components Affected",
                    ", ".join(f"`{c}`" for c in fc.components),
                    "",
                ]
            )

        if fc.change_patterns:
            lines.extend(
                [
                    "### Change Patterns",
                    ", ".join(f"`{c}`" for c in fc.change_patterns),
                    "",
                ]
            )

        if fc.summary:
            lines.extend(
                [
                    "### Summary",
                    fc.summary,
                    "",
                ]
            )
    else:
        lines.extend(
            [
                "## Failure Analysis",
                "",
                "_No failure analysis available for this run._",
                "",
            ]
        )

    return "\n".join(lines)

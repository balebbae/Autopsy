"""Optional LLM step: synthesize a 2-3 sentence preflight addendum.

The deterministic ``_template_addendum`` in ``traversal.py`` produces a
formulaic warning ("Similar past task failed with: incomplete_schema_change.
Watch out for: ...") which is fine but hard for the agent to act on.
When ``PREFLIGHT_LLM_ENABLED=true`` (and Gemma is configured), this module
turns the retrieved subgraph + a couple of past patches into actionable
prose.

Hard requirements:

  - Bounded latency: ``asyncio.wait_for`` against
    ``settings.preflight_llm_timeout_ms``. Preflight is on the agent's
    critical path; an LLM that hangs must never block the chat.
  - Graceful fallback: any timeout, missing key, or parse error returns
    ``None``; the caller falls back to the template.
  - No state: this module never writes to the DB. Patch sampling reads
    the artifacts table read-only.
"""

from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from aag.config import get_settings

log = logging.getLogger(__name__)

# Caps so the prompt stays small (and cheap). Gemma 3 12B has plenty of
# context but a tiny prompt is faster end-to-end.
MAX_PATCHES = 2
MAX_PATCH_CHARS = 800
MAX_FAILURE_MODES = 3
MAX_FIX_PATTERNS = 3

SYSTEM_PROMPT = """\
You are a code-review preflight assistant. The user is about to ask an AI \
coding agent to do a task. We have retrieved similar past tasks that \
failed and want to warn the agent.

Output: 2 to 3 short sentences of plain English. No preamble, no \
markdown headers, no numbered lists. Cite a specific file path or check \
when one is available in the evidence. Tone is direct and constructive — \
this addendum is appended to the agent's system prompt, not shown to the \
user. Never invent details that aren't in the evidence."""


_PATCHES_SQL = text(
    """
    SELECT a.run_id, a.content
    FROM artifacts a
    WHERE a.run_id = ANY(:run_ids)
      AND a.kind = 'diff'
    ORDER BY a.captured_at DESC
    LIMIT :limit
    """
)


def _render_patch_excerpt(content: dict | list) -> str | None:
    """Pull a single file's patch text from a ``diff`` artifact (either
    shape: ``{files: [...]}`` from ``session.diff`` or ``{path, oldText,
    newText}`` from a synthesized ``tool.execute.after``).
    """
    if isinstance(content, dict):
        files = content.get("files")
        if isinstance(files, list) and files:
            f = files[0]
            patch = f.get("patch") or ""
            path = f.get("file") or "?"
            if patch:
                return f"{path}:\n{patch[:MAX_PATCH_CHARS]}"
        # tool.execute.after diff shape
        path = content.get("path")
        new_text = content.get("newText") or ""
        if path and new_text:
            return f"{path}:\n{new_text[:MAX_PATCH_CHARS]}"
    return None


async def _fetch_patches(session: AsyncSession, run_ids: list[str]) -> list[str]:
    """Fetch up to ``MAX_PATCHES`` patch excerpts from the most recent
    rejected runs. Used to anchor the LLM in concrete code, not just
    failure-mode names.
    """
    if not run_ids:
        return []
    rows = (await session.execute(_PATCHES_SQL, {"run_ids": run_ids, "limit": MAX_PATCHES})).all()
    excerpts: list[str] = []
    for row in rows:
        rendered = _render_patch_excerpt(row.content)
        if rendered:
            excerpts.append(rendered)
    return excerpts


def _build_prompt(
    *,
    task: str,
    top_failure_modes: list[tuple[str, float]],
    top_fix_patterns: list[tuple[str, float]],
    similar_run_ids: list[str],
    patch_excerpts: list[str],
) -> str:
    parts: list[str] = [f"## Current task\n{task.strip()[:400]}"]

    if top_failure_modes:
        fm_lines = "\n".join(
            f"- {name} (score {score:.2f})" for name, score in top_failure_modes[:MAX_FAILURE_MODES]
        )
        parts.append(f"## Past failure modes (most relevant first)\n{fm_lines}")

    if top_fix_patterns:
        fp_lines = "\n".join(f"- {name}" for name, _ in top_fix_patterns[:MAX_FIX_PATTERNS])
        parts.append(f"## Suggested fixes from past runs\n{fp_lines}")

    if similar_run_ids:
        parts.append(f"## Similar past rejected runs\n{', '.join(similar_run_ids[:5])}")

    if patch_excerpts:
        parts.append("## Patches from those runs\n" + "\n\n".join(patch_excerpts))

    parts.append(
        "Write 2-3 sentences warning the agent. Reference a file or "
        "concrete check when possible. No preamble."
    )
    return "\n\n".join(parts)


async def _call_gemma(prompt: str, system: str) -> str | None:
    """Wrap Gemma with a hard timeout. Returns the response text or None
    on any failure (timeout, missing key, ImportError, parse error)."""
    settings = get_settings()
    if settings.llm_provider != "gemma":
        return None
    if not settings.gemini_api_key:
        return None

    try:
        import google.generativeai as genai  # type: ignore
    except ImportError:
        return None

    timeout_s = max(settings.preflight_llm_timeout_ms / 1000.0, 0.05)

    async def _do() -> str | None:
        try:
            genai.configure(api_key=settings.gemini_api_key)
            model = genai.GenerativeModel(
                model_name=settings.gemma_model,
                system_instruction=system,
                generation_config=genai.GenerationConfig(temperature=0.2),
            )
            response = await model.generate_content_async(prompt)
            text_out = (getattr(response, "text", "") or "").strip()
            return text_out or None
        except Exception:
            log.exception("preflight Gemma call failed")
            return None

    try:
        return await asyncio.wait_for(_do(), timeout=timeout_s)
    except TimeoutError:
        log.info("preflight LLM timed out after %dms", settings.preflight_llm_timeout_ms)
        return None


async def synthesize(
    *,
    session: AsyncSession,
    task: str,
    top_failure_modes: list[tuple[str, float]],
    top_fix_patterns: list[tuple[str, float]],
    similar_run_ids: list[str],
) -> str | None:
    """Run the optional LLM synthesis step. Returns prose addendum or
    ``None`` to signal the caller to use the deterministic template.

    Caller is responsible for the gating decision (e.g.
    ``settings.preflight_llm_enabled``); we always attempt synthesis
    when called.
    """
    if not top_failure_modes:
        return None

    patch_excerpts = await _fetch_patches(session, similar_run_ids)
    prompt = _build_prompt(
        task=task,
        top_failure_modes=top_failure_modes,
        top_fix_patterns=top_fix_patterns,
        similar_run_ids=similar_run_ids,
        patch_excerpts=patch_excerpts,
    )
    text_out = await _call_gemma(prompt, SYSTEM_PROMPT)
    if not text_out:
        return None
    # Strip markdown fences if Gemma decided to add them despite the
    # system prompt explicitly forbidding it.
    text_out = text_out.strip()
    if text_out.startswith("```"):
        text_out = text_out.split("\n", 1)[-1]
        if text_out.endswith("```"):
            text_out = text_out[:-3]
        text_out = text_out.strip()
    return text_out or None

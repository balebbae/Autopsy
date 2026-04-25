# AGENTS.md — Agent Autopsy Graph (root)

Project-specific notes for the Agent Autopsy Graph monorepo.

## Workspace conventions

- Don't run tests from the repo root. Tests live inside packages (`service/`, `dashboard/`, `plugin/`).
- opencode is not vendored here — install it from <https://opencode.ai/docs/>. Our plugin is loaded via `.opencode/plugins/autopsy.ts` (symlinked by `make plugin-link`).
- **API and DB contracts**: `contracts/openapi.yaml` and `contracts/db-schema.sql` are the source of truth. Update both in the same commit when changing endpoints or tables.
- Common dev commands: `make dev` (full stack), `make seed` (synthetic failures), `make replay` (demo run → dashboard).

## Service (Python / FastAPI / uv)

- Python 3.12+. Manage deps with `uv add` / `uv remove`; never edit `pyproject.toml` deps by hand.
- Format and lint: `make service-lint` (or `cd service && uv run ruff check . && uv run ruff format --check .`).
- Type-check with `pyright` if installed.
- Test: `make service-test` (or `cd service && uv run pytest -q`).
- Use SQLAlchemy 2.x async (`AsyncSession`); never block the event loop.
- Pydantic v2 for request/response schemas; SQLAlchemy ORM models live in `aag.models`, request/response models in `aag.schemas`.
- All endpoints prefixed `/v1/`.

## Plugin (TS / opencode)

- Plugin source loaded directly by opencode (Bun-based runtime); a build step is optional. For local dev the recommended path is `make plugin-link`, which symlinks the entry into `.opencode/plugins/autopsy.ts`.
- Don't import from `@opencode-ai/plugin` runtime — only the type. The plugin gets its `client`, `$`, etc. injected by the loader.
- The plugin must never block the LLM stream on a slow backend call. Use a fire-and-forget batcher for the `event` hook.

## Dashboard (Next.js)

- App Router, TypeScript, Tailwind. SSE consumer in `src/lib/sse.ts`.
- Read the AAG service URL from `NEXT_PUBLIC_AAG_URL`.

## Infra

- Postgres image: `pgvector/pgvector:pg16`. The `vector` extension and base schema are applied from `infra/postgres/` and `contracts/db-schema.sql` at first boot.
- `make db-reset` is destructive — it drops the volume.

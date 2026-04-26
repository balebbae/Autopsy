"""FastAPI app factory."""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from aag import __version__
from aag.config import get_settings
from aag.db import dispose, verify_vector_dim
from aag.db_init import init_schema
from aag.routes import events, graph, preflight, runs, stream
from aag.workers.stale_sweeper import run_periodic as run_stale_sweeper

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Idempotent — re-applies contracts/db-schema.sql so additive contract
    # changes (new tables / columns / indexes) reach existing dev databases
    # without requiring `make db-reset`.
    try:
        await init_schema()
    except Exception:  # noqa: BLE001
        log.exception("init_schema failed (continuing)")
    # Verify pgvector column dimension matches the configured EMBED_PROVIDER's
    # PROVIDER_DIM. Fails loudly if a provider switch happened without
    # `make embed-reset`, since silent dim mismatch corrupts ANN search.
    await verify_vector_dim()

    # Spawn the stale-run sweeper. This is the safety net for the case
    # where the plugin (R1) couldn't post a final outcome — opencode was
    # force-killed, the laptop crashed, etc. Without it, abandoned runs
    # stay pinned as "Active / Live" in the dashboard forever. The
    # `STALE_RUN_SWEEP_DISABLED=true` env var lets ops opt out.
    settings = get_settings()
    sweeper_task: asyncio.Task[None] | None = None
    if not settings.stale_run_sweep_disabled:
        sweeper_task = asyncio.create_task(
            run_stale_sweeper(
                threshold_ms=settings.stale_run_threshold_ms,
                interval_ms=settings.stale_run_sweep_interval_ms,
            ),
            name="aag.stale_sweeper",
        )

    try:
        yield
    finally:
        if sweeper_task is not None:
            sweeper_task.cancel()
            # CancelledError is the expected path; everything else is
            # already logged inside the sweeper. Either way we don't
            # want shutdown to fail because of cleanup.
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await sweeper_task
        await dispose()


app = FastAPI(
    title="Agent Autopsy Graph",
    version=__version__,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)

# CORS — be explicit about dev origins so the dashboard's preflight OPTIONS
# never gets rejected. ``allow_origins=["*"]`` combined with
# ``allow_credentials=True`` is invalid per the CORS spec — browsers reject
# the wildcard whenever credentials are sent, which has bitten us in the
# past (the dashboard's `fetch(..., {credentials: 'include'})` paths just
# silently fail). Spell out the local dev origins, and use
# ``allow_origin_regex`` to keep the wildcard semantics for everything else.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ],
    allow_origin_regex=r".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=600,
)


@app.get("/v1/health", tags=["events"])
async def health() -> dict[str, bool]:
    return {"ok": True}


app.include_router(events.router, prefix="/v1", tags=["events"])
app.include_router(runs.router, prefix="/v1", tags=["runs"])
app.include_router(preflight.router, prefix="/v1", tags=["preflight"])
app.include_router(stream.router, prefix="/v1", tags=["stream"])
app.include_router(graph.router, prefix="/v1", tags=["graph"])

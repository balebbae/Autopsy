"""FastAPI app factory."""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from aag import __version__
from aag.db import dispose
from aag.routes import events, graph, preflight, runs, stream


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await dispose()


app = FastAPI(
    title="Agent Autopsy Graph",
    version=__version__,
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten before any non-local deploy
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/v1/health", tags=["events"])
async def health() -> dict[str, bool]:
    return {"ok": True}


app.include_router(events.router, prefix="/v1", tags=["events"])
app.include_router(runs.router, prefix="/v1", tags=["runs"])
app.include_router(preflight.router, prefix="/v1", tags=["preflight"])
app.include_router(stream.router, prefix="/v1", tags=["stream"])
app.include_router(graph.router, prefix="/v1", tags=["graph"])

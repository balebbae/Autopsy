"""Test fixtures."""

import os

# Force the deterministic stub embedding provider for the entire test session,
# regardless of what the dev .env has. Must run before any `aag.*` import.
os.environ["EMBED_PROVIDER"] = "stub"

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from aag.config import get_settings  # noqa: E402
from aag.db import dispose  # noqa: E402
from aag.main import app  # noqa: E402

# Reset cached settings so the EMBED_PROVIDER override above takes effect even
# if some import path called get_settings() prior to the env var being set.
get_settings.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest_asyncio.fixture(autouse=True)
async def _dispose_engine_between_tests():
    """Recycle the global async engine per test.

    pytest-asyncio creates a new event loop per test by default; the engine
    cached in `aag.db._engine` is bound to whichever loop created it first,
    which causes "Future attached to a different loop" errors in subsequent
    tests. Disposing before and after each test guarantees a fresh engine
    on this test's loop.
    """
    await dispose()
    yield
    await dispose()

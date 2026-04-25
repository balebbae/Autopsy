"""Test fixtures."""

import pytest
from fastapi.testclient import TestClient

from aag.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)

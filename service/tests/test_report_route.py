"""Tests for the /v1/runs/{run_id}/report endpoint."""

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from aag.main import app
from aag.models import FailureCase, Run

client = TestClient(app)


def test_report_unknown_run():
    """GET /v1/runs/<missing>/report returns 404."""
    with patch("aag.routes.report.get_report") as mock_handler:
        mock_handler.side_effect = None  # won't be called
    r = client.get("/v1/runs/nonexistent-id/report")
    assert r.status_code == 404


def _make_run(run_id: str = "test-run-1", **kwargs) -> Run:
    defaults = {
        "run_id": run_id,
        "started_at": 1_714_000_000_000,
        "status": "rejected",
        "task": "Add email verification",
        "rejection_reason": "Missing migration",
    }
    defaults.update(kwargs)
    return Run(**defaults)


def _make_fc(run_id: str = "test-run-1", **kwargs) -> FailureCase:
    defaults = {
        "run_id": run_id,
        "failure_mode": "incomplete_schema_change",
        "fix_pattern": "Add migration file",
        "components": ["auth", "users"],
        "change_patterns": ["schema_change"],
        "symptoms": [
            {"name": "missing_migration", "confidence": 0.9, "evidence": ["user.schema.ts"]},
        ],
        "summary": "Schema changed without migration.",
    }
    defaults.update(kwargs)
    return FailureCase(**defaults)


def test_report_with_failure_case():
    """GET /v1/runs/<id>/report returns markdown with correct headers."""
    run = _make_run()
    fc = _make_fc()

    async def fake_get(model, pk):
        if model is Run:
            return run
        if model is FailureCase:
            return fc
        return None

    with patch("aag.db.sessionmaker") as mock_sm:
        mock_session = AsyncMock()
        mock_session.get = AsyncMock(side_effect=fake_get)
        mock_ctx = AsyncMock()
        mock_ctx.__aenter__ = AsyncMock(return_value=mock_session)
        mock_ctx.__aexit__ = AsyncMock(return_value=False)
        mock_sm.return_value = mock_ctx

        with patch("aag.deps.get_session") as mock_get_session:

            async def _override_session():
                return mock_session

            mock_get_session.return_value = mock_session
            app.dependency_overrides[_override_session] = lambda: mock_session

            from aag.db import get_session

            app.dependency_overrides[get_session] = lambda: mock_session

            try:
                r = client.get("/v1/runs/test-run-1/report")
            finally:
                app.dependency_overrides.clear()

    assert r.status_code == 200
    body = r.text
    assert "# Autopsy Report: test-run-1" in body
    assert "**Task**: Add email verification" in body
    assert "**Status**: rejected" in body
    assert "## Rejection Reason" in body
    assert "## Failure Analysis" in body
    assert "`incomplete_schema_change`" in body
    assert "### Symptoms" in body
    assert "missing_migration" in body
    assert "### Components Affected" in body
    assert "### Summary" in body


def test_report_without_failure_case():
    """Report for a run with no failure analysis shows fallback message."""
    run = _make_run(status="approved", rejection_reason=None)

    async def fake_get(model, pk):
        if model is Run:
            return run
        return None

    from aag.db import get_session

    mock_session = AsyncMock()
    mock_session.get = AsyncMock(side_effect=fake_get)

    app.dependency_overrides[get_session] = lambda: mock_session
    try:
        r = client.get("/v1/runs/test-run-1/report")
    finally:
        app.dependency_overrides.clear()

    assert r.status_code == 200
    body = r.text
    assert "# Autopsy Report: test-run-1" in body
    assert "_No failure analysis available for this run._" in body

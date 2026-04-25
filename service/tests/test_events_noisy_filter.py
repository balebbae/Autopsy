"""Regression tests for the server-side NOISY_TYPES drop list and empty-diff
shortcut on POST /v1/events.

The plugin already filters most of these out before sending, but the
server-side check is a belt-and-suspenders for older plugins or alternative
recorders. These tests pin the constants in place so a future merge can't
silently drop them.
"""

from __future__ import annotations

from aag.routes.events import NOISY_TYPES, _is_empty_diff


def test_noisy_types_covers_known_chatty_event_types() -> None:
    expected = {
        "session.status",
        "session.updated",
        "message.part.updated",
        "message.part.removed",
        "message.part.delta",
        "message.updated",
        "message.removed",
    }
    assert expected.issubset(NOISY_TYPES), (
        "NOISY_TYPES is missing entries that the server needs to drop. "
        f"Missing: {expected - set(NOISY_TYPES)}"
    )


def test_noisy_types_is_immutable() -> None:
    # frozenset prevents accidental mutation at runtime.
    assert isinstance(NOISY_TYPES, frozenset)


def test_is_empty_diff_only_fires_on_session_diff() -> None:
    assert _is_empty_diff("session.diff", {"diff": []}) is True
    assert _is_empty_diff("session.diff", {"diff": None}) is True
    assert _is_empty_diff("session.diff", {}) is True
    assert _is_empty_diff("session.diff", {"diff": [{"path": "a"}]}) is False


def test_is_empty_diff_passes_through_other_event_types() -> None:
    # Other event types must never be treated as an empty diff, even if the
    # `diff` key happens to be missing.
    assert _is_empty_diff("session.created", {}) is False
    assert _is_empty_diff("tool.execute.after", {"diff": []}) is False
    assert _is_empty_diff("session.updated", {"diff": None}) is False

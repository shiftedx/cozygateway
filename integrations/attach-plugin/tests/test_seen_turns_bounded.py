"""Unit tests for the adapter's turn-dedupe bounding (issue #5).

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

``cozygateway.adapter`` imports the harness tree only lazily inside its methods (see
its module docstring), so ``AttachAdapter`` is importable and constructible here with
no harness and no ``websockets`` on the path. These tests exercise ``_on_turn``
directly and monkeypatch ``_spawn_background`` to a recording no-op so the
harness-dependent ``_handle_turn`` coroutine is never actually run (it is created,
then closed unawaited, which is the correct way to discard a coroutine object
without triggering a "never awaited" warning).
"""

import os
import types
import unittest

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import TurnFrame


def _make_adapter(seen_turns_max: int) -> AttachAdapter:
    """Build a bare adapter with the env-configured dedupe cap, spawn recorded."""
    adapter = AttachAdapter()
    os.environ["COZYGATEWAY_SEEN_TURNS_MAX"] = str(seen_turns_max)
    try:
        adapter._attach_init(types.SimpleNamespace(extra={}))
    finally:
        os.environ.pop("COZYGATEWAY_SEEN_TURNS_MAX", None)
    adapter.spawned = []  # type: ignore[attr-defined]

    def _record_spawn(loop, coro):
        adapter.spawned.append(coro)  # type: ignore[attr-defined]
        coro.close()  # discard the never-run coroutine cleanly

    adapter._spawn_background = _record_spawn  # type: ignore[method-assign]
    return adapter


class SeenTurnsBoundedTests(unittest.IsolatedAsyncioTestCase):
    async def test_bounded_under_a_long_stream_of_turns(self):
        adapter = _make_adapter(seen_turns_max=8)
        for i in range(500):
            adapter._on_turn(TurnFrame(thread_id="chat-1", turn_id=f"turn-{i}", text="hi"))
        self.assertLessEqual(len(adapter._seen_turns), 8)
        self.assertEqual(len(adapter.spawned), 500)  # every distinct turn still ran

    async def test_duplicate_of_in_flight_turn_is_ignored(self):
        adapter = _make_adapter(seen_turns_max=8)
        frame = TurnFrame(thread_id="chat-1", turn_id="turn-1", text="hi")
        adapter._on_turn(frame)
        adapter._on_turn(frame)  # redelivered while still in flight
        self.assertEqual(len(adapter.spawned), 1)

    async def test_duplicate_of_just_sealed_turn_is_ignored(self):
        adapter = _make_adapter(seen_turns_max=8)
        frame = TurnFrame(thread_id="chat-1", turn_id="turn-1", text="hi")
        adapter._on_turn(frame)
        adapter._cleanup_turn("chat-1", "turn-1")  # simulate the done/failed seal
        adapter._on_turn(frame)  # a re-dial replays the same turn frame
        self.assertEqual(len(adapter.spawned), 1)

    async def test_oldest_entry_is_evicted_first(self):
        adapter = _make_adapter(seen_turns_max=4)
        for i in range(4):
            adapter._on_turn(TurnFrame(thread_id="chat-1", turn_id=f"turn-{i}", text="hi"))
        # A 5th distinct turn pushes turn-0 out of the retention window.
        adapter._on_turn(TurnFrame(thread_id="chat-1", turn_id="turn-4", text="hi"))
        self.assertEqual(len(adapter.spawned), 5)

        # turn-0 fell out of the window: a redelivery now reads as a new turn
        # (harmless -- the real turn is long since sealed and gone).
        adapter._on_turn(TurnFrame(thread_id="chat-1", turn_id="turn-0", text="hi"))
        self.assertEqual(len(adapter.spawned), 6)

        # turn-4 is still inside the window: a redelivery is still deduped.
        adapter._on_turn(TurnFrame(thread_id="chat-1", turn_id="turn-4", text="hi"))
        self.assertEqual(len(adapter.spawned), 6)

    async def test_seen_turns_max_env_var_invalid_falls_back_to_default(self):
        os.environ["COZYGATEWAY_SEEN_TURNS_MAX"] = "not-a-number"
        try:
            adapter = AttachAdapter()
            adapter._attach_init(types.SimpleNamespace(extra={}))
        finally:
            os.environ.pop("COZYGATEWAY_SEEN_TURNS_MAX", None)
        self.assertGreater(adapter._seen_turns_max, 0)


if __name__ == "__main__":
    unittest.main()

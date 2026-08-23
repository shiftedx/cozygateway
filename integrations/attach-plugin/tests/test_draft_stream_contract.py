"""CozyChat's attach draft is the one mutable message for the whole turn."""

import sys
import types
import unittest

from cozygateway.adapter import AttachAdapter


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _Client:
    def __init__(self):
        self.drafts = []
        self.commits = []

    async def send_draft(self, thread_id, turn_id, blocks, tool_calls=None):
        self.drafts.append((thread_id, turn_id, blocks, tool_calls))

    async def send_done(self, thread_id, turn_id):
        self.commits.append((thread_id, turn_id))

    async def send_failed(self, thread_id, turn_id, message):
        raise AssertionError(f"unexpected failure: {message}")


class DraftStreamContractTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = {
            key: sys.modules.get(key)
            for key in ("gateway", "gateway.platforms", "gateway.platforms.base")
        }
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.SendResult = _SendResult
        gateway.platforms = platforms
        platforms.base = base
        sys.modules["gateway"] = gateway
        sys.modules["gateway.platforms"] = platforms
        sys.modules["gateway.platforms.base"] = base

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def test_tool_boundaries_do_not_finalize_the_attach_turn(self):
        """Hermes must keep segment breaks on send_draft until the real final."""

        adapter = AttachAdapter()

        self.assertTrue(adapter.draft_stream_is_message)

    async def test_interim_status_does_not_commit_or_clean_up_the_turn(self):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        client = _Client()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"

        interim = await adapter.send(
            "thread",
            "Still working",
            metadata={"_interim_send": True},
        )

        self.assertTrue(interim.success)
        self.assertEqual(adapter._active_turn, {"thread": "turn"})
        self.assertEqual(client.commits, [])

        final = await adapter.send(
            "thread",
            "Finished",
            reply_to="turn",
            metadata={"notify": True},
        )

        self.assertTrue(final.success)
        self.assertEqual(client.commits, [("thread", "turn")])
        self.assertEqual(adapter._active_turn, {})


if __name__ == "__main__":
    unittest.main()

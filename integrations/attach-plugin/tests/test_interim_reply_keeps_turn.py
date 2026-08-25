"""An interim reply is a message, not the end of the turn.

A Hermes agent loop can reply several times before it is finished: ``send_message`` to the
current chat on iteration 5 of 90 reaches this adapter on the very same ``send`` surface as the
answer that ends the run. Both used to leave the wire as a plain ``commit``, and the gateway ends
a turn on a commit, so the first interim reply killed the turn: the app stopped receiving tool
activity, and the still-running tool steps were force-terminalized ("1 did not finish") while the
agent kept working for minutes.

Hermes marks its own terminal delivery -- the turn's reply anchor, and the ``notify`` marker on
final user-visible content -- and marks nothing else with either. These tests pin that reading and
the additive ``continues`` field it produces.
"""

import sys
import types
import unittest

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _EventClient(AttachV1Client):
    """Records the durable events the real client would spool."""

    def __init__(self):
        self.events = []
        self._latest_blocks = {}
        self._latest_tools = {}

    async def _queue_event(self, event):
        self.events.append(event)
        return {"eventId": f"event-{len(self.events)}"}

    def commits(self):
        return [event for event in self.events if event["kind"] == "commit"]


class InterimReplyTests(unittest.IsolatedAsyncioTestCase):
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

    def _adapter(self):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        client = _EventClient()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"
        return adapter, client

    async def test_a_mid_run_reply_commits_its_message_and_keeps_the_turn(self):
        adapter, client = self._adapter()

        # What tools/send_message_tool.py sends on the plugin-platform path: no reply anchor,
        # no notify marker, at most a thread id.
        interim = await adapter.send("thread", "Two rooms done, still going.")

        self.assertTrue(interim.success)
        self.assertEqual(len(client.commits()), 1)
        self.assertIs(client.commits()[0]["continues"], True)
        # The anchor survives, so the drafts and tool chips of the rest of the run still land.
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

    async def test_the_reply_that_ends_the_run_seals_the_turn(self):
        adapter, client = self._adapter()

        await adapter.send("thread", "Two rooms done, still going.")
        final = await adapter.send(
            "thread",
            "All rooms audited.",
            reply_to="turn",
            metadata={"notify": True},
        )

        self.assertTrue(final.success)
        commits = client.commits()
        self.assertEqual(len(commits), 2)
        self.assertIs(commits[0]["continues"], True)
        self.assertNotIn("continues", commits[1])
        self.assertEqual(adapter._active_turn, {})

    async def test_either_hermes_mark_alone_reads_as_the_terminal_delivery(self):
        for label, kwargs in (
            ("reply anchor only", {"reply_to": "turn"}),
            ("notify marker only", {"metadata": {"notify": True}}),
        ):
            with self.subTest(label):
                adapter, client = self._adapter()
                await adapter.send("thread", "Done.", **kwargs)
                self.assertNotIn("continues", client.commits()[0], label)

    async def test_an_empty_interim_reply_is_a_no_op_not_a_failed_turn(self):
        adapter, client = self._adapter()

        result = await adapter.send("thread", "   ")

        self.assertTrue(result.success)
        self.assertEqual(client.events, [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

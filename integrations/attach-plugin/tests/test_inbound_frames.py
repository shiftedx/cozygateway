"""Harness-free tests for inbound steer/interrupt frame parsing and dispatch.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_inbound_frames -v
"""

import json
import sys
import types
import unittest

from cozygateway.adapter import INBOUND_USER, AttachAdapter
from cozygateway.attach_client import (
    AttachClient,
    AttachClientConfig,
    InterruptFrame,
    SteerFrame,
    parse_interrupt_frame,
    parse_steer_frame,
)


class ParseSteerFrameTests(unittest.TestCase):
    def test_valid_steer_frame(self):
        frame = parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u", "text": "hi"})
        self.assertEqual(frame, SteerFrame(thread_id="t", turn_id="u", text="hi"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_steer_frame({"kind": "turn", "threadId": "t", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_steer_frame({"kind": "steer", "threadId": "", "turnId": "u", "text": "x"}))
        self.assertIsNone(parse_steer_frame("nope"))


class ParseInterruptFrameTests(unittest.TestCase):
    def test_valid_interrupt_frame(self):
        frame = parse_interrupt_frame({"kind": "interrupt", "threadId": "t", "turnId": "u"})
        self.assertEqual(frame, InterruptFrame(thread_id="t", turn_id="u"))

    def test_rejects_wrong_kind_or_missing_fields(self):
        self.assertIsNone(parse_interrupt_frame({"kind": "steer", "threadId": "t", "turnId": "u"}))
        self.assertIsNone(parse_interrupt_frame({"kind": "interrupt", "threadId": "t"}))


class DispatchRoutingTests(unittest.TestCase):
    def _client(self):
        self.turns = []
        self.steers = []
        self.interrupts = []
        config = AttachClientConfig(
            gateway_url="http://gw.example",
            token="secret",
            on_turn=self.turns.append,
            on_steer=self.steers.append,
            on_interrupt=self.interrupts.append,
        )
        return AttachClient(config)

    def test_routes_each_kind_to_its_handler(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "turn", "threadId": "t", "turnId": "u", "text": "hi"}))
        client._dispatch_inbound(json.dumps({"kind": "steer", "threadId": "t", "turnId": "u", "text": "more"}))
        client._dispatch_inbound(json.dumps({"kind": "interrupt", "threadId": "t", "turnId": "u"}))
        self.assertEqual([t.text for t in self.turns], ["hi"])
        self.assertEqual([s.text for s in self.steers], ["more"])
        self.assertEqual([(i.thread_id, i.turn_id) for i in self.interrupts], [("t", "u")])

    def test_unknown_kind_and_malformed_json_are_dropped(self):
        client = self._client()
        client._dispatch_inbound(json.dumps({"kind": "mystery", "threadId": "t"}))
        client._dispatch_inbound("{not json")
        self.assertEqual(self.turns, [])
        self.assertEqual(self.steers, [])
        self.assertEqual(self.interrupts, [])


class _FakeMessageEvent:
    """Stand-in for ``gateway.platforms.base.MessageEvent`` (harness not on the path).

    Records exactly the kwargs the adapter constructs it with so a dispatch test can
    assert the injected text, source addressing, and (absence of) a reply anchor.
    """

    def __init__(self, text, source, message_id=None):
        self.text = text
        self.source = source
        self.message_id = message_id


class DispatchInjectionTests(unittest.IsolatedAsyncioTestCase):
    """Prove the adapter's steer/interrupt handlers inject the right inbound message.

    ``cozygateway.adapter`` imports the harness only lazily inside its methods, so a
    fake ``gateway.platforms.base`` module supplying ``MessageEvent`` lets these run
    with no harness installed. ``build_source`` and ``handle_message`` are faked the
    same way for both handlers, so the interrupt test asserts the new behavior
    (an injected native ``/stop`` command) with no reference to any harness seam.
    """

    _MODULE_KEYS = ("gateway", "gateway.platforms", "gateway.platforms.base")

    def setUp(self):
        # Install a minimal fake harness package tree so the adapter's lazy
        # ``from gateway.platforms.base import MessageEvent`` resolves to the fake.
        self._saved_modules = {k: sys.modules.get(k) for k in self._MODULE_KEYS}
        gateway_mod = types.ModuleType("gateway")
        platforms_mod = types.ModuleType("gateway.platforms")
        base_mod = types.ModuleType("gateway.platforms.base")
        base_mod.MessageEvent = _FakeMessageEvent
        gateway_mod.platforms = platforms_mod
        platforms_mod.base = base_mod
        sys.modules["gateway"] = gateway_mod
        sys.modules["gateway.platforms"] = platforms_mod
        sys.modules["gateway.platforms.base"] = base_mod

    def tearDown(self):
        for key, value in self._saved_modules.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def _make_adapter(self):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter.injected = []  # type: ignore[attr-defined]

        def _fake_build_source(**kwargs):
            return types.SimpleNamespace(**kwargs)

        async def _fake_handle_message(event):
            adapter.injected.append(event)  # type: ignore[attr-defined]

        adapter.build_source = _fake_build_source  # type: ignore[attr-defined]
        adapter.handle_message = _fake_handle_message  # type: ignore[attr-defined]
        return adapter

    async def test_interrupt_injects_native_stop_command(self):
        adapter = self._make_adapter()
        await adapter._handle_interrupt(InterruptFrame(thread_id="chat-1", turn_id="turn-1"))
        self.assertEqual(len(adapter.injected), 1)
        event = adapter.injected[0]
        # The injected command text is exactly "/stop" -- the harness recognizes the
        # bypass command from the message text, hard-stopping the run.
        self.assertEqual(event.text, "/stop")
        # A command carries no turn-derived reply anchor.
        self.assertIsNone(event.message_id)
        # Addressed to the same thread/session identity the turn/steer handlers use.
        self.assertEqual(event.source.chat_id, "chat-1")
        self.assertEqual(event.source.chat_type, "dm")
        self.assertEqual(event.source.user_id, INBOUND_USER)
        self.assertTrue(event.source.role_authorized)

    async def test_steer_injects_text_on_the_same_thread(self):
        # The steer counterpart shares the fake build_source/handle_message shape;
        # the interrupt test above mirrors it exactly but sends "/stop" and no anchor.
        adapter = self._make_adapter()
        await adapter._handle_steer(
            SteerFrame(thread_id="chat-1", turn_id="turn-1", text="keep going")
        )
        self.assertEqual(len(adapter.injected), 1)
        event = adapter.injected[0]
        self.assertEqual(event.text, "keep going")
        self.assertEqual(event.source.chat_id, "chat-1")
        # The steer's injected message uses a distinct anchor; the running turn's
        # reply anchor is deliberately left untouched.
        self.assertEqual(event.message_id, "turn-1:steer")

    async def test_interrupt_inject_failure_never_raises(self):
        adapter = self._make_adapter()

        async def _boom(event):
            raise RuntimeError("handle_message exploded")

        adapter.handle_message = _boom  # type: ignore[attr-defined]
        # A failed inject must degrade to a best-effort no-op, not crash the drain loop.
        await adapter._handle_interrupt(InterruptFrame(thread_id="chat-1", turn_id="turn-1"))


if __name__ == "__main__":
    unittest.main()

"""Unit tests for reading the harness's real tool call id off the native
pre_tool_call / post_tool_call hook payload (issue #7).

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

``cozygateway.adapter`` imports the harness tree only lazily inside its methods
(see its module docstring), so ``_dispatch_tool_hook`` and the active-adapter
registry are exercisable here with no harness on the path. These tests
monkeypatch ``_current_turn_platform_and_chat`` (normally backed by the
harness's session context) to simulate a hook firing mid-turn, and register a
recording fake in place of a real ``AttachAdapter`` to observe exactly what
``_dispatch_tool_hook`` forwards.
"""

import unittest

import cozygateway.adapter as adapter_module


class _RecordingAdapter:
    def __init__(self):
        self.events = []

    def observe_tool_event(self, chat_id, phase, tool_name, detail, call_id=None):
        self.events.append((chat_id, phase, tool_name, detail, call_id))


class ToolCallIdExtractionTests(unittest.TestCase):
    def test_present_id_is_extracted(self):
        self.assertEqual(adapter_module._tool_call_id({"tool_call_id": "call-123"}), "call-123")

    def test_missing_key_yields_none(self):
        self.assertIsNone(adapter_module._tool_call_id({}))

    def test_harness_default_empty_string_yields_none(self):
        # model_tools.py's real hook emitter passes tool_call_id=(tool_call_id or "")
        # when the harness itself has no id to give -- an empty string, not an
        # absent key.
        self.assertIsNone(adapter_module._tool_call_id({"tool_call_id": ""}))

    def test_whitespace_only_id_yields_none(self):
        self.assertIsNone(adapter_module._tool_call_id({"tool_call_id": "   "}))

    def test_id_is_stripped(self):
        self.assertEqual(adapter_module._tool_call_id({"tool_call_id": "  call-9  "}), "call-9")


class DispatchToolHookForwardsCallIdTests(unittest.TestCase):
    def setUp(self):
        self._orig_lookup = adapter_module._current_turn_platform_and_chat
        adapter_module._current_turn_platform_and_chat = lambda: (
            adapter_module.PLATFORM_NAME,
            "chat-1",
        )
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)

    def tearDown(self):
        adapter_module._current_turn_platform_and_chat = self._orig_lookup
        adapter_module._unregister_active_adapter(self.adapter)

    def test_pre_tool_call_forwards_the_harness_call_id(self):
        adapter_module._pre_tool_call(
            tool_name="search", args={"q": "x"}, tool_call_id="call-abc"
        )
        self.assertEqual(len(self.adapter.events), 1)
        chat_id, phase, tool_name, _detail, call_id = self.adapter.events[0]
        self.assertEqual((chat_id, phase, tool_name, call_id), ("chat-1", "start", "search", "call-abc"))

    def test_post_tool_call_forwards_the_harness_call_id(self):
        adapter_module._post_tool_call(
            tool_name="search", result="ok", status="ok", tool_call_id="call-abc"
        )
        self.assertEqual(len(self.adapter.events), 1)
        _chat_id, phase, _tool_name, _detail, call_id = self.adapter.events[0]
        self.assertEqual(phase, "complete")
        self.assertEqual(call_id, "call-abc")

    def test_missing_call_id_forwards_none_not_empty_string(self):
        adapter_module._pre_tool_call(tool_name="search", args={}, tool_call_id="")
        _chat_id, _phase, _tool_name, _detail, call_id = self.adapter.events[0]
        self.assertIsNone(call_id)

    def test_no_tool_call_id_kwarg_at_all_forwards_none(self):
        adapter_module._pre_tool_call(tool_name="search", args={})
        _chat_id, _phase, _tool_name, _detail, call_id = self.adapter.events[0]
        self.assertIsNone(call_id)


if __name__ == "__main__":
    unittest.main()

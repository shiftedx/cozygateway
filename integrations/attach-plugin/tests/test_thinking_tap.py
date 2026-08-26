"""Unit tests for the live thinking preview tap (capability ``thinking``).

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

Same harness-free pattern as ``test_subagent_hook_dispatch.py``: the module-level
``on_stream_delta`` dispatch is observed through a recording fake, and the adapter's
coalescing/suppression coroutines run against a bare ``AttachAdapter`` built with
``object.__new__`` so no harness import is needed.
"""

import asyncio
import time
import unittest

import cozygateway.adapter as adapter_module
from cozygateway.adapter import AttachAdapter, _sanitize_thinking


class SanitizeThinkingTests(unittest.TestCase):
    def test_tail_truncates_to_the_280_char_preview(self):
        text = _sanitize_thinking("start " + "word " * 200)
        self.assertLessEqual(len(text), 280)
        self.assertTrue(text.startswith("…"))
        self.assertTrue(text.endswith("word"))

    def test_short_prose_passes_through(self):
        self.assertEqual(
            _sanitize_thinking("The user wants a summary.  I should check the tests first."),
            "The user wants a summary. I should check the tests first.",
        )

    def test_redacts_paths_credentials_and_code_spans(self):
        raw = (
            "open /Users/kyle/Secrets/notes.txt then home ~/Documents/repos/x and call with "
            "api_key=sk_live_abcdefghijklmnop123456 plus `rm -rf /tmp/x` and "
            '```json {"arg": "secret-value"} ``` then Authorization: Bearer abc.def.ghi'
        )
        text = _sanitize_thinking(raw)
        self.assertNotIn("/Users", text)
        self.assertNotIn("Documents", text)
        self.assertNotIn("sk_live", text)
        self.assertNotIn("rm -rf", text)
        self.assertNotIn("secret-value", text)
        self.assertNotIn("abc.def.ghi", text)

    def test_redacts_long_opaque_token_runs(self):
        text = _sanitize_thinking("token is ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 done")
        self.assertNotIn("ghp_", text)
        self.assertIn("[redacted]", text)

    def test_unclosed_fence_drops_the_rest(self):
        # Tool args quoted into a fence the model never closed must not leak.
        text = _sanitize_thinking('plan ```{"cmd": "curl -H secret"}')
        self.assertNotIn("curl", text)


class _RecordingAdapter:
    def __init__(self):
        self.deltas = []

    def observe_reasoning_delta(self, delta):
        self.deltas.append(delta)


class StreamDeltaDispatchTests(unittest.TestCase):
    def setUp(self):
        self.adapter = _RecordingAdapter()
        adapter_module._register_active_adapter(self.adapter)

    def tearDown(self):
        adapter_module._unregister_active_adapter(self.adapter)

    def test_forwards_reasoning_deltas_for_this_surface(self):
        adapter_module._on_stream_delta(
            delta="weighing options", kind="reasoning",
            surface=adapter_module.PLATFORM_NAME, turn_id="h-1", session_id="s-1",
        )
        self.assertEqual(self.adapter.deltas, ["weighing options"])

    def test_ignores_content_deltas_and_foreign_surfaces(self):
        adapter_module._on_stream_delta(
            delta="reply text", kind="text", surface=adapter_module.PLATFORM_NAME,
        )
        adapter_module._on_stream_delta(
            delta="other platform", kind="reasoning", surface="discord",
        )
        adapter_module._on_stream_delta(
            delta="cli turn", kind="reasoning", surface="cli",
        )
        self.assertEqual(self.adapter.deltas, [])


class _FakeClient:
    def __init__(self):
        self.sent = []

    async def send_thinking(self, chat_id, turn_id, text, *, seq, last_active_at):
        self.sent.append({"chat": chat_id, "turn": turn_id, "text": text, "seq": seq})


def _bare_adapter():
    adapter = object.__new__(AttachAdapter)
    adapter._active_turn = {"chat-1": "turn-1"}
    adapter._thinking = {}
    adapter._client = _FakeClient()
    adapter._thinking_sleep = asyncio.sleep
    return adapter


async def _drain():
    for _ in range(4):
        await asyncio.sleep(0)


class ThinkingTapTests(unittest.IsolatedAsyncioTestCase):
    async def test_coalesces_a_burst_into_one_emit_with_the_full_tail(self):
        adapter = _bare_adapter()
        await adapter._apply_reasoning_delta("first thought ")
        await adapter._apply_reasoning_delta("second thought")
        await _drain()
        sent = adapter._client.sent
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["text"], "first thought second thought")
        self.assertEqual(sent[0], {"chat": "chat-1", "turn": "turn-1", "text": "first thought second thought", "seq": 1})

    async def test_next_emit_waits_a_full_coalesce_window(self):
        adapter = _bare_adapter()
        slept = []

        async def fake_sleep(delay):
            slept.append(delay)

        adapter._thinking_sleep = fake_sleep
        await adapter._apply_reasoning_delta("first")
        await _drain()
        await adapter._apply_reasoning_delta(" second")
        await _drain()
        self.assertEqual(len(adapter._client.sent), 2)
        self.assertEqual(adapter._client.sent[1]["seq"], 2)
        # The second emit was scheduled >= (coalesce - elapsed) after the first: ~a full second.
        self.assertGreaterEqual(max(slept), 0.5)

    async def test_unchanged_sanitized_text_is_not_re_emitted(self):
        adapter = _bare_adapter()
        await adapter._apply_reasoning_delta("stable thought")
        await _drain()
        adapter._thinking["turn-1"].last_emit = 0.0  # window elapsed
        await adapter._apply_reasoning_delta("   ")  # whitespace only: sanitized text unchanged
        await _drain()
        self.assertEqual(len(adapter._client.sent), 1)

    async def test_post_terminal_delta_never_emits(self):
        adapter = _bare_adapter()
        await adapter._apply_reasoning_delta("about to finish")
        adapter._active_turn.clear()  # the turn sealed before the coalescing window fired
        await _drain()
        self.assertEqual(adapter._client.sent, [])

    async def test_concurrent_chats_drop_the_preview_whole(self):
        adapter = _bare_adapter()
        adapter._active_turn = {"chat-1": "turn-1", "chat-2": "turn-2"}
        await adapter._apply_reasoning_delta("ambiguous routing")
        await _drain()
        self.assertEqual(adapter._client.sent, [])
        self.assertEqual(adapter._thinking, {})

    async def test_buffer_stays_bounded(self):
        adapter = _bare_adapter()
        await adapter._apply_reasoning_delta("x" * 10_000)
        self.assertLessEqual(len(adapter._thinking["turn-1"].buffer), adapter_module._THINKING_BUFFER_MAX_CHARS)
        await _drain()
        self.assertLessEqual(len(adapter._client.sent[0]["text"]), 280)


if __name__ == "__main__":
    unittest.main()

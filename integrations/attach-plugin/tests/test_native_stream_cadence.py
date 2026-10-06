"""Hermes' native-streaming transport, declared by this adapter (F16).

Hermes has two streaming transports. The draft one debounces every flush behind
``streaming.edit_interval`` (0.8s) and ``streaming.buffer_threshold`` (24), which
is Telegram's one-edit-a-second envelope; the native one is ungated and pushes
every delta ("No platform edit-rate limit: push every delta immediately",
``gateway/stream_consumer.py`` at the native branch of ``_should_edit``).

Picking the native one is an adapter decision and nothing else:
``gateway/stream_consumer_transport.py::_resolve_native_streaming`` wants a
class-level ``SUPPORTS_NATIVE_STREAMING`` plus a truthy
``supports_native_streaming(...)`` probe, and then routes every frame through
``send_stream_frame``. This adapter declares all three. The probe is OFF unless
the profile asks for it, for the reason spelled out beside it in the adapter:
Hermes finalizes the native stream at an approval or clarify boundary through
the same ``send_stream_frame(finalize=True)`` it uses for the turn-final one,
and a finalize on this platform COMMITS AND SEALS the turn.
"""

import os
import sys
import types
import unittest

from cozygateway.adapter import AttachAdapter, _make_adapter_class

# Stock Hermes, verbatim, so this suite fails if the plugin drifts from what the
# harness actually gates on (gateway/config.py, the shared streaming defaults).
HERMES_DEFAULT_EDIT_INTERVAL = 0.8
HERMES_DEFAULT_BUFFER_THRESHOLD = 24

# The one profile-side switch this transport has. Named here so the suite and the
# adapter cannot drift apart silently.
NATIVE_ENV = "COZYGATEWAY_NATIVE_STREAMING"


def _set_native_env(value):
    if value is None:
        os.environ.pop(NATIVE_ENV, None)
    else:
        os.environ[NATIVE_ENV] = value


class _Platform:
    """Enough of Hermes' closed Platform enum for the concrete class to build."""

    WEBHOOK = "webhook"

    def __init__(self, name):
        raise ValueError(name)


class _BasePlatformAdapter:
    """Stand-in for the harness base the concrete adapter subclasses."""

    SUPPORTS_MESSAGE_EDITING = True

    def __init__(self, config=None, platform=None):
        self.config = config
        self.platform = platform


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _Client:
    """Records the attach-v1 frames the adapter puts on the wire."""

    def __init__(self):
        self.drafts = []
        self.commits = []
        self.failures = []

    async def send_draft(self, thread_id, turn_id, blocks, tool_calls=None):
        self.drafts.append((thread_id, turn_id, blocks, tool_calls))

    async def send_done(self, thread_id, turn_id):
        self.commits.append((thread_id, turn_id))

    async def send_failed(self, thread_id, turn_id, message):
        self.failures.append((thread_id, turn_id, message))


class _StreamConsumerShim:
    """The two decisions stock Hermes makes about an adapter, and nothing else.

    Both bodies are transcribed from the Hermes this plugin runs inside:
    ``_resolve_native_streaming`` (gateway/stream_consumer_transport.py) and the
    two branches of ``_should_edit`` (gateway/stream_consumer.py). The plugin's
    own test tree cannot import ``gateway``, so the seam is reproduced rather
    than stubbed: this asserts the adapter answers the harness' real questions.
    """

    def __init__(self, adapter, *, chat_type="direct", edit_interval=None, buffer_threshold=None):
        self.adapter = adapter
        self.chat_type = chat_type
        self.edit_interval = (
            HERMES_DEFAULT_EDIT_INTERVAL if edit_interval is None else edit_interval
        )
        self.buffer_threshold = (
            HERMES_DEFAULT_BUFFER_THRESHOLD if buffer_threshold is None else buffer_threshold
        )
        self.use_native = False
        self.accumulated = ""
        self.last_edit_time = 0.0

    def resolve_native_streaming(self) -> bool:
        # The harness reads the attribute off the CONCRETE class, which is where
        # the switch is applied; the shim is handed an adapter built the same way.
        if not getattr(type(self.adapter), "SUPPORTS_NATIVE_STREAMING", False):
            return False
        probe = getattr(self.adapter, "supports_native_streaming", None)
        if probe is None:
            return False
        try:
            return bool(probe(chat_type=self.chat_type, metadata=None))
        except Exception:  # noqa: BLE001 - the harness reads a raise as False
            return False

    def should_edit(self, now: float) -> bool:
        if self.use_native:
            return bool(self.accumulated)
        elapsed = now - self.last_edit_time
        return bool(
            (elapsed >= self.edit_interval and self.accumulated)
            or len(self.accumulated) >= self.buffer_threshold
        )

    def frames_for(self, deltas, *, tick_seconds: float = 0.05) -> list:
        """Which ticks flush, for ``deltas`` arriving one run-loop tick apart.

        ``run()`` drains its queue and sleeps 0.05s, so a tick is the ceiling on
        cadence for BOTH transports; what differs is which ticks flush. Returns
        the accumulated length at each flush, so the FIRST one can be asserted on
        as well as the count.
        """
        self.use_native = self.resolve_native_streaming()
        self.accumulated = ""
        self.last_edit_time = 0.0
        flushes = []
        now = 0.0
        for delta in deltas:
            now += tick_seconds
            self.accumulated += delta
            if self.should_edit(now):
                flushes.append(len(self.accumulated))
                self.last_edit_time = now
        return flushes


def _forty_line_reply():
    """TB2's shape: a 40 line body arriving as one delta per line."""
    return [f"line {index} of the answer\n" for index in range(1, 41)]


class NativeStreamCadenceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = {
            key: sys.modules.get(key)
            for key in ("gateway", "gateway.platforms", "gateway.platforms.base",
                        "gateway.config")
        }
        config = types.ModuleType("gateway.config")
        config.Platform = _Platform
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.SendResult = _SendResult
        base.BasePlatformAdapter = _BasePlatformAdapter
        gateway.platforms = platforms
        platforms.base = base
        sys.modules["gateway"] = gateway
        sys.modules["gateway.platforms"] = platforms
        sys.modules["gateway.platforms.base"] = base
        sys.modules["gateway.config"] = config
        gateway.config = config
        self._saved_env = os.environ.get(NATIVE_ENV)

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value
        _set_native_env(self._saved_env)

    def _adapter(self, client=None):
        """The concrete adapter Hermes registers, so the class attribute is real."""
        adapter = _make_adapter_class()(types.SimpleNamespace(extra={}))
        if client is not None:
            adapter._client = client
            adapter._active_turn["thread"] = "turn"
        return adapter

    # -- the extension point --------------------------------------------------
    def test_adapter_declares_native_streaming_support(self):
        """The class attribute and the probe method Hermes looks for both exist."""
        adapter = self._adapter()
        self.assertIn("SUPPORTS_NATIVE_STREAMING", vars(AttachAdapter))
        self.assertTrue(callable(getattr(adapter, "supports_native_streaming", None)))
        self.assertTrue(callable(getattr(adapter, "send_stream_frame", None)))

    def test_the_class_attribute_follows_the_flag_not_just_the_probe(self):
        """The attribute has a reader that never asks the probe, so it must not lie.

        ``gateway/slash_commands.py``'s ``_deliver_approval_confirmation`` sends an
        ``/approve`` or ``/deny`` confirmation through the adapter directly when
        ``SUPPORTS_NATIVE_STREAMING`` is True, instead of returning the text for
        Hermes' own delivery, and it never consults
        ``supports_native_streaming``. A True attribute with the switch off would
        move that path while the transport is still off.
        """
        _set_native_env(None)
        self.assertIs(_make_adapter_class().SUPPORTS_NATIVE_STREAMING, False)
        _set_native_env("0")
        self.assertIs(_make_adapter_class().SUPPORTS_NATIVE_STREAMING, False)
        _set_native_env("1")
        self.assertIs(_make_adapter_class().SUPPORTS_NATIVE_STREAMING, True)
        # Attribute and probe are read from the same switch, so they cannot drift.
        self.assertTrue(self._adapter().supports_native_streaming(chat_type="direct"))

    def test_the_probe_answers_per_profile_and_defaults_off(self):
        adapter = self._adapter()
        self.assertFalse(adapter.supports_native_streaming(chat_type="direct"))
        _set_native_env("1")
        self.assertTrue(adapter.supports_native_streaming(chat_type="direct"))
        self.assertTrue(adapter.supports_native_streaming(chat_type="group"))
        _set_native_env("0")
        self.assertFalse(adapter.supports_native_streaming(chat_type="direct"))

    def test_the_draft_probe_still_answers_for_every_chat_type(self):
        """Never nerf the lane that ships: drafts stay declared either way."""
        adapter = self._adapter()
        self.assertTrue(adapter.supports_draft_streaming(chat_type="direct"))
        _set_native_env("1")
        self.assertTrue(adapter.supports_draft_streaming(chat_type="direct"))

    # -- what the harness does with it ----------------------------------------
    def test_native_streaming_bypasses_the_edit_rate_debounce(self):
        """Every delta flushes on the native branch, including the first one.

        ``buffer_threshold`` is compared against the WHOLE accumulated reply
        rather than the text since the last flush, so on Hermes' defaults the
        draft path withholds everything until 24 codepoints exist (or 0.8s pass)
        and then flushes on nearly every tick. The debounce that is actually felt
        is therefore the HEAD of a reply, which is the part a person is waiting
        for. The native branch has no head cost at all.
        """
        deltas = ["He", "llo", " the", "re, ", "this", " is ", "a re", "ply."]

        shim = _StreamConsumerShim(self._adapter())
        self.assertFalse(shim.resolve_native_streaming())
        debounced = shim.frames_for(deltas)

        # A fresh adapter, because the switch is read once when the concrete
        # class is built, which is exactly how a Hermes profile picks this up.
        _set_native_env("1")
        shim = _StreamConsumerShim(self._adapter())
        self.assertTrue(shim.resolve_native_streaming())
        native = shim.frames_for(deltas)

        # 24 codepoints of silence before the first frame, against none.
        self.assertGreaterEqual(debounced[0], HERMES_DEFAULT_BUFFER_THRESHOLD)
        self.assertEqual(native[0], len(deltas[0]))
        self.assertEqual(len(native), len(deltas))
        self.assertLess(len(debounced), len(native))

    def test_the_seeded_cadence_removes_the_same_head_debounce(self):
        """The config half of this packet, on the transport that ships.

        ``streaming.edit_interval: 0.05`` and ``streaming.buffer_threshold: 1``
        are values ``StreamingConfig.from_dict`` already reads, so this needs no
        Hermes change and no native transport: it puts the draft path on the same
        per-tick cadence, first delta included.
        """
        deltas = ["He", "llo", " the", "re, ", "this", " is ", "a re", "ply."]
        adapter = self._adapter()
        seeded = _StreamConsumerShim(adapter, edit_interval=0.05, buffer_threshold=1)
        flushes = seeded.frames_for(deltas)

        self.assertEqual(flushes[0], len(deltas[0]))
        self.assertEqual(len(flushes), len(deltas))

    # -- the frames themselves ------------------------------------------------
    async def test_interim_frames_are_drafts_and_never_seal_the_turn(self):
        _set_native_env("1")
        client = _Client()
        adapter = self._adapter(client)

        for text in ("hel", "hello", "hello wo", "hello world"):
            self.assertTrue(
                await adapter.send_stream_frame(
                    text, chat_id="thread", reply_to="turn", turn_id="turn"
                )
            )

        self.assertEqual(len(client.drafts), 4)
        self.assertEqual(client.commits, [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

    async def test_the_finalize_frame_commits_the_turn_exactly_once(self):
        _set_native_env("1")
        client = _Client()
        adapter = self._adapter(client)

        await adapter.send_stream_frame("hello", chat_id="thread", reply_to="turn", turn_id="turn")
        self.assertTrue(
            await adapter.send_stream_frame(
                "hello world", finalize=True, chat_id="thread", reply_to="turn", turn_id="turn"
            )
        )

        self.assertEqual(client.commits, [("thread", "turn")])
        self.assertEqual(client.failures, [])
        self.assertEqual(adapter._active_turn, {})

    async def test_an_empty_native_turn_seals_the_way_it_always_did(self):
        """Hermes finalizes a contentless native stream with a bare placeholder.

        Committing that would append a checkmark bubble to the transcript that no
        other transport produces, so it is delivered as the empty reply it is and
        takes ``send``'s existing "no content ever materialized" seal.
        """
        _set_native_env("1")
        client = _Client()
        adapter = self._adapter(client)

        self.assertTrue(
            await adapter.send_stream_frame(
                "✅", finalize=True, chat_id="thread", reply_to="turn", turn_id="turn"
            )
        )

        self.assertEqual(client.commits, [])
        self.assertEqual(len(client.failures), 1)
        self.assertEqual(client.failures[0][2], "empty reply")

    async def test_a_frame_with_no_live_turn_is_skipped_not_a_transport_failure(self):
        """False disables native for the whole run; a missing anchor must not."""
        adapter = self._adapter()
        adapter._client = _Client()

        self.assertTrue(
            await adapter.send_stream_frame("hello", chat_id="thread", turn_id="turn")
        )

    async def test_a_cozyapp_thread_never_streams_frames(self):
        adapter = self._adapter()
        client = _Client()
        adapter._client = client

        self.assertTrue(
            await adapter.send_stream_frame("hello", chat_id="__cozyapp__:demo", turn_id="turn")
        )
        self.assertEqual(client.drafts, [])


if __name__ == "__main__":
    unittest.main()

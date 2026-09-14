"""The context sample belongs to Hermes' finished background turn, not dispatch."""

import asyncio
import sys
import types
import unittest

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import TurnFrame


class _MessageEvent:
    def __init__(self, text, source, message_id=None, media_urls=None, media_types=None, metadata=None):
        self.text = text
        self.source = source
        self.message_id = message_id
        self.media_urls = media_urls or []
        self.media_types = media_types or []
        self.metadata = metadata or {}


class _DelayedBase:
    """The relevant BasePlatformAdapter behavior: handle_message starts, then returns."""

    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.owner = None

    async def handle_message(self, event):
        self.owner = asyncio.create_task(self._process_later(event))
        self.started.set()

    async def _process_later(self, event):
        await self.release.wait()
        await self.on_processing_complete(event, types.SimpleNamespace(value="success"))

    async def on_processing_complete(self, _event, _outcome):
        return None


class _LifecycleAdapter(AttachAdapter, _DelayedBase):
    def __init__(self):
        _DelayedBase.__init__(self)
        self._attach_init(types.SimpleNamespace(extra={}))


class ChatContextLifecycleTests(unittest.IsolatedAsyncioTestCase):
    _MODULE_KEYS = ("gateway", "gateway.platforms", "gateway.platforms.base")

    def setUp(self):
        self.saved_modules = {key: sys.modules.get(key) for key in self._MODULE_KEYS}
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.MessageEvent = _MessageEvent
        base.cache_media_bytes = lambda *_args, **_kwargs: None
        gateway.platforms = platforms
        platforms.base = base
        sys.modules["gateway"] = gateway
        sys.modules["gateway.platforms"] = platforms
        sys.modules["gateway.platforms.base"] = base

    def tearDown(self):
        for key, value in self.saved_modules.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    async def test_context_waits_for_the_exact_background_turn_to_finish(self):
        adapter = _LifecycleAdapter()
        reported = []

        async def available(_source):
            return True

        async def model_available(_turn, _source):
            return True

        async def no_desktop_flush(_thread_id):
            return None

        async def report(chat_id, turn_id, session_key):
            reported.append((chat_id, turn_id, session_key))

        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
        adapter._event_session_key = lambda _event: "hermes-session"
        adapter._apply_execution_launch_model = available
        adapter._apply_bot_default_model = model_available
        adapter._flush_desktop_session_before_injection = no_desktop_flush
        adapter._report_turn_context = report

        await adapter._handle_turn(TurnFrame("native:sage:session", "turn-1", "hello"))
        await adapter.started.wait()
        self.assertEqual(reported, [])

        adapter.release.set()
        await adapter.owner
        self.assertEqual(reported, [("native:sage:session", "turn-1", "hermes-session")])


if __name__ == "__main__":
    unittest.main()

"""Pins the exact Hermes desktop-session adoption seam without a Hermes install.

The plugin only acknowledges a desktop resume after the resident runner verified the raw id in
the current profile's SessionDB and switched its stable attach lane. These fakes model that narrow
internal contract so an upstream refactor cannot quietly turn an exact continuation into a fresh
chat or a cross-profile switch.
"""

import sys
import types
import unittest

# The production dependency is deliberately optional in the harness-free unit suite. The adapter
# imports only this exception at module load; socket behavior is outside this switch-focused test.
if "websockets.exceptions" not in sys.modules:
    websockets = types.ModuleType("websockets")
    exceptions = types.ModuleType("websockets.exceptions")
    exceptions.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    websockets.exceptions = exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = exceptions

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import TurnFrame


class _SessionDb:
    def __init__(self, rows, resolved=None):
        self.rows = set(rows)
        self.resolved = resolved or {}
        self.lookups = []

    def get_session(self, session_id):
        self.lookups.append(session_id)
        return {"id": session_id} if session_id in self.rows else None

    def resolve_resume_session_id(self, session_id):
        return self.resolved.get(session_id, session_id)


class _Store:
    def __init__(self, session_db, switched=None):
        self.session_db = session_db
        self.switched = switched
        self.created = []
        self.switches = []

    async def get_or_create_session(self, source):
        self.created.append(source)

    async def switch_session(self, key, target):
        self.switches.append((key, target))
        return target if self.switched is None else self.switched


class _Runner:
    def __init__(self, store, running=False):
        self.async_session_store = store
        self.running = running
        self.evicted = []
        self.released = []

    def _session_key_for_source(self, source):
        return f"agent:{source.profile}:cozygateway:dm:{source.chat_id}"

    def _is_session_running(self, _key):
        return self.running

    def _evict_cached_agent(self, key):
        self.evicted.append(key)

    def _release_running_agent_state(self, key):
        self.released.append(key)


class _Client:
    def __init__(self):
        self.confirmations = []

    async def send_desktop_session_resumed(self, thread_id, hermes_session_id, resume_id):
        self.confirmations.append((thread_id, hermes_session_id, resume_id))


class _MessageEvent:
    def __init__(self, text, source, message_id=None, media_urls=None, media_types=None, metadata=None):
        self.text = text
        self.source = source
        self.message_id = message_id
        self.media_urls = media_urls or []
        self.media_types = media_types or []
        self.metadata = metadata or {}


class DesktopSessionResumeTests(unittest.IsolatedAsyncioTestCase):
    _MODULE_KEYS = ("gateway", "gateway.platforms", "gateway.platforms.base")

    def setUp(self):
        self._saved_modules = {key: sys.modules.get(key) for key in self._MODULE_KEYS}
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
        for key, value in self._saved_modules.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def _adapter(self, *, rows=("desktop-raw",), resolved=None, running=False, switched=None):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "sage"
        store = _Store(_SessionDb(rows, resolved), switched)
        runner = _Runner(store, running)
        client = _Client()
        adapter.gateway_runner = runner
        adapter._client = client
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
        adapter.injected = []

        async def handle_message(event):
            adapter.injected.append(event)

        adapter.handle_message = handle_message
        return adapter, runner, store, client

    async def test_switches_the_compressed_profile_local_target_then_confirms(self):
        adapter, runner, store, client = self._adapter(
            rows=("desktop-raw", "desktop-tip"), resolved={"desktop-raw": "desktop-tip"},
        )

        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-1",
        })

        key = "agent:sage:cozygateway:dm:native:sage:1"
        self.assertEqual(store.session_db.lookups, ["desktop-raw", "desktop-tip"])
        self.assertEqual(store.switches, [(key, "desktop-tip")])
        self.assertEqual(runner.evicted, [key])
        self.assertEqual(runner.released, [key])
        self.assertEqual(client.confirmations, [("native:sage:1", "desktop-raw", "resume-1")])
        self.assertEqual(adapter._desktop_session_bindings["native:sage:1"], (key, "desktop-tip"))

    async def test_refuses_unknown_or_path_shaped_ids_without_switch_or_confirmation(self):
        adapter, runner, store, client = self._adapter(rows=("desktop-raw",))

        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "other-profile-session", "resumeId": "resume-1",
        })
        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "../state.db", "resumeId": "resume-2",
        })

        self.assertEqual(store.switches, [])
        self.assertEqual(runner.evicted, [])
        self.assertEqual(client.confirmations, [])
        self.assertNotIn("native:sage:1", adapter._desktop_session_bindings)

    async def test_refuses_when_the_stable_lane_is_running_or_switch_verification_fails(self):
        running, runner, store, client = self._adapter(running=True)
        await running._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-running",
        })
        self.assertEqual(store.switches, [])
        self.assertEqual(client.confirmations, [])

        mismatched, runner, store, client = self._adapter(switched="unexpected")
        await mismatched._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-mismatch",
        })
        self.assertEqual(store.switches, [("agent:sage:cozygateway:dm:native:sage:1", "desktop-raw")])
        self.assertEqual(runner.evicted, [])
        self.assertEqual(client.confirmations, [])

    async def test_following_turn_carries_strict_binding_metadata(self):
        adapter, _runner, _store, _client = self._adapter()
        adapter._desktop_session_bindings["native:sage:1"] = (
            "agent:sage:cozygateway:dm:native:sage:1", "desktop-tip",
        )

        await adapter._handle_turn(TurnFrame(thread_id="native:sage:1", turn_id="turn-1", text="continue"))

        self.assertEqual(len(adapter.injected), 1)
        event = adapter.injected[0]
        self.assertEqual(event.source.chat_id, "native:sage:1")
        self.assertEqual(event.metadata, {
            "gateway_session_key": "agent:sage:cozygateway:dm:native:sage:1",
            "gateway_session_id": "desktop-tip",
            "gateway_session_strict": True,
        })


if __name__ == "__main__":
    unittest.main()

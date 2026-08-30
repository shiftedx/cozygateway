"""Pins the exact Hermes desktop-session adoption seam without a Hermes install.

The plugin only acknowledges a desktop resume after the resident runner verified the raw id in
the current profile's SessionDB and switched its stable attach lane. These fakes model that narrow
internal contract so an upstream refactor cannot quietly turn an exact continuation into a fresh
chat or a cross-profile switch.
"""

import os
import sys
import tempfile
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
from cozygateway.attach_spool import AttachSpool


class _SessionDb:
    def __init__(self, rows, resolved=None, source="tui", messages=None, chat_id=None, hidden=False):
        self.rows = set(rows)
        self.resolved = resolved or {}
        self.source = source
        self.messages = messages or []
        self.chat_id = chat_id
        self.hidden = hidden
        self.lookups = []

    def get_session(self, session_id):
        self.lookups.append(session_id)
        return ({"id": session_id, "source": self.source, "chat_id": self.chat_id,
                 "hidden": self.hidden} if session_id in self.rows else None)

    def resolve_resume_session_id(self, session_id):
        return self.resolved.get(session_id, session_id)

    def get_messages(self, _session_id, *, limit, latest=False, after_id=None):
        rows = list(self.messages)
        if latest:
            return rows[-limit:]
        if after_id is not None:
            rows = [row for row in rows if row["id"] > after_id]
        return rows[:limit]


class _Store:
    def __init__(self, session_db, switched=None):
        self.session_db = session_db
        self.switched = switched
        self.created = []
        self.switches = []
        self.lookup_session_id = next(iter(session_db.rows))

    async def get_or_create_session(self, source):
        self.created.append(source)

    async def switch_session(self, key, target):
        self.switches.append((key, target))
        return target if self.switched is None else self.switched

    async def lookup_by_session_key(self, _key):
        return _SessionEntry(self.lookup_session_id)


class _SessionEntry:
    """The real Hermes ``SessionStore.switch_session`` return shape."""

    def __init__(self, session_id):
        self.session_id = session_id


class _AsyncSessionDb:
    """The real runner exposes this async wrapper, not the raw SessionDB."""

    def __init__(self, db):
        self._db = db

    async def get_session(self, session_id):  # pragma: no cover - must not be used by plugin
        return self._db.get_session(session_id)

    async def resolve_resume_session_id(self, session_id):  # pragma: no cover - must not be used
        return self._db.resolve_resume_session_id(session_id)


class _AsyncStore:
    """Models Hermes' AsyncSessionStore forwarding a synchronous SessionStore."""

    def __init__(self, db, switched=None):
        self._store = types.SimpleNamespace(_db=db)
        self.switched = switched
        self.created = []
        self.switches = []
        self.lookup_session_id = next(iter(db.rows))

    async def get_or_create_session(self, source):
        self.created.append(source)

    async def switch_session(self, key, target):
        self.switches.append((key, target))
        return _SessionEntry(target if self.switched is None else self.switched)

    async def lookup_by_session_key(self, _key):
        return _SessionEntry(self.lookup_session_id)


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
    def __init__(self, desktop_session_sync_available=False):
        self.confirmations = []
        self.desktop_session_sync_available = desktop_session_sync_available
        self.mirrored = []
        self.spool = None

    async def send_desktop_session_resumed(self, thread_id, hermes_session_id, resume_id):
        self.confirmations.append((thread_id, hermes_session_id, resume_id))

    async def send_desktop_session_message(self, **event):
        self.mirrored.append(event)
        if self.spool is not None:
            self.spool.journal_desktop_session_message(
                thread_id=event["thread_id"],
                current_hermes_session_id=event["current_hermes_session_id"],
                source=event["source"],
                desktop_session_id=event["desktop_session_id"],
                expected_current_hermes_session_id=event["expected_current_hermes_session_id"],
                message_row_id=event["message_row_id"], role=event["role"], text=event["text"], at=event["at"],
            )
        return True


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

    def _adapter(self, *, rows=("desktop-raw",), resolved=None, running=False, switched=None,
                 production_shapes=False, source="tui", messages=None, chat_id=None, hidden=False):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "sage"
        db = _SessionDb(rows, resolved, source, messages, chat_id, hidden)
        store = _AsyncStore(db, switched) if production_shapes else _Store(db, switched)
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

    def _spool(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        return AttachSpool(os.path.join(temp.name, "spool.sqlite"))

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

    async def test_switches_with_the_real_async_wrapper_and_session_entry_contract(self):
        adapter, runner, store, client = self._adapter(
            rows=("desktop-raw", "desktop-tip"),
            resolved={"desktop-raw": "desktop-tip"},
            production_shapes=True,
        )
        # Production GatewayRunner exposes AsyncSessionDB. The plugin must unwrap its `_db`
        # for synchronous exact lookups and treat a SessionEntry as a successful switch.
        runner._session_db = _AsyncSessionDb(store._store._db)

        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-1",
        })

        key = "agent:sage:cozygateway:dm:native:sage:1"
        self.assertEqual(store.switches, [(key, "desktop-tip")])
        self.assertEqual(runner.evicted, [key])
        self.assertEqual(client.confirmations, [("native:sage:1", "desktop-raw", "resume-1")])
        self.assertEqual(adapter._desktop_session_bindings["native:sage:1"], (key, "desktop-tip"))

    async def test_refuses_a_mismatched_real_session_entry(self):
        adapter, runner, store, client = self._adapter(switched="wrong-target", production_shapes=True)
        runner._session_db = _AsyncSessionDb(store._store._db)

        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-1",
        })

        self.assertEqual(runner.evicted, [])
        self.assertEqual(client.confirmations, [])
        self.assertNotIn("native:sage:1", adapter._desktop_session_bindings)

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

    async def test_refuses_non_tui_rows_even_if_the_id_exists_in_this_profile(self):
        adapter, runner, store, client = self._adapter(source="cozygateway")

        await adapter._handle_desktop_resume_command({
            "threadId": "native:sage:1", "hermesSessionId": "desktop-raw", "resumeId": "resume-1",
        })

        self.assertEqual(store.switches, [])
        self.assertEqual(runner.evicted, [])
        self.assertEqual(client.confirmations, [])

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

    async def test_mirror_follows_compression_tip_and_skips_non_transcript_rows(self):
        messages = [
            {"id": 11, "role": "tool", "content": "ignored", "timestamp": 1},
            {"id": 12, "role": "assistant", "content": "desktop reply", "timestamp": 1_700_000_000},
        ]
        adapter, runner, store, client = self._adapter(
            rows=("desktop-root", "desktop-tip"), resolved={"desktop-root": "desktop-tip"},
            source="tui", messages=messages,
        )
        client.desktop_session_sync_available = True
        spool = self._spool()
        self.addCleanup(spool.close)
        adapter._spool = spool
        client.spool = spool
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1", current_hermes_session_id="desktop-root", source="tui",
            desktop_session_id="desktop-root", last_message_row_id=10,
        )

        await adapter._mirror_desktop_session_link(
            client, spool, store.session_db, spool.desktop_session_links()[0],
        )

        self.assertEqual([event["message_row_id"] for event in client.mirrored], [12])
        self.assertEqual(client.mirrored[0]["current_hermes_session_id"], "desktop-tip")
        self.assertEqual(client.mirrored[0]["at"], 1_700_000_000_000)
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 12)

    async def test_mobile_baseline_suppresses_phone_authored_rows_before_next_poll(self):
        messages = [{"id": 21, "role": "user", "content": "from phone", "timestamp": 1}]
        adapter, runner, store, client = self._adapter(
            rows=("native-tip",), source="cozygateway", messages=messages,
            chat_id="native:sage:1",
        )
        client.desktop_session_sync_available = True
        spool = self._spool()
        self.addCleanup(spool.close)
        adapter._spool = spool
        source = adapter._inbound_source("native:sage:1", message_id="turn-1")

        await adapter._baseline_mobile_mirror_link("native:sage:1", source)
        await adapter._mirror_desktop_session_link(
            client, spool, store.session_db, spool.desktop_session_links()[0],
        )

        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 21)
        self.assertEqual(client.mirrored, [])

    async def test_resumed_tui_baseline_tracks_a_compression_rotated_active_tip(self):
        adapter, runner, store, client = self._adapter(
            rows=("desktop-root", "desktop-tip"), resolved={"desktop-root": "desktop-tip"},
            source="tui", messages=[{"id": 31, "role": "user", "content": "phone turn", "timestamp": 1}],
        )
        spool = self._spool()
        self.addCleanup(spool.close)
        adapter._spool = spool
        key = "agent:sage:cozygateway:dm:native:sage:1"
        adapter._desktop_session_bindings["native:sage:1"] = (key, "desktop-root")
        store.lookup_session_id = "desktop-tip"
        spool.reset_desktop_session_link(
            thread_id="native:sage:1", current_hermes_session_id="desktop-root", source="tui",
            desktop_session_id="desktop-root", last_message_row_id=30,
        )

        await adapter._baseline_mobile_mirror_link(
            "native:sage:1", adapter._inbound_source("native:sage:1", message_id="turn-1"),
        )

        self.assertEqual(spool.desktop_session_links()[0]["currentHermesSessionId"], "desktop-tip")
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 31)


if __name__ == "__main__":
    unittest.main()

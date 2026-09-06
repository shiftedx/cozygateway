"""One session key for a strict desktop binding, derived the same way by every check.

Hermes validates an internally routed turn twice with two different derivations:

* the adapter seam (``gateway/platforms/base.py`` ``_event_session_key``) namespaces the key by
  ``source.profile``, then by this adapter's owner profile on a multiplexed gateway, then by the
  session store's resolver, and drops the event when the result does not equal
  ``metadata["gateway_session_key"]``;
* the runner seam (``gateway/run_turn.py``) derives the key with ``_session_key_for_source`` and
  additionally requires the pinned session id to still be the current one for that key.

The binding has to be recorded with the key those seams will actually derive, in either topology,
and a turn the plugin cannot get past them has to be refused out loud. These fakes model the
derivations and the terminal frames, not a Hermes install.
"""

import asyncio
import sys
import types
import unittest

if "websockets.exceptions" not in sys.modules:
    websockets = types.ModuleType("websockets")
    exceptions = types.ModuleType("websockets.exceptions")
    exceptions.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    websockets.exceptions = exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = exceptions

import cozygateway.adapter as adapter_module
from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import InterruptFrame, SteerFrame, TurnFrame

THREAD = "native:sage:1"
RUNNER_KEY = f"agent:main:cozygateway:dm:{THREAD}"
MULTIPLEX_KEY = f"agent:polished-satellite:cozygateway:dm:{THREAD}"
PINNED = "desktop-tip"


class _MessageEvent:
    def __init__(self, text, source, message_id=None, media_urls=None, media_types=None, metadata=None):
        self.text = text
        self.source = source
        self.message_id = message_id
        self.media_urls = media_urls or []
        self.media_types = media_types or []
        self.metadata = metadata or {}


class _Client:
    """Only the terminal frames this file is about."""

    def __init__(self):
        self.failed = []
        self.interrupted = []

    async def send_failed(self, thread_id, turn_id, message=None, *, reason=None):
        self.failed.append((thread_id, turn_id, reason))

    async def send_interrupted(self, thread_id, turn_id):
        self.interrupted.append((thread_id, turn_id))


class _SessionEntry:
    def __init__(self, session_id):
        self.session_id = session_id


class _Store:
    """The runner seam's second check: is the pinned session still the current one?"""

    def __init__(self, session_id=PINNED):
        self.session_id = session_id
        self.lookups = []

    async def lookup_by_session_key(self, session_key):
        self.lookups.append(session_key)
        return _SessionEntry(self.session_id) if self.session_id is not None else None


class _Runner:
    """The runner seam. Profile-agnostic, exactly like a single-profile install."""

    def __init__(self, store=None):
        self.async_session_store = store

    @staticmethod
    def _session_key_for_source(source):
        return f"agent:main:cozygateway:dm:{source.chat_id}"


class _BindingHarness(unittest.IsolatedAsyncioTestCase):
    """Shared fakes: both derivations, a session store, and a client recording terminals."""

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

    def _adapter(self, *, owner_profile="", store=_Store, seam=True):
        """An adapter wired to both seams.

        ``owner_profile`` models a multiplexed gateway, where the adapter seam falls back to the
        profile this adapter owns and the runner sees the same profile stamped on the source
        before it derives. ``seam=False`` models a harness that exposes no adapter seam at all.
        """
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "polished-satellite"
        adapter.gateway_runner = _Runner(store() if callable(store) else store)
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
        adapter._client = _Client()
        adapter._interrupt_seal_grace = 0.0
        adapter._interrupt_sleep = lambda _seconds: asyncio.sleep(0)
        adapter.delivered = []
        adapter.dropped = []
        if seam:
            adapter._event_session_key = lambda event: (
                f"agent:{owner_profile or 'main'}:cozygateway:dm:{event.source.chat_id}")

        async def handle_message(event):
            derived = adapter._event_session_key(event) if seam else RUNNER_KEY
            expected = str((event.metadata or {}).get("gateway_session_key") or "").strip()
            if expected and derived != expected:
                adapter.dropped.append((expected, derived))
                return
            adapter.delivered.append(event)

        adapter.handle_message = handle_message
        return adapter


class SessionKeyBindingTests(_BindingHarness):
    async def test_a_turn_on_a_strictly_bound_thread_is_not_dropped(self):
        """The reported break: the binding is recorded with the key the seams derive, and a
        disagreement there dropped every turn on the thread."""
        adapter = self._adapter()
        adapter._desktop_session_bindings[THREAD] = (RUNNER_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.dropped, [])
        self.assertEqual(len(adapter.delivered), 1)
        self.assertEqual(adapter.delivered[0].metadata, {
            "gateway_session_key": RUNNER_KEY,
            "gateway_session_id": PINNED,
            "gateway_session_strict": True,
        })

    async def test_the_binding_key_is_the_one_both_seams_derive(self):
        adapter = self._adapter()
        source = adapter._inbound_source(THREAD)

        self.assertEqual(adapter._dispatch_session_key(source), RUNNER_KEY)
        self.assertEqual(adapter.gateway_runner._session_key_for_source(source), RUNNER_KEY)
        self.assertFalse(getattr(source, "profile", None))

    async def test_a_multiplexed_gateway_binds_the_key_its_seams_derive(self):
        """The unstamped source is right for both seams only if the binding follows them: on a
        multiplexed gateway both derive the owner profile's key, so the binding must too."""
        adapter = self._adapter(owner_profile="polished-satellite")

        self.assertEqual(adapter._dispatch_session_key(adapter._inbound_source(THREAD)), MULTIPLEX_KEY)

    async def test_a_multiplexed_binding_dispatches_rather_than_dropping(self):
        adapter = self._adapter(owner_profile="polished-satellite")
        adapter._desktop_session_bindings[THREAD] = (MULTIPLEX_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.dropped, [])
        self.assertEqual(adapter._client.failed, [])
        self.assertEqual([event.metadata["gateway_session_key"] for event in adapter.delivered],
                         [MULTIPLEX_KEY])

    async def test_without_an_adapter_seam_the_runner_key_is_used(self):
        adapter = self._adapter(seam=False)

        self.assertEqual(adapter._dispatch_session_key(adapter._inbound_source(THREAD)), RUNNER_KEY)

    async def test_an_explicit_multiplex_route_is_left_alone(self):
        """A real profile route resolved by build_source stays on the source untouched."""
        adapter = self._adapter()
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(profile="routed", **kwargs)

        self.assertEqual(adapter._inbound_source(THREAD).profile, "routed")

    async def test_a_turn_without_a_binding_carries_no_session_metadata(self):
        adapter = self._adapter()

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.dropped, [])
        self.assertEqual(len(adapter.delivered), 1)
        self.assertEqual(adapter.delivered[0].metadata, {})


class RefusedFrameTerminalTests(_BindingHarness):
    """No frame the plugin declines to dispatch may end in silence.

    A silently dropped turn left the gateway holding a running turn for its full cap, and the
    person's next message then arrived as a steer on a turn no restarted plugin held. Answering
    it as a fresh inbound produced draft and commit events on ``<turn>:steer`` that the gateway
    declined as orphaned, so the reply never reached the phone.
    """

    async def test_a_binding_the_adapter_seam_will_reject_is_failed_before_dispatch(self):
        adapter = self._adapter()
        adapter._desktop_session_bindings[THREAD] = (MULTIPLEX_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter.dropped, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])
        self.assertEqual(adapter._active_turn, {})

    async def test_a_pinned_session_that_moved_on_is_failed_before_dispatch(self):
        """A /new, a compaction retip or an eviction moves the pinned session; the runner seam
        then returns silently, which is the same 21 minute loss."""
        adapter = self._adapter(store=_Store("some-other-session"))
        adapter._desktop_session_bindings[THREAD] = (RUNNER_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])
        self.assertEqual(adapter.gateway_runner.async_session_store.lookups, [RUNNER_KEY])

    async def test_a_binding_whose_key_no_longer_resolves_at_all_is_failed(self):
        adapter = self._adapter(store=_Store(None))
        adapter._desktop_session_bindings[THREAD] = (RUNNER_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_an_unreachable_store_does_not_refuse_the_turn(self):
        # Absence is not proof of staleness: without a store to ask, the turn goes on exactly as
        # it did before this check existed.
        adapter = self._adapter(store=None)
        adapter._desktop_session_bindings[THREAD] = (RUNNER_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter._client.failed, [])
        self.assertEqual(len(adapter.delivered), 1)

    async def test_a_steer_for_a_turn_this_plugin_does_not_hold_is_failed(self):
        adapter = self._adapter()

        await adapter._handle_steer(SteerFrame(thread_id=THREAD, turn_id="turn-1", text="and now"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_a_steer_for_the_running_turn_is_still_injected(self):
        adapter = self._adapter()
        adapter._active_turn[THREAD] = "turn-1"

        await adapter._handle_steer(SteerFrame(thread_id=THREAD, turn_id="turn-1", text="and now"))

        self.assertEqual(adapter._client.failed, [])
        self.assertEqual([event.message_id for event in adapter.delivered], ["turn-1:steer"])

    async def test_an_interrupt_for_a_turn_this_plugin_does_not_hold_is_failed(self):
        adapter = self._adapter()

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.interrupted, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_an_interrupt_for_a_turn_that_arrived_but_was_never_sealed_is_failed(self):
        """Arrival is not a terminal. A turn that reached this process and then died without one
        is exactly the silence this exists to remove."""
        adapter = self._adapter()
        adapter._seen_turns[(THREAD, "turn-1")] = None

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_a_steer_for_a_turn_sealed_here_is_still_failed_so_the_text_survives(self):
        adapter = self._adapter()
        adapter._mark_sealed(THREAD, "turn-1")

        await adapter._handle_steer(SteerFrame(thread_id=THREAD, turn_id="turn-1", text="and now"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_an_interrupt_that_lost_the_race_with_its_own_seal_stays_quiet(self):
        adapter = self._adapter()
        adapter._mark_sealed(THREAD, "turn-1")

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [])
        self.assertEqual(adapter._client.interrupted, [])

    async def test_a_refused_turn_is_recorded_as_sealed(self):
        adapter = self._adapter()
        adapter._desktop_session_bindings[THREAD] = (MULTIPLEX_KEY, PINNED)

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))
        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        # One terminal for that turn, from the refusal; the interrupt that follows it is quiet.
        self.assertEqual(adapter._client.failed, [(THREAD, "turn-1", "unknown_turn")])

    async def test_an_interrupt_for_the_running_turn_still_stops_and_seals(self):
        adapter = self._adapter()
        adapter._active_turn[THREAD] = "turn-1"

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual([event.text for event in adapter.delivered], ["/stop"])
        self.assertEqual(adapter._client.failed, [])
        self.assertEqual(adapter._client.interrupted, [(THREAD, "turn-1")])

    async def test_the_sealed_record_is_bounded(self):
        adapter = self._adapter()
        adapter._seen_turns_max = 4
        for index in range(10):
            adapter._mark_sealed(THREAD, f"turn-{index}")

        self.assertLessEqual(len(adapter._sealed_turns), 4)
        self.assertIn((THREAD, "turn-9"), adapter._sealed_turns)


class SessionProfileRouteTests(unittest.IsolatedAsyncioTestCase):
    """The live-turn profile gate reads the same route the source now carries."""

    def _adapter(self, config=None):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "polished-satellite"
        adapter.gateway_runner = types.SimpleNamespace(config=config) if config is not None else None
        return adapter

    def test_a_single_profile_gateway_expects_no_route(self):
        adapter = self._adapter(types.SimpleNamespace(multiplex_profiles=False))
        self.assertEqual(adapter._session_profile_route(), "")

    def test_a_multiplexed_gateway_expects_its_own_profile(self):
        adapter = self._adapter(types.SimpleNamespace(multiplex_profiles=True))
        self.assertEqual(adapter._session_profile_route(), "polished-satellite")

    def test_an_unknown_topology_keeps_the_strict_identity(self):
        # No runner to judge the gateway shape by: demand the adapter's own profile rather
        # than relaxing the gate on a process this plugin cannot describe.
        self.assertEqual(self._adapter()._session_profile_route(), "polished-satellite")

    def test_the_live_turn_gate_admits_a_single_profile_process(self):
        adapter = self._adapter(types.SimpleNamespace(multiplex_profiles=False))
        adapter._active_turn = {THREAD: "turn-1"}
        adapter_module._register_active_adapter(adapter)
        self.addCleanup(adapter_module._unregister_active_adapter, adapter)
        saved = (adapter_module._current_turn_platform_and_chat,
                 adapter_module._current_turn_message_and_cron)
        adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, THREAD)
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, None)
        try:
            origin = adapter_module._resolve_live_origin()
        finally:
            (adapter_module._current_turn_platform_and_chat,
             adapter_module._current_turn_message_and_cron) = saved
        self.assertIsNotNone(origin)
        # The lease that later re-checks the origin holds the adapter's identity, not the
        # empty session value, so a replaced adapter still invalidates it.
        self.assertEqual(origin[1:], (THREAD, "turn-1", "polished-satellite"))

    def test_the_live_turn_gate_still_refuses_a_foreign_route(self):
        adapter = self._adapter(types.SimpleNamespace(multiplex_profiles=False))
        adapter._active_turn = {THREAD: "turn-1"}
        adapter_module._register_active_adapter(adapter)
        self.addCleanup(adapter_module._unregister_active_adapter, adapter)
        saved = (adapter_module._current_turn_platform_and_chat,
                 adapter_module._current_turn_message_and_cron)
        adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, THREAD)
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "other-profile")
        try:
            self.assertIsNone(adapter_module._resolve_live_origin())
        finally:
            (adapter_module._current_turn_platform_and_chat,
             adapter_module._current_turn_message_and_cron) = saved


if __name__ == "__main__":
    unittest.main()

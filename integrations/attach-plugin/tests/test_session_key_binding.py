"""One session key for a strict desktop binding, derived the same way by both checks.

Hermes validates an internally routed turn twice with two different derivations:

* the adapter seam (``gateway/platforms/base.py`` ``_event_session_key``) namespaces the key by
  ``source.profile`` when the source carries one, and drops the event when it does not equal
  ``metadata["gateway_session_key"]``;
* the runner seam (``gateway/run_turn.py``) derives the key with ``_session_key_for_source``,
  which is profile-agnostic in a single-profile install, and drops on the same mismatch.

Only an unstamped source lets one recorded binding satisfy both, so the plugin must not stamp
its own loader-owned profile on the synthetic inbound source of a single-profile process. These
fakes pin that: they model the two derivations, not a Hermes install.
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

    async def send_failed(self, thread_id, turn_id, message):
        self.failed.append((thread_id, turn_id, message))

    async def send_interrupted(self, thread_id, turn_id):
        self.interrupted.append((thread_id, turn_id))


class _Runner:
    """The runner seam: profile-agnostic, exactly like a single-profile install."""

    def __init__(self):
        self.async_session_store = None

    @staticmethod
    def _session_key_for_source(source):
        return f"agent:main:cozygateway:dm:{source.chat_id}"


class _BindingHarness(unittest.IsolatedAsyncioTestCase):
    """Shared fakes: the two derivations, plus a client that records terminal frames."""

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

    def _adapter(self):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "polished-satellite"
        adapter.gateway_runner = _Runner()
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
        adapter._client = _Client()
        adapter._interrupt_seal_grace = 0.0
        adapter._interrupt_sleep = lambda _seconds: asyncio.sleep(0)
        adapter.delivered = []
        adapter.dropped = []

        async def handle_message(event):
            # The adapter seam: build_session_key(profile=_session_key_profile(source)).
            profile = getattr(event.source, "profile", None)
            namespace = profile if isinstance(profile, str) and profile.strip() else "main"
            derived = f"agent:{namespace}:cozygateway:dm:{event.source.chat_id}"
            expected = str((event.metadata or {}).get("gateway_session_key") or "").strip()
            if expected and derived != expected:
                adapter.dropped.append((expected, derived))
                return
            adapter.delivered.append(event)

        adapter.handle_message = handle_message
        return adapter


class SessionKeyBindingTests(_BindingHarness):
    async def test_a_turn_on_a_strictly_bound_thread_is_not_dropped(self):
        """The reported break: the binding is recorded with the runner key, and the adapter
        derivation must agree with it or every turn on that thread is dropped."""
        adapter = self._adapter()
        adapter._desktop_session_bindings[THREAD] = (RUNNER_KEY, "desktop-tip")

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.dropped, [])
        self.assertEqual(len(adapter.delivered), 1)
        self.assertEqual(adapter.delivered[0].metadata, {
            "gateway_session_key": RUNNER_KEY,
            "gateway_session_id": "desktop-tip",
            "gateway_session_strict": True,
        })

    async def test_the_binding_is_recorded_with_the_key_both_checks_derive(self):
        adapter = self._adapter()
        source = adapter._inbound_source(THREAD)

        self.assertEqual(adapter.gateway_runner._session_key_for_source(source), RUNNER_KEY)
        self.assertFalse(getattr(source, "profile", None))

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

    async def test_a_turn_whose_binding_no_longer_derives_is_failed_not_dropped(self):
        adapter = self._adapter()
        adapter._desktop_session_bindings[THREAD] = (
            "agent:polished-satellite:cozygateway:dm:" + THREAD, "desktop-tip")

        await adapter._handle_turn(TurnFrame(thread_id=THREAD, turn_id="turn-1", text="hi"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter.dropped, [])
        self.assertEqual(adapter._client.failed, [
            (THREAD, "turn-1", adapter_module.STALE_SESSION_BINDING_FAILURE)])
        self.assertEqual(adapter._active_turn, {})

    async def test_a_steer_for_a_turn_this_plugin_does_not_hold_is_failed(self):
        adapter = self._adapter()

        await adapter._handle_steer(SteerFrame(thread_id=THREAD, turn_id="turn-1", text="and now"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [
            (THREAD, "turn-1", adapter_module.UNKNOWN_TURN_FAILURE)])

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
        self.assertEqual(adapter._client.failed, [
            (THREAD, "turn-1", adapter_module.UNKNOWN_TURN_FAILURE)])

    async def test_a_steer_for_a_turn_sealed_here_is_still_failed_so_the_text_survives(self):
        adapter = self._adapter()
        adapter._seen_turns[(THREAD, "turn-1")] = None  # this process ran it, then sealed it

        await adapter._handle_steer(SteerFrame(thread_id=THREAD, turn_id="turn-1", text="and now"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [
            (THREAD, "turn-1", adapter_module.UNKNOWN_TURN_FAILURE)])

    async def test_an_interrupt_that_lost_the_race_with_its_own_seal_stays_quiet(self):
        adapter = self._adapter()
        adapter._seen_turns[(THREAD, "turn-1")] = None

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual(adapter.delivered, [])
        self.assertEqual(adapter._client.failed, [])
        self.assertEqual(adapter._client.interrupted, [])

    async def test_an_interrupt_for_the_running_turn_still_stops_and_seals(self):
        adapter = self._adapter()
        adapter._active_turn[THREAD] = "turn-1"

        await adapter._handle_interrupt(InterruptFrame(thread_id=THREAD, turn_id="turn-1"))

        self.assertEqual([event.text for event in adapter.delivered], ["/stop"])
        self.assertEqual(adapter._client.failed, [])
        self.assertEqual(adapter._client.interrupted, [(THREAD, "turn-1")])


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

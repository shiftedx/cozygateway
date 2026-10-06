"""CozyApp actions retain their own private Hermes turn until they finish.

The gateway may dispatch two actions for one app back-to-back.  They share the
private ``__cozyapp__:<appId>`` chat lane, so overlapping injections would let
the second request replace the first request's reply anchor.
"""

from __future__ import annotations

import asyncio
import sys
import types
import unittest

# Keep this adapter seam stdlib-only when the optional transport package is absent.
try:
    import websockets.exceptions  # type: ignore[import-not-found]  # noqa: F401
except ModuleNotFoundError:
    websocket_exceptions = types.ModuleType("websockets.exceptions")
    websocket_exceptions.ConnectionClosed = RuntimeError
    websockets = types.ModuleType("websockets")
    websockets.exceptions = websocket_exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = websocket_exceptions

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client


class _MessageEvent:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


class _ActionClient(AttachV1Client):
    """A real-client subtype without a socket, for the adapter's type guard."""

    def __init__(self) -> None:  # noqa: D107 - deliberately skips transport setup
        self.finished = []

    async def finish_cozyapp_action(self, command, status):
        self.finished.append((command["actionRequestId"], status))


class CozyAppActionSerializationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved_modules = {
            key: sys.modules.get(key)
            for key in ("gateway", "gateway.platforms", "gateway.platforms.base")
        }
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.MessageEvent = _MessageEvent
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

    @staticmethod
    def _command(app_id, request_id):
        return {
            "appId": app_id,
            "actionId": "refresh",
            "actionRequestId": request_id,
        }

    def _adapter(self):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._client = _ActionClient()
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
        return adapter

    async def test_same_app_actions_are_serialized_without_crossing_turn_bindings(self):
        adapter = self._adapter()
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        second_started = asyncio.Event()
        observed = []

        async def handle(event):
            chat_id = event.source.chat_id
            observed.append((event.message_id, adapter._active_turn.get(chat_id)))
            if event.message_id == "request-1":
                first_started.set()
                await release_first.wait()
                observed.append(("request-1-after-wait", adapter._active_turn.get(chat_id)))
            else:
                second_started.set()

        adapter.handle_message = handle
        first = asyncio.create_task(
            adapter._handle_cozyapp_action_command(self._command("thermostat", "request-1"))
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)

        second = asyncio.create_task(
            adapter._handle_cozyapp_action_command(self._command("thermostat", "request-2"))
        )
        await asyncio.sleep(0)
        was_serialized = not second_started.is_set()
        first_binding_survived = adapter._active_turn.get("__cozyapp__:thermostat") == "request-1"

        release_first.set()
        await asyncio.wait_for(asyncio.gather(first, second), timeout=1)

        self.assertTrue(was_serialized, "the second same-app action must wait for the first")
        self.assertTrue(first_binding_survived, "the first action must retain its reply anchor")
        self.assertEqual(
            observed,
            [
                ("request-1", "request-1"),
                ("request-1-after-wait", "request-1"),
                ("request-2", "request-2"),
            ],
        )
        self.assertEqual(adapter._client.finished, [("request-1", "completed"), ("request-2", "completed")])
        self.assertNotIn("__cozyapp__:thermostat", adapter._active_turn)
        self.assertEqual(adapter._cozyapp_action_gates, {})

    async def test_actions_for_different_apps_do_not_share_a_global_gate(self):
        adapter = self._adapter()
        first_started = asyncio.Event()
        release_first = asyncio.Event()
        other_app_started = asyncio.Event()

        async def handle(event):
            if event.message_id == "request-1":
                first_started.set()
                await release_first.wait()
            else:
                other_app_started.set()

        adapter.handle_message = handle
        first = asyncio.create_task(
            adapter._handle_cozyapp_action_command(self._command("thermostat", "request-1"))
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        other = asyncio.create_task(
            adapter._handle_cozyapp_action_command(self._command("lighting", "request-2"))
        )
        await asyncio.wait_for(other_app_started.wait(), timeout=1)

        release_first.set()
        await asyncio.wait_for(asyncio.gather(first, other), timeout=1)
        self.assertEqual(adapter._client.finished, [("request-2", "completed"), ("request-1", "completed")])
        self.assertEqual(adapter._cozyapp_action_gates, {})


if __name__ == "__main__":
    unittest.main()

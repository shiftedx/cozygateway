import asyncio
import json
import sqlite3
import sys
import threading
import types
import unittest

# Keep this registration-seam suite stdlib-only when the optional transport package is absent.
try:
    import websockets.exceptions  # type: ignore[import-not-found]  # noqa: F401
except ModuleNotFoundError:
    websocket_exceptions = types.ModuleType("websockets.exceptions")
    websocket_exceptions.ConnectionClosed = RuntimeError
    websockets = types.ModuleType("websockets")
    websockets.exceptions = websocket_exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = websocket_exceptions

import cozygateway.adapter as adapter_module
from cozygateway.adapter import register
from cozygateway.attach_client_v1 import HELLO_CAPABILITIES


class _Context:
    def __init__(self): self.tools = []
    def register_platform(self, **_kwargs): pass
    def register_tool(self, **kwargs): self.tools.append(kwargs)


class _OwnerLoopClient:
    """A client whose spool raises exactly as SQLite does off its owner loop."""

    def __init__(self, owner_loop):
        self.owner_loop = owner_loop
        self.calls = []

    async def upsert_cozyapp(self, app_id, name, tree):
        if asyncio.get_running_loop() is not self.owner_loop:
            raise sqlite3.ProgrammingError(
                "SQLite objects created in a thread can only be used in that same thread"
            )
        self.calls.append((app_id, name, tree))
        return True


class CozyAppsToolTests(unittest.TestCase):
    def test_registers_the_native_app_upsert_tool_and_capability(self):
        context = _Context()
        register(context)
        tool = next(item for item in context.tools if item["name"] == "cozyapp_upsert")
        self.assertEqual(tool["toolset"], "cozygateway")
        self.assertIn("cozyapps", HELLO_CAPABILITIES)
        description = tool["schema"]["description"]
        for node in ("stack", "section", "text", "image", "list", "keyValue", "button"):
            self.assertIn(node, description)
        self.assertIn("https://", description)
        self.assertIn("destructive", description)


class CozyAppsToolOwnerLoopTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner_loop = asyncio.new_event_loop()
        self.owner_thread = threading.Thread(
            target=self.owner_loop.run_forever, name="cozyapps-owner-loop", daemon=True
        )
        self.owner_thread.start()
        self.client = _OwnerLoopClient(self.owner_loop)
        self.adapter = object.__new__(adapter_module.AttachAdapter)
        self.adapter._client = self.client
        self.adapter._loop = self.owner_loop
        self.adapter._active_turn = {"thread-1": "turn-1"}
        self.adapter._profile = "profile-1"
        self.original_turn_context = adapter_module._current_turn_platform_and_chat
        self.original_message_context = adapter_module._current_turn_message_and_cron
        adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, "thread-1")
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "profile-1")
        adapter_module._register_active_adapter(self.adapter)

    async def asyncTearDown(self):
        adapter_module._unregister_active_adapter(self.adapter)
        adapter_module._current_turn_platform_and_chat = self.original_turn_context
        adapter_module._current_turn_message_and_cron = self.original_message_context
        self.owner_loop.call_soon_threadsafe(self.owner_loop.stop)
        self.owner_thread.join(timeout=2)
        self.owner_loop.close()

    async def test_model_facing_upsert_marshals_to_the_adapter_owner_loop(self):
        """Hermes tool handlers run on a different loop than the SQLite-backed client."""
        result = json.loads(await adapter_module._cozyapp_upsert({
            "appId": "home-temperatures", "name": "Home temperatures",
            "tree": {"root": {"id": "root", "kind": "stack", "children": []}},
        }))

        self.assertEqual(result, {"ok": True, "appId": "home-temperatures"})
        self.assertEqual(
            self.client.calls,
            [("home-temperatures", "Home temperatures", {"root": {"id": "root", "kind": "stack", "children": []}})],
        )


if __name__ == "__main__":
    unittest.main()

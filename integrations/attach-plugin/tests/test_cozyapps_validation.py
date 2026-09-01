"""Local CozyApps v1 validation prevents false successful publish results."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import sys
import threading
import types
import unittest

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


NIGHTY_TREE = {
    "root": {
        "id": "home",
        "kind": "stack",
        "children": [
            {
                "id": "summary",
                "kind": "section",
                "title": "Home temperatures",
                "children": [
                    {"id": "headline", "kind": "text", "text": "72°F", "style": "title"},
                    {"id": "refresh", "kind": "button", "label": "Refresh", "actionId": "refresh", "role": "primary"},
                ],
            },
        ],
    },
}


class _OwnerLoopClient:
    def __init__(self, owner_loop):
        self.owner_loop = owner_loop
        self.calls = []

    async def upsert_cozyapp(self, app_id, name, tree):
        if asyncio.get_running_loop() is not self.owner_loop:
            raise sqlite3.ProgrammingError("SQLite objects created in a thread can only be used in that same thread")
        self.calls.append((app_id, name, tree))
        return True


class CozyAppsValidationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owner_loop = asyncio.new_event_loop()
        self.owner_thread = threading.Thread(target=self.owner_loop.run_forever, daemon=True)
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

    async def test_valid_nighty_shaped_tree_passes_to_the_owner_loop(self):
        result = json.loads(await adapter_module._cozyapp_upsert({
            "appId": "house-temperature-dashboard", "name": "House Temperature", "tree": NIGHTY_TREE,
        }))

        self.assertEqual(result, {"ok": True, "appId": "house-temperature-dashboard"})
        self.assertEqual(self.client.calls, [("house-temperature-dashboard", "House Temperature", NIGHTY_TREE)])

    async def test_invalid_tree_returns_a_specific_error_without_journaling(self):
        tree = {"root": {"id": "home", "kind": "stack", "children": [], "unknown": True}}

        result = json.loads(await adapter_module._cozyapp_upsert({
            "appId": "house-temperature-dashboard", "name": "House Temperature", "tree": tree,
        }))

        self.assertEqual(result, {"ok": False, "error": "invalid CozyApp: stack node contains unsupported properties"})
        self.assertEqual(self.client.calls, [])

    def test_validator_mirrors_closed_contract_types_and_ceilings(self):
        validate = adapter_module._validate_cozyapp_upsert
        self.assertIsNone(validate("house-temperature-dashboard", "House Temperature", NIGHTY_TREE))
        self.assertEqual(validate("bad id", "House Temperature", NIGHTY_TREE), "appId must be 1-128 letters, digits, '_' or '-'")
        self.assertEqual(validate("house", "", NIGHTY_TREE), "name must be 1-120 characters")
        self.assertEqual(
            validate("house", "House", {"root": {"id": "home", "kind": "image", "source": "http://example.test"}}),
            "image source must be an HTTPS URL",
        )
        self.assertEqual(
            validate("house", "House", {"root": {"id": "home", "kind": "text", "text": "hello", "style": []}}),
            "text style is not supported",
        )
        self.assertEqual(
            validate("house", "House", {"root": {"id": "same", "kind": "stack", "children": [{"id": "same", "kind": "text", "text": "duplicate"}]}}),
            "node ids must be unique",
        )
        deep = {"id": "n1", "kind": "stack", "children": []}
        cursor = deep
        for index in range(2, 14):
            child = {"id": f"n{index}", "kind": "stack", "children": []}
            cursor["children"] = [child]
            cursor = child
        self.assertEqual(validate("house", "House", {"root": deep}), "tree exceeds maximum depth")
        many = {"root": {"id": "root", "kind": "stack", "children": [
            {"id": f"section{section}", "kind": "section", "children": [
                {"id": f"n{section}-{index}", "kind": "text", "text": "x"} for index in range(100)
            ]}
            for section in range(2)
        ]}}
        self.assertEqual(validate("house", "House", many), "tree exceeds maximum nodes")
        oversized = {"root": {"id": "root", "kind": "stack", "children": [
            {"id": f"n{index}", "kind": "text", "text": "x" * 8192} for index in range(16)
        ]}}
        self.assertEqual(validate("house", "House", oversized), "tree exceeds maximum serialized size")


if __name__ == "__main__":
    unittest.main()

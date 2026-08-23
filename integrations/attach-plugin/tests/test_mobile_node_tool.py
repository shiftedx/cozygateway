"""MN-0's public Hermes plugin-tool seam.

The real Hermes loader calls ``register(ctx)`` with a PluginContext.  This
recording context has that same public registration surface and invokes the
registered async handler exactly as Hermes's tool registry does.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import unittest
from pathlib import Path

import cozygateway.adapter as adapter_module


class _PluginContext:
    def __init__(self):
        self.tools = []

    def register_platform(self, **_kwargs):
        pass

    def register_hook(self, *_args, **_kwargs):
        pass

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


class _Client:
    def __init__(self):
        self.calls = []
        self.result = asyncio.get_running_loop().create_future()

    async def request_device_status(self, thread_id, turn_id):
        self.calls.append((thread_id, turn_id))
        return await self.result


class _Adapter:
    def __init__(self, client, active_turn=None, profile="profile-1"):
        self._client = client
        self._active_turn = active_turn or {}
        self._profile = profile

    async def request_device_status(self, thread_id, turn_id):
        return await self._client.request_device_status(thread_id, turn_id)


class MobileNodeToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = _PluginContext()
        adapter_module.register(self.context)
        self.tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_device_status")
        self.original_context = adapter_module._current_turn_platform_and_chat
        self.original_message_context = adapter_module._current_turn_message_and_cron
        adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, "thread-1")
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "profile-1")

    async def asyncTearDown(self):
        adapter_module._current_turn_platform_and_chat = self.original_context
        adapter_module._current_turn_message_and_cron = self.original_message_context
        for adapter in adapter_module._active_adapters_snapshot():
            adapter_module._unregister_active_adapter(adapter)

    async def test_registers_and_invokes_the_async_hermes_tool(self):
        self.assertEqual(self.tool["toolset"], "cozygateway")
        self.assertTrue(self.tool["is_async"])
        self.assertEqual(self.tool["schema"]["name"], "cozy_device_status")

        client = _Client()
        adapter = _Adapter(client, {"thread-1": "turn-1"})
        adapter_module._register_active_adapter(adapter)
        call = asyncio.create_task(self.tool["handler"]({}))
        await asyncio.sleep(0)
        self.assertEqual(client.calls, [("thread-1", "turn-1")])
        client.result.set_result({"status": "ok", "result": {"foreground": True}})
        self.assertEqual(json.loads(await call), {"status": "ok", "result": {"foreground": True}})

    async def test_rejects_unbound_context_before_phone_routing(self):
        adapter_module._current_turn_platform_and_chat = lambda: ("cron", "thread-1")
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))

        self.assertEqual(json.loads(await self.tool["handler"]({})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_rejects_cron_and_a_noncanonical_message_before_phone_routing(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", True, "profile-1")
        self.assertEqual(json.loads(await self.tool["handler"]({})), {"status": "policy_blocked"})
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1:steer", False, "profile-1")
        self.assertEqual(json.loads(await self.tool["handler"]({})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_rejects_a_foreign_profile_before_phone_routing(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "other-profile")
        self.assertEqual(json.loads(await self.tool["handler"]({})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_rejects_missing_active_turn_before_phone_routing(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client))

        self.assertEqual(json.loads(await self.tool["handler"]({})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_cancellation_is_one_terminal_result(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.tool["handler"]({}))
        await asyncio.sleep(0)
        call.cancel()
        self.assertEqual(json.loads(await call), {"status": "cancelled"})
        self.assertEqual(client.calls, [("thread-1", "turn-1")])


class HermesPluginContextTests(unittest.TestCase):
    @unittest.skipUnless(
        Path(os.environ.get("HERMES_AGENT_ROOT", os.path.expanduser("~/.hermes/hermes-agent"))).is_dir(),
        "pinned Hermes runtime is not installed",
    )
    def test_real_plugin_context_and_model_tools_dispatch_on_the_adapter_loop(self):
        try:
            import yaml  # noqa: F401 - Hermes' PluginContext dependency
        except ModuleNotFoundError:
            self.skipTest("pinned Hermes Python dependencies are not installed")
        root = Path(os.environ.get("HERMES_AGENT_ROOT", os.path.expanduser("~/.hermes/hermes-agent")))
        sys.path.insert(0, str(root))
        try:
            from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest
            import model_tools
            from tools.registry import registry

            manager = PluginManager()
            adapter_module.register(PluginContext(PluginManifest(name="cozygateway"), manager))
            entry = registry.get_entry("cozy_device_status")
            self.assertIsNotNone(entry)
            self.assertTrue(entry.is_async)
            self.assertEqual(entry.schema["name"], "cozy_device_status")
            ready = threading.Event()
            stopped = threading.Event()
            loop_box = []

            def run_loop():
                loop = asyncio.new_event_loop()
                loop_box.append(loop)
                ready.set()
                loop.run_forever()
                loop.close()
                stopped.set()

            thread = threading.Thread(target=run_loop)
            thread.start()
            self.assertTrue(ready.wait(1))

            class Client:
                async def request_device_status(self, _thread_id, _turn_id):
                    self.loop_thread = threading.get_ident()
                    return {"status": "ok", "result": {"foreground": True}}

            client = Client()
            adapter = adapter_module.AttachAdapter()
            adapter._client = client
            adapter._loop = loop_box[0]
            adapter._active_turn = {"thread-1": "turn-1"}
            adapter._profile = "profile-1"
            original = adapter_module._current_turn_platform_and_chat
            original_message = adapter_module._current_turn_message_and_cron
            adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, "thread-1")
            adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "profile-1")
            adapter_module._register_active_adapter(adapter)
            try:
                self.assertEqual(
                    json.loads(model_tools.handle_function_call("cozy_device_status", {})),
                    {"status": "ok", "result": {"foreground": True}},
                )
                self.assertEqual(client.loop_thread, thread.ident)
            finally:
                adapter_module._current_turn_platform_and_chat = original
                adapter_module._current_turn_message_and_cron = original_message
                adapter_module._unregister_active_adapter(adapter)
                loop_box[0].call_soon_threadsafe(loop_box[0].stop)
                thread.join(1)
                self.assertTrue(stopped.is_set())
                if model_tools._tool_loop is not None:
                    model_tools._tool_loop.close()
                    model_tools._tool_loop = None
        finally:
            sys.path.pop(0)


if __name__ == "__main__":
    unittest.main()

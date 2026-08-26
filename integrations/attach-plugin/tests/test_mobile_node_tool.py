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
from unittest import mock
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

    async def request_location(self, thread_id, turn_id, purpose):
        self.calls.append((thread_id, turn_id, purpose))
        return await self.result


class _Adapter:
    def __init__(self, client, active_turn=None, profile="profile-1"):
        self._client = client
        self._active_turn = active_turn or {}
        self._profile = profile

    async def request_device_status(self, thread_id, turn_id):
        return await self._client.request_device_status(thread_id, turn_id)

    async def request_location(self, thread_id, turn_id, purpose):
        return await self._client.request_location(thread_id, turn_id, purpose)


class MobileNodeToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = _PluginContext()
        adapter_module.register(self.context)
        self.tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_device_status")
        self.location_tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_request_location")
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

    async def test_registers_location_with_a_normalized_purpose_and_closed_result(self):
        self.assertEqual(self.location_tool["schema"]["parameters"]["properties"]["purpose"]["maxLength"], 160)
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.location_tool["handler"]({"purpose": "  Find   coffee  "}))
        await asyncio.sleep(0)
        self.assertEqual(client.calls, [("thread-1", "turn-1", "Find coffee")])
        client.result.set_result({"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}})
        self.assertEqual(json.loads(await call), {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}})
        self.assertEqual(json.loads(await self.location_tool["handler"]({"purpose": "bad\npurpose"})), {"status": "policy_blocked"})

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

    async def test_logs_each_fail_closed_guard_without_sensitive_values(self):
        cases = [
            (
                "session_context_unavailable",
                lambda: (_ for _ in ()).throw(RuntimeError("unavailable")),
                lambda: ("turn-1", False, "profile-1"),
                [],
            ),
            ("wrong_platform", lambda: ("other", "thread-1"), lambda: ("turn-1", False, "profile-1"), []),
            ("missing_chat_id", lambda: (adapter_module.PLATFORM_NAME, None), lambda: ("turn-1", False, "profile-1"), []),
            ("cron_session", lambda: (adapter_module.PLATFORM_NAME, "thread-1"), lambda: ("turn-1", True, "profile-1"), []),
            ("active_adapter_count", lambda: (adapter_module.PLATFORM_NAME, "thread-1"), lambda: ("turn-1", False, "profile-1"), []),
            (
                "active_adapter_count",
                lambda: (adapter_module.PLATFORM_NAME, "thread-1"),
                lambda: ("turn-1", False, "profile-1"),
                [_Adapter(_Client(), {"thread-1": "turn-1"}), _Adapter(_Client(), {"thread-1": "turn-2"})],
            ),
            (
                "profile_mismatch",
                lambda: (adapter_module.PLATFORM_NAME, "thread-1"),
                lambda: ("turn-1", False, None),
                [_Adapter(_Client(), {"thread-1": "turn-1"})],
            ),
            (
                "profile_mismatch",
                lambda: (adapter_module.PLATFORM_NAME, "thread-1"),
                lambda: ("turn-1", False, "other-profile"),
                [_Adapter(_Client(), {"thread-1": "turn-1"})],
            ),
            (
                "turn_message_mismatch",
                lambda: (adapter_module.PLATFORM_NAME, "thread-1"),
                lambda: ("other-turn", False, "profile-1"),
                [_Adapter(_Client(), {"thread-1": "turn-1"})],
            ),
        ]
        for reason, platform_context, message_context, adapters in cases:
            with self.subTest(reason=reason, adapter_count=len(adapters)):
                for active in adapter_module._active_adapters_snapshot():
                    adapter_module._unregister_active_adapter(active)
                adapter_module._current_turn_platform_and_chat = platform_context
                adapter_module._current_turn_message_and_cron = message_context
                for active in adapters:
                    adapter_module._register_active_adapter(active)
                with self.assertLogs(adapter_module.logger, level="WARNING") as captured:
                    result = json.loads(await self.tool["handler"]({}))
                self.assertEqual(result, {"status": "policy_blocked"})
                joined = "\n".join(captured.output)
                self.assertIn(f"reason={reason}", joined)
                for secret in ("thread-1", "turn-1", "other-turn", "profile-1"):
                    self.assertNotIn(secret, joined)

    async def test_logs_invalid_location_purpose_before_blocking(self):
        with self.assertLogs(adapter_module.logger, level="WARNING") as captured:
            result = json.loads(await self.location_tool["handler"]({"purpose": "secret\ncontent"}))
        self.assertEqual(result, {"status": "policy_blocked"})
        joined = "\n".join(captured.output)
        self.assertIn("reason=invalid_location_purpose", joined)
        self.assertNotIn("secret", joined)

    async def test_post_turn_replay_is_blocked_without_phone_routing(self):
        client = _Client()
        adapter = _Adapter(client, {"thread-1": "turn-1"})
        adapter_module._register_active_adapter(adapter)
        adapter._active_turn.clear()
        with self.assertLogs(adapter_module.logger, level="WARNING") as captured:
            result = json.loads(await self.tool["handler"]({}))
        self.assertEqual(result, {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])
        self.assertIn("reason=active_adapter_count", "\n".join(captured.output))

    async def test_cancellation_is_one_terminal_result(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.tool["handler"]({}))
        await asyncio.sleep(0)
        call.cancel()
        self.assertEqual(json.loads(await call), {"status": "cancelled"})
        self.assertEqual(client.calls, [("thread-1", "turn-1")])

    async def test_location_cancellation_and_noncanonical_context_never_leak_to_the_phone(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.location_tool["handler"]({"purpose": "Find coffee"}))
        await asyncio.sleep(0)
        call.cancel()
        self.assertEqual(json.loads(await call), {"status": "cancelled"})
        self.assertEqual(client.calls, [("thread-1", "turn-1", "Find coffee")])
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1:steer", False, "profile-1")
        self.assertEqual(json.loads(await self.location_tool["handler"]({"purpose": "Find coffee"})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [("thread-1", "turn-1", "Find coffee")])


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
            location_entry = registry.get_entry("cozy_request_location")
            self.assertIsNotNone(location_entry)
            self.assertTrue(location_entry.is_async)
            self.assertEqual(location_entry.schema["parameters"]["properties"]["purpose"]["maxLength"], 160)
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

                async def request_location(self, _thread_id, _turn_id, purpose):
                    self.loop_thread = threading.get_ident()
                    self.purpose = purpose
                    return {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}}

            client = Client()
            adapter = adapter_module.AttachAdapter()
            adapter._client = client
            adapter._loop = loop_box[0]
            adapter._active_turn = {"thread-1": "turn-1"}
            adapter._profile = "profile-1"
            adapter_module._register_active_adapter(adapter)
            from gateway.session_context import clear_session_vars, set_session_vars
            tokens = set_session_vars(
                platform=adapter_module.PLATFORM_NAME,
                chat_id="thread-1",
                message_id="turn-1",
                profile="profile-1",
                cron_session="",
            )
            try:
                self.assertEqual(
                    json.loads(model_tools.handle_function_call(
                        "tool_call",
                        {"name": "cozy_device_status", "arguments": {}},
                        enabled_toolsets=["cozygateway"],
                    )),
                    {"status": "ok", "result": {"foreground": True}},
                )
                self.assertEqual(
                    json.loads(model_tools.handle_function_call(
                        "tool_call",
                        {"name": "cozy_request_location", "arguments": {"purpose": "Find coffee"}},
                        enabled_toolsets=["cozygateway"],
                    )),
                    {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}},
                )
                self.assertEqual(client.purpose, "Find coffee")
                self.assertEqual(client.loop_thread, thread.ident)
            finally:
                clear_session_vars(tokens)
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


class ProfileFromHermesHomeTests(unittest.TestCase):
    """The profile a per-profile install never configures, derived from the process itself.

    Nothing sets `HERMES_PROFILE` or a plugin `profile` key in a normal install, so before this
    the adapter's profile was empty and every phone-node call was refused with profile_mismatch.
    """

    def test_a_profile_home_yields_its_name(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_HOME": "/Users/x/.hermes/profiles/cleo"}):
            self.assertEqual(adapter_module._profile_from_hermes_home(), "cleo")

    def test_a_trailing_separator_is_tolerated(self) -> None:
        with mock.patch.dict(os.environ, {"HERMES_HOME": "/Users/x/.hermes/profiles/night-owl/"}):
            self.assertEqual(adapter_module._profile_from_hermes_home(), "night-owl")

    def test_a_non_profile_home_yields_nothing(self) -> None:
        # The default profile and test harnesses do not live under profiles/, and guessing a name
        # there would hand the gate an identity the operator never granted.
        with mock.patch.dict(os.environ, {"HERMES_HOME": "/Users/x/.hermes"}):
            self.assertEqual(adapter_module._profile_from_hermes_home(), "")

    def test_an_absent_home_yields_nothing(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(adapter_module._profile_from_hermes_home(), "")

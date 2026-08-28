"""MN-0's public Hermes plugin-tool seam.

The real Hermes loader calls ``register(ctx)`` with a PluginContext.  This
recording context has that same public registration surface and invokes the
registered async handler exactly as Hermes's tool registry does.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import threading
import types
import unittest
from unittest import mock
from pathlib import Path

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


GATEWAY_STATUS = {
    "appState": "background",
    "lowPowerMode": True,
    "capabilities": [
        {"command": "device.status", "permission": "not_required"},
        {"command": "location.current", "permission": "authorized"},
        {"command": "camera.capture", "permission": "authorized"},
        {"command": "file.pick", "permission": "not_required"},
        {"command": "notification.present", "permission": "not_required"},
    ],
    "authenticatedReachable": True,
    "lastAuthenticatedPresenceAt": 1234,
}


class _PluginContext:
    def __init__(self):
        self.platforms = []
        self.tools = []

    def register_platform(self, **kwargs):
        self.platforms.append(kwargs)

    def register_hook(self, *_args, **_kwargs):
        pass

    def register_tool(self, **kwargs):
        self.tools.append(kwargs)


class _Client:
    def __init__(self):
        self.calls = []
        self.result = asyncio.get_running_loop().create_future()

    async def request_device_status(self, thread_id, turn_id, purpose):
        self.calls.append((thread_id, turn_id, purpose))
        return await self.result

    async def request_location(self, thread_id, turn_id, purpose):
        self.calls.append((thread_id, turn_id, purpose))
        return await self.result

    async def download_media(self, media_id, max_bytes):
        self.download_calls.append((media_id, max_bytes))
        return self.download


class _Adapter:
    def __init__(self, client, active_turn=None, profile="profile-1"):
        self._client = client
        self._active_turn = active_turn or {}
        self._profile = profile

    async def request_device_status(self, thread_id, turn_id, purpose):
        return await self._client.request_device_status(thread_id, turn_id, purpose)

    async def request_location(self, thread_id, turn_id, purpose):
        return await self._client.request_location(thread_id, turn_id, purpose)

    async def request_mobile(self, command, thread_id, turn_id, purpose, **options):
        self._client.calls.append((command, thread_id, turn_id, purpose, options))
        return await self._client.result


class MobileNodeToolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.context = _PluginContext()
        adapter_module.register(self.context)
        self.tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_device_status")
        self.location_tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_request_location")
        self.camera_tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_capture_camera")
        self.file_tool = next(tool for tool in self.context.tools if tool["name"] == "cozy_pick_file")
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
        self.assertEqual(self.tool["schema"]["parameters"]["required"], ["purpose"])

        client = _Client()
        adapter = _Adapter(client, {"thread-1": "turn-1"})
        adapter_module._register_active_adapter(adapter)
        call = asyncio.create_task(self.tool["handler"]({"purpose": "  Report   phone readiness  "}))
        await asyncio.sleep(0)
        self.assertEqual(client.calls, [("thread-1", "turn-1", "Report phone readiness")])
        client.result.set_result({"status": "ok", "result": GATEWAY_STATUS})
        self.assertEqual(json.loads(await call), {"status": "ok", "result": GATEWAY_STATUS})

    async def test_registration_teaches_native_media_delivery(self):
        platform = self.context.platforms[0]
        self.assertEqual(platform["name"], adapter_module.PLATFORM_NAME)
        hint = platform["platform_hint"]

        self.assertIn("MEDIA:/absolute/path", hint)
        self.assertIn("one MEDIA:/absolute/path directive on each line", hint)
        self.assertIn("multiple directive lines send multiple attachments", hint)
        self.assertIn("outside code fences", hint)
        self.assertIn("directives automatically target this originating conversation", hint)
        self.assertIn("instead of sandbox links or file:// URLs", hint)

    async def test_preserves_bounded_failure_details_in_the_hermes_tool_json(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.tool["handler"]({"purpose": "Report phone readiness"}))
        await asyncio.sleep(0)
        client.result.set_result({
            "status": "device_unavailable", "stage": "dispatch", "reason": "frame_send_failed",
        })
        self.assertEqual(json.loads(await call), {
            "status": "device_unavailable", "stage": "dispatch", "reason": "frame_send_failed",
        })

        self.assertEqual(
            json.loads(adapter_module._mobile_tool_result(
                "device_unavailable", stage="token-secret", reason="path-secret",
            )),
            {"status": "device_unavailable"},
        )

    async def test_registers_p1_camera_file_and_actionable_notification_tools(self):
        by_name = {tool["name"]: tool for tool in self.context.tools}
        self.assertEqual(set(("cozy_capture_camera", "cozy_pick_file", "cozy_present_notification")) - set(by_name), set())
        self.assertEqual(by_name["cozy_capture_camera"]["schema"]["parameters"]["properties"]["capture"]["enum"], ["photo", "video"])
        self.assertEqual(by_name["cozy_pick_file"]["schema"]["parameters"]["properties"]["selection"]["enum"], ["photo", "file"])

    async def test_camera_photo_returns_the_verified_bytes_on_hermes_multimodal_seam(self):
        png = b"\x89PNG\r\n\x1a\n" + b"artifact"
        digest = hashlib.sha256(png).hexdigest()
        descriptor = {
            "mediaId": "media-photo", "mimeType": "image/png", "byteCount": len(png),
            "sha256": digest, "filename": "photo.png", "family": "image",
        }
        client = _Client()
        client.download_calls = []
        client.download = (png, "photo.png", "image/png")
        client.result.set_result({"status": "ok", "result": descriptor})
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        cached = type("Cached", (), {
            "path": "/agent/cache/images/image.png", "media_type": "image/png",
            "kind": "image", "display_name": "photo.png",
        })()

        with mock.patch.object(adapter_module, "_cache_mobile_artifact_bytes", return_value=cached) as cache:
            result = await self.camera_tool["handler"]({
                "purpose": "Read the label", "camera": "rear", "capture": "photo",
            })

        self.assertTrue(result["_multimodal"])
        self.assertEqual(result["content"][1]["type"], "image_url")
        self.assertTrue(result["content"][1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertIn("media-photo", result["content"][0]["text"])
        self.assertNotIn("/agent/cache", result["content"][0]["text"])
        self.assertEqual(client.download_calls, [("media-photo", 8 * 1024 * 1024)])
        cache.assert_called_once_with(png, filename="mobile_media-photo.png", mime_type="image/png")

    async def test_pdf_uses_the_supported_cached_document_read_file_contract(self):
        pdf = b"%PDF-1.7\nartifact"
        descriptor = {
            "mediaId": "media-pdf", "mimeType": "application/pdf", "byteCount": len(pdf),
            "sha256": hashlib.sha256(pdf).hexdigest(),
            "filename": "report.pdf", "family": "file",
        }
        client = _Client()
        client.download_calls = []
        client.download = (pdf, "report.pdf", "application/pdf")
        client.result.set_result({"status": "ok", "result": descriptor})
        adapter = _Adapter(client, {"thread-1": "turn-1"})
        adapter_module._register_active_adapter(adapter)
        cached = type("Cached", (), {
            "path": "/agent/cache/documents/report.pdf", "media_type": "application/pdf",
            "kind": "document", "display_name": "report.pdf",
        })()

        with mock.patch.object(adapter_module, "_cache_mobile_artifact_bytes", return_value=cached) as cache:
            first = await self.file_tool["handler"]({"purpose": "Summarize it", "selection": "file"})
            # A replayed descriptor is served from the adapter's bounded verified cache.
            client.result = asyncio.get_running_loop().create_future()
            client.result.set_result({"status": "ok", "result": descriptor})
            second = await self.file_tool["handler"]({"purpose": "Summarize it", "selection": "file"})

        self.assertTrue(first["_multimodal"])
        self.assertEqual(first, second)
        self.assertEqual(len(first["content"]), 1)
        note = first["content"][0]["text"]
        self.assertIn("/agent/cache/documents/report.pdf", note)
        self.assertIn("read_file", note)
        self.assertIn("media-pdf", note)
        self.assertEqual(client.download_calls, [("media-pdf", 20 * 1024 * 1024)])
        cache.assert_called_once_with(pdf, filename="mobile_media-pdf.pdf", mime_type="application/pdf")

    async def test_mismatch_and_unsupported_families_never_return_ok(self):
        png = b"\x89PNG\r\n\x1a\nartifact"
        base = {
            "mediaId": "media-bad", "mimeType": "image/png", "byteCount": len(png),
            "sha256": hashlib.sha256(png).hexdigest(),
            "filename": "photo.png", "family": "image",
        }
        cases = [
            ({**base, "byteCount": len(png) + 1}, (png, "photo.png", "image/png")),
            ({**base, "sha256": "0" * 64}, (png, "photo.png", "image/png")),
            ({**base, "mimeType": "image/jpeg"}, (png, "photo.png", "image/jpeg")),
            ({**base, "filename": "../private.png"}, (png, "private.png", "image/png")),
            ({**base, "mimeType": "video/mp4", "family": "video", "filename": "clip.mp4"}, (b"x", "clip.mp4", "video/mp4")),
        ]
        for descriptor, download in cases:
            with self.subTest(descriptor=descriptor):
                for active in adapter_module._active_adapters_snapshot():
                    adapter_module._unregister_active_adapter(active)
                client = _Client()
                client.download_calls = []
                client.download = download
                client.result.set_result({"status": "ok", "result": descriptor})
                adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
                with mock.patch.object(adapter_module, "_cache_mobile_artifact_bytes") as cache:
                    result = await self.camera_tool["handler"]({
                        "purpose": "Inspect it", "camera": "rear", "capture": "photo",
                    })
                expected = {
                    "status": "device_unavailable",
                    "stage": "media", "reason": "media_validation_failed",
                }
                # A structurally safe descriptor remains useful as the audit
                # reference. A path-like filename fails before any descriptor is
                # released into model context.
                if descriptor["filename"] != "../private.png":
                    expected["result"] = descriptor
                self.assertEqual(json.loads(result), expected)
                cache.assert_not_called()

    async def test_mobile_artifact_tool_hooks_never_project_bytes_or_cache_paths(self):
        observed = []
        active = type("Observed", (), {
            "observe_tool_event": lambda _self, *args: observed.append(args),
        })()
        adapter_module._register_active_adapter(active)
        secret_result = {
            "_multimodal": True,
            "content": [{"type": "text", "text": "/private/cache/report.pdf"}, {
                "type": "image_url", "image_url": {"url": "data:image/png;base64,SECRET"},
            }],
        }
        with mock.patch.object(
            adapter_module, "_current_turn_platform_and_chat",
            return_value=(adapter_module.PLATFORM_NAME, "thread-1"),
        ):
            adapter_module._dispatch_tool_hook("complete", {
                "tool_name": "cozy_capture_camera", "result": secret_result,
            })
            adapter_module._dispatch_tool_hook("complete", {
                "tool_name": "cozy_pick_file", "result": secret_result,
            })
        self.assertEqual([event[2] for event in observed], ["cozy_capture_camera", "cozy_pick_file"])
        self.assertEqual([event[3] for event in observed], [None, None])

    async def test_oversize_and_download_failure_never_cache_or_return_ok(self):
        cases = [
            ({
                "mediaId": "too-large", "mimeType": "image/png",
                "byteCount": 8 * 1024 * 1024 + 1, "sha256": "a" * 64,
                "filename": "large.png", "family": "image",
            }, None),
            ({
                "mediaId": "missing", "mimeType": "application/pdf", "byteCount": 12,
                "sha256": "a" * 64, "filename": "missing.pdf", "family": "file",
            }, FileNotFoundError("missing")),
        ]
        for descriptor, download_error in cases:
            with self.subTest(media_id=descriptor["mediaId"]):
                for active in adapter_module._active_adapters_snapshot():
                    adapter_module._unregister_active_adapter(active)
                client = _Client()
                client.download_calls = []
                if download_error is None:
                    client.download = (b"", descriptor["filename"], descriptor["mimeType"])
                else:
                    async def fail_download(media_id, max_bytes, error=download_error):
                        client.download_calls.append((media_id, max_bytes))
                        raise error
                    client.download_media = fail_download
                client.result.set_result({"status": "ok", "result": descriptor})
                adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
                with mock.patch.object(adapter_module, "_cache_mobile_artifact_bytes") as cache:
                    result = await self.file_tool["handler"]({
                        "purpose": "Inspect it", "selection": "file",
                    })
                expected = {
                    "status": "device_unavailable", "result": descriptor,
                    "stage": "media", "reason": "media_validation_failed",
                }
                self.assertEqual(json.loads(result), expected)
                cache.assert_not_called()

    async def test_rejects_unbound_context_before_phone_routing(self):
        adapter_module._current_turn_platform_and_chat = lambda: ("cron", "thread-1")
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))

        self.assertEqual(json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"})), {"status": "policy_blocked"})
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
        self.assertEqual(json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"})), {"status": "policy_blocked"})
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1:steer", False, "profile-1")
        self.assertEqual(json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_rejects_a_foreign_profile_before_phone_routing(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        adapter_module._current_turn_message_and_cron = lambda: ("turn-1", False, "other-profile")
        self.assertEqual(json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"})), {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])

    async def test_rejects_missing_active_turn_before_phone_routing(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client))

        self.assertEqual(json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"})), {"status": "policy_blocked"})
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
                    result = json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"}))
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
            result = json.loads(await self.tool["handler"]({"purpose": "Report phone readiness"}))
        self.assertEqual(result, {"status": "policy_blocked"})
        self.assertEqual(client.calls, [])
        self.assertIn("reason=active_adapter_count", "\n".join(captured.output))

    async def test_post_await_turn_change_discards_the_phone_payload(self):
        client = _Client()
        adapter = _Adapter(client, {"thread-1": "turn-1"})
        adapter_module._register_active_adapter(adapter)
        call = asyncio.create_task(self.tool["handler"]({"purpose": "Report phone readiness"}))
        await asyncio.sleep(0)
        adapter._active_turn["thread-1"] = "turn-2"
        client.result.set_result({"status": "ok", "result": GATEWAY_STATUS})
        with self.assertLogs(adapter_module.logger, level="WARNING") as captured:
            result = json.loads(await call)
        self.assertEqual(result, {"status": "policy_blocked"})
        self.assertNotIn("background", "\n".join(captured.output))

    async def test_later_message_context_does_not_discard_the_originating_turns_phone_payload(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.tool["handler"]({"purpose": "Report phone readiness"}))
        await asyncio.sleep(0)

        adapter_module._current_turn_platform_and_chat = lambda: (adapter_module.PLATFORM_NAME, "thread-2")
        adapter_module._current_turn_message_and_cron = lambda: ("turn-2", False, "profile-1")
        client.result.set_result({"status": "ok", "result": GATEWAY_STATUS})

        self.assertEqual(json.loads(await call), {"status": "ok", "result": GATEWAY_STATUS})

    async def test_origin_ownership_changes_while_awaiting_still_discard_the_phone_payload(self):
        for change in ("ended_turn", "changed_profile", "replaced_adapter"):
            with self.subTest(change=change):
                for active in adapter_module._active_adapters_snapshot():
                    adapter_module._unregister_active_adapter(active)
                client = _Client()
                origin = _Adapter(client, {"thread-1": "turn-1"})
                adapter_module._register_active_adapter(origin)
                call = asyncio.create_task(self.tool["handler"]({"purpose": "Report phone readiness"}))
                await asyncio.sleep(0)

                if change == "ended_turn":
                    origin._active_turn.clear()
                elif change == "changed_profile":
                    origin._profile = "profile-2"
                else:
                    adapter_module._unregister_active_adapter(origin)
                    adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
                client.result.set_result({"status": "ok", "result": GATEWAY_STATUS})

                with self.assertLogs(adapter_module.logger, level="WARNING") as captured:
                    result = json.loads(await call)
                self.assertEqual(result, {"status": "policy_blocked"})
                self.assertIn("reason=origin_turn_changed_after_request", "\n".join(captured.output))
                self.assertNotIn("background", "\n".join(captured.output))

    async def test_cancellation_is_one_terminal_result(self):
        client = _Client()
        adapter_module._register_active_adapter(_Adapter(client, {"thread-1": "turn-1"}))
        call = asyncio.create_task(self.tool["handler"]({"purpose": "Report phone readiness"}))
        await asyncio.sleep(0)
        call.cancel()
        self.assertEqual(json.loads(await call), {"status": "cancelled"})
        self.assertEqual(client.calls, [("thread-1", "turn-1", "Report phone readiness")])

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
            camera_entry = registry.get_entry("cozy_capture_camera")
            self.assertIsNotNone(camera_entry)
            self.assertTrue(camera_entry.is_async)
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
                media_bytes = b"\x89PNG\r\n\x1a\nresident-turn"

                async def request_device_status(self, _thread_id, _turn_id, purpose):
                    self.loop_thread = threading.get_ident()
                    self.status_purpose = purpose
                    return {"status": "ok", "result": GATEWAY_STATUS}

                async def request_location(self, _thread_id, _turn_id, purpose):
                    self.loop_thread = threading.get_ident()
                    self.purpose = purpose
                    return {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}}

                async def _request_mobile(self, command, _thread_id, _turn_id, _purpose, _options):
                    self.command = command
                    return {"status": "ok", "result": {
                        "mediaId": "resident-photo", "mimeType": "image/png",
                        "byteCount": len(self.media_bytes),
                        "sha256": hashlib.sha256(self.media_bytes).hexdigest(),
                        "filename": "resident.png", "family": "image",
                    }}

                async def download_media(self, media_id, max_bytes):
                    self.download = (media_id, max_bytes)
                    return self.media_bytes, "resident.png", "image/png"

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
                        {"name": "cozy_device_status", "arguments": {"purpose": "Report phone readiness"}},
                        enabled_toolsets=["cozygateway"],
                    )),
                    {"status": "ok", "result": GATEWAY_STATUS},
                )
                self.assertEqual(
                    json.loads(model_tools.handle_function_call(
                        "tool_call",
                        {"name": "cozy_request_location", "arguments": {"purpose": "Find coffee"}},
                        enabled_toolsets=["cozygateway"],
                    )),
                    {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}},
                )
                cached = type("Cached", (), {
                    "path": "/agent/cache/images/resident.png", "media_type": "image/png",
                    "kind": "image", "display_name": "resident.png",
                })()
                with mock.patch.object(adapter_module, "_cache_mobile_artifact_bytes", return_value=cached):
                    artifact = model_tools.handle_function_call(
                        "tool_call",
                        {"name": "cozy_capture_camera", "arguments": {
                            "purpose": "Read the label", "camera": "rear", "capture": "photo",
                        }},
                        enabled_toolsets=["cozygateway"],
                    )
                self.assertTrue(artifact["_multimodal"])
                self.assertEqual(artifact["content"][1]["type"], "image_url")
                # This is the runner seam that puts the image parts in the next
                # model/tool message in the same resident turn.
                from run_agent import AIAgent

                class VisionRunner:
                    provider = "openai"
                    model = "vision-test"
                    _no_list_tool_content_models = set()

                    @staticmethod
                    def _content_has_image_parts(content):
                        return AIAgent._content_has_image_parts(content)

                    @staticmethod
                    def _model_supports_vision():
                        return True

                    @staticmethod
                    def _provider_supports_vision_tool_messages():
                        return True

                self.assertEqual(
                    AIAgent._tool_result_content_for_active_model(
                        VisionRunner(), "cozy_capture_camera", artifact
                    ),
                    artifact["content"],
                )
                self.assertEqual(client.purpose, "Find coffee")
                self.assertEqual(client.status_purpose, "Report phone readiness")
                self.assertEqual(client.loop_thread, thread.ident)
                self.assertEqual(client.download, ("resident-photo", 8 * 1024 * 1024))
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

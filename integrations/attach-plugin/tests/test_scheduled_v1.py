import os
import tempfile
import types
import unittest
import sys
from unittest.mock import AsyncMock, patch

# The scheduled sender tests exercise durable framing without requiring the optional production
# websocket package in the stdlib-only plugin test environment.
try:
    import websockets.exceptions  # type: ignore[import-not-found]  # noqa: F401
except ModuleNotFoundError:
    websocket_exceptions = types.ModuleType("websockets.exceptions")
    websocket_exceptions.ConnectionClosed = RuntimeError
    websockets = types.ModuleType("websockets")
    websockets.exceptions = websocket_exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = websocket_exceptions

from cozygateway.adapter import (
    AttachAdapter,
    _hermes_standalone_send,
    _post_tool_call,
    _pre_tool_call,
    _send_message_handler,
    _standalone_send,
    enqueue_proactive_delivery,
)
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class ScheduledDeliveryTests(unittest.IsolatedAsyncioTestCase):
    _CONNECTION_ENV_KEYS = (
        "COZYGATEWAY_URL",
        "COZYGATEWAY_TOKEN",
        "COZYGATEWAY_CA_FILE",
        "COZYGATEWAY_SPOOL_PATH",
    )

    def setUp(self):
        # These tests must never inherit a developer's live gateway endpoint,
        # credentials, CA bundle, or durable spool. Empty values force every
        # client through the disposable config/transport supplied by the test.
        self._connection_env = patch.dict(
            os.environ,
            {key: "" for key in self._CONNECTION_ENV_KEYS},
        )
        self._connection_env.start()
        self.addCleanup(self._connection_env.stop)

    async def test_send_message_handler_keeps_plugin_media_native(self):
        resident = types.SimpleNamespace(
            _ready=__import__("asyncio").Event(),
            send_proactive=AsyncMock(return_value={"state": "projected"}),
        )
        resident._ready.set()

        class BasePlatformAdapter:
            @staticmethod
            def extract_media(_message):
                return [("/tmp/photo.jpg", False)], "native caption"

            @staticmethod
            def filter_media_delivery_paths(media):
                return media

        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.BasePlatformAdapter = BasePlatformAdapter
        gateway.platforms = platforms
        platforms.base = base
        with patch.dict(sys.modules, {
            "gateway": gateway,
            "gateway.platforms": platforms,
            "gateway.platforms.base": base,
        }), patch("cozygateway.adapter._resident_adapter", return_value=resident):
            result = await _send_message_handler(
                {"target": "cozygateway", "message": "MEDIA:/tmp/photo.jpg native caption"},
                "old-session",
                "cozygateway",
                types.SimpleNamespace(extra={}),
            )

        self.assertEqual(result["state"], "projected")
        self.assertTrue(result["success"])
        resident.send_proactive.assert_awaited_once()
        args, kwargs = resident.send_proactive.await_args
        self.assertEqual(args[1:3], ("native caption", ["/tmp/photo.jpg"]))
        self.assertTrue(kwargs["canonical_home"])

    async def test_send_message_handler_never_calls_journal_admission_success(self):
        resident = types.SimpleNamespace(
            _ready=__import__("asyncio").Event(),
            send_proactive=AsyncMock(
                return_value={"state": "journaled", "accepted_pending": True}
            ),
        )
        resident._ready.set()

        class BasePlatformAdapter:
            extract_media = staticmethod(lambda message: ([], message))
            filter_media_delivery_paths = staticmethod(lambda media: media)

        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.BasePlatformAdapter = BasePlatformAdapter
        gateway.platforms = platforms
        platforms.base = base
        with patch.dict(sys.modules, {
            "gateway": gateway,
            "gateway.platforms": platforms,
            "gateway.platforms.base": base,
        }), patch("cozygateway.adapter._resident_adapter", return_value=resident):
            _pre_tool_call(tool_name="send_message", tool_call_id="call-1")
            result = await _send_message_handler(
                {"target": "cozygateway", "message": "daily note"},
                "home",
                "cozygateway",
                types.SimpleNamespace(extra={}),
            )
            retry = await _send_message_handler(
                {"target": "cozygateway", "message": "daily note"},
                "home",
                "cozygateway",
                types.SimpleNamespace(extra={}),
            )
            _post_tool_call(tool_name="send_message", tool_call_id="call-1")
            _pre_tool_call(tool_name="send_message", tool_call_id="call-2")
            await _send_message_handler(
                {"target": "cozygateway", "message": "daily note"},
                "home",
                "cozygateway",
                types.SimpleNamespace(extra={}),
            )
            _post_tool_call(tool_name="send_message", tool_call_id="call-2")

        self.assertEqual(result["state"], "journaled")
        self.assertIn("projection is not yet confirmed", result["error"])
        self.assertNotIn("success", result)
        first_key = resident.send_proactive.await_args_list[0].kwargs["delivery_key"]
        retry_key = resident.send_proactive.await_args_list[1].kwargs["delivery_key"]
        distinct_key = resident.send_proactive.await_args_list[2].kwargs["delivery_key"]
        self.assertEqual(first_key, retry_key)
        self.assertNotEqual(first_key, distinct_key)
        self.assertEqual(retry["state"], "journaled")

    async def test_resident_proactive_media_count_fails_instead_of_truncating(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            adapter = AttachAdapter()
            adapter._attach_init(types.SimpleNamespace(extra={}))
            adapter._spool = spool
            adapter._client = AttachV1Client(AttachV1ClientConfig(
                gateway_url="http://gateway.example", token="secret", spool=spool,
            ))
            adapter._ready.set()
            try:
                result = await adapter.send_proactive(
                    "home", "report", [f"/tmp/{index}.png" for index in range(17)],
                    canonical_home=True, delivery_key="tool:many",
                )
            finally:
                spool.close()

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "media_count_exceeded")

    @staticmethod
    def _config(path):
        return types.SimpleNamespace(extra={
            "spool_path": path,
            "gateway_url": "http://gateway.example",
            "token": "secret",
            "receipt_timeout_seconds": 0,
        })

    @staticmethod
    def _events(path):
        spool = AttachSpool(path)
        try:
            return [frame["event"] for frame in spool.pending_events(20, 100_000)]
        finally:
            spool.close()

    @staticmethod
    async def _wait_for_transport_lease(spool):
        asyncio = __import__("asyncio")
        while not spool.acquire_transport_lease():
            await asyncio.sleep(0.01)

    async def test_explicit_spool_path_wins_over_hostile_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            hostile = "/definitely/not/the/test/path.sqlite"
            with patch.dict(os.environ, {"COZYGATEWAY_SPOOL_PATH": hostile}):
                result = await enqueue_proactive_delivery(
                    types.SimpleNamespace(extra={}),
                    thread_id="home",
                    delivery_key="routine:isolated",
                    message="daily note",
                    spool_path=path,
                )
            self.assertEqual(result["state"], "journaled")
            self.assertTrue(result["accepted_pending"])
            self.assertEqual(self._events(path)[0]["kind"], "scheduled")
            self.assertFalse(os.path.exists(hostile))

    async def test_recovered_final_without_an_active_turn_never_claims_unconfirmed_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = self._config(path)
            adapter = AttachAdapter()
            adapter._attach_init(config)
            adapter._spool = AttachSpool(path)
            adapter._client = AttachV1Client(AttachV1ClientConfig(
                gateway_url="http://gateway.example",
                token="secret",
                spool=adapter._spool,
            ))

            gateway = types.ModuleType("gateway")
            platforms = types.ModuleType("gateway.platforms")
            base = types.ModuleType("gateway.platforms.base")
            base.SendResult = _SendResult
            gateway.platforms = platforms
            platforms.base = base
            with patch.dict(
                sys.modules,
                {
                    "gateway": gateway,
                    "gateway.platforms": platforms,
                    "gateway.platforms.base": base,
                },
            ):
                try:
                    first = await adapter.send("thread", "Recovered final answer")
                    retry = await adapter.send("thread", "Recovered final answer")
                finally:
                    adapter._spool.close()

            self.assertFalse(first.success)
            self.assertFalse(retry.success)
            self.assertIn("projection not yet confirmed", first.error)
            events = self._events(path)
            self.assertEqual([event["kind"] for event in events], ["scheduled", "scheduled"])
            self.assertEqual([event["threadId"] for event in events], ["thread", "thread"])
            self.assertEqual(events[0]["deliveryId"], events[1]["deliveryId"])
            self.assertEqual(events[0]["messageId"], events[1]["messageId"])

    async def test_upstream_hermes_abi_reports_journaled_delivery_as_pending_error(self):
        with patch(
            "cozygateway.adapter._standalone_send",
            AsyncMock(return_value={"state": "journaled", "accepted_pending": True}),
        ):
            result = await _hermes_standalone_send(
                types.SimpleNamespace(extra={}), "home", "daily note"
            )
        self.assertEqual(result["state"], "journaled")
        self.assertIn("projection is not yet confirmed", result["error"])
        self.assertNotIn("success", result)

    async def test_upstream_hermes_abi_reports_only_projected_as_success(self):
        with patch(
            "cozygateway.adapter._standalone_send",
            AsyncMock(return_value={"state": "projected", "accepted_pending": False}),
        ):
            result = await _hermes_standalone_send(
                types.SimpleNamespace(extra={}), "home", "daily note"
            )
        self.assertTrue(result["success"])

    async def test_upstream_hermes_abi_distinguishes_blocked_from_pending(self):
        with patch(
            "cozygateway.adapter._standalone_send",
            AsyncMock(return_value={"state": "blocked", "accepted_pending": False}),
        ):
            result = await _hermes_standalone_send(
                types.SimpleNamespace(extra={}), "home", "daily note"
            )
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["error"], "delivery was blocked before projection")

    def test_adapter_configured_spool_path_wins_over_hostile_environment(self):
        with patch.dict(os.environ, {"COZYGATEWAY_SPOOL_PATH": "/definitely/not/the/test/path.sqlite"}):
            adapter = AttachAdapter()
            adapter._attach_init(types.SimpleNamespace(extra={"spool_path": "/tmp/test-spool.sqlite"}))
        self.assertEqual(adapter._spool_path, "/tmp/test-spool.sqlite")

    async def test_standalone_cron_uses_canonical_home_and_preserves_delivery_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            first = await _standalone_send(config, "recipient", "daily note", thread_id="home:daily:2026-08-21")
            second = await _standalone_send(config, "recipient", "daily note", thread_id="home:daily:2026-08-21")
            self.assertEqual(first["state"], "journaled")
            self.assertEqual(second["state"], "journaled")

            spool = AttachSpool(path)
            try:
                events = [frame["event"] for frame in spool.pending_events(10, 100_000)]
            finally:
                spool.close()
            self.assertEqual(len(events), 2)
            self.assertEqual(
                [event["target"] for event in events],
                [{"kind": "canonical_home"}, {"kind": "canonical_home"}],
            )
            self.assertTrue(all("threadId" not in event for event in events))
            self.assertEqual(len({event["deliveryId"] for event in events}), 1)
            self.assertEqual(len({event["messageId"] for event in events}), 1)

    async def test_missing_target_is_rejected_without_spooling(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            missing_target = await enqueue_proactive_delivery(config, thread_id=" ", delivery_key="routine:1", message="daily note")
            missing_key = await enqueue_proactive_delivery(config, thread_id="home", delivery_key=" ", message="daily note")
            self.assertEqual(missing_target["state"], "failed")
            self.assertEqual(missing_target["error"], "target_required")
            self.assertEqual(missing_key["state"], "failed")
            self.assertEqual(missing_key["error"], "delivery_key_required")
            self.assertFalse(os.path.exists(path))

    async def test_proactive_delivery_distinguishes_identical_messages_by_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            first = await enqueue_proactive_delivery(config, thread_id="home", delivery_key="task:1", message="same report")
            retry = await enqueue_proactive_delivery(config, thread_id="home", delivery_key="task:1", message="same report")
            second = await enqueue_proactive_delivery(config, thread_id="home", delivery_key="task:2", message="same report")
            self.assertEqual(first["state"], "journaled")
            self.assertEqual(retry["state"], "journaled")
            self.assertEqual(second["state"], "journaled")
            spool = AttachSpool(path)
            try:
                events = [frame["event"] for frame in spool.pending_events(10, 100_000)]
            finally:
                spool.close()
            self.assertEqual([event["deliveryId"] for event in events], ["scheduled:task:1", "scheduled:task:1", "scheduled:task:2"])
            self.assertEqual(events[0]["messageId"], events[1]["messageId"])
            self.assertNotEqual(events[1]["messageId"], events[2]["messageId"])

    async def test_blank_proactive_delivery_succeeds_without_creating_a_spool(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            result = await enqueue_proactive_delivery(config, thread_id="home", delivery_key="routine:quiet", message=" \n\t ")
            self.assertEqual(result, {"state": "suppressed", "accepted_pending": False})
            self.assertFalse(os.path.exists(path))

    async def test_home_delivery_uses_the_cron_session_as_the_occurrence_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            gateway = types.ModuleType("gateway")
            context = types.ModuleType("gateway.session_context")
            run_id = ["run-1"]
            context.get_session_env = lambda key: run_id[0] if key == "HERMES_SESSION_ID" else ""
            with patch.dict(sys.modules, {"gateway": gateway, "gateway.session_context": context}):
                await _standalone_send(config, "home", "same report")
                await _standalone_send(config, "home", "same report")
                run_id[0] = "run-2"
                await _standalone_send(config, "home", "same report")
            spool = AttachSpool(path)
            try:
                events = [frame["event"] for frame in spool.pending_events(10, 100_000)]
            finally:
                spool.close()
            self.assertEqual(
                [event["target"] for event in events],
                [{"kind": "canonical_home"}] * 3,
            )
            self.assertEqual([event["deliveryId"] for event in events], ["scheduled:run-1", "scheduled:run-1", "scheduled:run-2"])
            self.assertEqual(events[0]["messageId"], events[1]["messageId"])
            self.assertNotEqual(events[1]["messageId"], events[2]["messageId"])

    async def test_explicit_occurrence_key_overrides_session_context(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = self._config(path)
            gateway = types.ModuleType("gateway")
            context = types.ModuleType("gateway.session_context")
            context.get_session_env = lambda _key: "stale-session"
            with patch.dict(sys.modules, {"gateway": gateway, "gateway.session_context": context}):
                first = await _standalone_send(
                    config, "home", "same report", delivery_key="occurrence-1"
                )
                retry = await _standalone_send(
                    config, "home", "same report", delivery_key="occurrence-1"
                )
                second = await _standalone_send(
                    config, "home", "same report", delivery_key="occurrence-2"
                )
            events = self._events(path)
            self.assertEqual(first["state"], "journaled")
            self.assertEqual(retry["state"], "journaled")
            self.assertEqual(second["state"], "journaled")
            self.assertEqual(
                [event["deliveryId"] for event in events],
                ["scheduled:occurrence-1", "scheduled:occurrence-1", "scheduled:occurrence-2"],
            )

    async def test_standalone_text_and_png_journal_media_before_scheduled_without_a_turn(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            png = os.path.join(directory, "report.png")
            with open(png, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

            def upload(media_id, _path, mime, digest, data, _expires_at):
                return {
                    "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                    "sha256": digest, "filename": "report.png", "family": "image",
                }

            with patch.object(AttachV1Client, "_upload_media_sync", side_effect=upload):
                result = await _standalone_send(
                    self._config(path), "home", "daily report", thread_id="home",
                    media_files=[png],
                )
            self.assertEqual(result["state"], "journaled")
            self.assertTrue(result["accepted_pending"])
            self.assertNotIn("success", result)
            self.assertNotIn("delivered", result)
            self.assertTrue(result["deliveryId"].startswith("scheduled:"))
            self.assertTrue(result["messageId"].startswith("scheduled-"))
            events = self._events(path)
            self.assertEqual([event["kind"] for event in events], ["media", "scheduled"])
            self.assertEqual(events[1]["blocks"], [{"type": "paragraph", "text": "daily report"}])
            self.assertEqual(events[1]["mediaIds"], [events[0]["media"]["mediaId"]])

    async def test_standalone_media_only_delivery_journals_an_attachment_only_scheduled_message(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            png = os.path.join(directory, "report.png")
            with open(png, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

            def upload(media_id, _path, mime, digest, data, _expires_at):
                return {
                    "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                    "sha256": digest, "filename": "report.png", "family": "image",
                }

            with patch.object(AttachV1Client, "_upload_media_sync", side_effect=upload):
                result = await _standalone_send(
                    self._config(path), "home", "", thread_id="home", media_files=[png],
                )
            self.assertEqual(result["state"], "journaled")
            scheduled = self._events(path)[1]
            self.assertEqual(scheduled["blocks"], [])
            self.assertEqual(len(scheduled["mediaIds"]), 1)

    async def test_allow_partial_media_journals_text_and_successful_files_with_honest_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            png = os.path.join(directory, "report.png")
            broken = os.path.join(directory, "missing.png")
            with open(png, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")
            with open(broken, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

            def upload(media_id, upload_path, mime, digest, data, _expires_at):
                if upload_path == broken:
                    raise OSError("gateway.internal/private/path")
                return {
                    "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                    "sha256": digest, "filename": "report.png", "family": "image",
                }

            with patch.object(AttachV1Client, "_upload_media_sync", side_effect=upload):
                result = await enqueue_proactive_delivery(
                    self._config(path), thread_id="home", delivery_key="routine:partial",
                    message="daily report", media_files=[png, broken],
                    media_policy="allow_partial_media",
                )
            self.assertEqual(result["state"], "journaled_partial")
            self.assertTrue(result["accepted_pending"])
            self.assertEqual(result["media_errors"], ["missing.png: io_error"])
            events = self._events(path)
            self.assertEqual([event["kind"] for event in events], ["media", "scheduled"])
            self.assertEqual(len(events[1]["mediaIds"]), 1)

    async def test_atomic_media_failure_rolls_back_earlier_uploaded_media(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            png = os.path.join(directory, "report.png")
            broken = os.path.join(directory, "missing.png")
            for candidate in (png, broken):
                with open(candidate, "wb") as handle:
                    handle.write(b"\x89PNG\r\n\x1a\n")

            def upload(media_id, upload_path, mime, digest, data, _expires_at):
                if upload_path == broken:
                    raise OSError("gateway.internal/private/path")
                return {
                    "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                    "sha256": digest, "filename": "report.png", "family": "image",
                }

            async def rollback(client, media_ids):
                client._spool.begin_media_cleanup(media_ids)
                return client._spool.pending_media_cleanups()

            with (
                patch.object(AttachV1Client, "_upload_media_sync", side_effect=upload),
                patch.object(AttachV1Client, "rollback_uploaded_media", autospec=True, side_effect=rollback) as rollback_call,
            ):
                result = await enqueue_proactive_delivery(
                    self._config(path), thread_id="home", delivery_key="routine:atomic",
                    message="daily report", media_files=[png, broken], media_policy="atomic",
                )
            self.assertEqual(result["state"], "failed")
            self.assertEqual(result["error"], "media_upload_failed")
            self.assertEqual(result["media_errors"], ["missing.png: io_error"])
            rollback_call.assert_awaited_once()
            rolled_back_ids = rollback_call.await_args.args[1]
            self.assertEqual(len(rolled_back_ids), 1)
            self.assertEqual(self._events(path), [])
            spool = AttachSpool(path)
            try:
                self.assertEqual(spool.pending_media_cleanups(), rolled_back_ids)
            finally:
                spool.close()

    async def test_more_than_sixteen_media_files_fails_before_creating_a_spool(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            result = await enqueue_proactive_delivery(
                self._config(path), thread_id="home", delivery_key="routine:too-many",
                message="daily report", media_files=[f"report-{index}.png" for index in range(17)],
            )
            self.assertEqual(result["state"], "failed")
            self.assertFalse(result["accepted_pending"])
            self.assertEqual(result["error"], "media_count_exceeded")
            self.assertTrue(result["deliveryId"].startswith("scheduled:"))
            self.assertFalse(os.path.exists(path))

    async def test_retry_reuses_stable_message_and_media_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            png = os.path.join(directory, "report.png")
            with open(png, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

            def upload(media_id, _path, mime, digest, data, _expires_at):
                return {
                    "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                    "sha256": digest, "filename": "report.png", "family": "image",
                }

            with patch.object(AttachV1Client, "_upload_media_sync", side_effect=upload):
                first = await _standalone_send(self._config(path), "home", "daily report", thread_id="home", media_files=[png])
                second = await _standalone_send(self._config(path), "home", "daily report", thread_id="home", media_files=[png])
            self.assertEqual(first["state"], "journaled")
            self.assertEqual(second["state"], "journaled")
            self.assertEqual(first["deliveryId"], second["deliveryId"])
            self.assertEqual(first["messageId"], second["messageId"])
            events = self._events(path)
            self.assertEqual([event["kind"] for event in events], ["media", "scheduled", "media", "scheduled"])
            self.assertEqual(events[0]["media"]["mediaId"], events[2]["media"]["mediaId"])
            self.assertEqual(events[1]["messageId"], events[3]["messageId"])
            self.assertEqual(events[1]["mediaIds"], events[3]["mediaIds"])

    async def test_projection_receipt_is_the_only_path_that_reports_projected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = self._config(path)
            config.extra["receipt_timeout_seconds"] = 0.1
            with (
                patch.object(AttachV1Client, "connect", new=AsyncMock()),
                patch.object(AttachV1Client, "watch", new=AsyncMock()),
                patch.object(AttachV1Client, "close", new=AsyncMock()),
                patch.object(AttachV1Client, "delivery_receipt", new=AsyncMock(return_value={"state": "projected", "projectedAt": 42})),
            ):
                result = await enqueue_proactive_delivery(
                    config, thread_id="home", delivery_key="routine:projected", message="daily report",
                )
            self.assertEqual(result["state"], "projected")
            self.assertFalse(result["accepted_pending"])
            self.assertEqual(result["projectedAt"], 42)

    async def test_unowned_spool_uses_one_short_lived_transport_and_waits_for_projected_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = self._config(path)
            config.extra["receipt_timeout_seconds"] = 0.1
            with (
                patch.object(AttachV1Client, "connect", new=AsyncMock()) as connect,
                patch.object(AttachV1Client, "watch", new=AsyncMock()) as watch,
                patch.object(AttachV1Client, "send_scheduled", new=AsyncMock(return_value={"eventId": "one-shot-event"})) as send,
                patch.object(AttachV1Client, "delivery_receipt", new=AsyncMock(return_value={"state": "projected", "projectedAt": 42})),
                patch.object(AttachV1Client, "close", new=AsyncMock()) as close,
            ):
                result = await enqueue_proactive_delivery(
                    config, thread_id="cron-run", delivery_key="routine:one-shot",
                    message="daily report", canonical_home=True,
                )
            self.assertEqual(result["state"], "projected")
            self.assertFalse(result["accepted_pending"])
            connect.assert_awaited_once()
            watch.assert_awaited_once()
            self.assertTrue(send.await_args.kwargs["canonical_home"])
            close.assert_awaited_once()

    async def test_resident_spool_owner_is_never_superseded_by_a_one_shot_sender(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            resident = AttachSpool(path)
            self.assertTrue(resident.acquire_transport_lease())
            try:
                with patch.object(AttachV1Client, "connect", new=AsyncMock()) as connect:
                    result = await enqueue_proactive_delivery(
                        self._config(path), thread_id="cron-run", delivery_key="routine:resident",
                        message="daily report", canonical_home=True,
                    )
                self.assertEqual(result["state"], "journaled")
                self.assertTrue(result["accepted_pending"])
                connect.assert_not_awaited()
            finally:
                resident.release_transport_lease()
                resident.close()

    async def test_cancellation_keeps_the_lease_until_the_one_shot_watcher_settles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = self._config(path)
            config.extra["receipt_timeout_seconds"] = 1
            watcher_started = __import__("asyncio").Event()
            watcher_settled = __import__("asyncio").Event()
            receipt_wait = __import__("asyncio").Event()

            async def watch(_client):
                watcher_started.set()
                try:
                    await __import__("asyncio").sleep(0.05)
                finally:
                    watcher_settled.set()

            async def receipt(_client, _delivery_id, _timeout):
                await receipt_wait.wait()
                return None

            with (
                patch.object(AttachV1Client, "connect", new=AsyncMock()),
                patch.object(AttachV1Client, "watch", new=watch),
                patch.object(AttachV1Client, "send_scheduled", new=AsyncMock(return_value={"eventId": "cancel-event"})),
                patch.object(AttachV1Client, "delivery_receipt", new=receipt),
                patch.object(AttachV1Client, "close", new=AsyncMock()),
            ):
                delivery = __import__("asyncio").create_task(enqueue_proactive_delivery(
                    config, thread_id="cron-run", delivery_key="routine:cancel",
                    message="daily report", canonical_home=True,
                ))
                await watcher_started.wait()
                delivery.cancel()
                contender = AttachSpool(path)
                try:
                    # Let cancellation enter its shielded teardown.  The second
                    # sender must remain excluded until the first watcher exits.
                    await __import__("asyncio").sleep(0)
                    self.assertFalse(contender.acquire_transport_lease())
                    with self.assertRaises(__import__("asyncio").CancelledError):
                        await delivery
                    await watcher_settled.wait()
                    await __import__("asyncio").wait_for(self._wait_for_transport_lease(contender), 1)
                finally:
                    contender.release_transport_lease()
                    contender.close()

    async def test_cancellation_during_close_keeps_the_lease_until_the_watcher_settles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            watcher_started = __import__("asyncio").Event()
            watcher_settled = __import__("asyncio").Event()
            watcher_release = __import__("asyncio").Event()
            close_started = __import__("asyncio").Event()
            close_release = __import__("asyncio").Event()

            async def watch(_client):
                watcher_started.set()
                try:
                    await watcher_release.wait()
                finally:
                    watcher_settled.set()

            async def close(_client):
                close_started.set()
                await close_release.wait()

            with (
                patch.object(AttachV1Client, "connect", new=AsyncMock()),
                patch.object(AttachV1Client, "watch", new=watch),
                patch.object(AttachV1Client, "send_scheduled", new=AsyncMock(return_value={"eventId": "close-event"})),
                patch.object(AttachV1Client, "close", new=close),
            ):
                delivery = __import__("asyncio").create_task(enqueue_proactive_delivery(
                    self._config(path), thread_id="cron-run", delivery_key="routine:close-cancel",
                    message="daily report", canonical_home=True,
                ))
                await watcher_started.wait()
                await close_started.wait()
                delivery.cancel()
                contender = AttachSpool(path)
                try:
                    await __import__("asyncio").sleep(0)
                    self.assertFalse(contender.acquire_transport_lease())
                    close_release.set()
                    watcher_release.set()
                    with self.assertRaises(__import__("asyncio").CancelledError):
                        await delivery
                    await watcher_settled.wait()
                    await __import__("asyncio").wait_for(self._wait_for_transport_lease(contender), 1)
                finally:
                    close_release.set()
                    watcher_release.set()
                    contender.release_transport_lease()
                    contender.close()

    async def test_socket_close_timeout_holds_lease_until_raw_socket_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            watcher_started = __import__("asyncio").Event()
            watcher_settled = __import__("asyncio").Event()
            watcher_release = __import__("asyncio").Event()
            socket_close_started = __import__("asyncio").Event()
            socket_close_release = __import__("asyncio").Event()

            class SlowSocket:
                async def close(self):
                    socket_close_started.set()
                    await socket_close_release.wait()

            async def connect(client):
                client._ws = SlowSocket()

            async def watch(_client):
                watcher_started.set()
                try:
                    await watcher_release.wait()
                finally:
                    watcher_settled.set()

            with (
                patch.object(AttachV1Client, "connect", new=connect),
                patch.object(AttachV1Client, "watch", new=watch),
            ):
                delivery = __import__("asyncio").create_task(enqueue_proactive_delivery(
                    self._config(path), thread_id="cron-run", delivery_key="routine:socket-timeout",
                    message="daily report", canonical_home=True,
                ))
                await watcher_started.wait()
                await socket_close_started.wait()
                # Let the bounded foreground close time out.  ``close()`` must
                # retain its raw socket task despite that cancellation.
                await __import__("asyncio").sleep(0.3)
                self.assertFalse(delivery.done())
                delivery.cancel()
                contender = AttachSpool(path)
                try:
                    await __import__("asyncio").sleep(0)
                    self.assertFalse(contender.acquire_transport_lease())
                    watcher_release.set()
                    await watcher_settled.wait()
                    # The watcher is gone but the raw socket close task remains;
                    # releasing here would let a second dial overlap the old FD.
                    self.assertFalse(contender.acquire_transport_lease())
                    socket_close_release.set()
                    with self.assertRaises(__import__("asyncio").CancelledError):
                        await delivery
                    await __import__("asyncio").wait_for(self._wait_for_transport_lease(contender), 1)
                finally:
                    watcher_release.set()
                    socket_close_release.set()
                    contender.release_transport_lease()
                    contender.close()


if __name__ == "__main__":
    unittest.main()

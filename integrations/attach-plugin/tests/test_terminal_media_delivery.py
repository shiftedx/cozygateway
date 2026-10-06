"""Terminal MEDIA paths must ride the same attach-v1 commit as the reply."""

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _Client(AttachV1Client):
    def __init__(self):
        self.uploads = []
        self.drafts = []
        self.commits = []

    async def upload_media(self, media_id, path, family, expires_at=None, mime=None, sha256=None):
        self.uploads.append((media_id, path, family))
        return {"id": media_id}

    async def send_draft(self, thread_id, turn_id, blocks, tool_calls=None):
        self.drafts.append((thread_id, turn_id, blocks))

    async def send_done(self, thread_id, turn_id, media_ids=None, media_positions=None, continues=False):
        self.commits.append((thread_id, turn_id, media_ids or [], media_positions))


class TerminalMediaDeliveryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = {key: sys.modules.get(key) for key in ("gateway", "gateway.platforms", "gateway.platforms.base")}
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.SendResult = _SendResult
        gateway.platforms = platforms
        platforms.base = base
        sys.modules["gateway"] = gateway
        sys.modules["gateway.platforms"] = platforms
        sys.modules["gateway.platforms.base"] = base

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def _adapter(self, media_path):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter.extract_media = lambda response: ([(media_path, False)], response.replace(f"MEDIA:{media_path}", ""))
        adapter.filter_media_delivery_paths = lambda paths: paths
        adapter.extract_local_files = lambda response: ([], response)
        adapter.filter_local_delivery_paths = lambda paths: paths
        return adapter

    async def test_video_is_uploaded_and_committed_before_hermes_calls_send_video(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            handle.write(b"video")
            video = handle.name
        self.addCleanup(lambda: os.path.exists(video) and os.unlink(video))

        adapter = self._adapter(video)
        client = _Client()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"

        async def handler(_event):
            return f"Here is the Office video.\nMEDIA:{video}"

        adapter.set_message_handler(handler)
        event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id="thread"))
        response = await adapter._message_handler(event)
        await adapter.send("thread", "Here is the Office video.", reply_to="turn")

        self.assertIn("MEDIA:", response)
        self.assertEqual([(path, family) for _, path, family in client.uploads], [(video, "video")])
        self.assertEqual(len(client.commits), 1)
        self.assertEqual(client.commits[0][2], [client.uploads[0][0]])

        # Hermes' ordinary post-text media phase still calls send_video. The adapter
        # must acknowledge the already-absorbed path instead of emitting a fallback.
        result = await adapter.send_video("thread", video)
        self.assertTrue(result.success)
        self.assertEqual(len(client.commits), 1)

    async def test_attachment_only_reply_commits_even_with_no_text_blocks(self):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            handle.write(b"video")
            video = handle.name
        self.addCleanup(lambda: os.path.exists(video) and os.unlink(video))

        adapter = self._adapter(video)
        client = _Client()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"

        async def handler(_event):
            return f"MEDIA:{video}"

        adapter.set_message_handler(handler)
        event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id="thread"))
        await adapter._message_handler(event)
        result = await adapter.send_video("thread", video)

        self.assertTrue(result.success)
        self.assertEqual(client.drafts, [("thread", "turn", [])])
        self.assertEqual(len(client.commits[0][2]), 1)

    async def test_standalone_image_with_no_turn_rides_the_canonical_home_proactive_path(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(b"\x89PNG\r\n\x1a\n")
            image = handle.name
        self.addCleanup(lambda: os.path.exists(image) and os.unlink(image))

        adapter = self._adapter(image)
        adapter._client = _Client()
        adapter._ready.set()
        adapter.send_proactive = AsyncMock(
            return_value={"state": "projected", "messageId": "scheduled-abc"}
        )

        result = await adapter.send_image_file("thread", image, "here it is")

        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "scheduled-abc")
        adapter.send_proactive.assert_awaited_once()
        args, kwargs = adapter.send_proactive.await_args
        self.assertEqual(args[0], "thread")
        self.assertEqual(args[1], "here it is")
        self.assertEqual(args[2], [image])
        self.assertTrue(kwargs["canonical_home"])
        self.assertTrue(kwargs["delivery_key"].startswith("media:"))

    async def test_standalone_document_with_a_pinned_thread_stays_thread_scoped(self):
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
            handle.write(b"%PDF-1.4")
            document = handle.name
        self.addCleanup(lambda: os.path.exists(document) and os.unlink(document))

        adapter = self._adapter(document)
        adapter._client = _Client()
        adapter._ready.set()
        adapter.send_proactive = AsyncMock(
            return_value={"state": "projected", "messageId": "scheduled-def"}
        )

        result = await adapter.send_document(
            "placeholder", document, metadata={"thread_id": "thread-42"}
        )

        self.assertTrue(result.success)
        _args, kwargs = adapter.send_proactive.await_args
        self.assertFalse(kwargs["canonical_home"])
        self.assertEqual(adapter.send_proactive.await_args[0][0], "thread-42")

    async def test_standalone_media_delivery_key_is_stable_per_file_and_occurrence(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
            handle.write(b"\x89PNG\r\n\x1a\n")
            image = handle.name
        self.addCleanup(lambda: os.path.exists(image) and os.unlink(image))

        adapter = self._adapter(image)
        adapter._client = _Client()
        adapter._ready.set()
        adapter.send_proactive = AsyncMock(
            return_value={"state": "journaled", "messageId": "scheduled-ghi"}
        )

        await adapter.send_image_file("thread", image, "caption")
        await adapter.send_image_file("thread", image, "caption")
        keys = [call.kwargs["delivery_key"] for call in adapter.send_proactive.await_args_list]
        self.assertEqual(keys[0], keys[1])

    async def test_standalone_media_surfaces_the_upload_failure_instead_of_claiming_success(self):
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as handle:
            handle.write(b"PK\x03\x04")
            archive = handle.name
        self.addCleanup(lambda: os.path.exists(archive) and os.unlink(archive))

        adapter = self._adapter(archive)
        adapter._client = _Client()
        adapter._ready.set()
        adapter.send_proactive = AsyncMock(
            return_value={
                "state": "failed",
                "error": "media_upload_failed",
                "media_errors": [
                    f"{os.path.basename(archive)} (application/zip, family=file): http_415 Unsupported Media Type"
                ],
            }
        )

        result = await adapter.send_document("thread", archive)

        self.assertFalse(result.success)
        self.assertIn("media_upload_failed", result.error)
        self.assertIn("http_415", result.error)
        self.assertIn("application/zip", result.error)


if __name__ == "__main__":
    unittest.main()

"""Terminal MEDIA paths must ride the same attach-v1 commit as the reply."""

import os
import sys
import tempfile
import types
import unittest

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

    async def upload_media(self, media_id, path, family):
        self.uploads.append((media_id, path, family))
        return {"id": media_id}

    async def send_draft(self, thread_id, turn_id, blocks, tool_calls=None):
        self.drafts.append((thread_id, turn_id, blocks))

    async def send_done(self, thread_id, turn_id, media_ids=None):
        self.commits.append((thread_id, turn_id, media_ids or []))


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


if __name__ == "__main__":
    unittest.main()

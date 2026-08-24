"""Inline media ordering: an attachment renders where the agent wrote it.

The draft still holds the ``MEDIA:`` marker lines when the message handler returns
(Hermes strips them only afterwards), so the marker line is the one place that knows
where the author put each picture. These tests pin the whole chain: the block index the
marker sits at, the terminal ``commit`` that carries the indices, the scheduled lane
that carries them too, and every ambiguity that must fall back to legacy above-stack
placement rather than guess.
"""

import os
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

from cozygateway.adapter import _media_positions_for_draft, _send_message_handler, AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client
from cozygateway.text_blocks import block_split_index


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _Client(AttachV1Client):
    """Captures what the adapter puts on the wire, without a socket."""

    def __init__(self):
        self.uploads = []
        self.drafts = []
        self.commits = []

    async def upload_media(self, media_id, path, family, expires_at=None, mime=None, sha256=None):
        self.uploads.append((media_id, path, family))
        return {"id": media_id}

    async def send_draft(self, thread_id, turn_id, blocks, tool_calls=None):
        self.drafts.append((thread_id, turn_id, blocks))

    async def send_done(self, thread_id, turn_id, media_ids=None, media_positions=None):
        self.commits.append((thread_id, turn_id, media_ids or [], media_positions))


class _EventClient(AttachV1Client):
    """A client that records the durable event instead of spooling it."""

    def __init__(self):
        self.events = []
        self._latest_blocks = {}
        self._latest_tools = {}

    async def _queue_event(self, event):
        self.events.append(event)
        return {"eventId": "event-1"}


class MarkerPositionTests(unittest.TestCase):
    def test_heading_marker_heading_marker_places_each_under_its_heading(self):
        draft = "## First\nMEDIA:/tmp/a.png\n## Second\nMEDIA:/tmp/b.png"
        cleaned = "## First\n## Second"
        self.assertEqual(
            _media_positions_for_draft(draft, cleaned, ["/tmp/a.png", "/tmp/b.png"]),
            [1, 2],
        )

    def test_a_marker_above_everything_is_position_zero(self):
        draft = "MEDIA:/tmp/a.png\n## First"
        self.assertEqual(_media_positions_for_draft(draft, "## First", ["/tmp/a.png"]), [0])

    def test_a_marker_below_everything_is_the_block_count(self):
        draft = "## First\n\nBody text.\n\nMEDIA:/tmp/a.png"
        cleaned = "## First\n\nBody text.\n"
        self.assertEqual(_media_positions_for_draft(draft, cleaned, ["/tmp/a.png"]), [2])

    def test_a_marker_inside_a_code_fence_has_no_answer(self):
        draft = "```\nMEDIA:/tmp/a.png\n```"
        cleaned = "```\n\n```"
        self.assertIsNone(_media_positions_for_draft(draft, cleaned, ["/tmp/a.png"]))

    def test_a_path_named_twice_has_no_answer(self):
        draft = "I saved /tmp/a.png for you.\n\nMEDIA:/tmp/a.png"
        cleaned = "I saved /tmp/a.png for you.\n"
        self.assertIsNone(_media_positions_for_draft(draft, cleaned, ["/tmp/a.png"]))

    def test_a_delivered_text_that_is_not_the_draft_has_no_answer(self):
        draft = "## First\nMEDIA:/tmp/a.png\n## Second"
        self.assertIsNone(
            _media_positions_for_draft(draft, "Something else entirely.", ["/tmp/a.png"])
        )

    def test_no_paths_is_no_answer_rather_than_an_empty_array(self):
        self.assertIsNone(_media_positions_for_draft("## First", "## First", []))

    def test_two_paths_on_one_marker_line_share_that_spot(self):
        draft = "## First\nMEDIA:/tmp/a.png MEDIA:/tmp/b.png"
        self.assertEqual(
            _media_positions_for_draft(draft, "## First", ["/tmp/a.png", "/tmp/b.png"]),
            [1, 1],
        )

    def test_splitting_inside_a_paragraph_is_refused(self):
        self.assertIsNone(block_split_index("one\ntwo", 1))

    def test_splitting_at_a_paragraph_boundary_counts_the_blocks_before_it(self):
        self.assertEqual(block_split_index("one\n\ntwo", 2), 1)


class TerminalCommitPositionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = {
            key: sys.modules.get(key)
            for key in ("gateway", "gateway.platforms", "gateway.platforms.base")
        }
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

    def _media(self, body):
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
            handle.write(body)
            path = handle.name
        self.addCleanup(lambda: os.path.exists(path) and os.unlink(path))
        return path

    def _adapter(self, paths):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))

        def extract(response):
            cleaned = response
            for path in paths:
                cleaned = cleaned.replace("MEDIA:%s\n" % path, "").replace("MEDIA:%s" % path, "")
            return [(path, False) for path in paths], cleaned

        adapter.extract_media = extract
        adapter.filter_media_delivery_paths = lambda media: media
        adapter.extract_local_files = lambda response: ([], response)
        adapter.filter_local_delivery_paths = lambda media: media
        return adapter

    async def _commit(self, draft, paths):
        adapter = self._adapter(paths)
        client = _Client()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"

        async def handler(_event):
            return draft

        adapter.set_message_handler(handler)
        event = types.SimpleNamespace(source=types.SimpleNamespace(chat_id="thread"))
        await adapter._message_handler(event)
        _media, cleaned = adapter.extract_media(draft)
        await adapter.send("thread", cleaned, reply_to="turn")
        self.assertEqual(len(client.commits), 1)
        return client.commits[0]

    async def test_heading_marker_heading_marker_commits_positions_one_and_two(self):
        first = self._media(b"first video")
        second = self._media(b"second video")
        draft = "## First\nMEDIA:%s\n## Second\nMEDIA:%s" % (first, second)

        _thread, _turn, media_ids, positions = await self._commit(draft, [first, second])

        self.assertEqual(len(media_ids), 2)
        self.assertEqual(positions, [1, 2])

    async def test_an_ambiguous_draft_commits_the_media_with_no_positions(self):
        only = self._media(b"only video")
        # The marker sits inside a paragraph, so there is no block boundary to name.
        draft = "Here is the clip.\nMEDIA:%s\nAnd here is why it matters." % only

        _thread, _turn, media_ids, positions = await self._commit(draft, [only])

        self.assertEqual(len(media_ids), 1)
        self.assertIsNone(positions)

    async def test_a_path_the_draft_never_staged_drops_every_position(self):
        staged = self._media(b"staged video")
        extra = self._media(b"metadata video")
        draft = "## First\nMEDIA:%s" % staged
        adapter = self._adapter([staged])
        client = _Client()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"

        async def handler(_event):
            return draft

        adapter.set_message_handler(handler)
        await adapter._message_handler(
            types.SimpleNamespace(source=types.SimpleNamespace(chat_id="thread"))
        )
        await adapter.send(
            "thread", "## First", reply_to="turn", metadata={"media_files": [extra]}
        )

        self.assertEqual(len(client.commits), 1)
        self.assertEqual(len(client.commits[0][2]), 2)
        self.assertIsNone(client.commits[0][3])


class WireEventTests(unittest.IsolatedAsyncioTestCase):
    async def test_done_carries_media_positions_aligned_with_media_ids(self):
        client = _EventClient()
        await client.send_done("thread", "turn", media_ids=["a", "b"], media_positions=[1, 2])
        self.assertEqual(client.events[0]["mediaIds"], ["a", "b"])
        self.assertEqual(client.events[0]["mediaPositions"], [1, 2])

    async def test_scheduled_carries_media_positions(self):
        client = _EventClient()
        await client.send_scheduled("thread", "d1", "m1", [], ["a"], media_positions=[0])
        self.assertEqual(client.events[0]["mediaPositions"], [0])

    async def test_a_length_mismatch_drops_the_whole_array(self):
        client = _EventClient()
        await client.send_done("thread", "turn", media_ids=["a", "b"], media_positions=[1])
        self.assertNotIn("mediaPositions", client.events[0])

    async def test_no_positions_stays_the_legacy_shape(self):
        client = _EventClient()
        await client.send_done("thread", "turn", media_ids=["a"])
        self.assertNotIn("mediaPositions", client.events[0])

    async def test_an_out_of_range_position_drops_the_whole_array(self):
        client = _EventClient()
        await client.send_done("thread", "turn", media_ids=["a"], media_positions=[-1])
        self.assertNotIn("mediaPositions", client.events[0])


class ScheduledLanePositionTests(unittest.IsolatedAsyncioTestCase):
    async def test_the_send_message_lane_places_its_attachment_under_its_heading(self):
        import asyncio

        resident = types.SimpleNamespace(
            _ready=asyncio.Event(),
            send_proactive=AsyncMock(return_value={"state": "projected"}),
        )
        resident._ready.set()

        class BasePlatformAdapter:
            @staticmethod
            def extract_media(_message):
                return [("/tmp/chart.png", False)], "## Sales\n\n## Costs"

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
            await _send_message_handler(
                {
                    "target": "cozygateway",
                    "message": "## Sales\nMEDIA:/tmp/chart.png\n\n## Costs",
                },
                "session",
                "cozygateway",
                types.SimpleNamespace(extra={}),
            )

        _args, kwargs = resident.send_proactive.await_args
        self.assertEqual(kwargs["media_positions"], [1])


if __name__ == "__main__":
    unittest.main()

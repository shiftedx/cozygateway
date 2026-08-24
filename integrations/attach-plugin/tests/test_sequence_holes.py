"""A numbered outbox row is a promise the plugin can never take back.

The gateway admits events only in strictly contiguous order. Deleting a row that already has a
sequence therefore does not remove work, it removes the ability to ever get past that number: the
plugin replays from after the hole, is gapped, replays again, and the stream livelocks while
heartbeats keep the connection reporting healthy. These tests hold both halves of the fix. Payload
withdrawal keeps the row and replaces its frame with an inert placeholder, and a gap pointing into
a hole the spool cannot fill is healed rather than replayed into forever.
"""

import asyncio
import logging
import os
import tempfile
import unittest

from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import MAX_HEALED_SEQUENCE_HOLES, AttachSpool
from tests.fake_gateway import FakeGateway


def _draft(turn: str) -> dict:
    return {"kind": "draft", "threadId": "thread", "turnId": turn, "blocks": []}


def _media(media_id: str) -> dict:
    return {"kind": "media", "media": {"mediaId": media_id, "mimeType": "image/png"}}


class SpoolSequenceHoleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "spool.sqlite")

    def _spool(self) -> AttachSpool:
        spool = AttachSpool(self.path)
        self.addCleanup(spool.close)
        return spool

    def test_media_rollback_keeps_the_sequence_and_neuters_the_payload(self):
        spool = self._spool()
        first = spool.enqueue_event(_draft("one"))
        withdrawn = spool.enqueue_event(_media("abandoned"))
        last = spool.enqueue_event(_draft("two"))

        self.assertEqual(spool.begin_media_cleanup(["abandoned"]), [withdrawn["sequence"]])

        frames = spool.pending_events(10, 1_000_000)
        self.assertEqual(
            [frame["sequence"] for frame in frames],
            [first["sequence"], withdrawn["sequence"], last["sequence"]],
            "a withdrawn media row must keep its number or the stream can never pass it",
        )
        placeholder = frames[1]
        self.assertEqual(placeholder["event"], {"kind": "presence", "state": "online"})
        self.assertEqual(placeholder["eventId"], withdrawn["eventId"])

    def test_a_withdrawn_row_reports_its_new_byte_count(self):
        spool = self._spool()
        frame = spool.enqueue_event(_media("abandoned"))
        spool.begin_media_cleanup(["abandoned"])
        stored = spool._db.execute(
            "SELECT byte_count, frame_json FROM event_outbox WHERE sequence = ?", (frame["sequence"],)
        ).fetchone()
        self.assertEqual(int(stored[0]), len(str(stored[1]).encode("utf-8")))

    def test_healing_fills_only_absent_sequences_the_spool_already_issued(self):
        spool = self._spool()
        for turn in ("one", "two", "three"):
            spool.enqueue_event(_draft(turn))
        with spool._db:
            spool._db.execute("DELETE FROM event_outbox WHERE sequence = 2")

        self.assertEqual(spool.heal_event_gap(1), [2])
        self.assertEqual([frame["sequence"] for frame in spool.pending_events(10, 1_000_000)], [1, 2, 3])
        self.assertEqual(spool.pending_events(10, 1_000_000)[1]["event"]["kind"], "presence")
        # Idempotent: the row is present now, so a repeated gap heals nothing.
        self.assertEqual(spool.heal_event_gap(1), [])

    def test_healing_never_invents_sequences_beyond_the_issued_tail(self):
        spool = self._spool()
        spool.enqueue_event(_draft("one"))
        self.assertEqual(spool.heal_event_gap(1), [])
        self.assertEqual(spool.heal_event_gap(9_000), [])

    def test_healing_is_bounded(self):
        spool = self._spool()
        for index in range(MAX_HEALED_SEQUENCE_HOLES + 20):
            spool.enqueue_event(_draft(f"turn-{index}"))
        with spool._db:
            spool._db.execute("DELETE FROM event_outbox")
        healed = spool.heal_event_gap(0)
        self.assertEqual(len(healed), MAX_HEALED_SEQUENCE_HOLES)
        self.assertEqual(healed[0], 1)


class GatewaySequenceHoleTests(unittest.IsolatedAsyncioTestCase):
    """The same two facts, proven against a gateway that enforces the real admission rule."""

    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gateway = FakeGateway(enforce_event_sequence=True)
        await self.gateway.start()
        self.addAsyncCleanup(self.gateway.stop)

    async def _attach(self, spool: AttachSpool) -> AttachV1Client:
        ready = []
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token=self.gateway.token,
            spool=spool, on_ready=lambda: ready.append(True),
        ))
        await client.connect()
        watcher = asyncio.get_running_loop().create_task(client.watch())
        self.addAsyncCleanup(self._shutdown, client, watcher)
        await self.gateway.wait_for(lambda: ready, what="hello_ack")
        return client

    async def _shutdown(self, client, watcher):
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best effort
            pass
        await client.close()

    def _spool(self, name: str) -> AttachSpool:
        spool = AttachSpool(os.path.join(self.tmp.name, name))
        self.addCleanup(spool.close)
        return spool

    async def test_a_rollback_mid_stream_does_not_stop_the_events_after_it(self):
        spool = self._spool("rollback.sqlite")
        spool.enqueue_event(_draft("one"))
        spool.enqueue_event(_media("abandoned"))
        spool.enqueue_event(_draft("two"))
        # The occurrence is abandoned while the socket is down, so the withdrawal is the only
        # thing that has ever touched this row: exactly the shape that used to leave a hole.
        spool.begin_media_cleanup(["abandoned"])

        client = await self._attach(spool)
        await client.send_draft("thread", "three", [])
        await self.gateway.wait_for(
            lambda: self.gateway.admitted_event_cursor >= 4, what="every event admitted",
        )
        self.assertEqual(self.gateway.gaps_sent, [])
        self.assertEqual(self.gateway.event_kinds, ["draft", "presence", "draft", "draft"])
        self.assertEqual(spool.pending_events(10, 1_000_000), [])

    async def test_an_existing_durable_hole_heals_itself_on_the_first_gap(self):
        spool = self._spool("wedged.sqlite")
        for turn in ("one", "two", "three"):
            spool.enqueue_event(_draft(turn))
        # The damage a pre-fix rollback left behind, and what cleo's spool looked like tonight.
        with spool._db:
            spool._db.execute("DELETE FROM event_outbox WHERE sequence = 2")

        with self.assertLogs("cozygateway.attach_client_v1", level=logging.WARNING) as logs:
            await self._attach(spool)
            await self.gateway.wait_for(
                lambda: self.gateway.admitted_event_cursor >= 3, what="the stream past the hole",
            )
        self.assertEqual(self.gateway.gaps_sent, [3])
        self.assertTrue(any("healed durable event sequence hole at 2" in line for line in logs.output))
        self.assertEqual(spool.pending_events(10, 1_000_000), [])


if __name__ == "__main__":
    unittest.main()

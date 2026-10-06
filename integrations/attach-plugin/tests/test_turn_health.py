"""Heartbeat delivery health for turns that a durable spool has already sealed."""

import json
import os
import tempfile
import unittest

from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


class _Socket:
    def __init__(self):
        self.sent = []

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def close(self):
        return None


class TurnHealthTests(unittest.IsolatedAsyncioTestCase):
    async def _client(self, spool, active_turns):
        socket = _Socket()

        async def connect_factory(_url, _headers, _ssl):
            return socket

        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=spool,
            active_turns=active_turns, connect_factory=connect_factory,
        ))
        await client.connect()
        return client, socket

    async def _negotiate(self, client, version=78):
        await client._dispatch_inbound(json.dumps({
            "kind": "hello_ack", "capabilities": ["draft"],
            "resume": {"eventSequence": 0, "commandSequence": 0},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4_194_304},
            "extensions": {"com.cozylabs.bots": version},
        }))

    async def _heartbeat(self, client):
        await client._dispatch_inbound(json.dumps({"kind": "heartbeat", "sentAt": 123}))

    async def test_healthy_active_turn_is_open(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            client, socket = await self._client(spool, lambda: ["x" * 257, "live-turn"])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client)

            await self._heartbeat(client)

            self.assertEqual(socket.sent[-1]["turnHealth"], [{
                "turnId": "live-turn", "execution": "active", "delivery": "open",
                "rejectedEvents": 0,
            }])

    async def test_active_sealed_turn_is_visible_even_without_a_rejected_event(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            terminal = spool.enqueue_event({
                "kind": "cancelled", "threadId": "thread", "turnId": "still-active", "messageId": "m",
            })
            client, socket = await self._client(spool, lambda: ["still-active"])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client)

            await self._heartbeat(client)

            self.assertEqual(socket.sent[-1]["turnHealth"], [{
                "turnId": "still-active", "execution": "active", "delivery": "sealed",
                "terminalEventId": terminal["eventId"], "rejectedEvents": 0,
            }])

    async def test_final_and_cancelled_turns_report_their_exact_durable_terminal_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            final = spool.enqueue_event({
                "kind": "commit", "threadId": "thread", "turnId": "final", "messageId": "m", "blocks": [],
            })
            cancelled = spool.enqueue_event({
                "kind": "cancelled", "threadId": "thread", "turnId": "cancelled", "messageId": "n",
            })
            client, socket = await self._client(spool, lambda: ["final", "cancelled"])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client)

            await self._heartbeat(client)

            self.assertEqual(socket.sent[-1]["turnHealth"], [{
                "turnId": "final", "execution": "active", "delivery": "sealed",
                "terminalEventId": final["eventId"], "rejectedEvents": 0,
            }, {
                "turnId": "cancelled", "execution": "active", "delivery": "sealed",
                "terminalEventId": cancelled["eventId"], "rejectedEvents": 0,
            }])

    async def test_interim_fault_seal_reports_next_rejected_event_while_live_and_outbox_empty(self):
        """Regression for an old interim commit that sealed a still-running Hermes turn."""
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            client, socket = await self._client(spool, lambda: ["running-turn"])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client)

            # The fixed source writes an interim commit with ``continues=True``.  Fault-inject
            # the old spool defect by adding the terminal row that old code wrote for that exact
            # event.  The gateway ACK has already emptied the durable outbox, but the next
            # model/tool event is rejected locally by the erroneous terminal fence.
            terminal = spool.enqueue_event({
                "kind": "commit", "threadId": "thread", "turnId": "running-turn", "messageId": "interim",
                "blocks": [], "continues": True,
            })
            self.assertTrue(terminal["event"]["continues"])
            with spool._db:
                spool._db.execute(
                    "INSERT INTO turn_terminals (turn_id, event_id, terminal_kind) VALUES (?, ?, ?)",
                    ("running-turn", terminal["eventId"], "commit"),
                )
            self.assertTrue(spool.ack_event(terminal["sequence"], terminal["eventId"]))
            self.assertEqual(spool.pending_events(10, 100_000), [])
            await client.send_draft("thread", "running-turn", [{"type": "paragraph", "text": "later"}])

            await self._heartbeat(client)

            self.assertTrue(client._negotiated)
            self.assertEqual(spool.pending_events(10, 100_000), [])
            self.assertEqual(socket.sent[-1]["turnHealth"], [{
                "turnId": "running-turn", "execution": "active", "delivery": "sealed",
                "terminalEventId": terminal["eventId"], "rejectedEvents": 1,
            }])

    async def test_legacy_extension_omits_turn_health(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            client, socket = await self._client(spool, lambda: ["live-turn"])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client, version=77)

            await self._heartbeat(client)

            self.assertNotIn("turnHealth", socket.sent[-1])

    async def test_missing_or_failing_active_callback_omits_health_without_a_rejection(self):
        def fails():
            raise RuntimeError("callback unavailable")

        for active_turns in (None, fails):
            with self.subTest(active_turns=active_turns):
                with tempfile.TemporaryDirectory() as directory:
                    spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
                    client, socket = await self._client(spool, active_turns)
                    try:
                        await self._negotiate(client)
                        await self._heartbeat(client)
                        self.assertNotIn("turnHealth", socket.sent[-1])
                    finally:
                        await client.close()
                        spool.close()

    async def test_malformed_active_callback_reports_remembered_seal_as_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            terminal = spool.enqueue_event({
                "kind": "cancelled", "threadId": "thread", "turnId": "lost-turn", "messageId": "m",
            })
            client, socket = await self._client(spool, lambda: {"not": "a turn list"})
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)
            await self._negotiate(client)
            await client._queue_event({"kind": "draft", "threadId": "thread", "turnId": "lost-turn", "blocks": []})

            await self._heartbeat(client)

            self.assertEqual(socket.sent[-1]["turnHealth"], [{
                "turnId": "lost-turn", "execution": "unknown", "delivery": "sealed",
                "terminalEventId": terminal["eventId"], "rejectedEvents": 1,
            }])

    async def test_rejection_memory_and_counters_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            client, _socket = await self._client(spool, lambda: [])
            self.addAsyncCleanup(client.close)
            self.addCleanup(spool.close)

            for number in range(300):
                client._remember_terminal_rejection({"turnId": f"turn-{number}"})
            self.assertEqual(len(client._terminal_rejections), 256)
            self.assertNotIn("turn-0", client._terminal_rejections)
            self.assertIn("turn-299", client._terminal_rejections)

            client._terminal_rejections["turn-299"] = 1_000_000
            client._remember_terminal_rejection({"turnId": "turn-299"})
            self.assertEqual(client._terminal_rejections["turn-299"], 1_000_000)

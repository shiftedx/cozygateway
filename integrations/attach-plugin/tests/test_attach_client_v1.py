import json
import os
import tempfile
import unittest

from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.close_code = None
    async def send(self, value):
        self.sent.append(json.loads(value))
    async def close(self):
        pass


class AttachV1ClientTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.spool = AttachSpool(os.path.join(self.tmp.name, "spool.sqlite"))
        self.socket = FakeSocket()

        async def connect_factory(url, headers, ssl_ctx):
            self.assertTrue(url.endswith("/attach/v1"))
            self.assertEqual(headers["Authorization"], "Bearer secret")
            return self.socket

        self.turns = []
        self.clarifications = []
        self.client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            on_turn=self.turns.append, connect_factory=connect_factory,
            on_clarify=self.clarifications.append,
        ))

    async def asyncTearDown(self):
        await self.client.close()
        self.spool.close()
        self.tmp.cleanup()

    async def test_hello_carries_durable_identity_and_resume_cursors(self):
        await self.client.connect()
        self.assertEqual(self.socket.sent[0]["kind"], "hello")
        self.assertEqual(self.socket.sent[0]["version"], 1)
        self.assertEqual(self.socket.sent[0]["instanceId"], self.spool.instance_id)
        self.assertEqual(self.socket.sent[0]["resume"], {"eventSequence": 0, "commandSequence": 0})

    async def test_unacked_event_reuses_id_and_sequence_after_reconnect(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        await self.client.send_draft("t", "u", [])
        first = self.socket.sent[-1]
        self.assertEqual((first["kind"], first["sequence"]), ("event", 1))
        replacement = FakeSocket()
        self.socket = replacement
        self.client._ws = replacement
        await self.client.replay()
        self.assertEqual(replacement.sent[0], first)
        await self.client._dispatch_inbound(json.dumps({"kind": "ack", "channel": "event", "sequence": 1, "id": first["eventId"]}))
        self.assertEqual(self.spool.pending_events(10, 100000), [])

    async def test_command_is_persisted_before_ack_and_dispatched_once(self):
        await self.client.connect()
        frame = {"kind": "command", "sequence": 1, "commandId": "c1", "command": {"kind": "turn", "threadId": "t", "turnId": "u", "messageId": "m", "text": "hi"}}
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual([turn.text for turn in self.turns], ["hi"])
        self.assertEqual(self.socket.sent[-1], {"kind": "ack", "channel": "command", "sequence": 1, "id": "c1"})
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual([turn.text for turn in self.turns], ["hi"])
        self.assertTrue(self.socket.sent[-1]["duplicate"])

    async def test_discard_advances_sequence_without_executing_unsupported_action(self):
        approvals = []
        self.client._config.on_approval = approvals.append
        await self.client.connect()
        discard = {"kind": "command", "sequence": 1, "commandId": "cancelled-approval", "command": {"kind": "discard", "originalKind": "resolve_approval", "reason": "capability not negotiated: approvals"}}
        turn = {"kind": "command", "sequence": 2, "commandId": "turn-after", "command": {"kind": "turn", "threadId": "t", "turnId": "u2", "messageId": "m2", "text": "still runs"}}
        await self.client._dispatch_inbound(json.dumps(discard))
        await self.client._dispatch_inbound(json.dumps(turn))
        self.assertEqual(approvals, [])
        self.assertEqual([item.text for item in self.turns], ["still runs"])
        self.assertEqual(self.spool.command_cursor, 2)
        self.assertEqual(self.spool.pending_commands(), [])

    async def test_clarify_resolution_preserves_stable_ids(self):
        await self.client.connect()
        frame = {"kind": "command", "sequence": 1, "commandId": "clarify-command", "command": {"kind": "resolve_clarify", "threadId": "t", "turnId": "u", "clarifyId": "question-1", "optionId": "answer-a"}}
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual(self.clarifications, [frame["command"]])
        self.assertEqual(self.socket.sent[-1], {"kind": "ack", "channel": "command", "sequence": 1, "id": "clarify-command"})

    async def test_async_resolution_finishes_before_command_is_marked_processed(self):
        completed = []

        async def resolve(command):
            await __import__("asyncio").sleep(0)
            completed.append(command["clarifyId"])

        self.client._config.on_clarify = resolve
        await self.client.connect()
        frame = {"kind": "command", "sequence": 1, "commandId": "clarify-command", "command": {"kind": "resolve_clarify", "threadId": "t", "turnId": "u", "clarifyId": "question-1", "optionId": "option-1"}}
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual(completed, ["question-1"])
        self.assertEqual(self.spool.pending_commands(), [])

    async def test_commit_carries_only_media_ids_not_bytes_or_paths(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft", "media"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        await self.client.send_done("t", "u", media_ids=["a" * 32])
        event = self.socket.sent[-1]["event"]
        self.assertEqual(event["mediaIds"], ["a" * 32])
        self.assertNotIn("bytes", json.dumps(event))

    async def test_live_events_pause_at_negotiated_count_and_refill_on_ack(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 2, "maxInFlightBytes": 4194304}}))
        for index in range(4):
            await self.client.send_draft("t", f"u-{index}", [])
        events = [frame for frame in self.socket.sent if frame.get("kind") == "event"]
        self.assertEqual([frame["sequence"] for frame in events], [1, 2])
        await self.client._dispatch_inbound(json.dumps({"kind": "ack", "channel": "event", "sequence": 1, "id": events[0]["eventId"]}))
        events = [frame for frame in self.socket.sent if frame.get("kind") == "event"]
        self.assertEqual([frame["sequence"] for frame in events], [1, 2, 3])

    async def test_ack_for_an_unsent_queued_event_cannot_drop_it(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 1, "maxInFlightBytes": 4194304}}))
        await self.client.send_draft("t", "u-1", [])
        second = await self.client._queue_event({"kind": "draft", "threadId": "t", "turnId": "u-2", "blocks": []})
        await self.client._dispatch_inbound(json.dumps({"kind": "ack", "channel": "event", "sequence": second["sequence"], "id": second["eventId"]}))
        self.assertEqual([frame["sequence"] for frame in self.spool.pending_events(10, 100000)], [1, 2])

    async def test_live_events_pause_at_negotiated_byte_budget(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 10, "maxInFlightBytes": 1024}}))
        blocks = [{"type": "paragraph", "text": "x" * 650}]
        await self.client.send_draft("t", "u-1", blocks)
        await self.client.send_draft("t", "u-2", blocks)
        events = [frame for frame in self.socket.sent if frame.get("kind") == "event"]
        self.assertEqual([frame["sequence"] for frame in events], [1])

    async def test_negotiated_capabilities_suppress_disabled_features(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        result = await self.client._queue_event({"kind": "scheduled", "threadId": "home", "deliveryId": "d", "messageId": "m", "blocks": []})
        self.assertIsNone(result)
        self.assertEqual(self.spool.pending_events(10, 100000), [])


if __name__ == "__main__":
    unittest.main()

import json
import os
import sys
import tempfile
import types
import unittest

# The health gate runs in the plugin's stdlib-only test environment. The real websocket client is
# lazy; this tiny import shim only makes the two client modules importable when the optional runtime
# dependency is absent.
try:
    import websockets.exceptions  # type: ignore[import-not-found]  # noqa: F401
except ModuleNotFoundError:
    websocket_exceptions = types.ModuleType("websockets.exceptions")
    websocket_exceptions.ConnectionClosed = RuntimeError
    websockets = types.ModuleType("websockets")
    websockets.exceptions = websocket_exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = websocket_exceptions

from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send(self, value):
        self.sent.append(json.loads(value))


class AttachV1FederatedHealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_durable_spool_snapshot_tracks_backlog_ack_progress_and_command_inbox(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            now = [1_000]
            spool = AttachSpool(path, now_ms=lambda: now[0])
            first = spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []})
            now[0] = 1_200
            spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "v", "blocks": []})
            self.assertEqual(spool.accept_command({
                "kind": "command", "sequence": 1, "commandId": "command-secret",
                "command": {"kind": "turn", "threadId": "t", "turnId": "u", "messageId": "m", "text": "private command"},
            }), "accepted")

            now[0] = 1_500
            self.assertEqual(spool.health_snapshot(), {
                "eventOutboxDepth": 2,
                "oldestEventAgeMs": 500,
                "eventAckCursor": 0,
                "commandInboxDepth": 1,
            })

            self.assertTrue(spool.ack_event(first["sequence"], first["eventId"]))
            now[0] = 1_700
            after_first_ack = spool.health_snapshot()
            self.assertEqual(after_first_ack["eventAckCursor"], 1)
            self.assertEqual(after_first_ack["oldestEventAgeMs"], 500)

            now[0] = 2_000
            self.assertFalse(spool.ack_event(first["sequence"], first["eventId"]))
            after_duplicate_ack = spool.health_snapshot()
            self.assertEqual(after_duplicate_ack["oldestEventAgeMs"], 800)
            self.assertNotIn(first["eventId"], json.dumps(after_duplicate_ack))
            self.assertNotIn("command-secret", json.dumps(after_duplicate_ack))
            self.assertNotIn("private command", json.dumps(after_duplicate_ack))
            spool.mark_command_processed("command-secret")
            after_processed = spool.health_snapshot()
            self.assertEqual(after_processed["commandInboxDepth"], 0)
            spool.close()

            reopened = AttachSpool(path, now_ms=lambda: now[0])
            self.assertEqual(reopened.health_snapshot(), after_processed)
            reopened.close()

    async def test_hello_and_heartbeat_carry_only_bounded_spool_telemetry(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            queued = spool.enqueue_event({
                "kind": "draft", "threadId": "thread-secret", "turnId": "turn-secret",
                "blocks": [{"type": "paragraph", "text": "private payload"}],
            })
            socket = FakeSocket()

            async def connect_factory(_url, _headers, _ssl):
                return socket

            client = AttachV1Client(AttachV1ClientConfig(
                gateway_url="http://gateway.example", token="secret", spool=spool,
                connect_factory=connect_factory,
            ))
            await client.connect()
            hello = socket.sent[0]
            self.assertEqual(hello["kind"], "hello")
            self.assertEqual(set(hello["telemetry"]), {
                "eventOutboxDepth", "oldestEventAgeMs", "eventAckCursor",
                "commandInboxDepth",
            })
            self.assertEqual(hello["telemetry"]["eventOutboxDepth"], 1)
            self.assertNotIn(queued["eventId"], json.dumps(hello["telemetry"]))
            self.assertNotIn("private payload", json.dumps(hello["telemetry"]))

            await client._dispatch_inbound(json.dumps({"kind": "heartbeat", "sentAt": 1}))
            heartbeat = socket.sent[-1]
            self.assertEqual(heartbeat["kind"], "heartbeat")
            self.assertEqual(heartbeat["sentAt"], 1)
            self.assertEqual(set(heartbeat["telemetry"]), set(hello["telemetry"]))
            self.assertNotIn(queued["eventId"], json.dumps(heartbeat["telemetry"]))
            spool.close()

    async def test_old_spool_age_is_clamped_to_the_v2_telemetry_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            now = [8 * 24 * 60 * 60 * 1_000]
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"), now_ms=lambda: now[0])
            spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []})
            now[0] += 8 * 24 * 60 * 60 * 1_000
            self.assertEqual(spool.health_snapshot()["oldestEventAgeMs"], 7 * 24 * 60 * 60 * 1_000)
            spool.close()

    async def test_telemetry_rides_every_hello_and_heartbeat(self):
        """There is no reduced hello, so telemetry is never conditional on a negotiated version."""
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            socket = FakeSocket()

            async def connect_factory(_url, _headers, _ssl):
                return socket

            client = AttachV1Client(AttachV1ClientConfig(
                gateway_url="http://gateway.example", token="secret", spool=spool,
                connect_factory=connect_factory,
            ))
            await client._open()
            self.assertEqual(socket.sent[0]["version"], 2)
            self.assertIn("telemetry", socket.sent[0])
            await client._dispatch_inbound(json.dumps({"kind": "heartbeat", "sentAt": 1}))
            self.assertIn("telemetry", socket.sent[-1])
            spool.close()

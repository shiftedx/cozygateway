import hashlib
import json
import os
import tempfile
import unittest
from unittest.mock import mock_open, patch

from websockets.exceptions import ConnectionClosedError
from websockets.frames import Close

from cozygateway.attach_client_v1 import (
    AttachV1Client, AttachV1ClientConfig, HELLO_CAPABILITIES, HELLO_VERSION,
    _HashingReader, _is_device_status,
)
from cozygateway.attach_client import ToolChip
from cozygateway.attach_spool import AttachSpool


GATEWAY_STATUS = {
    "appState": "background", "batteryBand": "low", "lowPowerMode": True,
    "thermalState": "serious", "networkClass": "cellular",
    "capabilities": [
        {"command": "device.status", "permission": "not_required"},
        {"command": "location.current", "permission": "authorized"},
        {"command": "camera.capture", "permission": "authorized"},
        {"command": "file.pick", "permission": "not_required"},
        {"command": "notification.present", "permission": "not_required"},
    ],
    "wakeReason": "notification", "authenticatedReachable": True,
    "lastAuthenticatedPresenceAt": 1234,
}


class FakeSocket:
    def __init__(self):
        self.sent = []
        self.close_code = None
        self.inbound = __import__("asyncio").Queue()
    async def send(self, value):
        self.sent.append(json.loads(value))
    async def close(self):
        self.inbound.put_nowait(None)
    def __aiter__(self):
        return self
    async def __anext__(self):
        value = await self.inbound.get()
        if value is None:
            raise StopAsyncIteration
        if isinstance(value, BaseException):
            raise value
        return value


class FakeHTTPResponse:
    def __enter__(self):
        return self
    def __exit__(self, *_args):
        return None
    def read(self):
        return b'{"media":{"mediaId":"m"}}'


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

    def _movie(self, payload):
        """A real file on disk: the upload path streams from it rather than a buffer."""
        path = os.path.join(self.tmp.name, "movie.mp4")
        with open(path, "wb") as handle:
            handle.write(payload)
        return path

    async def asyncTearDown(self):
        await self.client.close()
        self.spool.close()
        self.tmp.cleanup()

    async def test_hello_carries_durable_identity_and_resume_cursors(self):
        self.client._config.commands = [
            {"name": "/status", "description": "Show session status", "category": "Session"},
            {"name": "/queue", "description": "Queue the next prompt", "argsHint": "<prompt>"},
        ]
        await self.client.connect()
        self.assertEqual(self.socket.sent[0]["kind"], "hello")
        self.assertEqual(self.socket.sent[0]["version"], 2)
        self.assertEqual(self.socket.sent[0]["instanceId"], self.spool.instance_id)
        self.assertEqual(self.socket.sent[0]["resume"], {"eventSequence": 0, "commandSequence": 0})
        self.assertIn("mobile_node", self.socket.sent[0]["capabilities"])
        self.assertIn("mobile_location", self.socket.sent[0]["capabilities"])
        self.assertEqual(self.socket.sent[0]["commands"], self.client._config.commands)

    async def test_hello_carries_an_explicit_empty_catalog_to_clear_stale_discovery(self):
        await self.client.connect()
        self.assertEqual(self.socket.sent[0]["commands"], [])

    async def test_reconnect_refreshes_a_rotated_credential(self):
        tokens = ["old-token"]
        headers = []

        async def connect_factory(_url, request_headers, _ssl):
            headers.append(request_headers["Authorization"])
            return FakeSocket()

        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example",
            token="bootstrap-token",
            token_provider=lambda: tokens[0],
            spool=self.spool,
            connect_factory=connect_factory,
        ))
        await client.connect()
        await client.close()
        tokens[0] = "rotated-token"
        await client.connect()
        await client.close()

        self.assertEqual(headers, ["Bearer old-token", "Bearer rotated-token"])

    async def test_ready_callback_requires_an_accepted_hello(self):
        ready = []
        self.client._config.on_ready = lambda: ready.append(True)
        await self.client.connect()
        self.assertEqual(ready, [])

        await self.client._dispatch_inbound(json.dumps({
            "kind": "hello_ack",
            "capabilities": ["draft"],
            "resume": {"eventSequence": 0, "commandSequence": 0},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))

        self.assertEqual(ready, [True])

    async def test_restored_events_drain_only_after_transport_is_marked_ready(self):
        sent_counts_at_ready = []
        self.client._config.on_ready = lambda: sent_counts_at_ready.append(
            len(self.socket.sent)
        )
        await self.client.connect()
        await self.client.send_draft("thread", "turn", [])
        self.assertEqual(len(self.socket.sent), 1)

        await self.client._dispatch_inbound(json.dumps({
            "kind": "hello_ack",
            "capabilities": ["draft"],
            "resume": {"eventSequence": 0, "commandSequence": 0},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))

        self.assertEqual(sent_counts_at_ready, [1])
        self.assertEqual(self.socket.sent[-1]["kind"], "event")

    async def test_send_delegation_carries_optional_alias_id(self):
        await self.client.send_delegation(
            "thread", "turn", "call_d3R3", "sa-0", index=0, count=1,
            status="succeeded", last_active_at=6, alias_id="deleg_c6eb9310",
        )
        await self.client.send_delegation(
            "thread", "turn", "call_d3R3", "sa-1", index=1, count=2,
            status="running", last_active_at=7,
        )
        events = [frame["event"] for frame in self.spool.pending_events(10, 100_000)]
        self.assertEqual(events[0]["aliasId"], "deleg_c6eb9310")
        self.assertEqual(events[0]["batchId"], "call_d3R3")
        # Alias-absent events keep the exact historical shape.
        self.assertNotIn("aliasId", events[1])

    async def test_send_delegation_bounds_structured_terminal_enrichment(self):
        await self.client.send_delegation(
            "thread", "turn", "call", "sa-0", index=0, count=1,
            status="failed", last_active_at=8, cost_usd=0.125,
            cost_status="reported", schema_validation={"valid": False, "retries": 1},
            duration_ms=2345,
        )
        event = self.spool.pending_events(10, 100_000)[0]["event"]
        self.assertEqual(event["costUsd"], 0.125)
        self.assertEqual(event["costStatus"], "reported")
        self.assertEqual(event["schemaValidation"], {"valid": False, "retries": 1})
        self.assertEqual(event["durationMs"], 2345)

    async def test_repeated_draft_snapshot_emits_only_tool_lifecycle_changes(self):
        chip = ToolChip(id="call-1", name="search", status="running")

        await self.client.send_draft("thread", "turn", [], [chip])
        await self.client.send_draft("thread", "turn", [], [chip])

        events = [
            frame["event"]
            for frame in self.spool.pending_events(10, 100_000)
        ]
        self.assertEqual([event["kind"] for event in events], ["draft", "tool", "draft"])

    async def test_captured_workload_shape_stays_linear_in_tool_calls(self):
        # Sanitized shape of the Cleo incident: 564 cumulative snapshots containing 80,430
        # tool entries and reaching 283 distinct calls. The old implementation journaled every
        # entry; lifecycle deltas keep the same UI state without the quadratic outbox growth.
        snapshot_sizes = [1] + [142] * 559 + [202, 283, 283, 283]
        self.assertEqual((len(snapshot_sizes), sum(snapshot_sizes), max(snapshot_sizes)), (564, 80_430, 283))

        chips = [ToolChip(id=f"call-{index}", name="tool", status="running") for index in range(283)]
        for size in snapshot_sizes:
            await self.client.send_draft("thread", "turn", [], chips[:size])

        events = self.spool.pending_events(1_000, 10_000_000)
        kinds = [frame["event"]["kind"] for frame in events]
        self.assertEqual((kinds.count("draft"), kinds.count("tool")), (564, 283))

    async def test_hello_ack_recovers_a_recreated_empty_spool_from_server_cursors(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({
            "kind": "hello_ack",
            "capabilities": ["draft"],
            "resume": {"eventSequence": 2244, "commandSequence": 5},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))
        command = {
            "kind": "command",
            "sequence": 6,
            "commandId": "c6",
            "command": {"kind": "turn", "threadId": "t", "turnId": "u", "messageId": "m", "text": "hi"},
        }
        await self.client._dispatch_inbound(json.dumps(command))
        self.assertEqual(self.spool.command_cursor, 6)
        self.assertEqual([turn.text for turn in self.turns], ["hi"])
        self.assertEqual(self.socket.sent[-1], {"kind": "ack", "channel": "command", "sequence": 6, "id": "c6"})

        await self.client.send_draft("t", "u", [])
        self.assertEqual(self.socket.sent[-1]["sequence"], 2245)

    async def test_stalled_handshake_retries_the_same_hello_and_never_downgrades(self):
        """Regression: a stalled hello_ack used to downgrade the connection to a smaller hello.

        The downgrade removed ``mobile_location`` and ``memory_management`` for the life of the
        connection and said nothing, so every surface built on them failed with an "unavailable"
        that named no cause. There is one hello now: a retry re-sends the identical shape, and
        the reason is a warning so the stall itself is still visible.
        """
        first, second = FakeSocket(), FakeSocket()
        sockets = iter([first, second])

        async def slow_server_factory(_url, _headers, _ssl):
            return next(sockets)

        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            connect_factory=slow_server_factory,
        ))
        await second.inbound.put(json.dumps({
            "kind": "hello_ack", "version": 2, "agentId": "sage",
            "capabilities": list(HELLO_CAPABILITIES),
            "resume": {"eventSequence": 0, "commandSequence": 0},
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}, "heartbeatIntervalMs": 15000,
        }))
        with patch("cozygateway.attach_client_v1.HELLO_ACK_TIMEOUT_SECONDS", 0.001):
            await client.connect()
            with self.assertLogs("cozygateway.attach_client_v1", level="INFO") as captured:
                watcher = __import__("asyncio").create_task(client.watch())
                for _ in range(50):
                    if client._negotiated:
                        break
                    await __import__("asyncio").sleep(0.001)
                self.assertTrue(client._negotiated)
            # Identical shape both times. No capability is traded away for a second chance.
            self.assertEqual(first.sent[0], second.sent[0])
            self.assertEqual(second.sent[0]["version"], 2)
            self.assertIn("mobile_location", second.sent[0]["capabilities"])
            self.assertIn("memory_management", second.sent[0]["capabilities"])
            warnings = [line for line in captured.output if line.startswith("WARNING")]
            self.assertTrue(any("re-dialing with the same hello" in line for line in warnings), captured.output)
            self.assertTrue(any("no hello_ack within" in line for line in warnings), captured.output)
            # The negotiated set is recorded too, so "which capabilities does this bot actually
            # have" is answerable from the Hermes log alone.
            self.assertTrue(any("negotiated hello v2" in line for line in captured.output), captured.output)
            await client.close()
            await watcher

    async def test_pre_ack_socket_end_retries_the_same_hello(self):
        first, second = FakeSocket(), FakeSocket()
        sockets = iter([first, second])

        async def flaky_server_factory(_url, _headers, _ssl):
            return next(sockets)

        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            connect_factory=flaky_server_factory,
        ))
        await first.close()
        await second.inbound.put(json.dumps({
            "kind": "hello_ack", "version": 2, "capabilities": list(HELLO_CAPABILITIES),
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))
        await client.connect()
        watcher = __import__("asyncio").create_task(client.watch())
        for _ in range(20):
            if client._negotiated:
                break
            await __import__("asyncio").sleep(0.001)
        self.assertTrue(client._negotiated)
        self.assertEqual(first.sent[0], second.sent[0])
        await client.close()
        await watcher

    async def test_refused_hello_is_reported_not_retried_into_a_smaller_one(self):
        """A 1008 before hello_ack is the gateway rejecting this contract on purpose.

        Re-dialing the same shape cannot change that answer, and there is no smaller shape to try,
        so the refusal is logged with the gateway's own reason and left to surface.
        """
        first, second = FakeSocket(), FakeSocket()
        sockets = iter([first, second])

        async def refusing_server_factory(_url, _headers, _ssl):
            return next(sockets)

        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            connect_factory=refusing_server_factory,
        ))
        await first.inbound.put(ConnectionClosedError(Close(1008, "attach-v1 invalid hello frame"), None, None))
        await client.connect()
        with self.assertLogs("cozygateway.attach_client_v1", level="INFO") as captured:
            await client.watch()
        self.assertTrue(any(
            line.startswith("ERROR") and "gateway refused the hello" in line and "attach-v1 invalid hello frame" in line
            for line in captured.output
        ), captured.output)
        self.assertFalse(client._negotiated)
        self.assertEqual(second.sent, [])
        await client.close()

    async def test_capability_gap_in_the_ack_is_warned_about_at_handshake_time(self):
        """Regression: the stale-code incident that started all of this.

        The plugin asked for all nine capabilities and the gateway acked a smaller set. Nothing
        recorded the gap, so the memory surface was dead for hours before anyone could name why.
        """
        await self.client.connect()
        with self.assertLogs("cozygateway.attach_client_v1", level="INFO") as captured:
            await self.client._dispatch_inbound(json.dumps({
                "kind": "hello_ack", "version": 2, "capabilities": ["draft", "media"],
                "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
            }))
        warnings = [line for line in captured.output if line.startswith("WARNING")]
        self.assertTrue(any("memory_management" in line and "stay OFF" in line for line in warnings), captured.output)

    def test_hello_is_one_shape_with_every_capability(self):
        self.assertEqual(HELLO_VERSION, 2)
        self.assertEqual(set(HELLO_CAPABILITIES), {
            "draft", "media", "tools", "approvals", "clarify", "scheduled",
            "mobile_node", "mobile_location", "mobile_media", "mobile_notifications",
            "memory_management", "memory_setup", "delivery_receipts", "delegation", "thinking",
            "desktop_session_resume", "desktop_session_sync", "cozyapps", "bot_config", "chat_configuration", "provider_connections",
        })

    async def test_provider_handoff_uses_the_attach_bearer_without_a_socket_frame(self):
        class HandoffResponse:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _limit): return b'{"name":"Local","baseUrl":"https://local.test/v1","apiKey":"secret"}'

        with patch("cozygateway.attach_client_v1.urlopen", return_value=HandoffResponse()) as opener:
            handoff = await self.client.fetch_provider_handoff("handoff id")
        self.assertEqual(handoff["apiKey"], "secret")
        request = opener.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/attach/v1/provider-handoffs/handoff%20id"))
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertFalse(any(frame["kind"] == "config_result" for frame in self.socket.sent))

    async def test_provider_transfer_posts_a_bounded_private_payload_without_redirects(self):
        class TransferResponse:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _limit): return b'{"handoffId":"handoff"}'
        class Opener:
            def __init__(self): self.request = None
            def open(self, request, timeout): self.request = request; self.timeout = timeout; return TransferResponse()
        opener = Opener()
        with patch("cozygateway.attach_client_v1.build_opener", return_value=opener):
            handoff = await self.client.transfer_provider_connection("execution", {"id":"custom-id","name":"Local","baseUrl":"https://local.test/v1","apiKey":"secret","manualModels":["model"]})
        self.assertEqual(handoff, "handoff"); self.assertEqual(opener.timeout, 5)
        self.assertTrue(opener.request.full_url.endswith("/attach/v1/provider-transfers/execution"))
        self.assertEqual(opener.request.get_header("Authorization"), "Bearer secret")
        self.assertIn(b'"apiKey":"secret"', opener.request.data)

    def test_hello_ack_budget_is_not_a_one_second_race(self):
        """Regression: the budget was 1s and named for mobile status.

        A handshake that lost that race used to be downgraded silently and permanently, so the
        budget has to be the gateway's own hello window, not a value tight enough for an ordinary
        slow boot to trip.
        """
        from cozygateway.attach_client_v1 import HELLO_ACK_TIMEOUT_SECONDS

        self.assertGreaterEqual(HELLO_ACK_TIMEOUT_SECONDS, 5)

    async def test_non_auth_policy_close_does_not_masquerade_as_token_rejection(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({
            "kind": "hello_ack", "capabilities": ["draft"],
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))
        await self.socket.inbound.put(ConnectionClosedError(Close(1008, "event sequence conflict"), None, None))
        await self.client.watch()

    async def test_unauthorized_policy_close_remains_a_terminal_auth_error(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({
            "kind": "hello_ack", "capabilities": ["draft"],
            "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304},
        }))
        await self.socket.inbound.put(ConnectionClosedError(Close(1008, "unauthorized"), None, None))
        with self.assertRaisesRegex(Exception, "rejected"):
            await self.client.watch()

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

    async def test_quarantine_ack_advances_spool_and_warns_without_payload(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        await self.client.send_draft("retired-thread", "turn", [{"type": "paragraph", "text": "private payload"}])
        event = self.socket.sent[-1]
        with self.assertLogs("cozygateway.attach_client_v1", level="WARNING") as logs:
            await self.client._dispatch_inbound(json.dumps({
                "kind": "ack", "channel": "event", "sequence": 1, "id": event["eventId"],
                "discarded": True, "reason": "unauthorized_target",
            }))
        self.assertEqual(self.spool.pending_events(10, 100000), [])
        self.assertEqual(self.spool.event_cursor, 1)
        self.assertIn("unauthorized_target", logs.output[0])
        self.assertNotIn("private payload", logs.output[0])

    async def test_command_is_persisted_before_ack_and_dispatched_once(self):
        await self.client.connect()
        frame = {"kind": "command", "sequence": 1, "commandId": "c1", "command": {"kind": "turn", "threadId": "t", "turnId": "u", "messageId": "m", "text": "hi"}}
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual([turn.text for turn in self.turns], ["hi"])
        self.assertEqual(self.socket.sent[-1], {"kind": "ack", "channel": "command", "sequence": 1, "id": "c1"})
        await self.client._dispatch_inbound(json.dumps(frame))
        self.assertEqual([turn.text for turn in self.turns], ["hi"])
        self.assertTrue(self.socket.sent[-1]["duplicate"])

    async def test_acknowledges_each_gateway_heartbeat_once(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "heartbeat", "sentAt": 10}))
        await self.client._dispatch_inbound(json.dumps({"kind": "heartbeat", "sentAt": 20}))
        heartbeats = self.socket.sent[-2:]
        self.assertEqual(
            [(frame["kind"], frame["sentAt"]) for frame in heartbeats],
            [("heartbeat", 10), ("heartbeat", 20)],
        )
        self.assertTrue(all("telemetry" in frame for frame in heartbeats))

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

    def test_media_upload_uses_an_explicit_client_user_agent(self):
        captured = []

        def open_request(request, **_kwargs):
            captured.append(request)
            return FakeHTTPResponse()

        movie = self._movie(b"video")
        with patch("cozygateway.attach_client_v1.urlopen", side_effect=open_request):
            self.client._upload_media_sync("m", movie, "video/mp4", 5, "a" * 64, None)

        self.assertEqual(captured[0].get_header("User-agent"), "CozyGateway-Attach/1.0")

    def test_rotated_credential_is_shared_by_media_and_receipt_http_requests(self):
        captured = []
        self.client._config.token_provider = lambda: "rotated-token"

        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self):
                if "/deliveries/" in captured[-1].full_url:
                    return b'{"state":"projected"}'
                return b'{"media":{"mediaId":"m"}}'

        def open_request(request, **_kwargs):
            captured.append(request)
            return Response()

        with patch("cozygateway.attach_client_v1.urlopen", side_effect=open_request):
            self.client._upload_media_sync(
                "m", self._movie(b"video"), "video/mp4", 5, "a" * 64, None
            )
            self.client._delivery_receipt_sync("delivery", 0.1)

        self.assertEqual(
            [request.get_header("Authorization") for request in captured],
            ["Bearer rotated-token", "Bearer rotated-token"],
        )

    async def test_media_upload_rejects_an_oversize_file_before_opening_it(self):
        __import__("mimetypes").guess_type("/tmp/report.png")
        with patch("cozygateway.attach_client_v1.os.stat", return_value=type("Stat", (), {"st_size": 8 * 1024 * 1024 + 1})()), \
             patch("builtins.open", mock_open()) as opened:
            with self.assertRaisesRegex(ValueError, "size cap"):
                await self.client.upload_media("m", "/private/report.png", "image")
        opened.assert_not_called()

    async def test_atomic_media_rollback_persists_then_cleans_remote_bytes_and_descriptor_event(self):
        frame = self.spool.enqueue_event({
            "kind": "media", "media": {"mediaId": "atomic-first"},
        })
        self.client._sent_events[frame["sequence"]] = 100
        self.client._sent_event_bytes = 100
        with patch.object(self.client, "_delete_media_sync") as delete:
            await self.client.rollback_uploaded_media(["atomic-first"])
        delete.assert_called_once_with("atomic-first")
        # The descriptor payload is gone but its sequence is not: the row now carries the inert
        # placeholder, because deleting it would wedge every event numbered after it.
        pending = self.spool.pending_events(10, 100_000)
        self.assertEqual([item["sequence"] for item in pending], [frame["sequence"]])
        self.assertEqual(pending[0]["event"], {"kind": "presence", "state": "online"})
        self.assertEqual(pending[0]["eventId"], frame["eventId"])
        self.assertEqual(self.spool.pending_media_cleanups(), [])
        self.assertNotIn(frame["sequence"], self.client._sent_events)
        self.assertEqual(self.client._sent_event_bytes, 0)

    async def test_reconnect_retries_durable_atomic_media_cleanup(self):
        self.spool.begin_media_cleanup(["cleanup-after-crash"])
        with patch.object(self.client, "_delete_media_sync") as delete:
            await self.client.connect()
        delete.assert_called_once_with("cleanup-after-crash")
        self.assertEqual(self.spool.pending_media_cleanups(), [])

    def test_media_upload_streams_no_more_than_the_declared_byte_count(self):
        """A file that grew after it was measured cannot outrun its Content-Length.

        The declared length is what the cap was checked against and what frames the
        request, so the body reader stops there however many bytes are on disk.
        """
        movie = self._movie(b"x" * 4096)
        with open(movie, "rb") as handle:
            body = _HashingReader(handle, 5)
            streamed = b"".join(iter(lambda: body.read(4096), b""))
        self.assertEqual(streamed, b"xxxxx")
        self.assertEqual(body.hexdigest(), hashlib.sha256(b"xxxxx").hexdigest())

    async def test_media_download_defaults_to_the_gateway_audio_video_cap(self):
        with patch.object(self.client, "_download_media_sync", return_value=(b"movie", "movie.mp4", "video/mp4")) as download:
            await self.client.download_media("movie")
        download.assert_called_once_with("movie", 40 * 1024 * 1024)

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

    async def test_device_status_is_ephemeral_and_settles_once(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft", "mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        request = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "  Report   phone readiness "))
        await __import__("asyncio").sleep(0)
        frame = self.socket.sent[-1]
        self.assertEqual(frame["kind"], "mobile_request")
        self.assertEqual(frame["command"], "device.status")
        self.assertEqual(frame["purpose"], "Report phone readiness")
        self.assertEqual(self.spool.pending_events(10, 100000), [])
        await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": frame["requestId"], "status": "ok", "result": GATEWAY_STATUS}))
        self.assertEqual(await request, {"status": "ok", "result": GATEWAY_STATUS})
        await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": frame["requestId"], "status": "denied"}))

    async def test_mobile_deadline_fits_gateway_budget_with_subsecond_clock_lead(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node", "mobile_location", "mobile_media"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        for command, budget_ms in (("device.status", 30_000), ("location.current", 30_000), ("camera.capture", 120_000)):
            for clock_lead in (0.002, 0.5):
                with self.subTest(command=command, clock_lead=clock_lead):
                    with patch("cozygateway.attach_client_v1.time.time", return_value=1000 + clock_lead):
                        request = __import__("asyncio").create_task(self.client._request_mobile(command, "thread", "turn", "Test clock budget"))
                        await __import__("asyncio").sleep(0)
                    frame = self.socket.sent[-1]
                    request.cancel()
                    self.assertEqual(await request, {"status": "cancelled"})
                    self.assertGreater(frame["expiresAt"], 1_000_000)
                    self.assertLessEqual(frame["expiresAt"], 1_000_000 + budget_ms)

    async def test_mobile_failures_are_closed_and_preserved(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        request = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
        await __import__("asyncio").sleep(0)
        request_id = self.socket.sent[-1]["requestId"]
        await self.client._dispatch_inbound(json.dumps({
            "kind": "mobile_result", "requestId": request_id, "status": "device_unavailable",
            "stage": "dispatch", "reason": "frame_send_failed",
        }))
        self.assertEqual(await request, {
            "status": "device_unavailable", "stage": "dispatch", "reason": "frame_send_failed",
        })

        for stage, reason in (("secret-stage", "frame_send_failed"), ("dispatch", "secret-reason")):
            pending = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
            await __import__("asyncio").sleep(0)
            request_id = self.socket.sent[-1]["requestId"]
            await self.client._dispatch_inbound(json.dumps({
                "kind": "mobile_result", "requestId": request_id, "status": "device_unavailable",
                "stage": stage, "reason": reason,
            }))
            self.assertEqual(await pending, {"status": "device_unavailable"})

    async def test_device_status_cancellation_and_disconnect_do_not_leave_pending_work(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        cancelled = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
        await __import__("asyncio").sleep(0)
        cancelled.cancel()
        self.assertEqual(await cancelled, {"status": "cancelled"})
        self.assertEqual(self.socket.sent[-1]["kind"], "mobile_cancel")
        pending = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
        await __import__("asyncio").sleep(0)
        await self.client.close()
        self.assertEqual(await pending, {"status": "device_unavailable"})

    async def test_device_status_deadline_sends_an_ephemeral_cancel(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        with patch("cozygateway.attach_client_v1.MOBILE_STATUS_TIMEOUT_SECONDS", 0.001):
            self.assertEqual(await self.client.request_device_status("thread", "turn", "Report phone readiness"), {"status": "expired"})
        self.assertEqual([frame["kind"] for frame in self.socket.sent[-2:]], ["mobile_request", "mobile_cancel"])

    async def test_mobile_deadlines_distinguish_queries_from_human_interactions(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node", "mobile_media"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        with patch("cozygateway.attach_client_v1.time.time", return_value=1_000):
            status_request = __import__("asyncio").create_task(
                self.client.request_device_status("thread", "turn", "Report phone readiness")
            )
            await __import__("asyncio").sleep(0)
            status_frame = self.socket.sent[-1]
            status_request.cancel()
            self.assertEqual(await status_request, {"status": "cancelled"})
            request = __import__("asyncio").create_task(
                self.client.request_camera("thread", "turn", "Capture a test photo", "rear", "photo")
            )
            await __import__("asyncio").sleep(0)
        frame = self.socket.sent[-1]
        self.assertEqual(status_frame["command"], "device.status")
        self.assertEqual(status_frame["expiresAt"], 1_029_000)
        self.assertEqual(frame["command"], "camera.capture")
        self.assertEqual(frame["expiresAt"], 1_119_000)
        request.cancel()
        self.assertEqual(await request, {"status": "cancelled"})

    async def test_device_status_rejects_arbitrary_result_payloads(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        request = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
        await __import__("asyncio").sleep(0)
        request_id = self.socket.sent[-1]["requestId"]
        await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": request_id, "status": "ok", "result": {**GATEWAY_STATUS, "serialNumber": "never forward"}}))
        self.assertEqual(await request, {"status": "device_unavailable"})

    async def test_device_status_rejects_nested_extras_and_duplicate_commands(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        for payload in (
            {**GATEWAY_STATUS, "capabilities": [{"command": "device.status", "permission": "not_required", "ssid": "secret"}]},
            {**GATEWAY_STATUS, "capabilities": [{"command": "device.status", "permission": "not_required"}]},
            {**GATEWAY_STATUS, "capabilities": [
                {"command": "device.status", "permission": "not_required"},
                {"command": "device.status", "permission": "authorized"},
            ]},
            {**GATEWAY_STATUS, "capabilities": [
                {"command": "device.status", "permission": "authorized"},
                {"command": "location.current", "permission": "not_required"},
            ]},
        ):
            request = __import__("asyncio").create_task(self.client.request_device_status("thread", "turn", "Report phone readiness"))
            await __import__("asyncio").sleep(0)
            request_id = self.socket.sent[-1]["requestId"]
            await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": request_id, "status": "ok", "result": payload}))
            self.assertEqual(await request, {"status": "device_unavailable"})

    async def test_device_status_rejects_invalid_purpose_without_sending(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        self.assertEqual(await self.client.request_device_status("thread", "turn", "bad\npurpose"), {"status": "policy_blocked"})
        self.assertEqual([frame for frame in self.socket.sent if frame["kind"] == "mobile_request"], [])

    async def test_location_requires_its_own_negotiated_capability(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        self.assertEqual(await self.client.request_location("thread", "turn", "Find coffee"), {"status": "device_unavailable"})
        self.assertEqual([frame for frame in self.socket.sent if frame["kind"] == "mobile_request"], [])

    async def test_location_is_ephemeral_normalizes_purpose_and_validates_the_closed_result(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node", "mobile_location"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        request = __import__("asyncio").create_task(self.client.request_location("thread", "turn", "  Find   coffee  "))
        await __import__("asyncio").sleep(0)
        frame = self.socket.sent[-1]
        self.assertEqual(frame, {"kind": "mobile_request", "requestId": frame["requestId"], "command": "location.current", "threadId": "thread", "turnId": "turn", "expiresAt": frame["expiresAt"], "purpose": "Find coffee"})
        await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": frame["requestId"], "status": "ok", "result": {"latitude": 41.881, "longitude": -87.63}}))
        self.assertEqual(await request, {"status": "device_unavailable"})
        accepted = __import__("asyncio").create_task(self.client.request_location("thread", "turn", "Find coffee"))
        await __import__("asyncio").sleep(0)
        accepted_frame = self.socket.sent[-1]
        await self.client._dispatch_inbound(json.dumps({"kind": "mobile_result", "requestId": accepted_frame["requestId"], "status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}}))
        self.assertEqual(await accepted, {"status": "ok", "result": {"latitude": 41.88, "longitude": -87.63}})
        self.assertEqual(await self.client.request_location("thread", "turn", "bad\npurpose"), {"status": "policy_blocked"})

    async def test_location_cancellation_sends_only_an_ephemeral_cancel(self):
        await self.client.connect()
        await self.client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["mobile_node", "mobile_location"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))
        request = __import__("asyncio").create_task(self.client.request_location("thread", "turn", "Find coffee"))
        await __import__("asyncio").sleep(0)
        request.cancel()
        self.assertEqual(await request, {"status": "cancelled"})
        self.assertEqual(self.socket.sent[-1]["kind"], "mobile_cancel")
        self.assertEqual(self.spool.pending_events(10, 100000), [])


if __name__ == "__main__":
    unittest.main()


class DeviceStatusCapabilityShapeTests(unittest.TestCase):
    """The phone reports one capability record per selected command, in one fixed order.

    That list grew from two to five when camera, file picking and notifications arrived. The
    validator kept requiring two, so a correct answer from a correct phone was rejected and
    reported to the asking bot as `device_unavailable`, which reads as a hardware or connection
    problem rather than a contract disagreement.
    """

    def _status(self, capabilities):
        return {
            "appState": "foreground",
            "lowPowerMode": False,
            "capabilities": capabilities,
            "authenticatedReachable": True,
            "lastAuthenticatedPresenceAt": 1,
        }

    def _full(self):
        return [
            {"command": "device.status", "permission": "not_required"},
            {"command": "location.current", "permission": "authorized"},
            {"command": "camera.capture", "permission": "not_determined"},
            {"command": "file.pick", "permission": "not_required"},
            {"command": "notification.present", "permission": "not_required"},
        ]

    def test_accepts_the_full_command_inventory(self):
        self.assertTrue(_is_device_status(self._status(self._full())))

    def test_rejects_a_short_inventory(self):
        self.assertFalse(_is_device_status(self._status(self._full()[:2])))

    def test_rejects_a_reordered_inventory(self):
        shuffled = self._full()
        shuffled[0], shuffled[1] = shuffled[1], shuffled[0]
        self.assertFalse(_is_device_status(self._status(shuffled)))

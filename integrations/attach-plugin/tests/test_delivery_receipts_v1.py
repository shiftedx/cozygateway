import json
import os
import tempfile
import types
import unittest

from cozygateway.adapter import _apply_projection, delivery_state
from cozygateway.attach_client_v1 import (
    AttachV1Client, AttachV1ClientConfig, HELLO_CAPABILITIES,
)
from cozygateway.attach_spool import AttachSpool


class FakeSocket:
    def __init__(self):
        self.sent = []
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
        return value


class DeliveryReceiptSpoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.spool = AttachSpool(os.path.join(self.tmp.name, "spool.sqlite"))

    def tearDown(self):
        self.spool.close()
        self.tmp.cleanup()

    def test_first_terminal_wins_in_both_directions(self):
        self.assertEqual(self.spool.record_delivery_receipt("d1", "displayed", 10), "recorded")
        self.assertEqual(
            self.spool.record_delivery_receipt("d1", "failed", 20, stage="projection", reason="dead"),
            "conflict",
        )
        self.assertEqual(self.spool.delivery_receipt_row("d1"), {"state": "displayed", "at": 10})

        self.assertEqual(
            self.spool.record_delivery_receipt("d2", "failed", 5, stage="authorization", reason="quarantined"),
            "recorded",
        )
        self.assertEqual(self.spool.record_delivery_receipt("d2", "displayed", 99), "conflict")
        self.assertEqual(
            self.spool.delivery_receipt_row("d2"),
            {"state": "failed", "at": 5, "stage": "authorization", "reason": "quarantined"},
        )

    def test_repeat_of_the_same_terminal_is_a_duplicate_not_a_conflict(self):
        self.spool.record_delivery_receipt("d1", "displayed", 10)
        self.assertEqual(self.spool.record_delivery_receipt("d1", "displayed", 44), "duplicate")
        self.assertEqual(self.spool.delivery_receipt_row("d1")["at"], 10)

    def test_displayed_upgrades_a_non_terminal_row(self):
        self.assertEqual(self.spool.record_delivery_receipt("d1", "projected", 10), "recorded")
        self.assertEqual(self.spool.record_delivery_receipt("d1", "displayed", 20), "recorded")
        self.assertEqual(self.spool.delivery_receipt_row("d1"), {"state": "displayed", "at": 20})

    def test_rows_survive_a_restart_and_unknown_ids_read_as_none(self):
        self.spool.record_delivery_receipt("d1", "displayed", 10)
        path = self.spool._path
        self.spool.close()
        self.spool = AttachSpool(path)
        self.assertEqual(self.spool.delivery_receipt_row("d1"), {"state": "displayed", "at": 10})
        self.assertIsNone(self.spool.delivery_receipt_row("nope"))


class DeliveryReceiptCommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.spool = AttachSpool(os.path.join(self.tmp.name, "spool.sqlite"))
        self.socket = FakeSocket()

        async def connect_factory(_url, _headers, _ssl):
            return self.socket

        self.client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="http://gateway.example", token="secret", spool=self.spool,
            connect_factory=connect_factory,
        ))
        await self.client.connect()

    async def asyncTearDown(self):
        await self.client.close()
        self.spool.close()
        self.tmp.cleanup()

    def _frame(self, sequence, command_id, command):
        return json.dumps({
            "kind": "command", "sequence": sequence, "commandId": command_id, "command": command,
        })

    async def test_hello_advertises_the_delivery_receipts_capability(self):
        self.assertIn("delivery_receipts", HELLO_CAPABILITIES)
        self.assertIn("delivery_receipts", self.socket.sent[0]["capabilities"])

    async def test_receipt_command_persists_and_acks(self):
        await self.client._dispatch_inbound(self._frame(1, "rcpt:scheduled:k:displayed", {
            "kind": "delivery_receipt", "deliveryId": "scheduled:k", "messageId": "m",
            "state": "displayed", "at": 1700,
        }))
        acks = [f for f in self.socket.sent if f.get("kind") == "ack" and f.get("channel") == "command"]
        self.assertEqual(acks[-1]["id"], "rcpt:scheduled:k:displayed")
        self.assertEqual(
            self.spool.delivery_receipt_row("scheduled:k"), {"state": "displayed", "at": 1700},
        )
        self.assertEqual(self.spool.pending_commands(), [])

    async def test_failed_receipt_carries_stage_and_bounded_reason(self):
        await self.client._dispatch_inbound(self._frame(1, "rcpt:scheduled:k:failed", {
            "kind": "delivery_receipt", "deliveryId": "scheduled:k", "messageId": "m",
            "state": "failed", "at": 1700, "stage": "authorization", "reason": "x" * 400,
        }))
        row = self.spool.delivery_receipt_row("scheduled:k")
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["stage"], "authorization")
        self.assertEqual(len(row["reason"]), 256)

    async def test_malformed_receipt_is_acked_and_dropped(self):
        await self.client._dispatch_inbound(self._frame(1, "rcpt:bad", {
            "kind": "delivery_receipt", "deliveryId": "scheduled:k", "state": "shown", "at": 1,
        }))
        acks = [f for f in self.socket.sent if f.get("kind") == "ack" and f.get("channel") == "command"]
        self.assertEqual(acks[-1]["id"], "rcpt:bad")
        self.assertIsNone(self.spool.delivery_receipt_row("scheduled:k"))
        self.assertEqual(self.spool.pending_commands(), [])


class ReceiptProjectionMergeTests(unittest.TestCase):
    def test_projection_surfaces_displayed_at_and_terminal(self):
        result = _apply_projection(
            {"state": "journaled", "accepted_pending": True},
            {
                "state": "projected", "projectedAt": 5, "displayedAt": 9,
                "terminal": {"state": "displayed", "at": 9},
            },
        )
        self.assertEqual(result["state"], "projected")
        self.assertEqual(result["projectedAt"], 5)
        self.assertEqual(result["displayedAt"], 9)
        self.assertEqual(result["terminal"], {"state": "displayed", "at": 9})

    def test_absent_additive_fields_leave_the_result_unchanged(self):
        result = _apply_projection(
            {"state": "journaled", "accepted_pending": True},
            {"state": "projected", "projectedAt": 5},
        )
        self.assertEqual(
            result, {"state": "projected", "accepted_pending": False, "projectedAt": 5},
        )

    def test_terminal_failure_rides_a_blocked_receipt(self):
        result = _apply_projection(
            {"state": "journaled", "accepted_pending": True},
            {
                "state": "blocked", "attempts": 3,
                "terminal": {"state": "failed", "stage": "projection", "reason": "boom", "at": 12},
            },
        )
        self.assertEqual(result["state"], "blocked")
        self.assertEqual(result["terminal"]["stage"], "projection")


class DeliveryStateHelperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
        self.pconfig = types.SimpleNamespace(extra={"spool_path": self.path})

    def tearDown(self):
        self.tmp.cleanup()

    def test_unknown_delivery_reports_unknown_with_its_identity(self):
        state = delivery_state(self.pconfig, "session-1")
        self.assertEqual(state["state"], "unknown")
        self.assertEqual(state["deliveryId"], "scheduled:session-1")
        self.assertTrue(state["messageId"].startswith("scheduled-"))

    def test_recorded_terminal_is_readable_by_delivery_key(self):
        spool = AttachSpool(self.path)
        spool.record_delivery_receipt(
            "scheduled:session-1", "failed", 42, stage="projection", reason="dead-letter",
        )
        spool.close()
        state = delivery_state(self.pconfig, "session-1")
        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["stage"], "projection")
        self.assertEqual(state["reason"], "dead-letter")
        self.assertEqual(state["at"], 42)
        self.assertEqual(state["deliveryId"], "scheduled:session-1")


if __name__ == "__main__":
    unittest.main()

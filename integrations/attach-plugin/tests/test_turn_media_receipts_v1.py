"""A reply's attachments must be able to reach ``displayed``, not stall at ``journaled``.

Media sent inside a live conversation is journaled under ``turn:<turnId>``. Until the gateway
addressed a receipt at that id, nothing could move those rows, so an agent asked "did you see the
picture?" had to answer that it could not confirm the app had displayed it while the owner was
already looking at it.
"""

import json
import os
import tempfile
import types
import unittest

from cozygateway.adapter import TURN_DELIVERY_PREFIX, delivery_state
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
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


class TurnMediaReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.path)
        self.pconfig = types.SimpleNamespace(extra={"spool_path": self.path})
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

    def _receipt(self, delivery_id, state="displayed", at=1700):
        return json.dumps({
            "kind": "command", "sequence": 1, "commandId": f"rcpt:{delivery_id}:{state}",
            "command": {
                "kind": "delivery_receipt", "deliveryId": delivery_id, "messageId": "answer",
                "state": state, "at": at,
            },
        })

    async def test_receipt_for_a_turn_delivery_marks_its_media_displayed(self):
        delivery_id = TURN_DELIVERY_PREFIX + "turn-1"
        self.spool.media_mark(delivery_id, "media_chart", "journaled")
        self.spool.media_mark(delivery_id, "media_table", "journaled")

        await self.client._dispatch_inbound(self._receipt(delivery_id))

        self.assertEqual(
            [row["state"] for row in self.spool.media_rows(delivery_id)],
            ["displayed", "displayed"],
        )

    async def test_delivery_state_reads_a_turn_key_and_carries_its_media_rows(self):
        delivery_id = TURN_DELIVERY_PREFIX + "turn-2"
        self.spool.media_mark(delivery_id, "media_chart", "journaled")
        await self.client._dispatch_inbound(self._receipt(delivery_id, at=1800))

        state = delivery_state(self.pconfig, delivery_id)
        self.assertEqual(state["state"], "displayed")
        self.assertEqual(state["at"], 1800)
        self.assertEqual(state["deliveryId"], delivery_id)
        self.assertEqual(state["messageId"], "turn-2")
        self.assertEqual([row["state"] for row in state["media"]], ["displayed"])

    async def test_a_turn_key_with_no_receipt_yet_reads_as_its_journaled_media(self):
        delivery_id = TURN_DELIVERY_PREFIX + "turn-3"
        self.spool.media_mark(delivery_id, "media_chart", "journaled")

        state = delivery_state(self.pconfig, delivery_id)
        self.assertEqual(state["state"], "unknown")
        self.assertEqual([row["state"] for row in state["media"]], ["journaled"])

    def test_a_scheduled_key_still_reads_the_way_it_always_has(self):
        self.spool.record_delivery_receipt("scheduled:session-1", "displayed", 42)
        state = delivery_state(self.pconfig, "session-1")
        self.assertEqual(state["state"], "displayed")
        self.assertEqual(state["deliveryId"], "scheduled:session-1")
        self.assertNotIn("media", state)


if __name__ == "__main__":
    unittest.main()

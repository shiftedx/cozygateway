"""The fake gateway is test infrastructure, so it needs its own proof.

Every scripted behaviour the media integration lane relies on is fired here through the
real ``AttachV1Client`` over a real socket and a real HTTP request, and the assertion
surface is checked for having recorded it. If this file is green, an integration test that
fails is describing the adapter and not the harness.
"""

import asyncio
import json
import os
import tempfile
import unittest
from urllib.error import HTTPError

from cozygateway.attach_client import AttachAuthError
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool
from tests.fake_gateway import (
    PNG_1X1, FakeGateway, receipt, receipt_missing, upload_drop_after_body,
    upload_drop_before_body, upload_forbidden, upload_ok, upload_rate_limited,
    upload_server_error, upload_too_large, upload_unsupported_mime,
)


class FakeGatewaySelfTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.addAsyncCleanup(self.gateway.stop)
        self.png = os.path.join(self.tmp.name, "shot.png")
        with open(self.png, "wb") as handle:
            handle.write(PNG_1X1)

    async def _client(self):
        spool = AttachSpool(os.path.join(self.tmp.name, "spool.sqlite"))
        self.addCleanup(spool.close)
        ready = []
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token=self.gateway.token,
            spool=spool, on_ready=lambda: ready.append(True),
        ))
        await client.connect()
        watcher = asyncio.get_running_loop().create_task(client.watch())
        self.addAsyncCleanup(self._shutdown, client, watcher)
        await self.gateway.wait_for(lambda: ready, what="hello_ack")
        return client, spool

    async def _shutdown(self, client, watcher):
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best effort
            pass
        await client.close()

    async def _upload(self, client, media_id="media-1"):
        return await client.upload_media(media_id, self.png, "image")

    # -- handshake -----------------------------------------------------------------

    async def test_hello_v2_is_acked_with_the_configured_capabilities(self):
        client, spool = await self._client()
        hello = self.gateway.hellos[0]
        self.assertEqual((hello["kind"], hello["version"]), ("hello", 2))
        self.assertEqual(hello["instanceId"], spool.instance_id)
        self.assertIn("media", hello["capabilities"])
        self.assertIn("delivery_receipts", client._capabilities)

    async def test_a_narrowed_hello_ack_takes_the_media_surface_offline(self):
        self.gateway.capabilities = ["draft"]
        client, _spool = await self._client()
        self.assertEqual(client._capabilities, {"draft"})
        # No socket event, but the HTTP upload still happens: the two are separate channels.
        await self._upload(client)
        await self.gateway.wait_for_uploads()
        self.assertEqual(self.gateway.media_event_ids, [])

    async def test_a_rejected_token_fails_the_handshake(self):
        spool = AttachSpool(os.path.join(self.tmp.name, "rejected.sqlite"))
        self.addCleanup(spool.close)
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token="wrong-token", spool=spool,
        ))
        with self.assertRaises(AttachAuthError):
            await client.connect()

    # -- upload success path -------------------------------------------------------

    async def test_a_200_upload_returns_a_descriptor_and_is_recorded(self):
        client, _spool = await self._client()
        descriptor = await self._upload(client, "media-abc")

        self.assertEqual(descriptor["mediaId"], "media-abc")
        self.assertEqual((descriptor["byteCount"], descriptor["family"]), (len(PNG_1X1), "image"))
        self.assertEqual(self.gateway.upload_media_ids, ["media-abc"])
        self.assertEqual(self.gateway.upload_sizes, [len(PNG_1X1)])
        self.assertEqual(self.gateway.upload_content_types, ["image/png"])
        self.assertEqual(self.gateway.uploads[0].filename, "shot.png")
        self.assertEqual(self.gateway.uploads[0].sha256, descriptor["sha256"])
        await self.gateway.wait_for_event_kind("media")
        self.assertEqual(self.gateway.media_event_ids, ["media-abc"])

    async def test_frames_are_recorded_in_arrival_order_and_acked(self):
        client, spool = await self._client()
        await client.send_draft("thread", "turn", [])
        await self._upload(client)
        await client.send_done("thread", "turn", media_ids=["media-1"])
        await self.gateway.wait_for(
            lambda: self.gateway.event_kinds[-1:] == ["commit"], what="the commit event",
        )
        self.assertEqual(self.gateway.event_kinds, ["draft", "media", "commit"])
        self.assertEqual(self.gateway.events[-1]["mediaIds"], ["media-1"])
        # Acked events leave the durable outbox, which is the client half of the same fact.
        await self.gateway.wait_for(lambda: not spool.pending_events(10, 1_000_000), what="drained outbox")

    # -- scripted upload failures ---------------------------------------------------

    async def _failing_upload(self, response):
        client, _spool = await self._client()
        self.gateway.script_upload(response)
        with self.assertRaises(HTTPError) as caught:
            await self._upload(client)
        return caught.exception

    async def test_403_is_scripted_and_consumed(self):
        error = await self._failing_upload(upload_forbidden())
        self.assertEqual(error.code, 403)
        self.assertEqual(self.gateway.consumed_upload_script, ["403"])
        self.assertEqual(self.gateway.pending_upload_script, 0)

    async def test_413_names_the_limit_in_the_body(self):
        error = await self._failing_upload(upload_too_large(8 * 1024 * 1024))
        body = json.loads(error.read())
        self.assertEqual((error.code, body["reason"]), (413, "too_large"))
        self.assertEqual(body["limitBytes"], 8 * 1024 * 1024)

    async def test_415_names_the_rejected_mime_in_the_body(self):
        error = await self._failing_upload(upload_unsupported_mime("application/zip"))
        body = json.loads(error.read())
        self.assertEqual((error.code, body["mimeType"]), (415, "application/zip"))

    async def test_429_carries_retry_after(self):
        error = await self._failing_upload(upload_rate_limited(retry_after=7))
        self.assertEqual(error.code, 429)
        self.assertEqual(error.headers.get("Retry-After"), "7")
        self.assertEqual(json.loads(error.read())["retryAfter"], 7)

    async def test_500_and_502_are_both_scriptable(self):
        client, _spool = await self._client()
        self.gateway.script_upload(upload_server_error(), upload_server_error(status=502))
        for expected in (500, 502):
            with self.assertRaises(HTTPError) as caught:
                await self._upload(client)
            self.assertEqual(caught.exception.code, expected)
        self.assertEqual(self.gateway.consumed_upload_script, ["500", "502"])

    async def test_a_transient_failure_then_success_records_both_attempts(self):
        client, _spool = await self._client()
        self.gateway.script_upload(upload_server_error(), upload_ok())
        with self.assertRaises(HTTPError):
            await self._upload(client)
        descriptor = await self._upload(client)

        self.assertEqual(descriptor["mediaId"], "media-1")
        self.assertEqual(self.gateway.consumed_upload_script, ["500", "ok"])
        self.assertEqual([record.outcome for record in self.gateway.uploads], ["500", "ok"])

    async def test_an_exhausted_script_falls_back_to_accepting_the_upload(self):
        client, _spool = await self._client()
        await self._upload(client)
        self.assertEqual(self.gateway.consumed_upload_script, ["ok"])
        self.assertEqual([record.outcome for record in self.gateway.uploads], ["ok"])

    # -- scripted socket drops ------------------------------------------------------

    async def test_a_drop_before_the_body_is_recorded_as_unread(self):
        client, _spool = await self._client()
        self.gateway.script_upload(upload_drop_before_body())
        with self.assertRaises(Exception) as caught:
            await self._upload(client)
        self.assertNotIsInstance(caught.exception, HTTPError)

        record = self.gateway.uploads[0]
        self.assertEqual((record.outcome, record.body_read), ("drop_before_body", False))
        self.assertEqual(record.size_bytes, len(PNG_1X1))  # the declared Content-Length

    async def test_a_drop_after_the_body_is_recorded_as_read(self):
        client, _spool = await self._client()
        self.gateway.script_upload(upload_drop_after_body())
        with self.assertRaises(Exception) as caught:
            await self._upload(client)
        self.assertNotIsInstance(caught.exception, HTTPError)

        record = self.gateway.uploads[0]
        self.assertEqual((record.outcome, record.body_read), ("drop_after_body", True))
        self.assertEqual(record.size_bytes, len(PNG_1X1))

    # -- rollback -------------------------------------------------------------------

    async def test_rollback_deletions_are_seen_in_order(self):
        client, _spool = await self._client()
        await self._upload(client, "media-1")
        await self._upload(client, "media-2")
        await client.rollback_uploaded_media(["media-1", "media-2"])
        await self.gateway.wait_for(
            lambda: len(self.gateway.deleted_media_ids) == 2, what="two rollback deletes",
        )
        self.assertEqual(self.gateway.deleted_media_ids, ["media-1", "media-2"])

    # -- scheduled receipts over HTTP ------------------------------------------------

    async def test_a_delayed_receipt_answers_404_until_the_delivery_projects(self):
        client, _spool = await self._client()
        self.gateway.script_receipt(
            "delivery-1", receipt_missing(), receipt("projected", projected_at=5, delay_s=0.05),
        )
        self.assertIsNone(await client.delivery_receipt("delivery-1", 1.0))
        projected = await client.delivery_receipt("delivery-1", 1.0)

        self.assertEqual(projected["state"], "projected")
        self.assertEqual(projected["deliveryId"], "delivery-1")
        self.assertEqual(self.gateway.consumed_receipt_script("delivery-1"), ["404", "receipt:projected"])
        self.assertEqual(self.gateway.receipt_requests, ["delivery-1", "delivery-1"])

    async def test_a_duplicate_receipt_read_repeats_the_terminal_answer(self):
        client, _spool = await self._client()
        self.gateway.script_receipt("delivery-1", receipt("projected", projected_at=5))
        first = await client.delivery_receipt("delivery-1", 1.0)
        second = await client.delivery_receipt("delivery-1", 1.0)

        self.assertEqual(first, second)
        self.assertEqual(
            self.gateway.consumed_receipt_script("delivery-1"),
            ["receipt:projected", "receipt:projected"],
        )

    async def test_an_unscripted_delivery_reads_as_not_found(self):
        client, _spool = await self._client()
        self.assertIsNone(await client.delivery_receipt("delivery-unknown", 1.0))
        self.assertEqual(self.gateway.receipt_requests, ["delivery-unknown"])

    # -- delivery_receipt commands over the socket -----------------------------------

    async def test_a_delayed_delivery_receipt_command_lands_and_is_acked(self):
        _client, spool = await self._client()
        self.gateway.schedule_delivery_receipt("delivery-1", "displayed", at=1700, delay_s=0.05)
        await self.gateway.wait_for(
            lambda: spool.delivery_receipt_row("delivery-1"), what="the delivery receipt row",
        )
        self.assertEqual(spool.delivery_receipt_row("delivery-1"), {"state": "displayed", "at": 1700})
        await self.gateway.wait_for(lambda: self.gateway.command_acks, what="a command ack")
        self.assertEqual(self.gateway.command_acks[0]["sequence"], 1)

    async def test_a_duplicate_delivery_receipt_command_is_acked_as_a_duplicate(self):
        _client, spool = await self._client()
        await self.gateway.push_delivery_receipt(
            "delivery-1", "failed", at=1700, stage="projection", reason="dead-lettered", repeat=2,
        )
        await self.gateway.wait_for(
            lambda: len(self.gateway.command_acks) == 2, what="both command acks",
        )
        self.assertEqual(
            [ack.get("duplicate") for ack in self.gateway.command_acks], [None, True],
        )
        self.assertEqual(
            spool.delivery_receipt_row("delivery-1"),
            {"state": "failed", "at": 1700, "stage": "projection", "reason": "dead-lettered"},
        )


if __name__ == "__main__":
    unittest.main()

"""Cleo's media matrix, driven end to end against the scriptable fake gateway.

Every case here is a row of the integration matrix in
``docs/specs/2026-08-24-media-delivery-hardening-cleo.md``: a real adapter, the real
``AttachV1Client``, a real socket and a real HTTP upload, with the gateway told exactly
how to answer. What is asserted is what the person and the operator can actually rely on:
which bytes reached the gateway, which media ids rode the commit, what the durable
lifecycle rows say, and whether the reply told the truth about a lost attachment.

The unit-level behaviour of the pieces lives with the pieces (``test_media_descriptor``,
``test_media_spool``, ``test_fake_gateway_selftest``).
"""

import asyncio
import os
import sys
import tempfile
import types
import unittest
import zipfile

from cozygateway.adapter import AttachAdapter, MediaDestination, MediaUploadService
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool
from tests.fake_gateway import (
    PNG_1X1, FakeGateway, receipt, upload_drop_after_body, upload_drop_before_body,
    upload_forbidden, upload_ok, upload_rate_limited, upload_server_error,
    upload_too_large, upload_unsupported_mime,
)

CHAT = "thread-1"
TURN = "turn-1"


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


def _harness_modules():
    gateway = types.ModuleType("gateway")
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")
    base.SendResult = _SendResult
    gateway.platforms = platforms
    platforms.base = base
    return {"gateway": gateway, "gateway.platforms": platforms, "gateway.platforms.base": base}


class MediaUploadServiceIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved = {key: sys.modules.get(key) for key in _harness_modules()}
        sys.modules.update(_harness_modules())

        def restore():
            for key, value in saved.items():
                if value is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = value

        self.addCleanup(restore)

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.addAsyncCleanup(self.gateway.stop)

        self.png = self._write("shot.png", PNG_1X1)
        self.png_two = self._write("second.png", PNG_1X1 + b"\x00" * 16)
        self.archive = os.path.join(self.tmp.name, "logs.zip")
        with zipfile.ZipFile(self.archive, "w") as bundle:
            bundle.writestr("note.txt", "a real archive, delivered as a file")
        # Markup, not a raster image: still refused by policy before any network call.
        self.vector = self._write("diagram.svg", b'<svg xmlns="http://www.w3.org/2000/svg"/>')
        # Bytes that identify nothing, named as something the policy supports: the
        # fail-open case, where the gateway is the authority on the type.
        self.opaque = self._write("clip.mp4", b"not really a container at all")

        self.spool_path = os.path.join(self.tmp.name, "spool.sqlite")
        self.adapter, self.client, self.spool = await self._connect(self.spool_path)

    def _write(self, name, payload):
        path = os.path.join(self.tmp.name, name)
        with open(path, "wb") as handle:
            handle.write(payload)
        return path

    async def _connect(self, spool_path):
        spool = AttachSpool(spool_path)
        ready = []
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token=self.gateway.token,
            spool=spool, on_ready=lambda: ready.append(True),
        ))
        await client.connect()
        watcher = asyncio.get_running_loop().create_task(client.watch())
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={"spool_path": spool_path}))
        adapter._client = client
        adapter._spool = spool
        adapter._ready.set()
        self.addAsyncCleanup(self._shutdown, client, watcher, spool)
        await self.gateway.wait_for(lambda: ready, what="hello_ack")
        return adapter, client, spool

    async def _shutdown(self, client, watcher, spool):
        watcher.cancel()
        try:
            await watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best effort
            pass
        await client.close()
        spool.close()

    # -- helpers -------------------------------------------------------------

    async def _reply(self, text, paths, turn_id=TURN):
        self.adapter._active_turn[CHAT] = turn_id
        return await self.adapter.send(
            CHAT, text, reply_to=turn_id, metadata={"media_files": list(paths)},
        )

    async def _proactive(self, paths, *, delivery_key="tool:1", message="here it is"):
        return await self.adapter.send_proactive(
            CHAT, message, list(paths), canonical_home=True, delivery_key=delivery_key,
        )

    def _restarted_adapter(self, spool_path):
        """A fresh adapter over the SAME durable spool: a process restart, in one loop.

        Only the in-memory halves are new (no absorbed-media ledger, no service state);
        the socket is shared because the fake gateway resumes from sequence zero and a
        second live handshake on one spool is a different test.
        """
        spool = AttachSpool(spool_path)
        self.addCleanup(spool.close)
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={"spool_path": spool_path}))
        adapter._client = self.client
        adapter._spool = spool
        adapter._ready.set()
        return adapter, spool

    def _rows(self, delivery_id, spool=None):
        return {row["mediaId"]: row["state"] for row in (spool or self.spool).media_rows(delivery_id)}

    def _committed_text(self):
        drafts = self.gateway.events_of_kind("draft")
        self.assertTrue(drafts, "no draft was committed")
        return " ".join(block.get("text", "") for block in drafts[-1]["blocks"])

    # -- 200: happy path to journaled, then upgraded by receipts --------------

    async def test_a_healthy_reply_uploads_the_probed_mime_and_commits_the_id(self):
        result = await self._reply("here is the shot", [self.png])
        await self.gateway.wait_for_event_kind("commit")

        self.assertTrue(result.success)
        self.assertEqual(self.gateway.upload_content_types, ["image/png"])
        self.assertEqual(self.gateway.uploads[0].filename, "shot.png")
        media_id = self.gateway.upload_media_ids[0]
        self.assertEqual(self.gateway.events_of_kind("commit")[0]["mediaIds"], [media_id])
        self.assertEqual(self._rows("turn:" + TURN), {media_id: "journaled"})
        self.assertIsNone(getattr(result, "media_result", None))

    async def test_a_proactive_delivery_is_accepted_pending_and_receipts_upgrade_the_rows(self):
        result = await self._proactive([self.png])
        delivery_id = result["deliveryId"]

        self.assertEqual(result["state"], "journaled")
        self.assertTrue(result["accepted_pending"])
        media_id = self.gateway.upload_media_ids[0]
        self.assertEqual(result["attachments"], [{
            "attachmentId": media_id, "name": "shot.png", "mimeType": "image/png",
            "bytes": len(PNG_1X1), "mediaKind": "image",
        }])
        self.assertNotIn("source", str(result["attachments"]))
        self.assertNotIn("sha256", str(result["attachments"]))
        self.assertNotIn(self.tmp.name, str(result["attachments"]))
        self.assertEqual(self._rows(delivery_id), {media_id: "journaled"})

        # The HTTP receipt read carries "projected" down onto the attachment...
        self.gateway.script_receipt(delivery_id, receipt("projected", projected_at=7))
        self.assertEqual(
            (await self.client.delivery_receipt(delivery_id, 1.0))["state"], "projected",
        )
        self.assertEqual(self._rows(delivery_id), {media_id: "projected"})

        # ...and the durable command carries the terminal one.
        self.gateway.schedule_delivery_receipt(delivery_id, "displayed", at=1700)
        await self.gateway.wait_for(
            lambda: self._rows(delivery_id) == {media_id: "displayed"}, what="the displayed row",
        )
        self.assertEqual(self.spool.delivery_receipt_row(delivery_id)["state"], "displayed")

    async def test_a_late_duplicate_receipt_updates_the_row_exactly_once(self):
        result = await self._proactive([self.png])
        delivery_id = result["deliveryId"]
        media_id = self.gateway.upload_media_ids[0]

        await self.gateway.push_delivery_receipt(delivery_id, "displayed", at=1700, repeat=2)
        await self.gateway.wait_for(
            lambda: self._rows(delivery_id) == {media_id: "displayed"}, what="the displayed row",
        )
        settled = self.spool.media_rows(delivery_id)[0]["updatedAt"]

        # A repeat of the same receipt changes nothing, and a stale earlier stage may
        # never walk the settled answer backwards.
        await self.gateway.push_delivery_receipt(delivery_id, "displayed", at=1900)
        self.assertEqual(self.spool.media_mark(delivery_id, media_id, "displayed"), "duplicate")
        self.assertEqual(self.spool.media_mark(delivery_id, media_id, "projected"), "conflict")
        self.assertEqual(self.spool.media_rows(delivery_id)[0]["updatedAt"], settled)
        self.assertEqual(self._rows(delivery_id), {media_id: "displayed"})

    async def test_a_projection_that_never_arrives_stays_pending_not_failed(self):
        result = await self._proactive([self.png])

        self.assertEqual(result["state"], "journaled")
        self.assertTrue(result["accepted_pending"])
        self.assertNotIn("error", result)
        self.assertIsNone(self.spool.delivery_receipt_row(result["deliveryId"]))
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["journaled"])

    # -- 403 / 413 / 415 / 429 / 5xx -----------------------------------------

    async def test_a_gateway_that_offers_no_media_surface_never_spends_an_upload(self):
        self.gateway.capabilities = ["draft", "scheduled"]
        adapter, _client, spool = await self._connect(os.path.join(self.tmp.name, "narrow.sqlite"))
        result = await adapter.send_proactive(
            CHAT, "here it is", [self.png], canonical_home=True, delivery_key="tool:narrow",
        )

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "media_upload_failed")
        self.assertEqual(result["media_errors"], ["shot.png: media_unavailable"])
        self.assertEqual(self.gateway.uploads, [])

    async def test_a_403_upload_is_reported_with_its_status_and_never_committed(self):
        self.gateway.script_upload(upload_forbidden())
        result = await self._proactive([self.png])

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "media_upload_failed")
        self.assertIn("http_403", result["media_errors"][0])
        self.assertEqual(self.gateway.events_of_kind("scheduled"), [])
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["upload_failed"])

    async def test_a_413_names_the_file_and_the_status_without_committing(self):
        self.gateway.script_upload(upload_too_large(8 * 1024 * 1024))
        result = await self._proactive([self.png])

        self.assertEqual(result["media_errors"], [
            "shot.png (image/png, family=image): http_413 Content Too Large",
        ])
        self.assertEqual(self.gateway.events_of_kind("scheduled"), [])

    async def test_bytes_that_prove_an_unsupported_type_fail_before_any_network_call(self):
        result = await self._proactive([self.vector])

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["media_errors"], [
            "diagram.svg (image/svg+xml, family=image): unsupported_media_type",
        ])
        self.assertEqual(self.gateway.uploads, [])
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["blocked"])

    async def test_an_archive_uploads_as_a_generic_file(self):
        result = await self._proactive([self.archive])

        self.assertEqual(result["state"], "journaled")
        self.assertNotIn("media_errors", result)
        self.assertEqual(self.gateway.upload_content_types, ["application/zip"])
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["journaled"])

    async def test_an_unidentifiable_file_fails_open_and_the_gateway_415_decides(self):
        self.gateway.script_upload(upload_unsupported_mime("video/mp4"))
        result = await self._proactive([self.opaque])

        # The probe could not read the bytes, so the upload still happened: the gateway
        # verifies magic numbers and is the authority on the type.
        self.assertEqual(self.gateway.upload_content_types, ["video/mp4"])
        self.assertEqual(result["media_errors"], [
            "clip.mp4 (video/mp4, family=video): http_415 Unsupported Media Type",
        ])

    async def test_a_429_is_retried_once_and_then_succeeds(self):
        self.gateway.script_upload(upload_rate_limited(retry_after=0), upload_ok())
        result = await self._proactive([self.png])

        self.assertEqual(result["state"], "journaled")
        self.assertEqual(self.gateway.consumed_upload_script, ["429", "ok"])
        self.assertEqual(len(self.gateway.uploads), 2)
        await self.gateway.wait_for_event_kind("scheduled")
        self.assertEqual(len(self.gateway.events_of_kind("scheduled")), 1)
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["journaled"])

    async def test_transient_5xx_failures_are_reported_not_retried_here(self):
        for status in (500, 502):
            with self.subTest(status=status):
                self.gateway.script_upload(upload_server_error(status=status))
                result = await self._proactive([self.png], delivery_key="tool:%d" % status)
                self.assertEqual(result["state"], "failed")
                self.assertIn("http_%d" % status, result["media_errors"][0])
        # One attempt each: the durable journal owns retrying a transient failure.
        self.assertEqual(self.gateway.consumed_upload_script, ["500", "502"])

    # -- dropped sockets and rollback ----------------------------------------

    async def test_a_socket_dropped_before_the_body_leaves_nothing_committed(self):
        self.gateway.script_upload(upload_drop_before_body())
        result = await self._proactive([self.png])

        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.gateway.uploads[0].body_read, False)
        self.assertEqual(self.gateway.events_of_kind("scheduled"), [])
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["upload_failed"])

    async def test_a_socket_dropped_after_the_body_rolls_back_the_earlier_upload(self):
        self.gateway.script_upload(upload_ok(), upload_drop_after_body())
        result = await self._proactive([self.png, self.png_two])
        await self.gateway.wait_for(
            lambda: self.gateway.deleted_media_ids, what="the rollback delete",
        )

        self.assertEqual(result["state"], "failed")
        self.assertTrue(self.gateway.uploads[1].body_read)
        # The first attachment was uploaded, so abandoning the occurrence must delete it.
        self.assertEqual(self.gateway.deleted_media_ids, [self.gateway.upload_media_ids[0]])
        self.assertEqual(self.gateway.events_of_kind("scheduled"), [])
        self.assertEqual(
            sorted(self._rows(result["deliveryId"]).values()), ["blocked", "upload_failed"],
        )

    # -- partial multi-attachment reply --------------------------------------

    async def test_a_partial_reply_commits_the_text_and_says_what_it_lost(self):
        self.gateway.script_upload(upload_ok(), upload_unsupported_mime("image/png"))
        result = await self._reply("both shots are attached", [self.png, self.png_two])
        await self.gateway.wait_for_event_kind("commit")

        self.assertTrue(result.success)
        payload = result.media_result
        self.assertEqual(payload["state"], "partial")
        self.assertEqual([entry["path"] for entry in payload["uploaded"]], ["shot.png"])
        failed = payload["failed"][0]
        self.assertEqual((failed["path"], failed["mime"], failed["status"]), ("second.png", "image/png", 415))
        self.assertIn("http_415", failed["error"])

        # The person is told, in the committed message itself.
        self.assertIn("I could not attach second.png.", self._committed_text())
        self.assertEqual(
            self.gateway.events_of_kind("commit")[0]["mediaIds"],
            [payload["uploaded"][0]["mediaId"]],
        )
        rows = self._rows("turn:" + TURN)
        self.assertEqual(rows[payload["uploaded"][0]["mediaId"]], "journaled")
        self.assertEqual(rows[failed["mediaId"]], "upload_failed")

    async def test_an_attachment_only_reply_that_loses_its_file_still_says_so(self):
        self.gateway.script_upload(upload_forbidden())
        result = await self._reply("", [self.png])
        await self.gateway.wait_for_event_kind("commit")

        self.assertTrue(result.success)
        self.assertEqual(result.media_result["state"], "partial")
        self.assertEqual(self._committed_text(), "I could not attach shot.png.")
        self.assertEqual(self.gateway.events_of_kind("commit")[0].get("mediaIds", []), [])

    # -- persisted idempotency -----------------------------------------------

    async def test_a_replayed_occurrence_reuses_the_media_id_across_a_restart(self):
        first = await self._proactive([self.png], delivery_key="tool:replay")
        media_id = self.gateway.upload_media_ids[0]

        adapter, spool = self._restarted_adapter(self.spool_path)
        second = await adapter.send_proactive(
            CHAT, "here it is", [self.png], canonical_home=True, delivery_key="tool:replay",
        )
        await self.gateway.wait_for_event_kind("scheduled", count=2)

        self.assertEqual(first["deliveryId"], second["deliveryId"])
        self.assertEqual(first["messageId"], second["messageId"])
        self.assertEqual(self.gateway.upload_media_ids, [media_id])  # exactly one upload
        self.assertEqual(
            [event["mediaIds"] for event in self.gateway.events_of_kind("scheduled")],
            [[media_id], [media_id]],
        )
        self.assertEqual(self._rows(second["deliveryId"], spool), {media_id: "journaled"})

    async def test_the_same_path_with_new_bytes_is_a_new_attachment(self):
        await self._proactive([self.png], delivery_key="tool:rewrite")
        with open(self.png, "wb") as handle:
            handle.write(PNG_1X1 + b"\x00" * 32)
        await self._proactive([self.png], delivery_key="tool:rewrite")

        self.assertEqual(len(self.gateway.upload_media_ids), 2)
        self.assertNotEqual(*self.gateway.upload_media_ids)

    async def test_two_identical_files_in_one_message_stay_two_attachments(self):
        same = self._write("copy.png", PNG_1X1)
        result = await self._proactive([self.png, same])
        await self.gateway.wait_for_event_kind("scheduled")

        self.assertEqual(len(self.gateway.upload_media_ids), 2)
        self.assertEqual(len(self.gateway.events_of_kind("scheduled")[0]["mediaIds"]), 2)
        self.assertEqual(len(self._rows(result["deliveryId"])), 2)

    # -- readiness ------------------------------------------------------------

    async def test_a_missing_file_fails_locally_with_an_actionable_code(self):
        result = await self._proactive([os.path.join(self.tmp.name, "never-written.png")])

        self.assertEqual(result["media_errors"], ["never-written.png: missing"])
        self.assertEqual(self.gateway.uploads, [])

    async def test_the_service_is_usable_without_a_spool_and_still_uploads(self):
        service = MediaUploadService(
            self.client, delivery_id="turn:bare",
            destination=MediaDestination("active_turn", CHAT), spool=None,
        )
        batch = await service.upload([self.png])

        self.assertEqual(len(batch.media_ids), 1)
        self.assertEqual(batch.failed, [])


if __name__ == "__main__":
    unittest.main()

"""Lane E: what the send path does under load, driven against the fake gateway.

The behaviours here are the ones a person notices when a reply carries more than one
file: how long the turn takes, whether a refusal is decided before bytes move, whether
a partial failure leaves orphan media behind, and whether a large upload freezes the
socket that carries heartbeats and tool events.
"""

import asyncio
import hashlib
import os
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import patch

from cozygateway import adapter as adapter_module
from cozygateway.adapter import MEDIA_UPLOAD_CONCURRENCY, AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool
from cozygateway.media_descriptor import clear_descriptor_cache
from tests.fake_gateway import PNG_1X1, FakeGateway, upload_forbidden, upload_ok

CHAT = "thread-1"


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


class MediaUploadPerfTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved = {key: sys.modules.get(key) for key in _harness_modules()}
        sys.modules.update(_harness_modules())

        def restore():
            modules = sys.modules
            for key, value in saved.items():
                if value is None:
                    modules.pop(key, None)
                else:
                    modules[key] = value

        self.addCleanup(restore)
        clear_descriptor_cache()
        self.addCleanup(clear_descriptor_cache)

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.addAsyncCleanup(self.gateway.stop)

        self.spool_path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.spool_path)
        self.client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token=self.gateway.token, spool=self.spool,
        ))
        await self.client.connect()
        self.watcher = asyncio.get_running_loop().create_task(self.client.watch())
        self.adapter = AttachAdapter()
        self.adapter._attach_init(types.SimpleNamespace(extra={"spool_path": self.spool_path}))
        self.adapter._client = self.client
        self.adapter._spool = self.spool
        self.adapter._ready.set()
        self.addAsyncCleanup(self._shutdown)
        await self.gateway.wait_for(lambda: self.gateway.hellos, what="hello")

    async def _shutdown(self):
        self.watcher.cancel()
        try:
            await self.watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best effort
            pass
        await self.client.close()
        self.spool.close()

    # -- helpers -------------------------------------------------------------

    def _pngs(self, count, padding=0):
        """``count`` distinct PNGs, so every attachment gets its own content hash."""
        paths = []
        for index in range(count):
            path = os.path.join(self.tmp.name, "shot%d.png" % index)
            with open(path, "wb") as handle:
                handle.write(PNG_1X1 + bytes([index]) * (padding + index + 1))
            paths.append(path)
        return paths

    async def _proactive(self, paths, *, delivery_key="tool:1"):
        return await self.adapter.send_proactive(
            CHAT, "here it is", list(paths), canonical_home=True, delivery_key=delivery_key,
        )

    def _rows(self, delivery_id):
        return {row["mediaId"]: row["state"] for row in self.spool.media_rows(delivery_id)}

    # -- bounded concurrency -------------------------------------------------

    async def test_six_attachments_upload_in_parallel_but_never_more_than_three(self):
        paths = self._pngs(6)
        held = 0.08
        self.gateway.script_upload(*(upload_ok(delay_s=held) for _ in paths))

        started = time.monotonic()
        result = await self._proactive(paths)
        elapsed = time.monotonic() - started

        self.assertEqual(result["state"], "journaled")
        self.assertEqual(len(self.gateway.uploads), 6)
        self.assertGreater(self.gateway.peak_upload_concurrency, 1)
        self.assertLessEqual(self.gateway.peak_upload_concurrency, MEDIA_UPLOAD_CONCURRENCY)
        # Six serial uploads would take at least 6 * held. Three at a time takes two waves.
        self.assertLess(elapsed, 6 * held)

    async def test_concurrent_uploads_keep_their_slot_order_on_the_commit(self):
        paths = self._pngs(4)
        # The slowest file first, so completion order cannot be arrival order.
        self.gateway.script_upload(
            upload_ok(delay_s=0.12), upload_ok(), upload_ok(), upload_ok(),
        )
        result = await self._proactive(paths)
        await self.gateway.wait_for_event_kind("scheduled")

        # A media id is derived from its slot index, so the ids on the delivery are the
        # proof that parallel uploads did not reshuffle the attachments.
        expected = [
            adapter_module._proactive_media_id(result["deliveryId"], index, self._sha(path))
            for index, path in enumerate(paths)
        ]
        self.assertEqual(self.gateway.events_of_kind("scheduled")[-1]["mediaIds"], expected)
        self.assertNotEqual(self.gateway.upload_media_ids, expected)

    def _sha(self, path):
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()

    async def test_one_refusal_rolls_back_every_sibling_that_did_upload(self):
        paths = self._pngs(3)
        self.gateway.script_upload(upload_ok(delay_s=0.05), upload_forbidden(), upload_ok(delay_s=0.05))

        result = await self._proactive(paths)

        self.assertEqual(result["state"], "failed")
        self.assertEqual(result["error"], "media_upload_failed")
        uploaded = [record.media_id for record in self.gateway.uploads if record.outcome == "ok"]
        self.assertEqual(len(uploaded), 2)
        await self.gateway.wait_for(
            lambda: sorted(self.gateway.deleted_media_ids) == sorted(uploaded),
            what="a rollback of every uploaded sibling",
        )
        self.assertEqual(self.gateway.events_of_kind("scheduled"), [])

    # -- size limits, decided before any byte moves ---------------------------

    async def test_a_file_over_its_type_cap_is_refused_locally_with_the_cap_named(self):
        paths = self._pngs(1)
        with patch.object(adapter_module, "_media_byte_limit", return_value=16):
            result = await self._proactive(paths)

        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.gateway.uploads, [])
        self.assertIn("too_large", result["media_errors"][0])
        self.assertIn("over the 16 byte cap for image/png", result["media_errors"][0])
        self.assertEqual(list(self._rows(result["deliveryId"]).values()), ["blocked"])

    async def test_attachments_that_together_exceed_the_message_cap_are_all_refused(self):
        paths = self._pngs(3)
        total = sum(os.path.getsize(path) for path in paths)
        with patch.object(adapter_module, "MEDIA_AGGREGATE_MAX_BYTES", total - 1):
            result = await self._proactive(paths)

        self.assertEqual(result["state"], "failed")
        self.assertEqual(self.gateway.uploads, [])
        self.assertEqual(len(result["media_errors"]), 3)
        for line in result["media_errors"]:
            self.assertIn("over the %d byte cap for one message" % (total - 1), line)
        self.assertEqual(sorted(self._rows(result["deliveryId"]).values()), ["blocked"] * 3)

    # -- the descriptor cache, at the send path level -------------------------

    async def test_resending_the_same_file_does_not_read_it_a_second_time(self):
        path = self._pngs(1)[0]
        with patch(
            "cozygateway.media_descriptor._read_head_and_hash",
            wraps=adapter_module.probe_media.__globals__["_read_head_and_hash"],
        ) as reads:
            await self._proactive([path], delivery_key="tool:first")
            await self._proactive([path], delivery_key="tool:second")
        self.assertEqual(reads.call_count, 1)
        self.assertEqual(len(self.gateway.uploads), 2)

    # -- backpressure --------------------------------------------------------

    async def test_a_slow_upload_does_not_stall_the_event_loop(self):
        """The bytes move on a worker thread, so the loop stays free to carry events.

        This is the measurement the spec asks for rather than machinery: nothing here
        schedules or throttles, it only proves the loop is never held.
        """
        path = os.path.join(self.tmp.name, "big.png")
        with open(path, "wb") as handle:
            handle.write(PNG_1X1 + b"\x00" * (6 * 1024 * 1024))
        self.gateway.script_upload(upload_ok(delay_s=0.3))

        gaps = []
        running = True

        async def ticker():
            last = time.monotonic()
            while running:
                await asyncio.sleep(0)
                now = time.monotonic()
                gaps.append(now - last)
                last = now

        tick = asyncio.get_running_loop().create_task(ticker())
        started = time.monotonic()
        result = await self._proactive([path])
        elapsed = time.monotonic() - started
        running = False
        await tick

        self.assertEqual(result["state"], "journaled")
        self.assertGreater(elapsed, 0.3, "the upload really was held open")
        self.assertLess(max(gaps), 0.1, "the event loop was blocked for %.3fs" % max(gaps))


if __name__ == "__main__":
    unittest.main()

"""Accepted-pending deliveries must report success, not a formatting failure.

Incident 2026-08-24: a correctly formatted scheduled reply was durably journaled, the
adapter answered ``SendResult(success=False, error="scheduled delivery journaled;
projection not yet confirmed")`` while the displayed receipt was still in flight, and
hermes core's ``_send_with_retry`` -- which reads every non-network, non-timeout false
result as a FORMATTING failure -- posted a second plain-text copy of the same reply.
Both copies were later displayed, so the fallback duplicated a valid message.

``_HermesCoreSender`` below is that classification, written out, so each case says what
the person actually receives: one message, two messages, or an honest failure.

Every case runs the real adapter, the real client, a real socket and real HTTP against
the scriptable fake gateway.
"""

import asyncio
import hashlib
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from cozygateway.adapter import (
    AttachAdapter, _send_message_handler, delivery_state,
)
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool
from tests.fake_gateway import PNG_1X1, FakeGateway

CHAT = "thread-1"
RICH = "## Automation health\n\n- 19/19 passing\n- no regressions"
NETWORK_TOKENS = ("network", "timeout", "connection", "not connected")


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _BasePlatformAdapter:
    """The two static helpers ``_send_message_handler`` reaches for."""

    extract_media = staticmethod(lambda message: ([], message))
    filter_media_delivery_paths = staticmethod(lambda media: media)


def _harness_modules():
    gateway = types.ModuleType("gateway")
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")
    base.SendResult = _SendResult
    base.BasePlatformAdapter = _BasePlatformAdapter
    gateway.platforms = platforms
    platforms.base = base
    return {"gateway": gateway, "gateway.platforms": platforms, "gateway.platforms.base": base}


def _canonical_home_delivery_id(chat_id: str, content: str) -> str:
    """The id the no-turn text lane derives when the harness exposes no session id.

    Mirrors ``AttachAdapter.send``: without ``HERMES_SESSION_ID`` the occurrence is
    content addressed, which is what makes a retry of one occurrence idempotent.
    """
    key = hashlib.sha256(f"{chat_id}\0{chat_id}\0{content}".encode("utf-8")).hexdigest()
    return "scheduled:" + key


class _HermesCoreSender:
    """Hermes core's send classification, so the duplicate is visible in the assertions.

    ``sent`` records every message the person would receive: the reply, plus the
    plain-text fallback when core decides the reply failed to format.
    """

    FALLBACK_PREFIX = "Response formatting failed, plain text: "

    def __init__(self, adapter: AttachAdapter) -> None:
        self._adapter = adapter
        self.sent = []

    async def send(self, chat_id: str, content: str, **kwargs) -> object:
        result = await self._adapter.send(chat_id, content, **kwargs)
        self.sent.append(content)
        if getattr(result, "success", False):
            return result
        error = str(getattr(result, "error", "") or "").lower()
        if any(token in error for token in NETWORK_TOKENS):
            return result  # retried as a transport problem, never reformatted
        fallback = self.FALLBACK_PREFIX + content
        await self._adapter.send(chat_id, fallback, **kwargs)
        self.sent.append(fallback)
        return result


class AcceptedPendingSendResultTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        saved = {key: sys.modules.get(key) for key in _harness_modules()}
        session_key = "gateway.session_context"
        saved_session = sys.modules.pop(session_key, None)
        sys.modules.update(_harness_modules())

        def restore():
            for key, value in saved.items():
                if value is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = value
            if saved_session is not None:
                sys.modules[session_key] = saved_session

        self.addCleanup(restore)

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.gateway = FakeGateway()
        await self.gateway.start()
        self.addAsyncCleanup(self.gateway.stop)

        self.png = os.path.join(self.tmp.name, "shot.png")
        with open(self.png, "wb") as handle:
            handle.write(PNG_1X1)

        self.spool_path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.spool_path)
        ready = []
        self.client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=self.gateway.http_url, token=self.gateway.token,
            spool=self.spool, on_ready=lambda: ready.append(True),
        ))
        await self.client.connect()
        self.watcher = asyncio.get_running_loop().create_task(self.client.watch())
        self.pconfig = types.SimpleNamespace(extra={"spool_path": self.spool_path})
        self.adapter = AttachAdapter()
        self.adapter._attach_init(self.pconfig)
        self.adapter._client = self.client
        self.adapter._spool = self.spool
        self.adapter._ready.set()
        self.addAsyncCleanup(self._shutdown)
        await self.gateway.wait_for(lambda: ready, what="hello_ack")
        self.core = _HermesCoreSender(self.adapter)

    async def _shutdown(self):
        self.watcher.cancel()
        try:
            await self.watcher
        except (asyncio.CancelledError, Exception):  # noqa: BLE001 - teardown is best effort
            pass
        await self.client.close()
        self.spool.close()

    # -- helpers -------------------------------------------------------------

    async def _await_receipt(self, delivery_id, state):
        await self.gateway.wait_for(
            lambda: (self.spool.delivery_receipt_row(delivery_id) or {}).get("state") == state,
            what=f"a {state} receipt for {delivery_id}",
        )

    def _state_of(self, delivery_id):
        return delivery_state(self.pconfig, delivery_id.split("scheduled:", 1)[1])

    def _scheduled_events(self):
        return self.gateway.events_of_kind("scheduled")

    async def _await_scheduled_events(self, count=1):
        """The spool admits events asynchronously; wait for the ones we expect."""
        await self.gateway.wait_for_event_kind("scheduled", count)
        return self._scheduled_events()

    # -- 1: journaled rich text, displayed receipt arrives late --------------

    async def test_journaled_rich_text_with_a_late_receipt_sends_exactly_once(self):
        result = await self.core.send(CHAT, RICH)

        self.assertTrue(result.success)
        self.assertEqual(self.core.sent, [RICH])  # no plain-text second copy
        self.assertEqual(len(await self._await_scheduled_events()), 1)
        lifecycle = result.delivery_lifecycle
        self.assertEqual(lifecycle["state"], "journaled")
        self.assertTrue(lifecycle["accepted_pending"])

        delivery_id = lifecycle["deliveryId"]
        self.gateway.schedule_delivery_receipt(delivery_id, "displayed", delay_s=0.05)
        await self._await_receipt(delivery_id, "displayed")

        self.assertEqual(len(self._scheduled_events()), 1)
        self.assertEqual(self._state_of(delivery_id)["state"], "displayed")

    # -- 2: journaled text plus media, receipts arrive late ------------------

    async def test_journaled_text_plus_media_with_late_receipts_sends_exactly_once(self):
        result = await self.adapter.send_image_file(CHAT, self.png, "here is the chart")

        self.assertTrue(result.success)
        self.assertEqual(len(await self._await_scheduled_events()), 1)
        self.assertEqual(len(self.gateway.uploads), 1)
        lifecycle = result.delivery_lifecycle
        self.assertEqual(lifecycle["state"], "journaled")
        self.assertTrue(lifecycle["accepted_pending"])

        delivery_id = lifecycle["deliveryId"]
        self.gateway.schedule_delivery_receipt(delivery_id, "displayed", delay_s=0.05)
        await self._await_receipt(delivery_id, "displayed")

        self.assertEqual(len(self._scheduled_events()), 1)
        landed = self._state_of(delivery_id)
        self.assertEqual(landed["state"], "displayed")
        # The receipt walks the attachment row on to the same terminal state.
        self.assertEqual([row["state"] for row in landed["media"]], ["displayed"])

    # -- 3: a real rejection still earns the plain-text fallback -------------

    async def test_a_refused_block_payload_still_returns_false_and_falls_back(self):
        original = AttachV1Client.send_scheduled
        refusals = {"remaining": 1}

        async def refuse_once(self_client, *args, **kwargs):
            if refusals["remaining"]:
                refusals["remaining"] -= 1
                return None  # the gateway would not journal these blocks
            return await original(self_client, *args, **kwargs)

        with patch.object(AttachV1Client, "send_scheduled", refuse_once):
            result = await self.core.send(CHAT, RICH)

        self.assertFalse(result.success)
        self.assertIn("unavailable", result.error)
        self.assertFalse(hasattr(result, "delivery_lifecycle"))
        # The legitimate fallback case: one refused reply, one plain-text copy that
        # actually reaches the person.
        self.assertEqual(
            self.core.sent, [RICH, _HermesCoreSender.FALLBACK_PREFIX + RICH]
        )
        self.assertEqual(len(await self._await_scheduled_events()), 1)

    # -- 4: terminal rejections stay failures --------------------------------

    async def test_a_quarantined_delivery_returns_false_before_it_is_ever_accepted(self):
        content = "a report for a target this session may not write to"
        delivery_id = _canonical_home_delivery_id(CHAT, content)
        await self.gateway.push_delivery_receipt(
            delivery_id, "failed", stage="authorization", reason="unauthorized_target",
        )
        await self._await_receipt(delivery_id, "failed")

        result = await self.adapter.send(CHAT, content)

        self.assertFalse(result.success)
        self.assertEqual(result.error, "scheduled delivery blocked")
        self.assertFalse(hasattr(result, "delivery_lifecycle"))

    async def test_a_late_failed_receipt_is_terminal_and_never_resends(self):
        result = await self.core.send(CHAT, RICH)
        self.assertTrue(result.success)
        delivery_id = result.delivery_lifecycle["deliveryId"]
        await self._await_scheduled_events()

        self.gateway.schedule_delivery_receipt(
            delivery_id, "failed", stage="projection", reason="render_rejected", delay_s=0.05,
        )
        await self._await_receipt(delivery_id, "failed")

        # Terminal, visible, and NOT re-sent: the occurrence was accepted once.
        self.assertEqual(self._state_of(delivery_id)["state"], "failed")
        self.assertEqual(self.core.sent, [RICH])
        self.assertEqual(len(self._scheduled_events()), 1)

        # A retry of the same occurrence now reports the terminal rejection instead of
        # a pending acceptance.
        retry = await self.adapter.send(CHAT, RICH)
        self.assertFalse(retry.success)
        self.assertEqual(retry.error, "scheduled delivery failed")

    # -- 5: the job ledger reconciles instead of keeping a stale error -------

    async def test_the_send_message_lane_records_acceptance_then_the_displayed_state(self):
        with patch("cozygateway.adapter._resident_adapter", return_value=self.adapter):
            ledger = await _send_message_handler(
                {"target": "cozygateway", "message": RICH}, CHAT, "cozygateway", self.pconfig,
            )

        # What the scheduler writes into job status. A projection-timeout error here is
        # what used to survive long after the occurrence reached the person's screen.
        self.assertTrue(ledger["success"])
        self.assertTrue(ledger["pending"])
        self.assertNotIn("error", ledger)
        self.assertEqual(ledger["state"], "journaled")
        await self._await_scheduled_events()

        delivery_id = ledger["deliveryId"]
        self.gateway.schedule_delivery_receipt(delivery_id, "displayed", delay_s=0.05)
        await self._await_receipt(delivery_id, "displayed")

        landed = self._state_of(delivery_id)
        self.assertEqual(landed["state"], "displayed")
        self.assertEqual(landed["messageId"], ledger["messageId"])
        self.assertEqual(len(self._scheduled_events()), 1)


if __name__ == "__main__":
    unittest.main()

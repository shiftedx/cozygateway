import os
import tempfile
import types
import unittest
import sys
from unittest.mock import patch

from cozygateway.adapter import _standalone_send
from cozygateway.attach_spool import AttachSpool


class ScheduledDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_preserves_caller_thread_delivery_and_message_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            first = await _standalone_send(config, "recipient", "daily note", thread_id="home:daily:2026-08-21")
            second = await _standalone_send(config, "recipient", "daily note", thread_id="home:daily:2026-08-21")
            self.assertTrue(first["success"])
            self.assertTrue(second["success"])

            spool = AttachSpool(path)
            try:
                events = [frame["event"] for frame in spool.pending_events(10, 100_000)]
            finally:
                spool.close()
            self.assertEqual(len(events), 2)
            self.assertEqual({event["threadId"] for event in events}, {"home:daily:2026-08-21"})
            self.assertEqual(len({event["deliveryId"] for event in events}), 1)
            self.assertEqual(len({event["messageId"] for event in events}), 1)

    async def test_missing_target_is_rejected_without_spooling(self):
        config = types.SimpleNamespace(extra={})
        result = await _standalone_send(config, "", "daily note")
        self.assertFalse(result["success"])
        self.assertIn("target thread", result["error"])

    async def test_home_delivery_uses_the_cron_session_as_the_occurrence_key(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "spool.sqlite")
            config = types.SimpleNamespace(extra={"spool_path": path})
            gateway = types.ModuleType("gateway")
            context = types.ModuleType("gateway.session_context")
            run_id = ["run-1"]
            context.get_session_env = lambda key: run_id[0] if key == "HERMES_SESSION_ID" else ""
            with patch.dict(sys.modules, {"gateway": gateway, "gateway.session_context": context}):
                await _standalone_send(config, "home", "same report")
                await _standalone_send(config, "home", "same report")
                run_id[0] = "run-2"
                await _standalone_send(config, "home", "same report")
            spool = AttachSpool(path)
            try:
                events = [frame["event"] for frame in spool.pending_events(10, 100_000)]
            finally:
                spool.close()
            self.assertEqual([event["threadId"] for event in events], ["home", "home", "home"])
            self.assertEqual([event["deliveryId"] for event in events], ["scheduled:run-1", "scheduled:run-1", "scheduled:run-2"])
            self.assertEqual(events[0]["messageId"], events[1]["messageId"])
            self.assertNotEqual(events[1]["messageId"], events[2]["messageId"])


if __name__ == "__main__":
    unittest.main()

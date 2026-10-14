import os
import sqlite3
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock

if "websockets.exceptions" not in sys.modules:
    websockets = types.ModuleType("websockets")
    exceptions = types.ModuleType("websockets.exceptions")
    exceptions.ConnectionClosed = type("ConnectionClosed", (Exception,), {})
    websockets.exceptions = exceptions
    sys.modules["websockets"] = websockets
    sys.modules["websockets.exceptions"] = exceptions

from cozygateway.attach_spool import AttachSpool
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig


class DesktopSessionSyncSpoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")

    def tearDown(self):
        self.tmp.cleanup()

    def test_link_and_cursor_survive_reopen(self):
        spool = AttachSpool(self.path)
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1",
            current_hermes_session_id="desktop-tip",
            source="tui",
            desktop_session_id="desktop-root",
            last_message_row_id=41,
        )
        spool.close()

        reopened = AttachSpool(self.path)
        self.assertEqual(reopened.desktop_session_links(), [{
            "threadId": "native:sage:1",
            "currentHermesSessionId": "desktop-tip",
            "source": "tui",
            "desktopSessionId": "desktop-root",
            "lastMessageRowId": 41,
        }])
        reopened.close()

    def test_message_journal_and_cursor_advance_are_atomic(self):
        spool = AttachSpool(self.path)
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1",
            current_hermes_session_id="desktop-tip",
            source="tui",
            desktop_session_id="desktop-root",
            last_message_row_id=41,
        )

        frame = spool.journal_desktop_session_message(
            thread_id="native:sage:1",
            current_hermes_session_id="desktop-tip",
            source="tui",
            desktop_session_id="desktop-root",
            message_row_id=42,
            role="assistant",
            text="done",
            at=1_700_000_000_000,
        )

        self.assertEqual(frame["event"]["kind"], "desktop_session_message")
        self.assertEqual(frame["event"]["rowId"], "42")
        self.assertEqual(frame["event"]["at"], 1_700_000_000_000)
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 42)
        self.assertEqual(spool.pending_events(10, 100_000), [frame])

        spool._db.execute("""
            CREATE TRIGGER desktop_sync_outbox_abort
            BEFORE INSERT ON event_outbox
            WHEN NEW.frame_json LIKE '%desktop_session_message%'
            BEGIN SELECT RAISE(ABORT, 'test rollback'); END
        """)
        with self.assertRaises(sqlite3.IntegrityError):
            spool.journal_desktop_session_message(
                thread_id="native:sage:1",
                current_hermes_session_id="desktop-tip",
                source="tui",
                desktop_session_id="desktop-root",
                message_row_id=43,
                role="user",
                text="continue",
                at=1_700_000_000_001,
            )
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 42)
        spool.close()

    def test_stale_link_mutations_cannot_retarget_the_durable_lane(self):
        spool = AttachSpool(self.path)
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1", current_hermes_session_id="tip-a", source="tui",
            desktop_session_id="desktop-root", last_message_row_id=9,
        )
        self.assertFalse(spool.advance_desktop_session_link(
            thread_id="native:sage:1", expected_current_hermes_session_id="other-tip",
            current_hermes_session_id="tip-b", expected_source="tui",
            expected_desktop_session_id="desktop-root", last_message_row_id=10,
        ))
        with self.assertRaises(ValueError):
            spool.journal_desktop_session_message(
                thread_id="native:sage:1", current_hermes_session_id="tip-b", source="cozygateway",
                desktop_session_id=None, expected_current_hermes_session_id="tip-a", message_row_id=10,
                role="user", text="wrong lane", at=1,
            )
        self.assertEqual(spool.desktop_session_links()[0], {
            "threadId": "native:sage:1", "currentHermesSessionId": "tip-a", "source": "tui",
            "desktopSessionId": "desktop-root", "lastMessageRowId": 9,
        })
        spool.close()

    def test_journal_rejects_wire_values_beyond_gateway_bounds(self):
        spool = AttachSpool(self.path)
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1", current_hermes_session_id="tip", source="cozygateway",
            desktop_session_id=None, last_message_row_id=0,
        )
        with self.assertRaises(ValueError):
            spool.journal_desktop_session_message(
                thread_id="native:sage:1", current_hermes_session_id="tip", source="cozygateway",
                desktop_session_id=None, message_row_id=1, role="assistant", text="x" * 32_001, at=1,
            )
        self.assertEqual(spool.pending_events(10, 100_000), [])
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 0)
        spool.close()

class DesktopSessionSyncClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")

    def tearDown(self):
        self.tmp.cleanup()

    async def test_client_does_not_journal_sync_rows_without_negotiated_capability(self):
        spool = AttachSpool(self.path)
        spool.upsert_desktop_session_link(
            thread_id="native:sage:1", current_hermes_session_id="desktop-tip", source="tui",
            desktop_session_id="desktop-root", last_message_row_id=41,
        )
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url="https://gateway.invalid", token="test", spool=spool,
        ))
        client._negotiated = True
        client._capabilities = set()
        client._drain_events = AsyncMock()

        sent = await client.send_desktop_session_message(
            thread_id="native:sage:1", current_hermes_session_id="desktop-tip", source="tui",
            desktop_session_id="desktop-root", message_row_id=42, role="assistant", text="done",
            at=1_700_000_000_000,
        )

        self.assertFalse(sent)
        self.assertEqual(spool.pending_events(10, 100_000), [])
        self.assertEqual(spool.desktop_session_links()[0]["lastMessageRowId"], 41)
        client._drain_events.assert_not_awaited()
        spool.close()


if __name__ == "__main__":
    unittest.main()

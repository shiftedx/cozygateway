"""The local attach journal keeps sequence proof after its copied payload expires."""

import json
import os
import tempfile
import unittest

from cozygateway.attach_spool import AttachSpool, TerminalSealed


DAY_MS = 24 * 60 * 60 * 1_000
NOW_MS = 2_000_000_000_000


class AttachSpoolPayloadRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.path, now_ms=lambda: NOW_MS)

    def tearDown(self):
        self.spool.close()
        self.tmp.cleanup()

    def _enqueue_acked(self, event, created_at=NOW_MS - 14 * DAY_MS - 1):
        frame = self.spool.enqueue_event(event)
        self.spool.ack_event(frame["sequence"], frame["eventId"])
        with self.spool._db:
            self.spool._db.execute(
                "UPDATE event_outbox SET created_at = ? WHERE sequence = ?",
                (created_at, frame["sequence"]),
            )
        return frame

    def _stored(self, sequence):
        row = self.spool._db.execute(
            "SELECT event_id, frame_json, byte_count, acked FROM event_outbox WHERE sequence = ?",
            (sequence,),
        ).fetchone()
        return str(row[0]), json.loads(str(row[1])), int(row[2]), int(row[3])

    def test_compacts_only_acked_eligible_rows_strictly_older_than_fourteen_days(self):
        old = self._enqueue_acked({"kind": "draft", "threadId": "t", "turnId": "old", "blocks": [{"type": "paragraph", "text": "private old draft"}]})
        boundary = self._enqueue_acked(
            {"kind": "tool", "threadId": "t", "turnId": "boundary", "callId": "c", "name": "read", "status": "completed", "detail": "private detail"},
            NOW_MS - 14 * DAY_MS,
        )
        pending = self.spool.enqueue_event({"kind": "thinking", "threadId": "t", "turnId": "pending", "text": "still queued", "seq": 1})
        media = self._enqueue_acked({"kind": "media", "media": {"mediaId": "keep-media", "mimeType": "image/png"}})
        approval = self._enqueue_acked({"kind": "approval", "threadId": "t", "turnId": "approval", "approvalId": "a", "callId": "c", "name": "write", "status": "pending"})
        clarify = self._enqueue_acked({"kind": "clarify", "threadId": "t", "turnId": "clarify", "clarifyId": "q", "prompt": "private question", "options": [], "status": "pending"})
        scheduled = self._enqueue_acked({"kind": "scheduled", "threadId": "t", "deliveryId": "d", "messageId": "m", "blocks": []})
        delegation = self._enqueue_acked({"kind": "delegation", "threadId": "t", "turnId": "delegation", "batchId": "b", "childId": "c", "index": 0, "count": 1, "status": "running", "lastActiveAt": 0})

        self.assertEqual(self.spool.compact_acked_payloads(), 1)

        event_id, compacted, byte_count, acked = self._stored(old["sequence"])
        self.assertEqual(event_id, old["eventId"])
        self.assertEqual(acked, 1)
        self.assertEqual(compacted, {"kind": "event", "sequence": old["sequence"], "eventId": old["eventId"], "event": {"kind": "presence", "state": "online"}})
        self.assertEqual(byte_count, len(json.dumps(compacted, separators=(",", ":")).encode("utf-8")))
        self.assertIn("private detail", json.dumps(self._stored(boundary["sequence"])[1]))
        self.assertIn("still queued", json.dumps(self._stored(pending["sequence"])[1]))
        self.assertIn("keep-media", json.dumps(self._stored(media["sequence"])[1]))
        self.assertIn("approvalId", json.dumps(self._stored(approval["sequence"])[1]))
        self.assertIn("private question", json.dumps(self._stored(clarify["sequence"])[1]))
        self.assertIn("deliveryId", json.dumps(self._stored(scheduled["sequence"])[1]))
        self.assertIn("batchId", json.dumps(self._stored(delegation["sequence"])[1]))

    def test_compaction_preserves_cursor_terminal_seal_and_identity_after_restart(self):
        terminal = self._enqueue_acked({"kind": "commit", "threadId": "t", "turnId": "sealed", "messageId": "m", "blocks": [{"type": "paragraph", "text": "private final"}]})
        self.assertEqual(self.spool.compact_acked_payloads(), 1)
        self.assertEqual(self.spool.event_cursor, terminal["sequence"])
        self.spool.close()
        self.spool = AttachSpool(self.path, now_ms=lambda: NOW_MS)

        event_id, compacted, _, acked = self._stored(terminal["sequence"])
        self.assertEqual((event_id, acked), (terminal["eventId"], 1))
        self.assertEqual(compacted["event"], {"kind": "presence", "state": "online"})
        with self.assertRaisesRegex(TerminalSealed, "already has a terminal"):
            self.spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "sealed", "blocks": []})

    def test_compaction_keeps_media_descriptor_available_to_rollback(self):
        media = self._enqueue_acked({"kind": "media", "media": {"mediaId": "old-media", "mimeType": "image/png"}})
        self.assertEqual(self.spool.compact_acked_payloads(), 0)
        self.assertEqual(self.spool.begin_media_cleanup(["old-media"]), [media["sequence"]])
        _, compacted, _, _ = self._stored(media["sequence"])
        self.assertEqual(compacted["event"], {"kind": "presence", "state": "online"})

    def test_compaction_is_bounded_by_source_bytes_and_makes_progress_for_one_large_frame(self):
        large = "x" * (3 * 1024 * 1024)
        first = self._enqueue_acked({"kind": "draft", "threadId": "t", "turnId": "one", "blocks": [{"type": "paragraph", "text": large}]})
        second = self._enqueue_acked({"kind": "draft", "threadId": "t", "turnId": "two", "blocks": [{"type": "paragraph", "text": large}]})
        self.assertEqual(self.spool.compact_acked_payloads(), 1)
        self.assertEqual(self._stored(first["sequence"])[1]["event"]["kind"], "presence")
        self.assertEqual(self._stored(second["sequence"])[1]["event"]["kind"], "draft")
        self.assertEqual(self.spool.compact_acked_payloads(), 1)
        self.assertEqual(self._stored(second["sequence"])[1]["event"]["kind"], "presence")

    def test_candidate_query_uses_partial_index_with_large_acked_history(self):
        frame_json = json.dumps({
            "kind": "event", "sequence": 1, "eventId": "seed",
            "event": {"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []},
        }, separators=(",", ":"))
        with self.spool._db:
            self.spool._db.executemany(
                "INSERT INTO event_outbox (sequence, event_id, frame_json, byte_count, created_at, acked) "
                "VALUES (?, ?, ?, ?, ?, 1)",
                ((index, "seed-%d" % index, frame_json, len(frame_json.encode("utf-8")), NOW_MS - 14 * DAY_MS - 1)
                 for index in range(1, 128_001)),
            )
        plan = " ".join(str(row[-1]) for row in self.spool._db.execute(
            "EXPLAIN QUERY PLAN SELECT sequence, event_id, length(CAST(frame_json AS BLOB)) "
            "FROM event_outbox WHERE acked = 1 AND created_at < ? AND json_valid(frame_json) "
            "AND json_extract(frame_json, '$.event.kind') IN "
            "('draft', 'tool', 'thinking', 'commit', 'failed', 'cancelled', 'interrupted') "
            "ORDER BY created_at, sequence LIMIT 256",
            (NOW_MS - 14 * DAY_MS,),
        ))
        self.assertIn("event_outbox_acked_compaction_candidates", plan, plan)
        self.assertEqual(self.spool.compact_acked_payloads(), 256)


if __name__ == "__main__":
    unittest.main()

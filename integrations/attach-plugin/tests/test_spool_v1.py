import os
import tempfile
import unittest

from cozygateway.attach_spool import AttachSpool, ResumeConflict, TerminalSealed


class AttachSpoolTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
    def tearDown(self):
        self.tmp.cleanup()

    def test_event_sequence_and_unacked_replay_survive_restart(self):
        spool = AttachSpool(self.path)
        first = spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []})
        second = spool.enqueue_event({"kind": "commit", "threadId": "t", "turnId": "u", "messageId": "m", "blocks": []})
        self.assertEqual([first["sequence"], second["sequence"]], [1, 2])
        spool.ack_event(1, first["eventId"])
        instance = spool.instance_id
        spool.close()

        spool = AttachSpool(self.path)
        self.assertEqual(spool.instance_id, instance)
        self.assertEqual([f["sequence"] for f in spool.pending_events(10, 100000)], [2])
        self.assertEqual(spool.event_cursor, 1)
        with self.assertRaises(TerminalSealed):
            spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []})
        spool.close()

    def test_command_is_persisted_before_ack_and_deduped(self):
        spool = AttachSpool(self.path)
        frame = {"kind": "command", "sequence": 1, "commandId": "c1", "command": {"kind": "turn", "threadId": "t", "turnId": "u", "messageId": "m", "text": "hi"}}
        self.assertEqual(spool.accept_command(frame), "accepted")
        self.assertEqual(spool.command_cursor, 1)
        self.assertEqual(spool.accept_command(frame), "duplicate")
        gap = {"kind": "command", "sequence": 3, "commandId": "c3", "command": {"kind": "interrupt", "threadId": "t", "turnId": "u"}}
        self.assertEqual(spool.accept_command(gap), "gap")
        spool.close()

        spool = AttachSpool(self.path)
        self.assertEqual([f["commandId"] for f in spool.pending_commands()], ["c1"])
        spool.mark_command_processed("c1")
        self.assertEqual(spool.pending_commands(), [])
        spool.close()

    def test_server_resume_fast_forwards_only_an_empty_recreated_event_stream(self):
        spool = AttachSpool(self.path)
        spool.reconcile_server_resume(event_sequence=2244, command_sequence=5)
        self.assertEqual(spool.event_cursor, 2244)
        self.assertEqual(spool.command_cursor, 5)
        self.assertEqual(spool.enqueue_event({
            "kind": "draft", "threadId": "t", "turnId": "u", "blocks": []
        })["sequence"], 2245)
        spool.close()

    def test_server_resume_never_skips_a_divergent_pending_event(self):
        spool = AttachSpool(self.path)
        spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": "u", "blocks": []})
        with self.assertRaises(ResumeConflict):
            spool.reconcile_server_resume(event_sequence=2244, command_sequence=5)
        self.assertEqual(spool.event_cursor, 0)
        self.assertEqual(spool.command_cursor, 0)
        self.assertEqual([f["sequence"] for f in spool.pending_events(10, 100000)], [1])
        spool.close()

    def test_atomic_media_rollback_neuters_only_the_target_media_events(self):
        spool = AttachSpool(self.path)
        first = spool.enqueue_event({
            "kind": "media", "media": {"mediaId": "uploaded-first"},
        })
        retained = spool.enqueue_event({
            "kind": "media", "media": {"mediaId": "keep-me"},
        })
        withdrawn = spool.begin_media_cleanup(["uploaded-first"])
        self.assertEqual(withdrawn, [first["sequence"]])
        self.assertEqual(spool.pending_media_cleanups(), ["uploaded-first"])
        spool.mark_media_cleanup_complete("uploaded-first")
        self.assertEqual(spool.pending_media_cleanups(), [])
        # The row survives, so the sequence stays contiguous; only its payload is withdrawn.
        frames = spool.pending_events(10, 100000)
        self.assertEqual(
            [frame["sequence"] for frame in frames],
            [first["sequence"], retained["sequence"]],
        )
        self.assertEqual(frames[0]["event"], {"kind": "presence", "state": "online"})
        self.assertEqual(frames[1]["event"]["media"]["mediaId"], "keep-me")
        spool.close()

    def test_reading_the_pending_tail_never_scans_the_acked_history(self):
        """The read that runs on the event loop must not grow with the outbox.

        ``acked`` is the last column of the row, so an unindexed ``WHERE acked = 0`` makes SQLite
        decode every ``frame_json`` in the file: on a 103k-row spool that is tens of MB of JSON
        per send tick, which is how a Discord shard heartbeat ends up blocked for ten seconds.
        The partial index over the unacked tail is the whole fix, and the query plan is the only
        honest assertion about it.
        """
        spool = AttachSpool(self.path)
        for index in range(50):
            frame = spool.enqueue_event({"kind": "draft", "threadId": "t", "turnId": f"u{index}", "blocks": []})
            if index < 40:
                spool.ack_event(frame["sequence"], frame["eventId"])
        plan = " ".join(
            str(row[-1]) for row in spool._db.execute(
                "EXPLAIN QUERY PLAN SELECT frame_json, byte_count FROM event_outbox"
                " WHERE acked = 0 ORDER BY sequence LIMIT 8"
            )
        )
        self.assertIn("event_outbox_unacked", plan, plan)
        self.assertNotIn("SCAN event_outbox\n", plan + "\n")
        self.assertEqual([frame["sequence"] for frame in spool.pending_events(8, 1_000_000)], list(range(41, 49)))
        spool.close()

    def test_an_existing_spool_gains_the_unacked_index_on_open(self):
        """A wedged spool is repaired by opening it, not by a migration someone must remember."""
        spool = AttachSpool(self.path)
        with spool._db:
            spool._db.execute("DROP INDEX event_outbox_unacked")
        spool.close()

        spool = AttachSpool(self.path)
        indexes = {str(row[1]) for row in spool._db.execute("PRAGMA index_list(event_outbox)")}
        self.assertIn("event_outbox_unacked", indexes)
        spool.close()


if __name__ == "__main__":
    unittest.main()

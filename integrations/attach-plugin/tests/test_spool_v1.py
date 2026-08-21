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


if __name__ == "__main__":
    unittest.main()

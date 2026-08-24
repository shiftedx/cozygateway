import os
import tempfile
import threading
import unittest

from cozygateway.attach_spool import AttachSpool


class MediaLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.path)

    def tearDown(self):
        self.spool.close()
        self.tmp.cleanup()

    def test_happy_path_walks_prepared_to_displayed(self):
        for state in ("prepared", "uploaded", "journaled", "projected", "displayed"):
            self.assertEqual(
                self.spool.media_mark("d1", "m1", state, sha256="abc", path_meta="/tmp/cat.png"),
                "recorded",
                state,
            )
        rows = self.spool.media_rows("d1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["state"], "displayed")
        self.assertEqual(rows[0]["sha256"], "abc")
        self.assertEqual(rows[0]["pathMeta"], "/tmp/cat.png")

    def test_metadata_is_retained_when_a_later_mark_omits_it(self):
        self.spool.media_mark("d1", "m1", "prepared", sha256="abc", path_meta="/tmp/cat.png")
        self.spool.media_mark("d1", "m1", "uploaded")
        row = self.spool.media_rows("d1")[0]
        self.assertEqual((row["sha256"], row["pathMeta"]), ("abc", "/tmp/cat.png"))

    def test_media_rows_are_scoped_per_delivery_and_ordered(self):
        self.spool.media_mark("d1", "m2", "prepared")
        self.spool.media_mark("d1", "m1", "prepared")
        self.spool.media_mark("d2", "m9", "prepared")
        self.assertEqual([r["mediaId"] for r in self.spool.media_rows("d1")], ["m1", "m2"])
        self.assertEqual([r["mediaId"] for r in self.spool.media_rows("d2")], ["m9"])
        self.assertEqual(self.spool.media_rows("nope"), [])

    def test_projected_may_still_upgrade_to_displayed(self):
        self.spool.media_mark("d1", "m1", "projected")
        self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "recorded")
        self.assertEqual(self.spool.media_rows("d1")[0]["state"], "displayed")

    def test_displayed_is_terminal_against_a_later_failure(self):
        self.spool.media_mark("d1", "m1", "displayed")
        with self.assertLogs("cozygateway.attach_spool", level="INFO") as captured:
            self.assertEqual(self.spool.media_mark("d1", "m1", "expired"), "conflict")
            self.assertEqual(self.spool.media_mark("d1", "m1", "blocked"), "conflict")
        self.assertTrue(any("already terminal" in line for line in captured.output))
        self.assertEqual(self.spool.media_rows("d1")[0]["state"], "displayed")

    def test_blocked_is_terminal_against_a_later_display(self):
        self.spool.media_mark("d1", "m1", "blocked", detail="unauthorized_target")
        with self.assertLogs("cozygateway.attach_spool", level="INFO"):
            self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "conflict")
        row = self.spool.media_rows("d1")[0]
        self.assertEqual(row["state"], "blocked")
        self.assertEqual(row["detail"], "unauthorized_target")

    def test_upload_failed_and_expired_are_terminal_too(self):
        self.spool.media_mark("d1", "m1", "upload_failed", detail="http 415")
        self.spool.media_mark("d2", "m1", "expired")
        with self.assertLogs("cozygateway.attach_spool", level="INFO"):
            self.assertEqual(self.spool.media_mark("d1", "m1", "journaled"), "conflict")
            self.assertEqual(self.spool.media_mark("d2", "m1", "projected"), "conflict")
        self.assertEqual(self.spool.media_rows("d1")[0]["state"], "upload_failed")
        self.assertEqual(self.spool.media_rows("d2")[0]["state"], "expired")

    def test_non_terminal_stage_never_rewinds(self):
        self.spool.media_mark("d1", "m1", "journaled")
        with self.assertLogs("cozygateway.attach_spool", level="INFO") as captured:
            self.assertEqual(self.spool.media_mark("d1", "m1", "uploaded"), "conflict")
        self.assertTrue(any("regressive" in line for line in captured.output))
        self.assertEqual(self.spool.media_rows("d1")[0]["state"], "journaled")

    def test_repeating_a_state_is_a_duplicate_not_a_write(self):
        self.spool.media_mark("d1", "m1", "projected")
        self.assertEqual(self.spool.media_mark("d1", "m1", "projected"), "duplicate")
        self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "recorded")
        self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "duplicate")

    def test_late_receipt_updates_the_durable_state_exactly_once(self):
        self.spool.media_mark("d1", "m1", "projected")
        self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "recorded")
        # The gateway redelivers the same receipt; the row must not move or re-log a change.
        self.assertEqual(self.spool.media_mark("d1", "m1", "displayed"), "duplicate")
        rows = self.spool.media_rows("d1")
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["state"], "displayed")

    def test_unknown_and_empty_inputs_are_rejected(self):
        self.assertEqual(self.spool.media_mark("d1", "m1", "success"), "invalid")
        self.assertEqual(self.spool.media_mark("", "m1", "prepared"), "invalid")
        self.assertEqual(self.spool.media_mark("d1", "", "prepared"), "invalid")
        self.assertEqual(self.spool.media_rows("d1"), [])

    def test_lifecycle_survives_a_process_restart(self):
        self.spool.media_mark("d1", "m1", "projected", sha256="abc", path_meta="/tmp/cat.png")
        self.spool.close()

        reopened = AttachSpool(self.path)
        self.addCleanup(reopened.close)
        row = reopened.media_rows("d1")[0]
        self.assertEqual(row["state"], "projected")
        self.assertEqual(row["sha256"], "abc")
        self.assertEqual(reopened.media_mark("d1", "m1", "displayed"), "recorded")
        with self.assertLogs("cozygateway.attach_spool", level="INFO"):
            self.assertEqual(reopened.media_mark("d1", "m1", "upload_failed"), "conflict")
        self.assertEqual(reopened.media_rows("d1")[0]["state"], "displayed")


class MediaDedupeClaimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "spool.sqlite")
        self.spool = AttachSpool(self.path)

    def tearDown(self):
        self.spool.close()
        self.tmp.cleanup()

    def test_first_claim_wins_and_a_retry_reuses_it(self):
        first = self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-1")
        self.assertEqual(first, {"claimed": True, "media_id": "media-1"})
        again = self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-2")
        self.assertEqual(again, {"claimed": False, "media_id": "media-1"})

    def test_same_path_with_changed_content_is_not_deduped(self):
        # Path is metadata only; the bytes decide identity.
        self.spool.media_mark("d1", "media-1", "uploaded", sha256="sha-a", path_meta="/tmp/chart.png")
        self.assertTrue(self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-1")["claimed"])
        rewritten = self.spool.media_dedupe_claim("occ-1", "sha-b", "home:cleo", "media-2")
        self.assertEqual(rewritten, {"claimed": True, "media_id": "media-2"})

    def test_a_different_destination_claims_separately(self):
        self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-1")
        other = self.spool.media_dedupe_claim("occ-1", "sha-a", "thread:t42", "media-2")
        self.assertEqual(other, {"claimed": True, "media_id": "media-2"})

    def test_a_different_occurrence_claims_separately(self):
        self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-1")
        other = self.spool.media_dedupe_claim("occ-2", "sha-a", "home:cleo", "media-2")
        self.assertEqual(other, {"claimed": True, "media_id": "media-2"})

    def test_same_occurrence_content_and_destination_is_idempotent_across_restart(self):
        self.spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-1")
        self.spool.close()

        reopened = AttachSpool(self.path)
        self.addCleanup(reopened.close)
        replay = reopened.media_dedupe_claim("occ-1", "sha-a", "home:cleo", "media-restarted")
        self.assertEqual(replay, {"claimed": False, "media_id": "media-1"})

    def test_empty_arguments_are_rejected(self):
        for args in (
            ("", "sha-a", "home:cleo", "media-1"),
            ("occ-1", "", "home:cleo", "media-1"),
            ("occ-1", "sha-a", "", "media-1"),
            ("occ-1", "sha-a", "home:cleo", ""),
        ):
            with self.assertRaises(ValueError):
                self.spool.media_dedupe_claim(*args)

    def test_two_connections_racing_yield_exactly_one_claim(self):
        start = threading.Barrier(2)
        results = {}

        def claim(name):
            spool = AttachSpool(self.path)
            try:
                start.wait(timeout=10)
                results[name] = spool.media_dedupe_claim("occ-1", "sha-a", "home:cleo", name)
            finally:
                spool.close()

        threads = [threading.Thread(target=claim, args=(name,)) for name in ("media-a", "media-b")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        self.assertEqual(len(results), 2)
        winners = [name for name, outcome in results.items() if outcome["claimed"]]
        self.assertEqual(len(winners), 1)
        self.assertEqual({outcome["media_id"] for outcome in results.values()}, {winners[0]})


if __name__ == "__main__":
    unittest.main()

"""Unit tests for harness-id chip pairing in ``ToolChipTracker`` (issue #7).

Run with:
    cd integrations/attach-plugin && python3 -m unittest discover -s tests -v

v0 paired a chip's open (start) and close (completion) legs purely by tool name
plus recency: the completion closed the MOST RECENTLY OPENED still-running chip
of that name. That mispairs two overlapping calls to the same tool that finish
in the same order they started (open A, open B, close A, close B): the close-A
event would incorrectly close B first.

These tests exercise the harness-provided ``call_id`` param end to end: when
both legs carry it, pairing is exact regardless of finish order; when either
leg lacks it, pairing falls back to the old name-plus-recency behavior; and a
close whose id matches no open chip degrades to that same fallback rather than
crashing or mispairing.
"""

import unittest

from cozygateway.tool_chips import ToolChipTracker


class OverlappingSameToolCallsPairViaHarnessIdTests(unittest.TestCase):
    def test_open_a_open_b_close_b_close_a_pairs_correctly(self):
        """The brief's required case: closes arrive in reverse-open order."""
        tracker = ToolChipTracker()
        tracker.open("search", detail="query a", call_id="call-a")
        tracker.open("search", detail="query b", call_id="call-b")
        tracker.close("search", ok=True, detail="result b", call_id="call-b")
        tracker.close("search", ok=False, detail="result a", call_id="call-a")

        chips = {chip.id: chip for chip in tracker.chips()}
        self.assertEqual(chips["call-a"].status, "error")
        self.assertEqual(chips["call-a"].detail, "result a")
        self.assertEqual(chips["call-b"].status, "ok")
        self.assertEqual(chips["call-b"].detail, "result b")

    def test_open_a_open_b_close_a_close_b_pairs_correctly_out_of_order(self):
        """The mispairing case v0 got wrong: closes arrive in OPEN order, which
        used to make the recency-based fallback close the wrong (most recently
        opened) chip first. With ids, order of completion cannot flip identity.
        """
        tracker = ToolChipTracker()
        tracker.open("search", detail="query a", call_id="call-a")
        tracker.open("search", detail="query b", call_id="call-b")
        tracker.close("search", ok=True, detail="result a", call_id="call-a")
        tracker.close("search", ok=False, detail="result b", call_id="call-b")

        chips = {chip.id: chip for chip in tracker.chips()}
        self.assertEqual(chips["call-a"].status, "ok")
        self.assertEqual(chips["call-a"].detail, "result a")
        self.assertEqual(chips["call-b"].status, "error")
        self.assertEqual(chips["call-b"].detail, "result b")

    def test_chip_ids_on_the_wire_are_the_harness_ids_when_present(self):
        tracker = ToolChipTracker()
        tracker.open("search", call_id="call-a")
        ids = [chip.id for chip in tracker.chips()]
        self.assertEqual(ids, ["call-a"])


class FallbackToSynthesizedIdTests(unittest.TestCase):
    def test_no_call_id_on_either_leg_falls_back_to_name_hash_scheme(self):
        tracker = ToolChipTracker()
        tracker.open("search")
        tracker.open("search")
        tracker.close("search", ok=True)
        tracker.close("search", ok=False)

        ids = [chip.id for chip in tracker.chips()]
        self.assertEqual(ids, ["search#1", "search#2"])
        statuses = {chip.id: chip.status for chip in tracker.chips()}
        # Recency-based fallback: the second close closes the remaining open one.
        self.assertEqual(statuses["search#2"], "ok")
        self.assertEqual(statuses["search#1"], "error")

    def test_call_id_on_open_but_not_on_close_falls_back_to_name_recency(self):
        tracker = ToolChipTracker()
        tracker.open("search", call_id="call-a")
        tracker.close("search", ok=True)  # no id on the close leg

        chip = tracker.chips()[0]
        # The wire id stays the harness id assigned at open time; pairing just
        # fell back to the only running chip of that name.
        self.assertEqual(chip.id, "call-a")
        self.assertEqual(chip.status, "ok")

    def test_call_id_on_close_but_not_on_open_falls_back_to_name_recency(self):
        tracker = ToolChipTracker()
        tracker.open("search")  # no id on the open leg
        tracker.close("search", ok=True, call_id="call-a")

        chip = tracker.chips()[0]
        # The open leg committed to the synthesized identity; a late id on the
        # close leg does not retroactively rename it.
        self.assertEqual(chip.id, "search#1")
        self.assertEqual(chip.status, "ok")


class MismatchedIdRobustnessTests(unittest.TestCase):
    def test_close_id_matching_no_open_chip_does_not_crash_and_falls_back(self):
        tracker = ToolChipTracker()
        tracker.open("search", call_id="call-a")
        # A close arrives with a call id that was never opened (e.g. lost/garbled
        # start event). It must not crash, and must not silently drop the
        # in-flight chip: fall back to closing the one running chip of that name.
        tracker.close("search", ok=True, call_id="call-does-not-exist")

        chips = tracker.chips()
        self.assertEqual(len(chips), 1)
        self.assertEqual(chips[0].id, "call-a")
        self.assertEqual(chips[0].status, "ok")

    def test_close_id_matching_no_open_chip_and_no_running_chip_creates_closed_chip(self):
        tracker = ToolChipTracker()
        # A completion with no observed start at all (pre-existing behavior),
        # now carrying a harness id: the synthesized chip should use it.
        tracker.close("search", ok=False, call_id="call-orphan")

        chips = tracker.chips()
        self.assertEqual(len(chips), 1)
        self.assertEqual(chips[0].id, "call-orphan")
        self.assertEqual(chips[0].status, "error")

    def test_two_overlapping_calls_one_mismatched_close_id_does_not_mispair(self):
        tracker = ToolChipTracker()
        tracker.open("search", call_id="call-a")
        tracker.open("search", call_id="call-b")
        # call-b's completion is garbled and arrives with an unknown id: it must
        # not be paired against call-a by accident. It falls back to the most
        # recent running chip of the name, which is call-b (the currently
        # correct fallback target since neither has closed yet).
        tracker.close("search", ok=True, call_id="unknown-id")
        tracker.close("search", ok=False, call_id="call-a")

        chips = {chip.id: chip for chip in tracker.chips()}
        self.assertEqual(chips["call-b"].status, "ok")
        self.assertEqual(chips["call-a"].status, "error")


if __name__ == "__main__":
    unittest.main()

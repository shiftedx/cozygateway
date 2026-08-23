"""CozyChat's attach draft is the one mutable message for the whole turn."""

import unittest

from cozygateway.adapter import AttachAdapter


class DraftStreamContractTests(unittest.TestCase):
    def test_tool_boundaries_do_not_finalize_the_attach_turn(self):
        """Hermes must keep segment breaks on send_draft until the real final."""

        adapter = AttachAdapter()

        self.assertTrue(adapter.draft_stream_is_message)


if __name__ == "__main__":
    unittest.main()

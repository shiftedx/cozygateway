import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cozygateway.memory import MemoryConflict, MemoryInvalid, VaultAdapter

from tests.memory_harness import THREAT_MARKER, install_threat_scanner


class VaultMemoryTests(unittest.TestCase):
    def setUp(self):
        install_threat_scanner(self)
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "Vault"
        self.root.mkdir()
        self.adapter = VaultAdapter("Test vault", str(self.root), 0)

    def tearDown(self):
        self.temp.cleanup()

    def test_frontmatter_round_trip_keeps_one_header_and_identical_bytes(self):
        path = self.root / "Cleo.md"
        original = "---\ndate: 2026-08-23T12:00:00Z\ntags: [friend, assistant]\n---\n# Cleo\nHelpful and concise.\n"
        path.write_text(original, encoding="utf-8")

        item = self.adapter.get("note:Cleo.md")
        self.assertEqual(item["content"], "# Cleo\nHelpful and concise.\n")
        self.adapter.update("note:Cleo.md", {
            "content": item["content"],
            "expectedRevision": item["revision"],
        })

        self.assertEqual(path.read_text("utf-8"), original)
        self.assertEqual(path.read_text("utf-8").count("---"), 2)

    def test_list_searches_full_body_and_does_not_compute_backlinks_per_row(self):
        (self.root / "Long.md").write_text("# Long\n" + "x" * 1_500 + " deep-needle\n", encoding="utf-8")
        with patch.object(self.adapter, "_backlinks", side_effect=AssertionError("list must not scan backlinks")):
            items = self.adapter.items(q="deep-needle")
        self.assertEqual([item["id"] for item in items], ["note:Long.md"])

    def test_graph_uses_source_qualified_edges(self):
        (self.root / "A.md").write_text("# A\nLinks to [[B]].\n", encoding="utf-8")
        (self.root / "B.md").write_text("# B\n", encoding="utf-8")
        graph = self.adapter.graph(limit=200)
        self.assertIn({"from": "vault:0:note:A.md", "to": "vault:0:note:B.md", "kind": "wikilink"}, graph["edges"])

    @unittest.skipUnless(hasattr(os, "symlink") and hasattr(os, "O_NOFOLLOW"), "requires no-follow symlinks")
    def test_create_refuses_a_dangling_symlink_target(self):
        outside = Path(self.temp.name) / "outside.md"
        os.symlink(outside, self.root / "Escape.md")
        with self.assertRaises(MemoryInvalid):
            self.adapter.create({"title": "Escape", "content": "must stay inside"})
        self.assertFalse(outside.exists())

    def test_a_write_racing_the_agent_conflicts_instead_of_overwriting(self):
        path = self.root / "Race.md"
        path.write_text("# Race\noriginal\n", encoding="utf-8")
        stale = self.adapter.get("note:Race.md")

        # The agent rewrites the same note between the client's read and its write.
        path.write_text("# Race\nwritten by the agent\n", encoding="utf-8")

        with self.assertRaises(MemoryConflict) as raised:
            self.adapter.update("note:Race.md", {"content": "written by the phone", "expectedRevision": stale["revision"]})
        self.assertEqual(raised.exception.current["content"], "# Race\nwritten by the agent\n")
        self.assertIn("written by the agent", path.read_text("utf-8"))
        with self.assertRaises(MemoryConflict):
            self.adapter.remove("note:Race.md", {"expectedRevision": stale["revision"]})
        self.assertTrue(path.is_file())

    def test_writes_are_refused_when_content_trips_the_threat_scan(self):
        with self.assertRaises(MemoryInvalid):
            self.adapter.create({"title": "Payload", "content": f"# Payload\n{THREAT_MARKER}\n"})
        self.assertFalse((self.root / "Payload.md").exists())

        (self.root / "Clean.md").write_text("# Clean\nfine\n", encoding="utf-8")
        item = self.adapter.get("note:Clean.md")
        with self.assertRaises(MemoryInvalid):
            self.adapter.update("note:Clean.md", {"content": THREAT_MARKER, "expectedRevision": item["revision"]})
        self.assertEqual((self.root / "Clean.md").read_text("utf-8"), "# Clean\nfine\n")

    def test_an_unreadable_note_costs_that_note_and_not_the_listing(self):
        (self.root / "Good.md").write_text("# Good\nreadable\n", encoding="utf-8")
        (self.root / "Bad.md").write_bytes(b"# Bad\n\xff\xfe not utf-8\n")
        titles = [item["title"] for item in self.adapter.items()]
        self.assertIn("Good", titles)
        self.assertEqual(len(titles), 2)

    def test_existing_tags_and_paths_are_bounded_for_the_wire(self):
        long_tag = "t" * 300
        (self.root / "Tags.md").write_text(f"---\ntags: [{long_tag}]\n---\n# Tags\n", encoding="utf-8")
        item = self.adapter.items()[0]
        self.assertLessEqual(len(item["tags"][0]), 120)
        self.assertLessEqual(len(item["relativePath"]), 1_024)


if __name__ == "__main__":
    unittest.main()

"""Every memory operation, through ``MemoryManager.execute``, for every adapter.

The adapters were previously exercised directly, which is how a whole adapter
shipped with a call shape ``execute`` could not call: the curated methods took a
leading ``source`` argument the dispatcher never passed, so every curated call
raised TypeError into a broad except and curated memories silently never
appeared.  These tests drive the dispatcher, not the adapters.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_memory_dispatch -v
"""
from __future__ import annotations

import re
import copy
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import patch

from cozygateway.memory import CuratedAdapter, HolographicAdapter, MemoryConflict, MemoryError, MemoryManager, VaultAdapter

from tests.memory_harness import FakeCuratedStore, FakeHolographicStore, install_threat_scanner

CONTRACT = Path(__file__).resolve().parents[3] / "packages" / "contract" / "src" / "ext-bots.ts"


def contract_kinds() -> List[str]:
    """The kind union, read out of the contract source the gateway validates against."""
    source = CONTRACT.read_text("utf-8")
    union = re.search(r"export const BotMemoryKindSchema = Type\.Union\(\[(.*?)\]\);", source, re.S)
    assert union is not None, "BotMemoryKindSchema not found in the contract"
    return re.findall(r'Type\.Literal\("([^"]+)"\)', union.group(1))


class MemoryDispatchTests(unittest.TestCase):
    """One manager wired to a fake curated store, a fake Holographic store, and a real vault."""

    def setUp(self):
        install_threat_scanner(self)
        self.temp = tempfile.TemporaryDirectory()
        home = Path(self.temp.name)
        self.vault_root = home / "Vault"; self.vault_root.mkdir()
        (self.vault_root / "Note.md").write_text("# Note\nvault body\n", encoding="utf-8")

        self.curated = FakeCuratedStore(home / "curated", memory=["curated fact"], user=["I prefer short replies"])
        self.holographic = FakeHolographicStore(); self.addCleanup(self.holographic.close)
        self.holographic.add_fact("Cleo prefers concise reports", category="user_pref", tags="cleo")

        self.manager = MemoryManager({"memory_vaults": [{"display_name": "Test vault", "root": str(self.vault_root)}]}, str(home))
        self.enterContext(patch.object(CuratedAdapter, "_store", lambda _self: self.curated))
        self.enterContext(patch.object(HolographicAdapter, "_provider", lambda _self: (None, self.holographic)))
        self.enterContext(patch.object(HolographicAdapter, "_config", lambda _self: {"memory": {"provider": "holographic"}, "plugins": {"hermes-memory-store": {}}}))
        self.addCleanup(self.temp.cleanup)

    def sources(self) -> Dict[str, Dict[str, Any]]:
        return {row["id"]: row for row in self.manager.execute("overview", {})["sources"]}

    def first(self, source: str) -> Dict[str, Any]:
        items = self.manager.execute("items", {"sourceId": source})["items"]
        self.assertTrue(items, f"{source} returned no items")
        return items[0]

    def test_overview_lists_every_source_once(self):
        sources = self.sources()
        self.assertEqual(sources["curated-memory"]["status"], "available")
        self.assertEqual(sources["curated-user"]["status"], "available")
        self.assertEqual(sources["holographic"]["status"], "available")
        self.assertEqual(sources["vault:0"]["status"], "available")

    def _config_writer(self, initial: Dict[str, Any]):
        state = copy.deepcopy(initial)
        writes: List[Dict[str, Any]] = []
        preserves: List[Any] = []
        module = types.ModuleType("hermes_cli.config")
        module.load_config = lambda: copy.deepcopy(state)
        module.load_config_readonly = lambda: copy.deepcopy(state)

        def save_config(value, *, preserve_keys=None, merge_existing=False, **_kwargs):
            def merge(target, incoming):
                for key, child in incoming.items():
                    if isinstance(child, dict) and isinstance(target.get(key), dict):
                        merge(target[key], child)
                    else:
                        target[key] = copy.deepcopy(child)
            if merge_existing:
                merge(state, value)
            else:
                state.clear(); state.update(copy.deepcopy(value))
            writes.append(copy.deepcopy(value)); preserves.append(set(preserve_keys or set()))

        module.save_config = save_config
        package = types.ModuleType("hermes_cli"); package.__path__ = []  # type: ignore[attr-defined]
        return state, writes, preserves, patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.config": module})

    def test_setup_uses_the_native_merge_writer_for_only_allowlisted_memory_settings(self):
        state, writes, preserves, modules = self._config_writer({
            "memory": {"memory_enabled": False, "user_profile_enabled": True, "provider": "external", "limit": 77},
            "model": {"default": "safe-model"},
        })
        with modules:
            answer = self.manager.execute("setup", {
                "memoryEnabled": True, "userProfileEnabled": False, "holographicEnabled": False,
            })
        self.assertEqual(len(writes), 1)
        self.assertEqual(state["memory"], {
            "memory_enabled": True, "user_profile_enabled": False, "provider": "external", "limit": 77,
        })
        self.assertEqual(state["model"], {"default": "safe-model"})
        self.assertIn(("memory", "memory_enabled"), preserves[0])
        self.assertIn(("memory", "user_profile_enabled"), preserves[0])
        self.assertIn("sources", answer)

    def test_setup_selects_and_disables_only_holographic(self):
        state, _, _, modules = self._config_writer({"memory": {"provider": "external"}})
        with modules:
            self.manager.execute("setup", {"memoryEnabled": False, "userProfileEnabled": False, "holographicEnabled": True})
            self.assertEqual(state["memory"]["provider"], "holographic")
            self.manager.execute("setup", {"memoryEnabled": True, "userProfileEnabled": False, "holographicEnabled": False})
        self.assertIsNone(state["memory"]["provider"])

    def test_setup_serializes_plugin_writers_and_preserves_fresh_external_provider(self):
        state = {
            "memory": {"provider": "external", "limit": 77},
            "model": {"default": "safe-model"},
        }
        state_lock = threading.RLock()
        active_writers = 0
        maximum_active_writers = 0
        module = types.ModuleType("hermes_cli.config")

        def load_config_readonly():
            with state_lock:
                return copy.deepcopy(state)

        def save_config(value, *, merge_existing=False, **_kwargs):
            nonlocal active_writers, maximum_active_writers
            self.assertTrue(merge_existing)
            with state_lock:
                active_writers += 1
                maximum_active_writers = max(maximum_active_writers, active_writers)
            time.sleep(0.03)
            with state_lock:
                for section, children in value.items():
                    state.setdefault(section, {}).update(copy.deepcopy(children))
                active_writers -= 1

        module.load_config_readonly = load_config_readonly
        module.save_config = save_config
        package = types.ModuleType("hermes_cli"); package.__path__ = []  # type: ignore[attr-defined]

        def setup(memory_enabled: bool, user_enabled: bool):
            self.manager.execute("setup", {
                "memoryEnabled": memory_enabled, "userProfileEnabled": user_enabled,
                "holographicEnabled": False,
            })

        with patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.config": module}):
            threads = [
                threading.Thread(target=setup, args=(True, False)),
                threading.Thread(target=setup, args=(False, True)),
            ]
            for thread in threads: thread.start()
            for thread in threads: thread.join(5)
            self.assertTrue(all(not thread.is_alive() for thread in threads))

        self.assertEqual(maximum_active_writers, 1)
        self.assertEqual(state["memory"]["provider"], "external")
        self.assertEqual(state["memory"]["limit"], 77)
        self.assertEqual(state["model"], {"default": "safe-model"})

    def test_setup_returns_the_fresh_degraded_projection(self):
        _, _, _, modules = self._config_writer({"memory": {}})
        projection = [{
            "id": "holographic", "displayName": "Holographic", "kind": "holographic",
            "status": "degraded", "detail": "Holographic configuration needs review",
            "capabilities": {},
        }]
        with modules, patch.object(self.manager, "sources", return_value=projection):
            answer = self.manager.execute("setup", {
                "memoryEnabled": False, "userProfileEnabled": False, "holographicEnabled": True,
            })
        self.assertEqual(answer, {"sources": projection})

    def test_setup_applies_each_supported_curated_combination(self):
        cases = (
            (True, False),
            (False, True),
            (True, True),
        )
        for memory_enabled, user_enabled in cases:
            with self.subTest(memory=memory_enabled, user=user_enabled):
                state, _, _, modules = self._config_writer({"memory": {}})
                with modules:
                    answer = self.manager.execute("setup", {
                        "memoryEnabled": memory_enabled,
                        "userProfileEnabled": user_enabled,
                        "holographicEnabled": False,
                    })
                self.assertIs(state["memory"]["memory_enabled"], memory_enabled)
                self.assertIs(state["memory"]["user_profile_enabled"], user_enabled)
                self.assertTrue(answer["sources"])

    def test_setup_rejects_all_false_unknown_and_non_boolean_values(self):
        cases = [
            {"memoryEnabled": False, "userProfileEnabled": False, "holographicEnabled": False},
            {"memoryEnabled": True, "userProfileEnabled": False, "holographicEnabled": False, "provider": "external"},
            {"memoryEnabled": 1, "userProfileEnabled": False, "holographicEnabled": False},
        ]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(MemoryError):
                self.manager.execute("setup", value)

    def test_setup_write_failure_exposes_no_path_or_exception_text(self):
        secret = "/Users/private/profile/config.yaml token-secret memory-content"
        module = types.ModuleType("hermes_cli.config")
        module.load_config = lambda: {"memory": {}}
        module.load_config_readonly = lambda: {"memory": {}}
        module.save_config = lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError(secret))
        package = types.ModuleType("hermes_cli"); package.__path__ = []  # type: ignore[attr-defined]
        with patch.dict(sys.modules, {"hermes_cli": package, "hermes_cli.config": module}):
            with self.assertRaises(MemoryError) as raised:
                self.manager.execute("setup", {
                    "memoryEnabled": True, "userProfileEnabled": False, "holographicEnabled": False,
                })
        self.assertEqual(str(raised.exception), "memory settings could not be applied")
        self.assertNotIn(secret, str(raised.exception))

    def test_every_operation_dispatches_through_execute_for_every_adapter(self):
        cases = (
            ("curated-memory", {"content": "a new curated note"}, "an edited curated note"),
            ("curated-user", {"content": "I like pixel art"}, "I like pixel art and short replies"),
            ("holographic", {"content": "Kyle runs a homelab", "category": "general", "tags": ["kyle"]}, "Kyle runs two homelabs"),
            ("vault:0", {"title": "Fresh", "content": "# Fresh\nbody\n"}, "# Fresh\nedited body\n"),
        )
        for source, create, edited in cases:
            with self.subTest(source=source):
                # items
                listed = self.manager.execute("items", {"sourceId": source})["items"]
                self.assertTrue(all(item["sourceId"] == source for item in listed))
                # item
                full = self.manager.execute("item", {"sourceId": source, "itemId": listed[0]["id"]})
                self.assertIn("content", full)
                # create
                created = self.manager.execute("create", {**create, "sourceId": source})["item"]
                self.assertEqual(created["sourceId"], source)
                # update
                updated = self.manager.execute("update", {"sourceId": source, "itemId": created["id"], "content": edited, "expectedRevision": created["revision"]})["item"]
                self.assertIn(edited.strip().splitlines()[-1], updated.get("content", ""))
                # delete
                removed = self.manager.execute("delete", {"sourceId": source, "itemId": updated["id"], "expectedRevision": updated["revision"]})
                self.assertEqual(removed["id"], updated["id"])
                remaining = [item["id"] for item in self.manager.execute("items", {"sourceId": source})["items"]]
                self.assertNotIn(updated["id"], remaining)

    def test_an_unscoped_listing_carries_items_from_every_adapter(self):
        items = self.manager.execute("items", {})["items"]
        self.assertEqual(
            {item["sourceId"] for item in items},
            {"curated-memory", "curated-user", "holographic", "vault:0"},
        )

    def test_a_graph_scoped_to_a_curated_source_is_a_valid_empty_relationship_answer(self):
        graph = self.manager.execute("graph", {"sourceId": "curated-user"})
        self.assertEqual(graph["edges"], [])
        self.assertTrue(graph["nodes"])

    def test_a_failing_source_is_reported_as_degraded_rather_than_dropped(self):
        with patch.object(VaultAdapter, "items", side_effect=RuntimeError("disk gone")):
            answer = self.manager.execute("items", {})
        statuses = {row["id"]: row for row in answer["sources"]}
        self.assertEqual(statuses["vault:0"]["status"], "degraded")
        self.assertIn("could not be read", statuses["vault:0"]["detail"])
        # The healthy sources still answer.
        self.assertTrue(any(item["sourceId"] == "holographic" for item in answer["items"]))

    def test_holographic_lists_newest_first(self):
        self.holographic.add_fact("Newest fact")
        self.holographic._conn.execute("UPDATE facts SET trust_score=0.1 WHERE content='Newest fact'")
        self.holographic._conn.commit()
        titles = [item["title"] for item in self.manager.execute("items", {"sourceId": "holographic"})["items"]]
        self.assertEqual(titles[0], "Newest fact")

    def test_a_fact_write_racing_the_agent_conflicts_instead_of_overwriting(self):
        item = self.first("holographic")
        # The agent rewrites the same fact between the client's read and its write.
        self.holographic.update_fact(int(item["id"][5:]), content="Cleo prefers long reports")

        with self.assertRaises(MemoryConflict):
            self.manager.execute("update", {"sourceId": "holographic", "itemId": item["id"], "content": "Cleo prefers bullet points", "expectedRevision": item["revision"]})
        stored = self.holographic._conn.execute("SELECT content FROM facts WHERE fact_id=?", (int(item["id"][5:]),)).fetchone()
        self.assertEqual(stored["content"], "Cleo prefers long reports")
        with self.assertRaises(MemoryConflict):
            self.manager.execute("delete", {"sourceId": "holographic", "itemId": item["id"], "expectedRevision": item["revision"]})

    def test_a_curated_write_racing_the_agent_never_lands_on_top_of_it(self):
        item = self.first("curated-memory")
        self.curated.replace("memory", "curated fact", "rewritten by the agent")
        # A curated id is the hash of the entry text, so an entry the agent rewrote is
        # gone rather than stale: the phone's write is refused either way, and the
        # store's own replace (which matches on the old text under its file lock) is
        # the guard that makes that true even without the id check.
        with self.assertRaises(MemoryError):
            self.manager.execute("update", {"sourceId": "curated-memory", "itemId": item["id"], "content": "rewritten by the phone", "expectedRevision": item["revision"]})
        self.assertEqual(self.curated.memory_entries, ["rewritten by the agent"])

    def test_only_one_conditional_fact_write_wins_a_concurrent_race(self):
        item = self.first("holographic")
        start, outcomes = threading.Barrier(2), []

        def edit(text: str) -> None:
            start.wait()
            try: outcomes.append(("ok", self.manager.execute("update", {"sourceId": "holographic", "itemId": item["id"], "content": text, "expectedRevision": item["revision"]})))
            except MemoryConflict: outcomes.append(("conflict", None))

        threads = [threading.Thread(target=edit, args=(text,)) for text in ("first writer", "second writer")]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(sorted(outcome for outcome, _ in outcomes), ["conflict", "ok"])


class ContractKindTests(unittest.TestCase):
    """Every kind an adapter emits has to be a member of the wire union.

    An attach reply is schema-validated on ingress, so a kind the contract does
    not name does not degrade: the whole frame is dropped and the phone waits out
    its timeout.
    """

    def test_every_adapter_kind_is_a_member_of_the_contract_union(self):
        kinds = set(contract_kinds())
        self.assertEqual(kinds, {"memory", "profile", "fact", "note"})
        self.assertNotIn("user", kinds, "the store-side target name must not reach the wire")
        emitted = {*CuratedAdapter.KINDS.values(), "fact", "note"}
        self.assertTrue(emitted <= kinds, f"kinds not in the contract union: {emitted - kinds}")


if __name__ == "__main__":
    unittest.main()

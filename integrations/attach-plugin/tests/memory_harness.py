"""Shared stand-ins for the Hermes modules the memory adapters import lazily.

The plugin runs inside Hermes and reaches for ``tools.threat_patterns`` and the
curated / Holographic stores at call time.  These tests run harness-free, so the
seams are stubbed here once rather than in every module, and the stubs behave the
way the real ones do at the boundary that matters: the scanner refuses content
carrying a threat marker, and the fake stores enforce the same conditions the
real ones do (curated ``replace`` matches on the old entry text, the Holographic
UPDATE is conditional).
"""
from __future__ import annotations

import sqlite3
import sys
import threading
import types
from pathlib import Path
from typing import Any, Dict, List, Optional

#: Any content containing this marker is treated as a threat by the stub scanner.
THREAT_MARKER = "ignore all previous instructions"


def install_threat_scanner(test: Any, blocked: Optional[str] = None) -> None:
    """Install a ``tools.threat_patterns`` stub for the duration of one test.

    The adapters refuse a write they cannot scan, so a test that writes must
    declare which scanner it is writing against.
    """
    marker = THREAT_MARKER if blocked is None else blocked

    def first_threat_message(content: str, scope: str = "strict") -> Optional[str]:
        return f"Blocked: content matches threat pattern (scope {scope})." if marker in content else None

    module = types.ModuleType("tools.threat_patterns")
    module.first_threat_message = first_threat_message  # type: ignore[attr-defined]
    package = sys.modules.get("tools") or types.ModuleType("tools")
    saved = {"tools": sys.modules.get("tools"), "tools.threat_patterns": sys.modules.get("tools.threat_patterns")}
    package.threat_patterns = module  # type: ignore[attr-defined]
    sys.modules["tools"] = package
    sys.modules["tools.threat_patterns"] = module

    def restore() -> None:
        for name, value in saved.items():
            if value is None: sys.modules.pop(name, None)
            else: sys.modules[name] = value

    test.addCleanup(restore)


class FakeCuratedStore:
    """The slice of Hermes' built-in ``MemoryStore`` the curated adapter uses.

    ``replace`` mirrors the real store's guard: it matches on the OLD entry text
    and refuses when that text is gone, which is what makes a lost race a
    conflict rather than a silent overwrite.
    """

    def __init__(self, root: Path, memory: Optional[List[str]] = None, user: Optional[List[str]] = None, enabled: bool = True):
        self.root = root
        self.memory_entries = list(memory or [])
        self.user_entries = list(user or [])
        self.memory_char_limit, self.user_char_limit = 2_200, 1_375
        self.enabled = enabled
        self._flush("memory"); self._flush("user")

    def _entries(self, target: str) -> List[str]:
        return self.memory_entries if target == "memory" else self.user_entries

    def _path_for(self, target: str) -> Path:
        return self.root / f"{target}.md"

    def _flush(self, target: str) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        self._path_for(target).write_text("\n§\n".join(self._entries(target)), encoding="utf-8")

    def target_enabled(self, target: str) -> bool:
        return self.enabled

    def load_from_disk(self) -> None:
        for target in ("memory", "user"):
            path = self._path_for(target)
            if not path.exists(): continue
            text = path.read_text("utf-8")
            entries = [entry for entry in text.split("\n§\n") if entry]
            if target == "memory": self.memory_entries = entries
            else: self.user_entries = entries

    def add(self, target: str, content: str) -> Dict[str, Any]:
        if not self.enabled: return {"success": False, "error": "disabled"}
        self._entries(target).append(content.strip()); self._flush(target)
        return {"success": True}

    def replace(self, target: str, old_text: str, new_content: str) -> Dict[str, Any]:
        entries = self._entries(target)
        matches = [index for index, entry in enumerate(entries) if old_text.strip() in entry]
        if not matches: return {"success": False, "error": "no entry matched"}
        entries[matches[0]] = new_content.strip(); self._flush(target)
        return {"success": True}

    def remove(self, target: str, old_text: str) -> Dict[str, Any]:
        entries = self._entries(target)
        matches = [index for index, entry in enumerate(entries) if old_text.strip() in entry]
        if not matches: return {"success": False, "error": "no entry matched"}
        entries.pop(matches[0]); self._flush(target)
        return {"success": True}


class FakeHolographicStore:
    """A real SQLite ``facts`` table behind the store methods the adapter calls.

    Backed by SQLite rather than a dict on purpose: the adapter's conflict guard
    is a conditional UPDATE with a rowcount check, which only means anything
    against a real statement.
    """

    def __init__(self) -> None:
        self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute(
            "CREATE TABLE facts (fact_id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT UNIQUE, category TEXT, tags TEXT,"
            " trust_score REAL DEFAULT 0.5, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)"
        )
        self._conn.execute("CREATE TABLE entities (entity_id INTEGER PRIMARY KEY)")
        self._conn.execute("CREATE TABLE fact_entities (fact_id INTEGER, entity_id INTEGER)")
        self._conn.commit()
        self._lock = threading.RLock()

    def close(self) -> None:
        self._conn.close()

    def add_fact(self, content: str, category: str = "general", tags: str = "") -> int:
        with self._lock:
            cursor = self._conn.execute("INSERT INTO facts (content,category,tags) VALUES (?,?,?)", (content.strip(), category, tags))
            self._conn.commit()
            return int(cursor.lastrowid)

    def search_facts(self, query: str, limit: int = 10, **_: Any) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT fact_id,content,category,tags,trust_score,created_at,updated_at FROM facts WHERE content LIKE ? ORDER BY trust_score DESC LIMIT ?",
                (f"%{query.strip()}%", limit),
            ).fetchall()
            return [dict(row) for row in rows]

    def list_facts(self, limit: int = 50, **_: Any) -> List[Dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT fact_id,content,category,tags,trust_score,created_at,updated_at FROM facts ORDER BY trust_score DESC LIMIT ?",
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]

    def update_fact(self, fact_id: int, content: Optional[str] = None, category: Optional[str] = None, tags: Optional[str] = None, **_: Any) -> bool:
        with self._lock:
            row = self._conn.execute("SELECT fact_id FROM facts WHERE fact_id=?", (fact_id,)).fetchone()
            if row is None: return False
            assignments, params = ["updated_at = strftime('%Y-%m-%d %H:%M:%f','now')"], []
            if content is not None: assignments.append("content = ?"); params.append(content.strip())
            if category is not None: assignments.append("category = ?"); params.append(category)
            if tags is not None: assignments.append("tags = ?"); params.append(tags)
            params.append(fact_id)
            self._conn.execute(f"UPDATE facts SET {', '.join(assignments)} WHERE fact_id = ?", params)
            self._conn.commit()
            return True

    def remove_fact(self, fact_id: int) -> bool:
        with self._lock:
            row = self._conn.execute("SELECT fact_id FROM facts WHERE fact_id=?", (fact_id,)).fetchone()
            if row is None: return False
            self._conn.execute("DELETE FROM facts WHERE fact_id=?", (fact_id,))
            self._conn.commit()
            return True

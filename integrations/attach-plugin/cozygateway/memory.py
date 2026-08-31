"""Profile-local Memory management adapters for CozyGateway attach-v1.

This module deliberately runs beside Hermes.  Gateway only forwards bounded
requests; neither it nor a phone gets a filesystem path or opens provider SQL.
Writes use Hermes' MemoryStore / Holographic MemoryStore public mutation paths.
"""
from __future__ import annotations

import contextlib
import hashlib
import errno
import json
import logging
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

try:
    import fcntl
except ImportError:  # pragma: no cover - POSIX only
    fcntl = None  # type: ignore[assignment]

# Memory content never reaches a log line here: a fault is logged by source id and
# exception class only, and never with ``exc_info``, whose UnicodeDecodeError args
# carry the offending file bytes.
logger = logging.getLogger(__name__)

_MAX_ITEMS = 100
_MAX_GRAPH_ITEMS = 200
_MAX_SOURCE_SCAN = 5_000
_MAX_TEXT = 32_000
_WIKILINK = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")


def _now() -> int: return int(time.time() * 1000)
def _millis(value: Any) -> Optional[int]:
    """Parse one ISO-8601 stamp (a naive value is read as UTC) into epoch millis."""
    if not value: return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None: parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except Exception: return None
def _hash(value: str) -> str: return hashlib.sha256(value.encode("utf-8")).hexdigest()
def _revision(*parts: str) -> str: return _hash("\0".join(parts))
def _snippet(value: str) -> str: return " ".join(value.split())[:1_000]
def _title(value: str, fallback: str = "Memory") -> str: return next((line.strip("# ").strip() for line in value.splitlines() if line.strip()), fallback)[:512]

def _caps(**yes: bool) -> Dict[str, bool]:
    keys = ("create", "edit", "delete", "relationships", "capacity", "effectiveNextSession")
    return {key: bool(yes.get(key, False)) for key in keys}


class MemoryError(Exception):
    status = "unavailable"
class MemoryConflict(MemoryError):
    status = "conflict"
    def __init__(self, current: Optional[Dict[str, Any]] = None): super().__init__("memory item changed; refresh and try again"); self.current = current
class MemoryNotFound(MemoryError): status = "not_found"
class MemoryInvalid(MemoryError): status = "invalid_request"


def _scan_content(content: str) -> None:
    """Refuse memory content that trips Hermes' write-time threat scan.

    Curated writes inherit this scan inside Hermes' own ``MemoryStore.add`` /
    ``replace``; vault notes and Holographic facts reach their stores raw, so the
    same seam is called here rather than a private copy of the pattern set that
    would drift.  The scan is mandatory: if the harness module cannot be imported
    the write is REFUSED rather than written unscanned, because everything in
    these stores is injected into a future system prompt.
    """
    try:
        from tools.threat_patterns import first_threat_message
        finding = first_threat_message(content, scope="strict")
    except Exception:
        raise MemoryInvalid("memory content could not be safety checked; nothing was written") from None
    if finding: raise MemoryInvalid(str(finding)[:512])


def _read_text(path: Path) -> str:
    """Read one note tolerantly.  A single note with undecodable bytes must not
    abort a whole vault listing, and ``errors="replace"`` also keeps those bytes
    out of a UnicodeDecodeError whose args would otherwise reach a log line."""
    return path.read_text("utf-8", errors="replace")


@contextlib.contextmanager
def _exclusive(path: Path) -> Iterator[None]:
    """Hold an exclusive lock for one note's read-modify-write.

    The lock is a sidecar rather than the note itself, because an atomic update
    replaces the note's inode and a lock held on that inode would guard nothing.
    The sidecar lives in a machine-local lock directory keyed by the note's
    absolute path, so a user's vault never collects lock files.
    """
    if fcntl is None:
        yield
        return
    locks = Path(tempfile.gettempdir()) / "cozygateway-memory-locks"
    lock_path = locks / f"{_hash(str(path))}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(lock_path, "a+", encoding="utf-8")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield
    finally:
        try: fcntl.flock(handle, fcntl.LOCK_UN)
        finally: handle.close()


class Observations:
    """Tiny atomic sidecar for curated first observation / UI creation timestamps."""
    def __init__(self, path: Path): self.path, self.data = path, self._load()
    def _load(self) -> Dict[str, int]:
        try:
            raw = json.loads(self.path.read_text("utf-8")); return raw if isinstance(raw, dict) else {}
        except Exception: return {}
    def get(self, key: str) -> Optional[int]:
        value = self.data.get(key); return value if isinstance(value, int) and value >= 0 else None
    def observe(self, key: str, at: Optional[int] = None) -> int:
        old = self.get(key)
        if old is not None: return old
        value = _now() if at is None else at; self.data[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(prefix="memory-observed-", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out: json.dump(self.data, out, separators=(",", ":")); out.flush(); os.fsync(out.fileno())
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        return value


class CuratedAdapter:
    """One curated built-in store (``memory`` or the ``user`` About-me profile).

    There is one adapter INSTANCE per curated source rather than one adapter that
    takes the source as a leading argument, so every adapter in this module has
    the same call shape and ``MemoryManager.execute`` can dispatch uniformly.
    """
    #: Curated sources this adapter serves, as (source id, store target, label).
    SOURCES: Tuple[Tuple[str, str, str], ...] = (
        ("curated-memory", "memory", "Curated notes"),
        ("curated-user", "user", "About me"),
    )
    #: Store target -> the wire kind it is published as.  ``user`` is a store-side
    #: name; the contract calls the About-me entries ``profile``.
    KINDS = {"memory": "memory", "user": "profile"}

    def __init__(self, source: str, observations: Observations):
        target = next((row[1] for row in self.SOURCES if row[0] == source), None)
        if target is None: raise MemoryNotFound("unknown curated source")
        self.source, self.target, self.observations = source, target, observations
        self.display_name = next(row[2] for row in self.SOURCES if row[0] == source)
    @property
    def kind(self) -> str: return self.KINDS[self.target]
    def _store(self):
        from tools.memory_tool import MemoryStore
        from tools.memory_tool import get_builtin_memory_config, get_builtin_memory_store_flags
        try:
            from hermes_cli.config import load_config_readonly
            config = load_config_readonly()
        except Exception: config = {}
        settings = get_builtin_memory_config(config); memory, user = get_builtin_memory_store_flags(config)
        store = MemoryStore(memory_char_limit=settings.get("memory_char_limit", 2200), user_char_limit=settings.get("user_char_limit", 1375), memory_enabled=memory, user_profile_enabled=user)
        store.load_from_disk(); return store
    def describe(self) -> Dict[str, Any]:
        try:
            store = self._store()
            entries = store.memory_entries if self.target == "memory" else store.user_entries
            limit = store.memory_char_limit if self.target == "memory" else store.user_char_limit
            enabled = store.target_enabled(self.target)
            return {"id": self.source, "displayName": self.display_name, "kind": self.kind, "status": "available" if enabled else "unavailable", "capabilities": _caps(create=enabled, edit=enabled, delete=enabled, capacity=True, effectiveNextSession=True), "capacity": {"used": len("\n§\n".join(entries)), "limit": limit}, "effectiveNextSession": True}
        except Exception as error:
            logger.debug("memory: curated source %s is unavailable (%s)", self.source, type(error).__name__)
            return {"id": self.source, "displayName": self.display_name, "kind": self.kind, "status": "unavailable", "detail": "Curated memory is unavailable", "capabilities": _caps()}
    def _items(self, content: bool = False) -> List[Dict[str, Any]]:
        store = self._store(); entries = store.memory_entries if self.target == "memory" else store.user_entries
        path = store._path_for(self.target); file_rev = _hash(_read_text(path)) if path.exists() else _hash("")
        result = []
        for text in entries:
            item_id = f"{self.target}:{_hash(text)}"; created = self.observations.observe(f"{self.source}:{item_id}")
            result.append({"id": item_id, "sourceId": self.source, "kind": self.kind, "title": _title(text), "snippet": _snippet(text), **({"content": text[:_MAX_TEXT]} if content else {}), "createdAt": created, "updatedAt": int(path.stat().st_mtime * 1000) if path.exists() else created, "timestampKind": "firstObserved", "revision": _revision(file_rev, text), "effectiveNextSession": True})
        return result
    def items(self, q: str = "", **_: Any) -> List[Dict[str, Any]]:
        values = self._items(); needle = q.lower().strip(); return [item for item in values if not needle or needle in item["title"].lower() or needle in item["snippet"].lower()]
    def get(self, item_id: str) -> Dict[str, Any]:
        item = next((item for item in self._items(True) if item["id"] == item_id), None)
        if item is None: raise MemoryNotFound("memory item not found")
        return item
    def graph(self, q: str = "", **filters: Any) -> Dict[str, Any]:
        """Curated entries are a flat list: real nodes, and no relationships to
        draw.  Answering with an empty edge set keeps a graph request scoped to a
        curated source a valid answer rather than a missing-attribute fault."""
        limit = min(max(int(filters.get("limit", _MAX_GRAPH_ITEMS)), 1), _MAX_GRAPH_ITEMS)
        return {"nodes": self.items(q=q)[:limit], "edges": []}
    def _fresh(self, item_id: str, expected: str) -> Tuple[Any, str]:
        item = self.get(item_id)
        if item["revision"] != expected: raise MemoryConflict(item)
        return self._store(), item["content"]
    def create(self, input: Dict[str, Any]) -> Dict[str, Any]:
        store = self._store(); answer = store.add(self.target, input["content"])
        if not answer.get("success"): raise MemoryInvalid("curated memory could not be written")
        return {"item": next(item for item in self._items(True) if item["content"] == input["content"])}
    def update(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        # The revision check in `_fresh` is advisory; the store's own `replace` is the
        # real guard, and it is not check-then-write: it takes the memory file's
        # exclusive lock, re-reads the file inside that lock, and matches on the
        # OLD entry text, refusing the write when that text is gone.
        store, old = self._fresh(item_id, input["expectedRevision"]); answer = store.replace(self.target, old, input["content"])
        if not answer.get("success"):
            # A refusal because the old entry is no longer there is a lost race, not
            # a bad request.  The store's own error string is not forwarded: it
            # quotes the entry text, which must not ride an error frame.
            if not any(item["id"] == item_id for item in self._items()): raise MemoryConflict()
            raise MemoryInvalid("curated memory could not be written")
        return {"item": next(item for item in self._items(True) if item["content"] == input["content"])}
    def remove(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        store, old = self._fresh(item_id, input["expectedRevision"]); answer = store.remove(self.target, old)
        if not answer.get("success"): raise MemoryInvalid("curated memory could not be deleted")
        return {"id": item_id, "revision": input["expectedRevision"]}


class HolographicAdapter:
    source = "holographic"
    CONFIG_KEY = "hermes-memory-store"
    def _config(self) -> Dict[str, Any]:
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly()
        return config if isinstance(config, dict) else {}
    def _provider(self):
        from plugins.memory.holographic import HolographicMemoryProvider
        config = self._config(); memory = config.get("memory", {}) if isinstance(config, dict) else {}
        if str(memory.get("provider", "")).strip().lower() != "holographic": raise MemoryNotFound("Holographic is not the active provider")
        canonical = ((config.get("plugins", {}) or {}).get(self.CONFIG_KEY, {}) or {})
        provider = HolographicMemoryProvider(config=canonical); provider.initialize("cozygateway-memory")
        return provider, provider._store
    def describe(self) -> Dict[str, Any]:
        try:
            self._provider()
            return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "available", "capabilities": _caps(create=True, edit=True, delete=True, relationships=True)}
        except MemoryNotFound: return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "unavailable", "detail": "Holographic is not the active provider", "capabilities": _caps()}
        except Exception as error:
            logger.debug("memory: holographic describe failed (%s)", type(error).__name__)
            return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "degraded", "detail": "Holographic configuration needs review", "capabilities": _caps()}
    def _item(self, row: Dict[str, Any], full: bool = False) -> Dict[str, Any]:
        fact_id = int(row["fact_id"])
        content = str(row["content"]); created, updated = _millis(row.get("created_at")), _millis(row.get("updated_at"))
        tags = [tag.strip() for tag in str(row.get("tags") or "").split(",") if tag.strip()]
        category = str(row.get("category") or "general")[:120]
        bounded_tags = [tag[:120] for tag in tags[:64]]
        return {"id": f"fact:{fact_id}", "sourceId": self.source, "kind": "fact", "title": _title(content, "Fact"), "snippet": _snippet(content), **({"content": content[:_MAX_TEXT]} if full else {}), **({"createdAt": created} if created is not None else {}), **({"updatedAt": updated} if updated is not None else {}), "timestampKind": "created", "revision": _revision(str(row.get("updated_at") or ""), content, category, "\0".join(bounded_tags)), "category": category, "tags": bounded_tags, "trustScore": float(row.get("trust_score") or 0)}
    def _row(self, store: Any, item_id: str) -> Dict[str, Any]:
        if not item_id.startswith("fact:") or not item_id[5:].isdigit(): raise MemoryNotFound("memory item not found")
        row = store._conn.execute("SELECT fact_id,content,category,tags,trust_score,created_at,updated_at FROM facts WHERE fact_id=?", (int(item_id[5:]),)).fetchone()
        if row is None: raise MemoryNotFound("memory item not found")
        return dict(row)
    def _recent(self, store: Any, limit: int) -> List[Dict[str, Any]]:
        """List facts newest first.

        ``list_facts`` orders by trust score, which is the ordering retrieval
        wants and the opposite of what a browsing client renders.  Re-sorting its
        page client-side would only re-sort a trust-shifted window, so the
        recency order is asked of the source instead.
        """
        rows = store._conn.execute(
            "SELECT fact_id,content,category,tags,trust_score,created_at,updated_at FROM facts ORDER BY updated_at DESC, fact_id DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]
    def items(self, q: str = "", limit: int = _MAX_ITEMS, **_: Any) -> List[Dict[str, Any]]:
        _, store = self._provider(); bounded = min(max(limit, 1), _MAX_SOURCE_SCAN)
        rows = store.search_facts(q, limit=bounded) if q.strip() else self._recent(store, bounded)
        return [self._item(row) for row in rows]
    def get(self, item_id: str) -> Dict[str, Any]:
        _, store = self._provider(); return self._item(self._row(store, item_id), True)
    def create(self, input: Dict[str, Any]) -> Dict[str, Any]:
        _scan_content(input["content"])
        _, store = self._provider(); fact_id = store.add_fact(input["content"], category=input.get("category", "general"), tags=",".join(input.get("tags", []))); return {"item": self.get(f"fact:{fact_id}")}
    def _claim(self, store: Any, item_id: str, expected: str) -> Dict[str, Any]:
        """Take the row for a mutation, atomically with respect to its revision.

        Checking the revision and then writing leaves a window in which the agent
        rewrites the same fact and the client's edit lands on top of it with a
        200.  The claim closes that window: it re-stamps ``updated_at`` under a
        single conditional UPDATE whose WHERE clause carries every field the
        revision is computed from, so a row that moved matches nothing and comes
        back as a conflict rather than an overwrite.
        """
        with store._lock:
            row = self._row(store, item_id); current = self._item(row, True)
            if current["revision"] != expected: raise MemoryConflict(current)
            claimed = store._conn.execute(
                # The re-stamp carries milliseconds on purpose: CURRENT_TIMESTAMP only
                # has second resolution, so two claims inside one second would both
                # match the same unchanged stamp and both believe they won.
                "UPDATE facts SET updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE fact_id=? AND updated_at IS ? AND content=? AND category IS ? AND tags IS ?",
                (int(item_id[5:]), row.get("updated_at"), row.get("content"), row.get("category"), row.get("tags")),
            )
            store._conn.commit()
            if claimed.rowcount != 1: raise MemoryConflict(self._item(self._row(store, item_id), True))
            return current
    def update(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        if input.get("content") is not None: _scan_content(str(input["content"]))
        _, store = self._provider()
        with store._lock:
            self._claim(store, item_id, input["expectedRevision"])
            if not store.update_fact(int(item_id[5:]), content=input.get("content"), category=input.get("category"), tags=",".join(input["tags"]) if "tags" in input else None): raise MemoryNotFound("memory item not found")
            return {"item": self.get(item_id)}
    def remove(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        _, store = self._provider()
        with store._lock:
            self._claim(store, item_id, input["expectedRevision"])
            if not store.remove_fact(int(item_id[5:])): raise MemoryNotFound("memory item not found")
            return {"id": item_id, "revision": input["expectedRevision"]}
    def graph(self, q: str = "", **filters: Any) -> Dict[str, Any]:
        _, store = self._provider(); limit = min(max(int(filters.get("limit", _MAX_GRAPH_ITEMS)), 1), _MAX_GRAPH_ITEMS)
        nodes = self.items(q=q, limit=_MAX_GRAPH_ITEMS); since, until = filters.get("since"), filters.get("until")
        nodes = [node for node in nodes if (not isinstance(since, int) or node.get("createdAt", -1) >= since) and (not isinstance(until, int) or node.get("createdAt", until + 1) <= until)][:limit]
        ids = {int(node["id"][5:]) for node in nodes}; edges = []
        for entity, in store._conn.execute("SELECT entity_id FROM entities").fetchall():
            linked = [int(row[0]) for row in store._conn.execute("SELECT fact_id FROM fact_entities WHERE entity_id=?", (entity,)).fetchall() if int(row[0]) in ids]
            for left, right in zip(linked, linked[1:]): edges.append({"from": f"{self.source}:fact:{left}", "to": f"{self.source}:fact:{right}", "kind": "entity"})
        return {"nodes": nodes, "edges": edges[:400]}


class VaultAdapter:
    def __init__(self, display_name: str, root: str, index: int): self.source, self.display_name, self.root = f"vault:{index}", display_name, Path(root).expanduser().resolve()
    def describe(self) -> Dict[str, Any]:
        if not self.root.is_dir(): return {"id": self.source, "displayName": self.display_name, "kind": "vault", "status": "unavailable", "detail": "Vault root is unavailable", "capabilities": _caps()}
        return {"id": self.source, "displayName": self.display_name, "kind": "vault", "status": "available", "capabilities": _caps(create=True, edit=True, delete=True, relationships=True)}
    def _paths(self) -> Iterable[Path]:
        if not self.root.is_dir(): raise MemoryNotFound("vault root is unavailable")
        for path in self.root.rglob("*.md"):
            if path.is_file() and not path.is_symlink() and path.resolve().is_relative_to(self.root):
                relative = path.relative_to(self.root).as_posix()
                if len(relative) <= 507: yield path
    def _path(self, item_id: str) -> Path:
        if not item_id.startswith("note:"): raise MemoryNotFound("memory item not found")
        unresolved = self.root / item_id[5:]
        if unresolved.is_symlink(): raise MemoryNotFound("memory item not found")
        candidate = unresolved.resolve()
        if not candidate.is_relative_to(self.root) or candidate.suffix.lower() != ".md": raise MemoryNotFound("memory item not found")
        return candidate
    @staticmethod
    def _frontmatter(raw: str) -> Tuple[str, str]:
        if raw.startswith("---\n"):
            end = raw.find("\n---", 4)
            if end >= 0: return raw[:end + 5], raw[end + 5:].lstrip("\n")
        return "", raw
    @staticmethod
    def _frontmatter_date(front: str) -> Optional[int]:
        match = re.search(r"(?:^|\n)date:\s*['\"]?([^\n'\"]+)", front)
        return None if match is None else _millis(match.group(1).strip())
    def _backlinks(self, path: Path, title: str) -> List[str]:
        target_names = {title.lower(), path.stem.lower(), path.relative_to(self.root).with_suffix("").as_posix().lower()}
        found: List[str] = []
        for other in self._paths():
            if other == path: continue
            try: _, body = self._frontmatter(_read_text(other))
            except Exception as error:
                logger.debug("memory: vault note skipped in %s (%s)", self.source, type(error).__name__)
                continue
            if any(match.group(1).strip().lower() in target_names for match in _WIKILINK.finditer(body)):
                found.append(other.relative_to(self.root).as_posix())
        return sorted(found)[:128]
    def _item(self, path: Path, full: bool = False, searchable: bool = False) -> Dict[str, Any]:
        raw = _read_text(path); front, body = self._frontmatter(raw); relative = path.relative_to(self.root).as_posix(); stat = path.stat(); created = getattr(stat, "st_birthtime", None)
        tags = re.findall(r"(?:^|\n)tags:\s*\[([^]]*)\]", front); tag_values = [tag.strip(" '\"") for value in tags for tag in value.split(",") if tag.strip()]
        links = sorted(set(match.group(1).strip() for match in _WIKILINK.finditer(body)))[:128]
        title = _title(body, path.stem); front_date = self._frontmatter_date(front)
        item = {"id": f"note:{relative}", "sourceId": self.source, "kind": "note", "title": title, "snippet": _snippet(body), **({"content": body[:_MAX_TEXT]} if full else {}), **({"createdAt": front_date} if front_date is not None else ({"createdAt": int(created * 1000)} if isinstance(created, (float, int)) else {})), "updatedAt": int(stat.st_mtime * 1000), "timestampKind": "created" if front_date is not None else ("fileCreated" if isinstance(created, (float, int)) else "unknown"), "revision": _hash(raw), "tags": [tag[:120] for tag in tag_values[:64]], "relativePath": relative, **({"backlinks": [value[:1_024] for value in self._backlinks(path, title)]} if full else {})}
        if searchable: item["_search"] = f"{title}\n{body}\n{relative}\n{' '.join(tag_values)}".lower()
        return item
    def items(self, q: str = "", limit: int = _MAX_ITEMS, **_: Any) -> List[Dict[str, Any]]:
        needle = q.lower().strip(); bounded = min(max(limit, 1), _MAX_SOURCE_SCAN); found: List[Dict[str, Any]] = []
        for path in sorted(self._paths()):
            # One unreadable note (deleted mid-scan, unreadable mode) costs that note,
            # not the whole listing.
            try: item = self._item(path, searchable=bool(needle))
            except OSError as error:
                logger.debug("memory: vault note skipped in %s (%s)", self.source, type(error).__name__)
                continue
            search_text = str(item.pop("_search", ""))
            if not needle or needle in search_text:
                found.append(item)
                if len(found) >= bounded: break
        return found
    def get(self, item_id: str) -> Dict[str, Any]:
        path = self._path(item_id)
        if not path.is_file(): raise MemoryNotFound("memory item not found")
        return self._item(path, True)
    def create(self, input: Dict[str, Any]) -> Dict[str, Any]:
        _scan_content(input["content"])
        title = str(input.get("title") or _title(input["content"], "Untitled")); safe = re.sub(r"[^A-Za-z0-9 _-]+", "", title).strip().replace(" ", "-")[:120] or "note"; path = self.root / f"{safe}.md"
        if path.exists(): raise MemoryInvalid("a vault note with that title already exists")
        path.parent.mkdir(parents=True, exist_ok=True)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        try: fd = os.open(path, flags, 0o600)
        except OSError as error:
            if error.errno in (errno.EEXIST, errno.ELOOP): raise MemoryInvalid("a vault note with that title already exists")
            raise MemoryInvalid("vault note could not be created")
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write(input["content"].rstrip() + "\n"); out.flush(); os.fsync(out.fileno())
        return {"item": self._item(path, True)}
    def update(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        _scan_content(input["content"])
        path = self._path(item_id)
        # Under the note's exclusive lock: re-read, re-verify the revision, and
        # replace.  Verifying outside the lock would leave a window in which the
        # agent's own write to the same note is overwritten and answered 200.
        with _exclusive(path):
            if not path.is_file(): raise MemoryNotFound("memory item not found")
            current = self._item(path, True)
            if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
            front, _ = self._frontmatter(_read_text(path)); fd, temp = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".md.tmp", dir=str(path.parent))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as out:
                    separator = "" if not front or front.endswith("\n") else "\n"
                    out.write(front + separator + input["content"].rstrip() + "\n"); out.flush(); os.fsync(out.fileno())
                os.replace(temp, path)
            finally:
                if os.path.exists(temp): os.unlink(temp)
            return {"item": self._item(path, True)}
    def remove(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        path = self._path(item_id)
        with _exclusive(path):
            if not path.is_file(): raise MemoryNotFound("memory item not found")
            current = self._item(path, True)
            if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
            path.unlink()
        return {"id": item_id, "revision": input["expectedRevision"]}
    def graph(self, q: str = "", **filters: Any) -> Dict[str, Any]:
        limit = min(max(int(filters.get("limit", _MAX_GRAPH_ITEMS)), 1), _MAX_GRAPH_ITEMS)
        nodes = self.items(q=q, limit=_MAX_GRAPH_ITEMS)
        since, until = filters.get("since"), filters.get("until")
        nodes = [node for node in nodes if (not isinstance(since, int) or node.get("createdAt", -1) >= since) and (not isinstance(until, int) or node.get("createdAt", until + 1) <= until)][:limit]
        by_title: Dict[str, str] = {}
        for node in nodes:
            relative = str(node.get("relativePath", "")); stable = f"{self.source}:{node['id']}"
            for key in (node["title"], Path(relative).stem, str(Path(relative).with_suffix(""))):
                if key: by_title[key.lower()] = stable
        edges = []
        for node in nodes:
            try: _, body = self._frontmatter(_read_text(self._path(node["id"])))
            except Exception as error:
                logger.debug("memory: vault note skipped in %s (%s)", self.source, type(error).__name__)
                continue
            for match in _WIKILINK.finditer(body):
                target = by_title.get(match.group(1).strip().lower())
                if target: edges.append({"from": f"{self.source}:{node['id']}", "to": target, "kind": "wikilink"})
        return {"nodes": nodes, "edges": edges[:400]}


class MemoryManager:
    def __init__(self, extra: Dict[str, Any], profile_home: Optional[str] = None):
        home = Path(profile_home or os.getenv("HERMES_HOME") or ".").expanduser()
        observations = Observations(home / "plugin-data" / "cozygateway" / "memory-observed.json")
        self.curated = [CuratedAdapter(source, observations) for source, _, _ in CuratedAdapter.SOURCES]
        self.holographic = HolographicAdapter()
        # Hermes has no public cross-process config transaction/CAS. Serialize this
        # plugin's setup calls, then hand a minimal patch to save_config's canonical
        # merge_existing writer so it re-reads and retains unrelated raw config.
        self._setup_lock = threading.Lock()
        configs = extra.get("memory_vaults", []) if isinstance(extra, dict) else []; self.vaults = [VaultAdapter(str(item["display_name"]), str(item["root"]), index) for index, item in enumerate(configs) if isinstance(item, dict) and isinstance(item.get("display_name"), str) and isinstance(item.get("root"), str)]
    @property
    def adapters(self) -> List[Any]: return [*self.curated, self.holographic, *self.vaults]
    def sources(self) -> List[Dict[str, Any]]:
        rows = [adapter.describe() for adapter in self.adapters]
        try:
            from hermes_cli.config import load_config_readonly
            provider = str((load_config_readonly().get("memory", {}) or {}).get("provider", "")).strip()
            if provider and provider.lower() != "holographic": rows.append({"id": f"provider:{provider}", "displayName": provider, "kind": "provider", "status": "unsupported", "detail": "No Cozy memory adapter is installed for this provider", "capabilities": _caps()})
        except Exception as error:
            logger.debug("memory: provider row unavailable (%s)", type(error).__name__)
        return rows
    def setup(self, input: Dict[str, Any]) -> Dict[str, Any]:
        """Apply the capability-42 settings through Hermes' atomic publisher.

        The request is validated again at the profile boundary. Hermes owns the
        config writer owns fail-closed publication and merge-with-current behavior;
        this plugin serializes its own setup calls, sends only the three allow-listed
        leaves, then proves effective state through a fresh behavioral read.
        """
        keys = {"memoryEnabled", "userProfileEnabled", "holographicEnabled"}
        if set(input) != keys or any(type(input.get(key)) is not bool for key in keys):
            raise MemoryInvalid("memory setup requires exactly three boolean settings")
        if not any(input[key] for key in keys):
            raise MemoryInvalid("at least one memory source must be enabled")

        try:
            from hermes_cli.config import load_config_readonly, save_config
            with self._setup_lock:
                current_config = load_config_readonly()
                current_memory = current_config.get("memory", {}) if isinstance(current_config, dict) else {}
                if not isinstance(current_memory, dict):
                    raise MemoryInvalid("memory configuration is not a mapping")
                previous_provider = str(current_memory.get("provider") or "").strip()
                patch_memory: Dict[str, Any] = {
                    "memory_enabled": input["memoryEnabled"],
                    "user_profile_enabled": input["userProfileEnabled"],
                }
                if input["holographicEnabled"]:
                    patch_memory["provider"] = "holographic"
                elif previous_provider.lower() == "holographic":
                    # Hermes treats an explicit null provider as no selected provider.
                    # A partial merge cannot express deletion; null disables only the
                    # freshly observed Holographic selection without naming another.
                    patch_memory["provider"] = None

                preserve = {
                    ("memory", "memory_enabled"),
                    ("memory", "user_profile_enabled"),
                }
                if "provider" in patch_memory:
                    preserve.add(("memory", "provider"))
                save_config(
                    {"memory": patch_memory},
                    merge_existing=True,
                    preserve_keys=preserve,
                )

                effective_config = load_config_readonly()
            effective = effective_config.get("memory", {}) if isinstance(effective_config, dict) else {}
            if not isinstance(effective, dict):
                raise MemoryError("memory settings could not be confirmed")
            provider = str(effective.get("provider") or "").strip()
            if effective.get("memory_enabled", True) is not input["memoryEnabled"]:
                raise MemoryError("memory settings could not be confirmed")
            if effective.get("user_profile_enabled", True) is not input["userProfileEnabled"]:
                raise MemoryError("memory settings could not be confirmed")
            if input["holographicEnabled"] and provider.lower() != "holographic":
                raise MemoryError("memory settings could not be confirmed")
            if not input["holographicEnabled"]:
                if previous_provider.lower() == "holographic" and provider.lower() == "holographic":
                    raise MemoryError("memory settings could not be confirmed")
                if previous_provider and previous_provider.lower() != "holographic" and provider != previous_provider:
                    raise MemoryError("memory settings could not be confirmed")
        except MemoryError:
            raise
        except Exception as error:
            logger.debug("memory: setup failed (%s)", type(error).__name__)
            raise MemoryError("memory settings could not be applied") from None
        try:
            return {"sources": self.sources()}
        except Exception as error:
            logger.debug("memory: setup projection failed (%s)", type(error).__name__)
            raise MemoryError("memory settings could not be confirmed") from None
    def _adapter(self, source: str):
        adapter = next((adapter for adapter in self.adapters if adapter.source == source), None)
        if adapter is None: raise MemoryNotFound("memory source not found")
        return adapter
    @staticmethod
    def _degrade(statuses: List[Dict[str, Any]], source: str, detail: str) -> None:
        """Report one source's fault in the answer instead of dropping it silently.

        A source that raises used to vanish from a listing that still returned 200,
        which is how a whole adapter can be dead without anyone noticing.
        """
        for row in statuses:
            if row.get("id") == source and row.get("status") == "available":
                row["status"], row["detail"] = "degraded", detail[:512]
    def execute(self, operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
        if operation == "overview": return {"sources": self.sources()}
        if operation == "setup": return self.setup(input)
        source = input.get("sourceId")
        if operation == "items":
            selected = [self._adapter(source)] if isinstance(source, str) and source else self.adapters
            items: List[Dict[str, Any]] = []; statuses = self.sources()
            for adapter in selected:
                try: items.extend(adapter.items(**{**input, "limit": _MAX_SOURCE_SCAN}))
                except Exception as error:
                    logger.debug("memory: source %s failed to list (%s)", adapter.source, type(error).__name__)
                    self._degrade(statuses, adapter.source, "This source could not be read for this request")
            kind, since, until = input.get("kind"), input.get("since"), input.get("until")
            items = [item for item in items if (not kind or item["kind"] == kind) and (not isinstance(since, int) or item.get("createdAt", -1) >= since) and (not isinstance(until, int) or item.get("createdAt", until + 1) <= until)]
            items.sort(key=lambda item: (int(item.get("updatedAt", 0)), item["id"]), reverse=True)
            limit = min(_MAX_ITEMS, max(1, int(input.get("limit", _MAX_ITEMS))))
            return {"items": items[:limit], "sources": statuses}
        if operation == "graph":
            if isinstance(source, str) and source:
                return self._adapter(source).graph(**input)
            nodes: List[Dict[str, Any]] = []; edges: List[Dict[str, Any]] = []
            for adapter in (self.holographic, *self.vaults):
                try:
                    graph = adapter.graph(**input); nodes.extend(graph["nodes"]); edges.extend(graph["edges"])
                except Exception as error:
                    logger.debug("memory: source %s failed to graph (%s)", adapter.source, type(error).__name__)
            return {"nodes": nodes[:200], "edges": edges[:400]}
        if not isinstance(source, str): raise MemoryInvalid("sourceId is required")
        adapter = self._adapter(source)
        if operation == "item": return adapter.get(str(input.get("itemId", "")))
        if operation == "create": return adapter.create(input)
        if operation == "update": return adapter.update(str(input.get("itemId", "")), input)
        if operation == "delete": return adapter.remove(str(input.get("itemId", "")), input)
        raise MemoryInvalid("unknown memory operation")

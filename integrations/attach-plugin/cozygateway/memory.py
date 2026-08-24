"""Profile-local Memory management adapters for CozyGateway attach-v1.

This module deliberately runs beside Hermes.  Gateway only forwards bounded
requests; neither it nor a phone gets a filesystem path or opens provider SQL.
Writes use Hermes' MemoryStore / Holographic MemoryStore public mutation paths.
"""
from __future__ import annotations

import hashlib
import errno
import json
import os
import re
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

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
    def __init__(self, observations: Observations): self.observations = observations
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
    @staticmethod
    def _target(source: str) -> str:
        if source == "curated-memory": return "memory"
        if source == "curated-user": return "user"
        raise MemoryNotFound("unknown curated source")
    def describe(self) -> List[Dict[str, Any]]:
        try:
            store = self._store(); rows = []
            for source, target, label in (("curated-memory", "memory", "Curated notes"), ("curated-user", "user", "About me")):
                entries = store.memory_entries if target == "memory" else store.user_entries
                limit = store.memory_char_limit if target == "memory" else store.user_char_limit
                rows.append({"id": source, "displayName": label, "kind": target, "status": "available" if store.target_enabled(target) else "unavailable", "capabilities": _caps(create=store.target_enabled(target), edit=store.target_enabled(target), delete=store.target_enabled(target), capacity=True, effectiveNextSession=True), "capacity": {"used": len("\n§\n".join(entries)), "limit": limit}, "effectiveNextSession": True})
            return rows
        except Exception: return [{"id": "curated-memory", "displayName": "Curated notes", "kind": "memory", "status": "unavailable", "detail": "Curated memory is unavailable", "capabilities": _caps()}]
    def _items(self, source: str, content: bool = False) -> List[Dict[str, Any]]:
        target, store = self._target(source), self._store(); entries = store.memory_entries if target == "memory" else store.user_entries
        path = store._path_for(target); file_rev = _hash(path.read_text("utf-8")) if path.exists() else _hash("")
        result = []
        for text in entries:
            item_id = f"{target}:{_hash(text)}"; created = self.observations.observe(f"{source}:{item_id}")
            result.append({"id": item_id, "sourceId": source, "kind": target, "title": _title(text), "snippet": _snippet(text), **({"content": text[:_MAX_TEXT]} if content else {}), "createdAt": created, "updatedAt": int(path.stat().st_mtime * 1000) if path.exists() else created, "timestampKind": "firstObserved", "revision": _revision(file_rev, text), "effectiveNextSession": True})
        return result
    def items(self, source: str, q: str = "", **_: Any) -> List[Dict[str, Any]]:
        values = self._items(source); needle = q.lower().strip(); return [item for item in values if not needle or needle in item["title"].lower() or needle in item["snippet"].lower()]
    def get(self, source: str, item_id: str) -> Dict[str, Any]:
        item = next((item for item in self._items(source, True) if item["id"] == item_id), None)
        if item is None: raise MemoryNotFound("memory item not found")
        return item
    def _fresh(self, source: str, item_id: str, expected: str) -> Tuple[Any, str]:
        item = self.get(source, item_id)
        if item["revision"] != expected: raise MemoryConflict(item)
        return self._store(), item["content"]
    def create(self, source: str, input: Dict[str, Any]) -> Dict[str, Any]:
        target, store = self._target(source), self._store(); answer = store.add(target, input["content"])
        if not answer.get("success"): raise MemoryInvalid("curated memory could not be written")
        return {"item": next(item for item in self._items(source, True) if item["content"] == input["content"])}
    def update(self, source: str, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        store, old = self._fresh(source, item_id, input["expectedRevision"]); answer = store.replace(self._target(source), old, input["content"])
        if not answer.get("success"): raise MemoryInvalid("curated memory could not be written")
        return {"item": next(item for item in self._items(source, True) if item["content"] == input["content"])}
    def remove(self, source: str, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        store, old = self._fresh(source, item_id, input["expectedRevision"]); answer = store.remove(self._target(source), old)
        if not answer.get("success"): raise MemoryInvalid("curated memory could not be deleted")
        return {"id": item_id, "revision": input["expectedRevision"]}


class HolographicAdapter:
    source = "holographic"
    def _provider(self):
        from plugins.memory.holographic import HolographicMemoryProvider
        from hermes_cli.config import load_config_readonly
        config = load_config_readonly(); memory = config.get("memory", {}) if isinstance(config, dict) else {}
        if str(memory.get("provider", "")).strip().lower() != "holographic": raise MemoryNotFound("Holographic is not the active provider")
        canonical = ((config.get("plugins", {}) or {}).get("hermes-memory-store", {}) or {})
        provider = HolographicMemoryProvider(config=canonical); provider.initialize("cozygateway-memory")
        return provider, provider._store
    def describe(self) -> Dict[str, Any]:
        try:
            self._provider()
            return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "available", "capabilities": _caps(create=True, edit=True, delete=True, relationships=True)}
        except MemoryNotFound: return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "unavailable", "detail": "Holographic is not the active provider", "capabilities": _caps()}
        except Exception: return {"id": self.source, "displayName": "Holographic", "kind": "holographic", "status": "degraded", "detail": "Holographic configuration needs review", "capabilities": _caps()}
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
    def items(self, q: str = "", limit: int = _MAX_ITEMS, **_: Any) -> List[Dict[str, Any]]:
        _, store = self._provider(); bounded = min(max(limit, 1), _MAX_SOURCE_SCAN); rows = store.search_facts(q, limit=bounded) if q.strip() else store.list_facts(limit=bounded); return [self._item(row) for row in rows]
    def get(self, item_id: str) -> Dict[str, Any]:
        _, store = self._provider(); return self._item(self._row(store, item_id), True)
    def create(self, input: Dict[str, Any]) -> Dict[str, Any]:
        _, store = self._provider(); fact_id = store.add_fact(input["content"], category=input.get("category", "general"), tags=",".join(input.get("tags", []))); return {"item": self.get(f"fact:{fact_id}")}
    def update(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        _, store = self._provider(); current = self.get(item_id)
        if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
        if not store.update_fact(int(item_id[5:]), content=input.get("content"), category=input.get("category"), tags=",".join(input["tags"]) if "tags" in input else None): raise MemoryNotFound("memory item not found")
        return {"item": self.get(item_id)}
    def remove(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        _, store = self._provider(); current = self.get(item_id)
        if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
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
            try: _, body = self._frontmatter(other.read_text("utf-8"))
            except Exception: continue
            if any(match.group(1).strip().lower() in target_names for match in _WIKILINK.finditer(body)):
                found.append(other.relative_to(self.root).as_posix())
        return sorted(found)[:128]
    def _item(self, path: Path, full: bool = False, searchable: bool = False) -> Dict[str, Any]:
        raw = path.read_text("utf-8"); front, body = self._frontmatter(raw); relative = path.relative_to(self.root).as_posix(); stat = path.stat(); created = getattr(stat, "st_birthtime", None)
        tags = re.findall(r"(?:^|\n)tags:\s*\[([^]]*)\]", front); tag_values = [tag.strip(" '\"") for value in tags for tag in value.split(",") if tag.strip()]
        links = sorted(set(match.group(1).strip() for match in _WIKILINK.finditer(body)))[:128]
        title = _title(body, path.stem); front_date = self._frontmatter_date(front)
        item = {"id": f"note:{relative}", "sourceId": self.source, "kind": "note", "title": title, "snippet": _snippet(body), **({"content": body[:_MAX_TEXT]} if full else {}), **({"createdAt": front_date} if front_date is not None else ({"createdAt": int(created * 1000)} if isinstance(created, (float, int)) else {})), "updatedAt": int(stat.st_mtime * 1000), "timestampKind": "created" if front_date is not None else ("fileCreated" if isinstance(created, (float, int)) else "unknown"), "revision": _hash(raw), "tags": [tag[:120] for tag in tag_values[:64]], "relativePath": relative, **({"backlinks": [value[:1_024] for value in self._backlinks(path, title)]} if full else {})}
        if searchable: item["_search"] = f"{title}\n{body}\n{relative}\n{' '.join(tag_values)}".lower()
        return item
    def _all(self, full: bool = False) -> List[Dict[str, Any]]: return [self._item(path, full) for path in sorted(self._paths())]
    def items(self, q: str = "", limit: int = _MAX_ITEMS, **_: Any) -> List[Dict[str, Any]]:
        needle = q.lower().strip(); bounded = min(max(limit, 1), _MAX_SOURCE_SCAN); found: List[Dict[str, Any]] = []
        for path in sorted(self._paths()):
            item = self._item(path, searchable=bool(needle)); search_text = str(item.pop("_search", ""))
            if not needle or needle in search_text:
                found.append(item)
                if len(found) >= bounded: break
        return found
    def get(self, item_id: str) -> Dict[str, Any]:
        path = self._path(item_id)
        if not path.is_file(): raise MemoryNotFound("memory item not found")
        return self._item(path, True)
    def create(self, input: Dict[str, Any]) -> Dict[str, Any]:
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
        current = self.get(item_id)
        if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
        path = self._path(item_id); front, _ = self._frontmatter(path.read_text("utf-8")); fd, temp = tempfile.mkstemp(prefix=f".{path.stem}-", suffix=".md.tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as out:
                separator = "" if not front or front.endswith("\n") else "\n"
                out.write(front + separator + input["content"].rstrip() + "\n"); out.flush(); os.fsync(out.fileno())
            os.replace(temp, path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        return {"item": self._item(path, True)}
    def remove(self, item_id: str, input: Dict[str, Any]) -> Dict[str, Any]:
        current = self.get(item_id)
        if current["revision"] != input["expectedRevision"]: raise MemoryConflict(current)
        self._path(item_id).unlink(); return {"id": item_id, "revision": input["expectedRevision"]}
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
            try: _, body = self._frontmatter(self._path(node["id"]).read_text("utf-8"))
            except Exception: continue
            for match in _WIKILINK.finditer(body):
                target = by_title.get(match.group(1).strip().lower())
                if target: edges.append({"from": f"{self.source}:{node['id']}", "to": target, "kind": "wikilink"})
        return {"nodes": nodes, "edges": edges[:400]}


class MemoryManager:
    def __init__(self, extra: Dict[str, Any], profile_home: Optional[str] = None):
        home = Path(profile_home or os.getenv("HERMES_HOME") or ".").expanduser(); self.curated = CuratedAdapter(Observations(home / "plugin-data" / "cozygateway" / "memory-observed.json")); self.holographic = HolographicAdapter()
        configs = extra.get("memory_vaults", []) if isinstance(extra, dict) else []; self.vaults = [VaultAdapter(str(item["display_name"]), str(item["root"]), index) for index, item in enumerate(configs) if isinstance(item, dict) and isinstance(item.get("display_name"), str) and isinstance(item.get("root"), str)]
    def sources(self) -> List[Dict[str, Any]]:
        rows = self.curated.describe() + [self.holographic.describe()] + [vault.describe() for vault in self.vaults]
        try:
            from hermes_cli.config import load_config_readonly
            provider = str((load_config_readonly().get("memory", {}) or {}).get("provider", "")).strip()
            if provider and provider.lower() != "holographic": rows.append({"id": f"provider:{provider}", "displayName": provider, "kind": "provider", "status": "unsupported", "detail": "No Cozy memory adapter is installed for this provider", "capabilities": _caps()})
        except Exception: pass
        return rows
    def _adapter(self, source: str):
        if source.startswith("curated-"): return self.curated
        if source == "holographic": return self.holographic
        vault = next((vault for vault in self.vaults if vault.source == source), None)
        if vault is None: raise MemoryNotFound("memory source not found")
        return vault
    def execute(self, operation: str, input: Dict[str, Any]) -> Dict[str, Any]:
        if operation == "overview": return {"sources": self.sources()}
        source = input.get("sourceId")
        if operation == "items":
            selected = [self._adapter(source)] if isinstance(source, str) and source else [self.curated, self.holographic, *self.vaults]
            items: List[Dict[str, Any]] = []; statuses = self.sources()
            for adapter in selected:
                try: items.extend(adapter.items(**{**input, "limit": _MAX_SOURCE_SCAN}))
                except Exception: pass
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
                except Exception: pass
            return {"nodes": nodes[:200], "edges": edges[:400]}
        if not isinstance(source, str): raise MemoryInvalid("sourceId is required")
        adapter = self._adapter(source)
        if operation == "item": return adapter.get(str(input.get("itemId", "")))
        if operation == "create": return adapter.create(input)
        if operation == "update": return adapter.update(str(input.get("itemId", "")), input)
        if operation == "delete": return adapter.remove(str(input.get("itemId", "")), input)
        raise MemoryInvalid("unknown memory operation")

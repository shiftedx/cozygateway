"""Durable attach-v1 command inbox and event outbox.

SQLite is deliberately stdlib-only so the platform plugin adds no deployment dependency. Every
outbound event is persisted before a socket send; every inbound command is persisted before its
ACK. That is the plugin half of attach-v1's at-least-once contract.
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

try:
    import fcntl
except ImportError:  # pragma: no cover - the native Hermes host is POSIX
    fcntl = None


class TerminalSealed(RuntimeError):
    """Raised when an event attempts to mutate a turn after its terminal event."""


class ResumeConflict(RuntimeError):
    """Raised when server cursors would discard locally durable work."""


_TELEMETRY_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1_000


_SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  next_event_sequence INTEGER NOT NULL,
  command_cursor INTEGER NOT NULL,
  event_cursor INTEGER NOT NULL,
  last_event_ack_progress_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS event_outbox (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  frame_json TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0 CHECK (acked IN (0, 1))
) STRICT;
CREATE TABLE IF NOT EXISTS command_inbox (
  sequence INTEGER PRIMARY KEY,
  command_id TEXT NOT NULL UNIQUE,
  frame_json TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0, 1))
) STRICT;
CREATE TABLE IF NOT EXISTS turn_terminals (
  turn_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  terminal_kind TEXT NOT NULL
) STRICT;
"""

_TRANSPORT_LEASES: set[str] = set()
_TRANSPORT_LEASES_LOCK = threading.Lock()


class AttachSpool:
    def __init__(self, path: str, now_ms: Optional[Callable[[], int]] = None) -> None:
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._path = os.path.abspath(path)
        self._lease_file: Optional[Any] = None
        parent = os.path.dirname(self._path)
        os.makedirs(parent, exist_ok=True)
        self._db = sqlite3.connect(self._path, timeout=30)
        self._db.execute("PRAGMA busy_timeout=30000")
        self._db.executescript(_SCHEMA)
        self._migrate_health_columns()
        with self._db:
            self._db.execute(
                "INSERT OR IGNORE INTO state (id, instance_id, next_event_sequence, command_cursor, event_cursor) VALUES (1, ?, 1, 0, 0)",
                (str(uuid.uuid4()),),
            )

    def _migrate_health_columns(self) -> None:
        """Add bounded health accounting to existing durable spools without discarding work."""
        state_columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(state)")}
        event_columns = {str(row[1]) for row in self._db.execute("PRAGMA table_info(event_outbox)")}
        with self._db:
            if "last_event_ack_progress_at" not in state_columns:
                self._db.execute("ALTER TABLE state ADD COLUMN last_event_ack_progress_at INTEGER")
            if "created_at" not in event_columns:
                self._db.execute("ALTER TABLE event_outbox ADD COLUMN created_at INTEGER")
                # A pre-health spool has no per-event creation time. Timestamp the migration rather
                # than exposing any payload data or refusing to resume existing durable work.
                self._db.execute("UPDATE event_outbox SET created_at = ? WHERE created_at IS NULL", (self._now_ms(),))

    def acquire_transport_lease(self) -> bool:
        """Become the sole websocket owner for this spool without touching its durable rows."""
        if self._lease_file is not None:
            return True
        if fcntl is None:
            return False
        lock_path = self._path + ".transport.lock"
        with _TRANSPORT_LEASES_LOCK:
            if lock_path in _TRANSPORT_LEASES:
                return False
            handle = open(lock_path, "a+b")
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                handle.close()
                return False
            _TRANSPORT_LEASES.add(lock_path)
            self._lease_file = handle
            return True

    def release_transport_lease(self) -> None:
        handle, self._lease_file = self._lease_file, None
        if handle is None:
            return
        lock_path = self._path + ".transport.lock"
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()
            with _TRANSPORT_LEASES_LOCK:
                _TRANSPORT_LEASES.discard(lock_path)

    @property
    def instance_id(self) -> str:
        return str(self._db.execute("SELECT instance_id FROM state WHERE id = 1").fetchone()[0])

    @property
    def command_cursor(self) -> int:
        return int(self._db.execute("SELECT command_cursor FROM state WHERE id = 1").fetchone()[0])

    @property
    def event_cursor(self) -> int:
        return int(self._db.execute("SELECT event_cursor FROM state WHERE id = 1").fetchone()[0])

    def reconcile_server_resume(self, event_sequence: int, command_sequence: int) -> None:
        """Adopt the authoritative cursors returned by ``hello_ack``.

        A spool can be recreated while the gateway still retains this agent's durable stream. In
        that case the first new command is necessarily ahead of the empty spool's cursor. Advancing
        is safe because the gateway only advertises command rows it has already ACKed and event rows
        it has already durably admitted. Locally pending events are never skipped.
        """
        if event_sequence < 0 or command_sequence < 0:
            raise ResumeConflict("attach-v1 server returned a negative resume cursor")
        with self._db:
            row = self._db.execute(
                "SELECT next_event_sequence, command_cursor, event_cursor FROM state WHERE id = 1"
            ).fetchone()
            next_event_sequence, local_command_cursor, local_event_cursor = map(int, row)
            if command_sequence < local_command_cursor or event_sequence < local_event_cursor:
                raise ResumeConflict("attach-v1 server resume cursor moved backwards")

            issued_event_tail = next_event_sequence - 1
            if event_sequence > issued_event_tail:
                pending = int(self._db.execute(
                    "SELECT COUNT(*) FROM event_outbox WHERE acked = 0"
                ).fetchone()[0])
                if pending:
                    raise ResumeConflict(
                        "attach-v1 server event cursor is ahead of locally pending events"
                    )
                next_event_sequence = event_sequence + 1
            else:
                self._db.execute(
                    "UPDATE event_outbox SET acked = 1 WHERE sequence <= ?",
                    (event_sequence,),
                )

            self._db.execute(
                "UPDATE state SET next_event_sequence = ?, command_cursor = ?, event_cursor = ? WHERE id = 1",
                (next_event_sequence, command_sequence, event_sequence),
            )

    def enqueue_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        turn_id = event.get("turnId")
        if isinstance(turn_id, str) and turn_id:
            sealed = self._db.execute("SELECT 1 FROM turn_terminals WHERE turn_id = ?", (turn_id,)).fetchone()
            if sealed is not None:
                raise TerminalSealed(f"turn {turn_id!r} already has a terminal event")
        terminal = event.get("kind") in {"commit", "failed", "cancelled", "interrupted"}
        with self._db:
            sequence = int(self._db.execute("SELECT next_event_sequence FROM state WHERE id = 1").fetchone()[0])
            event_id = str(uuid.uuid4())
            frame = {"kind": "event", "sequence": sequence, "eventId": event_id, "event": event}
            encoded = json.dumps(frame, separators=(",", ":"))
            self._db.execute(
                "INSERT INTO event_outbox (sequence, event_id, frame_json, byte_count, created_at, acked) VALUES (?, ?, ?, ?, ?, 0)",
                (sequence, event_id, encoded, len(encoded.encode("utf-8")), self._now_ms()),
            )
            if terminal and isinstance(turn_id, str) and turn_id:
                self._db.execute(
                    "INSERT INTO turn_terminals (turn_id, event_id, terminal_kind) VALUES (?, ?, ?)",
                    (turn_id, event_id, str(event["kind"])),
                )
            self._db.execute("UPDATE state SET next_event_sequence = ? WHERE id = 1", (sequence + 1,))
        return frame

    def pending_events(self, max_events: int, max_bytes: int) -> List[Dict[str, Any]]:
        rows = self._db.execute(
            "SELECT frame_json, byte_count FROM event_outbox WHERE acked = 0 ORDER BY sequence LIMIT ?",
            (max(1, max_events),),
        ).fetchall()
        result: List[Dict[str, Any]] = []
        used = 0
        for encoded, byte_count in rows:
            size = int(byte_count)
            if result and used + size > max_bytes:
                break
            if size > max_bytes:
                break
            result.append(json.loads(str(encoded)))
            used += size
        return result

    def ack_event(self, sequence: int, event_id: str) -> bool:
        with self._db:
            changed = self._db.execute(
                "UPDATE event_outbox SET acked = 1 WHERE sequence = ? AND event_id = ? AND acked = 0",
                (sequence, event_id),
            ).rowcount
            if not changed:
                return False
            # Gateway accepts strictly contiguous sequences, so the greatest ACK is the durable
            # resume cursor even if duplicate ACK frames arrive out of order.
            cursor = int(self._db.execute("SELECT COALESCE(MAX(sequence), 0) FROM event_outbox WHERE acked = 1").fetchone()[0])
            self._db.execute(
                "UPDATE state SET event_cursor = ?, last_event_ack_progress_at = ? WHERE id = 1",
                (cursor, self._now_ms()),
            )
        return True

    def health_snapshot(self) -> Dict[str, Any]:
        """Return only bounded operational counters, cursors and ages (never payload metadata)."""
        now = self._now_ms()
        event_outbox_depth, oldest_created_at = self._db.execute(
            "SELECT COUNT(*), MIN(created_at) FROM event_outbox WHERE acked = 0"
        ).fetchone()
        event_cursor = self._db.execute("SELECT event_cursor FROM state WHERE id = 1").fetchone()[0]
        command_inbox_depth = self._db.execute(
            "SELECT COUNT(*) FROM command_inbox WHERE processed = 0"
        ).fetchone()[0]
        return {
            "eventOutboxDepth": int(event_outbox_depth),
            "oldestEventAgeMs": (
                min(_TELEMETRY_MAX_EVENT_AGE_MS, max(0, now - int(oldest_created_at)))
                if oldest_created_at is not None else None
            ),
            "eventAckCursor": int(event_cursor),
            "commandInboxDepth": int(command_inbox_depth),
        }

    def accept_command(self, frame: Dict[str, Any]) -> str:
        sequence = frame.get("sequence")
        command_id = frame.get("commandId")
        command = frame.get("command")
        if not isinstance(sequence, int) or sequence < 1 or not isinstance(command_id, str) or not command_id or not isinstance(command, dict):
            return "invalid"
        prior = self._db.execute("SELECT sequence FROM command_inbox WHERE command_id = ?", (command_id,)).fetchone()
        if prior is not None:
            return "duplicate" if int(prior[0]) == sequence else "conflict"
        expected = self.command_cursor + 1
        if sequence != expected:
            return "gap" if sequence > expected else "conflict"
        with self._db:
            self._db.execute(
                "INSERT INTO command_inbox (sequence, command_id, frame_json, processed) VALUES (?, ?, ?, 0)",
                (sequence, command_id, json.dumps(frame, separators=(",", ":"))),
            )
            self._db.execute("UPDATE state SET command_cursor = ? WHERE id = 1", (sequence,))
        return "accepted"

    def pending_commands(self) -> List[Dict[str, Any]]:
        return [
            json.loads(str(row[0]))
            for row in self._db.execute(
                "SELECT frame_json FROM command_inbox WHERE processed = 0 ORDER BY sequence"
            ).fetchall()
        ]

    def mark_command_processed(self, command_id: str) -> None:
        with self._db:
            self._db.execute("UPDATE command_inbox SET processed = 1 WHERE command_id = ?", (command_id,))

    def close(self) -> None:
        self.release_transport_lease()
        self._db.close()

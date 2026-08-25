"""Durable attach-v1 command inbox and event outbox.

SQLite is deliberately stdlib-only so the platform plugin adds no deployment dependency. Every
outbound event is persisted before a socket send; every inbound command is persisted before its
ACK. That is the plugin half of attach-v1's at-least-once contract.
"""

from __future__ import annotations

import json
import logging
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


logger = logging.getLogger(__name__)

# A delivery occurrence reaches exactly one of these once, and never leaves it. Everything else
# ("pending", "journaled", "projected") is a stage on the way there and may still be upgraded.
TERMINAL_RECEIPT_STATES = frozenset({"displayed", "failed"})


# The media lifecycle a single attachment walks for one delivery occurrence. Ranks are the only
# forward direction: a mark may advance or repeat a stage, never rewind it.
MEDIA_LIFECYCLE_STAGES: Dict[str, int] = {
    "prepared": 0,
    "uploaded": 1,
    "journaled": 2,
    "projected": 3,
    "displayed": 4,
}

# Once a media occurrence reaches one of these it is answered for good. "displayed" is the only
# terminal that also sits on the progression ladder, so a projected row may still upgrade to it.
TERMINAL_MEDIA_STATES = frozenset({"displayed", "blocked", "expired", "upload_failed"})

MEDIA_LIFECYCLE_STATES = frozenset(MEDIA_LIFECYCLE_STAGES) | TERMINAL_MEDIA_STATES


class TerminalSealed(RuntimeError):
    """Raised when an event attempts to mutate a turn after its terminal event."""


class ResumeConflict(RuntimeError):
    """Raised when server cursors would discard locally durable work."""


_TELEMETRY_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1_000

# The one event the gateway admits with no negotiated capability and applies to nothing: it needs
# no thread, seals no turn, and its projection is a bare `return true`. That makes it the frame a
# sequence number can wear when the number must survive but its payload must not.
_INERT_EVENT: Dict[str, Any] = {"kind": "presence", "state": "online"}

# A hole in someone else's spool is not this plugin's to paper over indefinitely. Healing is
# capped so a badly wrong cursor cannot make the plugin mint an unbounded run of frames.
MAX_HEALED_SEQUENCE_HOLES = 64


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
-- The outbox keeps every row it ever numbered, so the unacked tail is a vanishing fraction of the
-- table. `acked` is the LAST column, so without this partial index SQLite must decode every
-- `frame_json` in the file just to learn a row is already answered for: a 73 MB read per send tick
-- that blocks the event loop. The index is over the unacked rows alone.
CREATE INDEX IF NOT EXISTS event_outbox_unacked ON event_outbox (sequence) WHERE acked = 0;
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
CREATE TABLE IF NOT EXISTS media_cleanup (
  media_id TEXT PRIMARY KEY
) STRICT;
CREATE TABLE IF NOT EXISTS media_lifecycle (
  delivery_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  sha256 TEXT,
  path_meta TEXT,
  state TEXT NOT NULL,
  detail TEXT,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (delivery_id, media_id)
) STRICT;
CREATE TABLE IF NOT EXISTS media_occurrences (
  occurrence_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  destination TEXT NOT NULL,
  media_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (occurrence_key, sha256, destination)
) STRICT;
CREATE TABLE IF NOT EXISTS delivery_receipts (
  delivery_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  stage TEXT,
  reason TEXT,
  at_ms INTEGER NOT NULL
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
        # A `delegation` event is exempt from the terminal seal: an async delegate_task batch
        # legitimately outlives its turn, and a child's finish leg after the seal must still
        # settle its card (the gateway projects post-seal delegation legs explicitly).
        if isinstance(turn_id, str) and turn_id and event.get("kind") != "delegation":
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

    def _inert_frame(self, sequence: int, event_id: str) -> tuple[str, int]:
        """Encode the same-sequence placeholder that stands in for a withdrawn or absent frame."""
        frame = {"kind": "event", "sequence": sequence, "eventId": event_id, "event": dict(_INERT_EVENT)}
        encoded = json.dumps(frame, separators=(",", ":"))
        return encoded, len(encoded.encode("utf-8"))

    def begin_media_cleanup(self, media_ids: List[str]) -> List[int]:
        """Withdraw the descriptor payload of an abandoned atomic media occurrence.

        Upload bytes live outside the journal, but their descriptor events are ordinary numbered
        rows, and a numbered row is a promise: the gateway admits events only in strictly
        contiguous order, so a deleted row is a permanent hole that no replay can ever step over.
        The payload is therefore replaced in place by an inert placeholder carrying the same
        sequence, the same event id and honest byte accounting. An already-ACKed row re-sends as an
        exact duplicate and is ignored; an unsent one costs one meaningless frame. Callers delete
        the corresponding remote bytes after this local withdrawal; a later scheduled/commit event
        must never reference these ids.
        """
        targets = {media_id for media_id in media_ids if isinstance(media_id, str) and media_id}
        if not targets:
            return []
        rows = self._db.execute(
            "SELECT sequence, event_id, frame_json FROM event_outbox ORDER BY sequence"
        ).fetchall()
        withdrawn: List[tuple[str, int, int]] = []
        sequences: List[int] = []
        for sequence, event_id, encoded in rows:
            try:
                event = json.loads(str(encoded)).get("event")
                descriptor = event.get("media") if isinstance(event, dict) else None
                media_id = descriptor.get("mediaId") if isinstance(descriptor, dict) else None
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
            if isinstance(event, dict) and event.get("kind") == "media" and media_id in targets:
                replacement, byte_count = self._inert_frame(int(sequence), str(event_id))
                withdrawn.append((replacement, byte_count, int(sequence)))
                sequences.append(int(sequence))
        with self._db:
            if withdrawn:
                self._db.executemany(
                    "UPDATE event_outbox SET frame_json = ?, byte_count = ? WHERE sequence = ?",
                    withdrawn,
                )
            self._db.executemany(
                "INSERT OR IGNORE INTO media_cleanup (media_id) VALUES (?)",
                ((media_id,) for media_id in targets),
            )
        return sequences

    def heal_event_gap(self, requested_after: int, limit: int = MAX_HEALED_SEQUENCE_HOLES) -> List[int]:
        """Mint inert placeholders for numbered rows this spool no longer has.

        A gap frame asks for ``requested_after + 1``. If that row is simply absent, replaying only
        hands the gateway the row after the hole, it gaps again, and the stream livelocks while
        heartbeats keep the connection looking healthy. Filling the hole with a frame the gateway
        accepts and ignores is the only move that lets the numbering continue. Only sequences this
        spool already issued are healed, so healing can never invent future work.
        """
        with self._db:
            next_sequence = int(
                self._db.execute("SELECT next_event_sequence FROM state WHERE id = 1").fetchone()[0]
            )
            start = max(1, requested_after + 1)
            last = min(next_sequence - 1, start + max(0, limit) - 1)
            if start > last:
                return []
            present = {
                int(row[0]) for row in self._db.execute(
                    "SELECT sequence FROM event_outbox WHERE sequence BETWEEN ? AND ?", (start, last)
                )
            }
            healed: List[int] = []
            for sequence in range(start, last + 1):
                if sequence in present:
                    continue
                event_id = str(uuid.uuid4())
                encoded, byte_count = self._inert_frame(sequence, event_id)
                self._db.execute(
                    "INSERT INTO event_outbox (sequence, event_id, frame_json, byte_count, created_at, acked)"
                    " VALUES (?, ?, ?, ?, ?, 0)",
                    (sequence, event_id, encoded, byte_count, self._now_ms()),
                )
                healed.append(sequence)
        return healed

    def pending_media_cleanups(self) -> List[str]:
        return [str(row[0]) for row in self._db.execute(
            "SELECT media_id FROM media_cleanup ORDER BY media_id"
        ).fetchall()]

    def mark_media_cleanup_complete(self, media_id: str) -> None:
        with self._db:
            self._db.execute("DELETE FROM media_cleanup WHERE media_id = ?", (media_id,))

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

    def record_delivery_receipt(
        self,
        delivery_id: str,
        state: str,
        at_ms: int,
        stage: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> str:
        """Upsert one delivery receipt. The first terminal state wins, forever.

        A "displayed" receipt may still upgrade a non-terminal row (the projected era), but a
        terminal row is never rewritten: neither displayed over failed nor failed over displayed.
        A conflicting terminal is dropped and logged rather than silently swallowed.
        """
        if not isinstance(delivery_id, str) or not delivery_id or not isinstance(state, str) or not state:
            return "invalid"
        prior = self._db.execute(
            "SELECT state FROM delivery_receipts WHERE delivery_id = ?", (delivery_id,)
        ).fetchone()
        if prior is not None:
            prior_state = str(prior[0])
            if prior_state in TERMINAL_RECEIPT_STATES:
                if prior_state == state:
                    return "duplicate"
                logger.info(
                    "attach-v1: delivery %s already terminal as %s; dropping conflicting %s receipt",
                    delivery_id, prior_state, state,
                )
                return "conflict"
        with self._db:
            self._db.execute(
                "INSERT INTO delivery_receipts (delivery_id, state, stage, reason, at_ms) VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(delivery_id) DO UPDATE SET state = excluded.state, stage = excluded.stage,"
                " reason = excluded.reason, at_ms = excluded.at_ms",
                (delivery_id, state, stage, reason, int(at_ms)),
            )
        return "recorded"

    def delivery_receipt_row(self, delivery_id: str) -> Optional[Dict[str, Any]]:
        """Return the locally persisted receipt for a delivery occurrence, or ``None``."""
        row = self._db.execute(
            "SELECT state, stage, reason, at_ms FROM delivery_receipts WHERE delivery_id = ?",
            (delivery_id,),
        ).fetchone()
        if row is None:
            return None
        state, stage, reason, at_ms = row
        result: Dict[str, Any] = {"state": str(state), "at": int(at_ms)}
        if stage is not None:
            result["stage"] = str(stage)
        if reason is not None:
            result["reason"] = str(reason)
        return result

    def media_mark(
        self,
        delivery_id: str,
        media_id: str,
        state: str,
        detail: Optional[str] = None,
        sha256: Optional[str] = None,
        path_meta: Optional[str] = None,
    ) -> str:
        """Advance one attachment's durable lifecycle state. Progress only, terminals forever.

        The row is the answer to "did this media actually reach the person", so a late or
        duplicated receipt must never turn a settled answer back into an optimistic one. A
        rejected mark is logged at INFO rather than swallowed, because a regression attempt is a
        real signal about the sender, not noise.
        """
        if not isinstance(delivery_id, str) or not delivery_id:
            return "invalid"
        if not isinstance(media_id, str) or not media_id:
            return "invalid"
        if state not in MEDIA_LIFECYCLE_STATES:
            return "invalid"
        prior = self._db.execute(
            "SELECT state FROM media_lifecycle WHERE delivery_id = ? AND media_id = ?",
            (delivery_id, media_id),
        ).fetchone()
        if prior is not None:
            prior_state = str(prior[0])
            if prior_state == state:
                return "duplicate"
            if prior_state in TERMINAL_MEDIA_STATES:
                logger.info(
                    "attach-v1: media %s of delivery %s already terminal as %s; dropping %s mark",
                    media_id, delivery_id, prior_state, state,
                )
                return "conflict"
            if state not in TERMINAL_MEDIA_STATES:
                if MEDIA_LIFECYCLE_STAGES[state] < MEDIA_LIFECYCLE_STAGES[prior_state]:
                    logger.info(
                        "attach-v1: media %s of delivery %s is at %s; dropping regressive %s mark",
                        media_id, delivery_id, prior_state, state,
                    )
                    return "conflict"
        with self._db:
            self._db.execute(
                "INSERT INTO media_lifecycle (delivery_id, media_id, sha256, path_meta, state, detail, updated_at_ms)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(delivery_id, media_id) DO UPDATE SET"
                " state = excluded.state, detail = excluded.detail, updated_at_ms = excluded.updated_at_ms,"
                " sha256 = COALESCE(excluded.sha256, media_lifecycle.sha256),"
                " path_meta = COALESCE(excluded.path_meta, media_lifecycle.path_meta)",
                (delivery_id, media_id, sha256, path_meta, state, detail, self._now_ms()),
            )
        return "recorded"

    def media_rows(self, delivery_id: str) -> List[Dict[str, Any]]:
        """Return every attachment row for one delivery occurrence, oldest media id first."""
        rows = self._db.execute(
            "SELECT media_id, sha256, path_meta, state, detail, updated_at_ms"
            " FROM media_lifecycle WHERE delivery_id = ? ORDER BY media_id",
            (delivery_id,),
        ).fetchall()
        result: List[Dict[str, Any]] = []
        for media_id, sha256, path_meta, state, detail, updated_at_ms in rows:
            result.append({
                "mediaId": str(media_id),
                "sha256": None if sha256 is None else str(sha256),
                "pathMeta": None if path_meta is None else str(path_meta),
                "state": str(state),
                "detail": None if detail is None else str(detail),
                "updatedAt": int(updated_at_ms),
            })
        return result

    def media_dedupe_claim(
        self,
        occurrence_key: str,
        sha256: str,
        destination: str,
        media_id: str,
    ) -> Dict[str, Any]:
        """Claim (occurrence, content hash, destination) for ``media_id``, or return the winner.

        Identity is the bytes, not the path: rewriting a file in place yields a new hash and so a
        genuinely new claim, while a retried or restarted send of the same bytes to the same
        destination reuses the already uploaded media id. The claim is a single conditional insert
        so two processes racing on the same spool cannot both believe they won.
        """
        if not isinstance(occurrence_key, str) or not occurrence_key:
            raise ValueError("media_dedupe_claim requires a non-empty occurrence key")
        if not isinstance(sha256, str) or not sha256:
            raise ValueError("media_dedupe_claim requires a non-empty content hash")
        if not isinstance(destination, str) or not destination:
            raise ValueError("media_dedupe_claim requires a non-empty destination")
        if not isinstance(media_id, str) or not media_id:
            raise ValueError("media_dedupe_claim requires a non-empty media id")
        with self._db:
            claimed = self._db.execute(
                "INSERT INTO media_occurrences (occurrence_key, sha256, destination, media_id, created_at_ms)"
                " VALUES (?, ?, ?, ?, ?) ON CONFLICT(occurrence_key, sha256, destination) DO NOTHING",
                (occurrence_key, sha256, destination, media_id, self._now_ms()),
            ).rowcount == 1
            winner = self._db.execute(
                "SELECT media_id FROM media_occurrences"
                " WHERE occurrence_key = ? AND sha256 = ? AND destination = ?",
                (occurrence_key, sha256, destination),
            ).fetchone()
        return {"claimed": claimed, "media_id": str(winner[0])}

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

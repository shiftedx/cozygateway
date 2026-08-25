"""Platform adapter for the gateway attach protocol.

This is the only module that imports the harness tree, and it does so LAZILY inside
methods so the package stays importable (e.g. to call :func:`register`) without the
harness on the path. The wire logic lives in the harness-free siblings:
:mod:`.attach_client` (transport), :mod:`.text_blocks` (markdown to blocks), and
:mod:`.tool_chips` (the tool-chip tracker).

How the harness's native stream maps onto the attach protocol:

* The adapter dials OUT to the gateway ``/attach/v1`` WS and authenticates header-only
  with a bearer token. Nothing listens on the agent host.
* A gateway ``turn`` frame is injected as a synthetic inbound message. The frame's
  ``threadId`` becomes the harness chat id (so a thread resumes one session) and
  the ``turnId`` rides ``message_id`` (so the streamed reply anchors to its turn).
* As the model streams, the harness calls the draft surface with the FULL
  accumulated text per flush. The adapter normalizes that text to typed blocks,
  folds in the current tool chips, and sends one ``draft`` frame (full replace).
* The terminal reply is delivered through ``send()``: one final ``draft`` then a
  single ``done``. An empty reply with no prior content sends ``failed`` instead.
* Any exception on the turn path sends a best-effort ``failed`` and per-turn state
  is dropped in a ``finally`` so nothing leaks across turns.
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import math
import mimetypes
import os
import random
import re
import threading
import time
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass, field
from urllib.error import HTTPError
from typing import Any, Dict, List, Optional, Set, Tuple

from .attach_client import (
    AttachAuthError,
    AttachSupersededError,
    InterruptFrame,
    SteerFrame,
    TurnFrame,
)
from .attach_client_v1 import (
    HELLO_ACK_TIMEOUT_SECONDS,
    MOBILE_STATUS_VALUES,
    AttachV1Client,
    AttachV1ClientConfig,
    _is_location,
    _media_byte_limit,
    normalize_location_purpose,
)
from .attach_spool import AttachSpool
from .media_descriptor import (
    MEDIA_COMPATIBILITY_POLICY,
    MediaDescriptor,
    MediaProbeError,
    probe as probe_media,
)
from .text_blocks import (
    IncrementalNormalizer,
    block_split_index,
    normalize_text_to_blocks,
)
from .tool_chips import ToolChipTracker
from .memory import MemoryConflict, MemoryError, MemoryManager

logger = logging.getLogger(__name__)

# The registered platform name. It is also the value the harness stamps into the
# per-turn session context, so the tool hooks can filter to this platform's turns.
PLATFORM_NAME = "cozygateway"

# The harness binds these task-local session identifiers per turn and propagates
# them into the tool worker thread. They are harness-defined identifiers, used only
# to route a tool event back to the right turn.
SESSION_PLATFORM_KEY = "HERMES_SESSION_PLATFORM"  # harness-defined identifier
SESSION_CHAT_ID_KEY = "HERMES_SESSION_CHAT_ID"  # harness-defined identifier

# The harness's pre_tool_call / post_tool_call hook payload carries the tool
# call's real per-call id under this key (empty string when the harness has none
# to give). Present on both legs, it lets a chip's open and close pair exactly;
# see tool_chips.ToolChipTracker for the name#n fallback used otherwise.
TOOL_CALL_ID_KEY = "tool_call_id"  # harness-defined identifier

# A neutral inbound identity for the injected message. The turn was already
# authorized by the gateway that issued the token, so the adapter marks it
# role-authorized to pass the harness's per-message authorization gate.
INBOUND_USER = "user"


def _truthy(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "on"} if value else False


def _env_float(name: str, default: float) -> float:
    """Read a positive float from the environment, falling back on unset/garbage."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return value if (math.isfinite(value) and value > 0) else default


def _env_int(name: str, default: int) -> int:
    """Read a positive int from the environment, falling back on unset/garbage."""
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def _fresh_attach_token(fallback: str) -> str:
    """Reload the profile secret so a rotated token can heal without a process restart."""
    hermes_home = os.getenv("HERMES_HOME", "").strip()
    if hermes_home:
        try:
            from agent.secret_scope import load_env_file  # harness-defined identifier
            from pathlib import Path

            token = load_env_file(Path(hermes_home) / ".env").get("COZYGATEWAY_TOKEN", "")
            if token.strip():
                return token.strip()
        except Exception:
            logger.debug("attach: could not refresh token from the profile env", exc_info=True)
    return (os.getenv("COZYGATEWAY_TOKEN") or fallback).strip()


_COMMAND_NAME = re.compile(r"^/[A-Za-z0-9_-]{1,128}$")

# A one-shot proactive sender shares its spool with the resident adapter.  Keep a
# bounded shutdown in the foreground, but if a broken websocket watcher refuses
# to stop, retain the lease until that watcher really exits rather than allowing
# a second connection to supersede it.
_ONE_SHOT_CLEANUP_SECONDS = 0.25
_ONE_SHOT_CLEANUP_TASKS: Set[asyncio.Task] = set()


def hermes_gateway_commands() -> List[Dict[str, str]]:
    """Return the commands this Hermes profile exposes to messaging clients.

    Hermes owns command semantics. CozyGateway only carries this structured projection in the
    authenticated attach hello, so built-ins, plugins, config gates, and installed skill commands
    stay aligned with the same registry Telegram and Discord use.
    """
    catalog: List[Dict[str, str]] = []
    seen: Set[str] = set()

    def append(name: str, description: str, args_hint: str = "", category: str = "") -> None:
        invocation = name if name.startswith("/") else f"/{name}"
        if not _COMMAND_NAME.fullmatch(invocation) or invocation.lower() in seen:
            return
        clean_description = " ".join(str(description).split()).strip() or f"Run {invocation}"
        entry = {
            "name": invocation,
            "description": clean_description[:200],
        }
        clean_hint = " ".join(str(args_hint).split()).strip()
        clean_category = " ".join(str(category).split()).strip()
        if clean_hint:
            entry["argsHint"] = clean_hint[:160]
        if clean_category:
            entry["category"] = clean_category[:80]
        catalog.append(entry)
        seen.add(invocation.lower())

    try:
        from hermes_cli.commands import (
            COMMAND_REGISTRY,
            _is_gateway_available,
            _iter_plugin_command_entries,
            _resolve_config_gates,
        )

        overrides = _resolve_config_gates()
        for command in COMMAND_REGISTRY:
            if _is_gateway_available(command, overrides):
                append(command.name, command.description, command.args_hint, command.category)
        for name, description, args_hint in _iter_plugin_command_entries():
            append(name, description, args_hint, "Plugins")
    except Exception:
        logger.debug("attach: Hermes command registry unavailable", exc_info=True)

    try:
        from agent.skill_commands import get_skill_commands

        for name, info in sorted((get_skill_commands() or {}).items()):
            if not isinstance(info, dict):
                continue
            append(str(name), str(info.get("description") or "Skill"), category="Skills")
    except Exception:
        logger.debug("attach: Hermes skill commands unavailable", exc_info=True)

    return catalog[:512]


# ---------------------------------------------------------------------------
# The one media upload path
# ---------------------------------------------------------------------------

# A file the agent generated moments ago may still be flushing when its path is
# named, so the probe samples its size twice this far apart before trusting the
# bytes (spec finding 8). The probe runs on a worker thread, so the wait never
# stalls the event loop.
MEDIA_STABILITY_WAIT_SECONDS = _env_float("COZYGATEWAY_MEDIA_STABILITY_WAIT", 0.1)

# 429 is the one upload status worth re-attempting inside a single send: the
# gateway said exactly how long to wait and the bytes are already in hand. 5xx
# and dropped sockets stay failures here, because the durable delivery journal
# already owns those retries and a second one would only double the latency.
MEDIA_RETRY_AFTER_CAP_SECONDS = 2.0

# Lifecycle states that prove these exact bytes already reached the gateway for
# this occurrence, so a replay reuses the id instead of uploading a second copy.
MEDIA_ALREADY_UPLOADED_STATES = frozenset({"uploaded", "journaled", "projected", "displayed"})

# The delivery id a reply made inside a live conversation journals its attachments under. It is
# derived from the turn rather than assigned, so the gateway can rebuild the same id from the
# commit it already saw and address a receipt back at these rows.
TURN_DELIVERY_PREFIX = "turn:"

# Attachments of one reply upload in parallel, because each one spends nearly all of
# its time waiting on a socket. Three at a time is where a multi-attachment reply
# stops being the slowest thing in the turn without turning one person's send into a
# burst the gateway has to absorb.
MEDIA_UPLOAD_CONCURRENCY = 3

# The per-file caps are the gateway's own (contract/ext-bots-v1.md, "Canonical media
# allowlist"), read through the client so the two cannot drift. The contract sets no
# aggregate, so this is the plugin's guard on one occurrence: 16 attachments at the
# video cap would be 640 MiB moved for a single message.
# ponytail: a fixed number, not a policy engine. If the gateway ever publishes an
# aggregate cap, delete this constant and read that one.
MEDIA_AGGREGATE_MAX_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class MediaDestination:
    """Where one delivery is going, in the single shape every path agrees on.

    Spec finding 6: response delivery, standalone media, ``send_message`` and cron
    must not each infer the target differently. ``key`` is what content idempotency
    is scoped by, so the same bytes going somewhere else is a separate claim.
    """

    kind: str
    thread_id: str = ""

    @property
    def key(self) -> str:
        return self.kind if self.kind == "canonical_home" else "%s:%s" % (self.kind, self.thread_id)


@dataclass
class MediaBatch:
    """What one delivery's attachments actually became. Never a delivery claim."""

    uploaded: List[Dict[str, Any]] = field(default_factory=list)
    failed: List[Dict[str, Any]] = field(default_factory=list)
    # Inline block positions for the ACCEPTED attachments, index-for-index with
    # ``media_ids``. ``None`` means the caller had none, which is legacy above-stack
    # placement.
    media_positions: Optional[List[int]] = None

    @property
    def media_ids(self) -> List[str]:
        return [entry["mediaId"] for entry in self.uploaded]

    @property
    def error_lines(self) -> List[str]:
        """The bounded human-readable failure lines the durable result ABI carries."""
        return [str(entry["error"]) for entry in self.failed]

    def failure_sentence(self) -> str:
        """One plain sentence naming what the person will NOT see (spec finding 2)."""
        names = [str(entry["path"]) for entry in self.failed]
        if not names:
            return ""
        if len(names) == 1:
            listed = names[0]
        elif len(names) == 2:
            listed = " and ".join(names)
        else:
            listed = ", ".join(names[:-1]) + ", and " + names[-1]
        return "I could not attach %s." % listed

    def partial_result(self, message_id: Optional[str]) -> Dict[str, Any]:
        return {
            "state": "partial",
            "messageId": message_id,
            "uploaded": [dict(entry) for entry in self.uploaded],
            "failed": [dict(entry) for entry in self.failed],
        }


def _client_supports(client: Any, capability: str) -> bool:
    """Whether the gateway advertised ``capability`` on this connection.

    An empty/absent set means the client has not handshaken (or predates capability
    advertisement); that is not evidence of refusal, so it reads as permitted.
    """
    capabilities = getattr(client, "_capabilities", None)
    return capability in capabilities if capabilities else True


def _policy_block_reason(descriptor: MediaDescriptor) -> Optional[str]:
    """Refuse locally only what the bytes PROVE the client cannot render.

    Spec finding 9 wants an explicit compatibility policy; findings 1 and 8 want the
    refusal to happen before a network request. But an inconclusive probe is not
    evidence: when the bytes do not identify a type and the extension claims one the
    policy supports, this fails OPEN and lets the upload run. The gateway verifies
    magic numbers as the backstop and answers 415, which is a truthful rejection from
    the authority rather than a guess from a sniffer.
    """
    if descriptor.compatibility != "unsupported":
        return None
    if descriptor.detected_mime == "application/octet-stream":
        rule = MEDIA_COMPATIBILITY_POLICY.get(descriptor.declared_mime)
        if rule is not None and rule["status"] == "supported":
            return None
    return descriptor.incompatibility_reason or (
        "%s is not an allowed attachment type." % descriptor.mime
    )


def _retry_after_seconds(exc: HTTPError) -> float:
    try:
        value = float((exc.headers or {}).get("Retry-After", "") or 0)
    except (AttributeError, TypeError, ValueError):
        value = 0.0
    return min(max(value, 0.05), MEDIA_RETRY_AFTER_CAP_SECONDS)


def _media_failure(
    path: str,
    descriptor: Optional[MediaDescriptor],
    status: Optional[Any],
    error: str,
    media_id: Optional[str] = None,
) -> Dict[str, Any]:
    """One refused attachment, in the shape a partial result reports (finding 2).

    ``path`` is the basename only: a failure line travels into agent output and logs,
    and the directory a file sits in is nobody else's business.
    """
    return {
        "path": os.path.basename(path)[:128] or "attachment",
        "mime": descriptor.mime if descriptor is not None else (
            mimetypes.guess_type(path)[0] or "application/octet-stream"
        ),
        "status": status,
        "error": error,
        "mediaId": media_id,
    }


def _media_positions_for_draft(
    draft: str, cleaned: str, paths: List[str]
) -> Optional[List[int]]:
    """Where each path's marker line sat in the block flow of the delivered text.

    A ``position`` is the index in the message's normalized block array BEFORE which
    the attachment renders, so an image written under its heading renders under that
    heading instead of on a stack above the whole reply.

    The draft still carries the ``MEDIA:``/local-file marker lines (Hermes strips them
    only after the message handler returns), so the marker line IS the author's chosen
    spot. This locates each path's line in the draft, removes every marker line, checks
    that what remains normalizes to exactly the blocks the delivered ``cleaned`` text
    normalizes to, and then asks the shared normalizer how many blocks precede each cut.

    Answers ``None`` -- for ALL paths, never a partial array -- whenever any of that is
    not certain: a path named on more than one line, a marker inside a paragraph or a
    code fence, or a draft whose leftovers no longer match what Hermes delivered. The
    caller then omits positions entirely and the reader gets today's above-stack
    rendering, which is the whole point: an uncertain index must degrade to a picture in
    the wrong place, never to a lost picture.
    """
    if not paths:
        return None
    lines = re.sub(r"\r\n?", "\n", draft).split("\n")
    marker_line: Dict[str, int] = {}
    for path in paths:
        hits = [index for index, line in enumerate(lines) if path in line]
        if len(hits) != 1:
            return None
        marker_line[path] = hits[0]
    markers = set(marker_line.values())
    stripped = "\n".join(line for index, line in enumerate(lines) if index not in markers)
    if normalize_text_to_blocks(stripped) != normalize_text_to_blocks(cleaned):
        return None
    positions: List[int] = []
    for path in paths:
        preceding = sum(1 for index in range(marker_line[path]) if index not in markers)
        position = block_split_index(stripped, preceding)
        if position is None:
            return None
        positions.append(position)
    return positions


@dataclass
class _PreparedMedia:
    """One attachment after probing: either a refusal, or bytes ready for the wire."""

    index: int
    path: str
    descriptor: Optional[MediaDescriptor] = None
    media_id: Optional[str] = None
    failure: Optional[Dict[str, Any]] = None


class MediaUploadService:
    """Local paths to gateway media ids: one implementation, four callers.

    The active-turn terminal send, the proactive tool send, the standalone/resend
    surfaces and the cron lane all call :meth:`upload`, so probing, the compatibility
    gate, content idempotency, the exact upload MIME and the durable lifecycle marks
    happen once and identically (spec P1, "unified delivery path").

    Nothing here claims delivery. The batch says what the gateway accepted and what it
    refused; the caller journals. A row only moves past ``journaled`` when a receipt
    says so, so "uploaded" and "journaled" can never be read as "the person saw it".
    """

    def __init__(
        self,
        client: Any,
        *,
        delivery_id: str,
        destination: MediaDestination,
        spool: Optional[AttachSpool] = None,
    ) -> None:
        self._client = client
        self._delivery_id = delivery_id
        self._destination = destination
        self._spool = spool if spool is not None else getattr(client, "_spool", None)

    # -- durable lifecycle ---------------------------------------------------
    def _mark(self, media_id: str, state: str, **fields: Any) -> str:
        """Record one lifecycle transition. A spool-less caller still delivers."""
        spool = self._spool
        if spool is None:
            return "unavailable"
        try:
            return spool.media_mark(self._delivery_id, media_id, state, **fields)
        except Exception:  # noqa: BLE001 - observability must never fail a delivery
            logger.debug("attach: media lifecycle mark failed", exc_info=True)
            return "unavailable"

    def _row_state(self, media_id: str) -> Optional[str]:
        spool = self._spool
        if spool is None:
            return None
        try:
            for row in spool.media_rows(self._delivery_id):
                if row["mediaId"] == media_id:
                    return str(row["state"])
        except Exception:  # noqa: BLE001 - an unreadable row only costs a re-upload
            logger.debug("attach: media lifecycle read failed", exc_info=True)
        return None

    def mark_journaled(self, media_ids: List[str]) -> None:
        """The commit carrying these ids was accepted by the durable event journal."""
        for media_id in media_ids:
            self._mark(media_id, "journaled")

    def mark_blocked(self, media_ids: List[str], detail: str) -> None:
        """The occurrence was abandoned before it was journaled (atomic rollback)."""
        for media_id in media_ids:
            self._mark(media_id, "blocked", detail=detail[:512])

    # -- upload --------------------------------------------------------------
    async def upload(
        self, paths: List[str], positions: Optional[List[int]] = None
    ) -> MediaBatch:
        """Upload ``paths``; ``positions`` (when given) is aligned index-for-index.

        Positions ride alongside the slots, they never reorder them: an attachment the
        gateway refuses drops its position with it, and the ones that survive keep the
        block index the author wrote them at.
        """
        batch = MediaBatch()
        if positions is not None and len(positions) != len(paths):
            positions = None
        if not paths:
            return batch
        if not _client_supports(self._client, "media"):
            # The one cheap authorization check this API offers: the hello ack says
            # whether this connection may carry media at all, and it costs nothing.
            # ponytail: attach-v1 has no destination-authorization endpoint (only
            # POST/GET/DELETE media and GET deliveries), so "may this target receive
            # this?" is still only answered when the delivery is journaled. Inventing
            # a preflight route belongs to the gateway lane, not here.
            for path in paths:
                batch.failed.append(
                    _media_failure(path, None, "media_unavailable", "%s: media_unavailable" % (
                        os.path.basename(path)[:128] or "attachment",
                    ))
                )
            return batch
        limiter = asyncio.Semaphore(MEDIA_UPLOAD_CONCURRENCY)

        async def prepare(index: int, path: str) -> "_PreparedMedia":
            async with limiter:
                return await self._prepare(index, path)

        # Probe every path first. The sizes decide whether the occurrence is sendable at
        # all, and no byte goes on the wire until they do (spec finding 8).
        prepared = list(await asyncio.gather(
            *(prepare(index, path) for index, path in enumerate(paths))
        ))
        refusal = self._aggregate_refusal(prepared)
        if refusal is not None:
            batch.failed.extend(refusal)
            return batch

        async def send(item: "_PreparedMedia") -> Tuple[bool, Dict[str, Any]]:
            if item.failure is not None:
                return False, item.failure
            async with limiter:
                return await self._send(item)

        # gather preserves argument order, so a media id keeps the slot its index gave it
        # however the uploads interleave.
        accepted_positions: List[int] = []
        results = await asyncio.gather(*(send(item) for item in prepared))
        for item, (ok, record) in zip(prepared, results):
            if ok:
                batch.uploaded.append(record)
                if positions is not None:
                    accepted_positions.append(positions[item.index])
            else:
                batch.failed.append(record)
        if positions is not None:
            batch.media_positions = accepted_positions
        return batch

    async def _prepare(self, index: int, path: str) -> "_PreparedMedia":
        """Probe one path and answer every question that does not need the network."""
        name = os.path.basename(path)[:128] or "attachment"
        try:
            descriptor = await asyncio.to_thread(
                probe_media, path, stability_wait_s=MEDIA_STABILITY_WAIT_SECONDS
            )
        except MediaProbeError as err:
            logger.warning("attach: %s is not ready to upload: %s", name, err)
            return _PreparedMedia(index, path, failure=_media_failure(
                path, None, err.code, "%s: %s" % (name, err.code)))
        except Exception as exc:  # noqa: BLE001 - a probe fault is that file's failure
            return _PreparedMedia(index, path, failure=_media_failure(
                path, None, None, _proactive_media_error(path, exc)))

        media_id = _proactive_media_id(self._delivery_id, index, descriptor.sha256)
        reason = _policy_block_reason(descriptor)
        if reason is not None:
            # No network request: the bytes already answered the question (finding 8).
            return _PreparedMedia(index, path, descriptor, failure=self._blocked(
                media_id, path, descriptor, "unsupported_media_type",
                "%s (%s, family=%s): unsupported_media_type"
                % (name, descriptor.mime, descriptor.family),
                reason,
            ))

        limit = _media_byte_limit(descriptor.mime)
        if descriptor.size_bytes > limit:
            detail = "%s is %d bytes, over the %d byte cap for %s" % (
                name, descriptor.size_bytes, limit, descriptor.mime,
            )
            return _PreparedMedia(index, path, descriptor, failure=self._blocked(
                media_id, path, descriptor, "too_large",
                "%s: too_large (%s)" % (name, detail), detail,
            ))
        return _PreparedMedia(index, path, descriptor, media_id)

    def _aggregate_refusal(self, prepared: List["_PreparedMedia"]) -> Optional[List[Dict[str, Any]]]:
        """Refuse the whole occurrence when its attachments together are too much.

        Individually legal files can still add up to more than one message should move,
        and half a message is not a useful outcome, so this is all or nothing.
        """
        total = sum(
            item.descriptor.size_bytes for item in prepared
            if item.failure is None and item.descriptor is not None
        )
        if total <= MEDIA_AGGREGATE_MAX_BYTES:
            return None
        detail = "%d attachments total %d bytes, over the %d byte cap for one message" % (
            len(prepared), total, MEDIA_AGGREGATE_MAX_BYTES,
        )
        logger.warning("attach: refusing delivery %s locally: %s", self._delivery_id, detail)
        failures = []
        for item in prepared:
            if item.failure is not None:
                failures.append(item.failure)
                continue
            name = os.path.basename(item.path)[:128] or "attachment"
            failures.append(self._blocked(
                item.media_id or "", item.path, item.descriptor, "too_large",
                "%s: too_large (%s)" % (name, detail), detail,
            ))
        return failures

    def _blocked(
        self,
        media_id: str,
        path: str,
        descriptor: Optional[MediaDescriptor],
        status: str,
        error: str,
        detail: str,
    ) -> Dict[str, Any]:
        """One attachment refused before any network request, recorded durably."""
        if media_id:
            self._mark(
                media_id, "blocked", detail=detail,
                sha256=descriptor.sha256 if descriptor is not None else None,
                path_meta=descriptor.filename if descriptor is not None else None,
            )
        logger.warning("attach: refusing %s locally: %s", os.path.basename(path)[:128], detail)
        return _media_failure(path, descriptor, status, error, media_id or None)

    async def _send(self, item: "_PreparedMedia") -> Tuple[bool, Dict[str, Any]]:
        """Claim the slot, then put one prepared file on the wire."""
        path, descriptor = item.path, item.descriptor
        assert descriptor is not None and item.media_id is not None
        name = os.path.basename(path)[:128] or "attachment"
        media_id = self._claim(item.index, descriptor, item.media_id)
        if self._row_state(media_id) in MEDIA_ALREADY_UPLOADED_STATES:
            return True, self._accepted(media_id, path, descriptor, reused=True)
        self._mark(
            media_id, "prepared", sha256=descriptor.sha256, path_meta=descriptor.filename,
        )
        if descriptor.mime_mismatch:
            logger.info(
                "attach: %s is named %s but its bytes are %s; uploading as the bytes",
                name, descriptor.declared_mime, descriptor.detected_mime,
            )
        for attempt in (0, 1):
            try:
                await self._client.upload_media(
                    media_id, descriptor.path, descriptor.family,
                    mime=descriptor.mime, sha256=descriptor.sha256,
                )
            except HTTPError as exc:
                if exc.code == 429 and attempt == 0:
                    await asyncio.sleep(_retry_after_seconds(exc))
                    continue
                return False, self._refused(media_id, path, descriptor, exc, exc.code)
            except Exception as exc:  # noqa: BLE001 - one file, not the whole send
                return False, self._refused(media_id, path, descriptor, exc, None)
            self._mark(media_id, "uploaded")
            return True, self._accepted(media_id, path, descriptor, reused=False)
        # Unreachable: the loop above either returns or retries exactly once.
        return False, _media_failure(path, descriptor, None, "%s: upload_failed" % name, media_id)

    def _claim(self, index: int, descriptor: MediaDescriptor, media_id: str) -> str:
        """Persisted idempotency: (occurrence slot, content hash, destination).

        The slot index is part of the occurrence key on purpose. Identity is the bytes,
        so a rewritten file is a genuinely new claim and a retry of the same send is not;
        but two attachments that happen to hold identical bytes in ONE message are two
        attachments, and collapsing them would silently drop one from the person's view.
        """
        spool = self._spool
        if spool is None:
            return media_id
        try:
            claim = spool.media_dedupe_claim(
                "%s#%d" % (self._delivery_id, index),
                descriptor.sha256,
                self._destination.key,
                media_id,
            )
        except Exception:  # noqa: BLE001 - a failed claim costs one duplicate upload
            logger.debug("attach: media dedupe claim failed", exc_info=True)
            return media_id
        return str(claim.get("media_id") or media_id)

    def _accepted(
        self, media_id: str, path: str, descriptor: MediaDescriptor, *, reused: bool
    ) -> Dict[str, Any]:
        return {
            "mediaId": media_id,
            "path": descriptor.filename,
            "mime": descriptor.mime,
            "family": descriptor.family,
            "bytes": descriptor.size_bytes,
            "sha256": descriptor.sha256,
            "reused": reused,
            "source": path,
        }

    def _refused(
        self,
        media_id: str,
        path: str,
        descriptor: MediaDescriptor,
        exc: Exception,
        status: Optional[int],
    ) -> Dict[str, Any]:
        detail = _proactive_media_error(descriptor.path, exc, descriptor)
        self._mark(media_id, "upload_failed", detail=detail)
        logger.warning(
            "attach: upload refused for delivery %s media %s: %s",
            self._delivery_id, media_id, detail,
        )
        return _media_failure(path, descriptor, status, detail, media_id)


class AttachAdapter:
    """The platform methods, mixed into a concrete adapter subclass by the factory.

    Kept as a plain class so the wire logic is readable and testable in isolation;
    :func:`_make_adapter_class` produces the concrete subclass the plugin registers.
    """

    # The stream consumer splits a reply that exceeds this into multiple sends, and
    # each send commits once. This platform renders any length, so the cap is raised
    # far above any reply to keep a turn a single commit.
    MAX_MESSAGE_LENGTH = 1_000_000

    # Attach drafts are the durable turn message under construction, not
    # disposable previews. Keep Hermes tool-boundary segment breaks on the
    # draft path; only the true turn-final send may emit ``done`` and clean up.
    draft_stream_is_message = True

    # -- construction ---------------------------------------------------------
    def _attach_init(self, config: Any) -> None:
        extra = getattr(config, "extra", {}) or {}
        # Retained so a proactive media send can fall back to the durable one-shot
        # journal when this adapter's own socket is not writable.
        self._pconfig: Any = config
        self.gateway_url: str = (
            os.getenv("COZYGATEWAY_URL") or extra.get("gateway_url", "")
        ).rstrip("/")
        # The attach bearer token. Header-only; never logged, never in a URL.
        self.token: str = os.getenv("COZYGATEWAY_TOKEN") or extra.get("token", "")
        self._profile: str = str(extra.get("profile") or os.getenv("HERMES_PROFILE") or "").strip()
        self.ca_file: Optional[str] = (
            os.getenv("COZYGATEWAY_CA_FILE") or extra.get("ca_file") or None
        )
        self._spool_path: Optional[str] = extra.get("spool_path") or os.getenv("COZYGATEWAY_SPOOL_PATH") or None
        self._spool: Optional[AttachSpool] = None
        self._client: Optional[Any] = None
        self._watcher: Optional[asyncio.Task] = None
        self._closing: bool = False
        self._ready = asyncio.Event()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._reconnect_initial: float = _env_float(
            "COZYGATEWAY_RECONNECT_INITIAL_SECONDS", 0.5
        )
        self._reconnect_max: float = _env_float("COZYGATEWAY_RECONNECT_MAX_SECONDS", 30.0)
        # Injectable so tests are deterministic.
        self._reconnect_sleep = asyncio.sleep
        self._reconnect_jitter = random.random
        # Per-thread active turn id: set on inject, read by the draft / terminal
        # surfaces, dropped when the turn ends.
        self._active_turn: Dict[str, str] = {}
        # (threadId, turnId) already seen or in flight: a repeat is dropped, but
        # only within a bounded retention window -- see below.
        #
        # Bounded oldest-first: an OrderedDict used as an ordered set (values are
        # unused). A turn's entry is NOT dropped the moment it seals (done/failed);
        # it stays until evicted by the cap. That gives a re-dial replaying a
        # just-sealed turn (or one still in flight) a WINDOW-BOUNDED dedupe
        # guarantee, not an unconditional one: the replay is deduped as long as
        # fewer than `_seen_turns_max` other distinct turns have arrived since the
        # original. Once that many intervening distinct turns have arrived, the
        # entry is evicted and a later replay is treated as a new turn (and would
        # re-execute, even if the original is still in flight). This trades an
        # unbounded-duration redelivery guarantee for bounded memory over a
        # long-lived process.
        self._seen_turns: OrderedDict[Tuple[str, str], None] = OrderedDict()
        self._seen_turns_max: int = _env_int("COZYGATEWAY_SEEN_TURNS_MAX", 512)
        # Per-turn accumulated text (the last full flush) and tool-chip tracker.
        self._turn_text: Dict[str, str] = {}
        self._tool_chips: Dict[str, ToolChipTracker] = {}
        # Per-turn incremental block-normalization cache: makes repeated draft
        # flushes over a long streaming reply proportional to newly arrived text
        # rather than re-normalizing the whole accumulated reply every time (see
        # IncrementalNormalizer). Wire output stays byte-identical full-replace.
        self._normalizers: Dict[str, IncrementalNormalizer] = {}
        # Whether any draft for a turn has carried visible content yet.
        self._content_seen: Dict[str, bool] = {}
        # Hermes strips terminal MEDIA/local-file directives only after the
        # message handler returns. Attach-v1 must know those paths before its
        # terminal send seals the turn, so retain them at that boundary.
        self._turn_media: Dict[str, List[str]] = {}
        # Where each of those paths sat in the reply's block flow, when the draft
        # said so unambiguously: ``{turnId: (cleanedBlocks, {path: position})}``.
        # Absent (or dropped at send time) means legacy above-stack placement.
        self._turn_media_positions: Dict[str, Tuple[List[Any], Dict[str, int]]] = {}
        # Hermes subsequently runs its conventional per-platform media phase.
        # Remember successful atomic uploads so those calls can be acknowledged
        # without a duplicate upload or a misleading fallback warning.
        self._absorbed_media: OrderedDict[str, None] = OrderedDict()
        self._absorbed_media_max = 512
        # Hermes' clarify callback gives the platform stable clarify ids plus display choices.
        # Keep the bounded id→answer map and original wire presentation until the durable
        # resolution command is executed and its terminal confirmation is journaled.
        self._clarify_choices: Dict[str, Dict[str, str]] = {}
        self._clarify_context: Dict[str, Tuple[str, List[Dict[str, str]]]] = {}
        # Strong refs to fire-and-forget tasks; the loop keeps only a weak ref to a
        # bare create_task result, so hold each here until it finishes.
        self._background_tasks: Set[asyncio.Task] = set()
        self._memory_manager = MemoryManager(extra, os.getenv("HERMES_HOME"))
        # A memory request reads real files and provider SQL, so it runs on a worker
        # thread and exactly one runs at a time. A second request arriving while one
        # is in flight is refused immediately: queueing them would let a search
        # keystroke stream build an unbounded backlog of full-vault scans.
        self._memory_busy: Optional[str] = None
        # Completed mutations by request id, so a replay of a request the gateway
        # already gave up waiting for returns the first outcome instead of applying
        # the write a second time. Bounded oldest-first.
        self._memory_results: OrderedDict[str, Tuple[str, Optional[Dict[str, Any]], Optional[str], Optional[Dict[str, Any]]]] = OrderedDict()
        self._memory_results_max = 64

    def _spawn_background(self, loop: asyncio.AbstractEventLoop, coro: Any) -> None:
        task = loop.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)

    def _normalize(self, turn_id: str, text: str) -> List[Any]:
        """Normalize ``text`` to blocks via this turn's incremental cache.

        Byte-identical to calling ``normalize_text_to_blocks(text)`` directly, but
        does work proportional to what changed since the last call for this turn
        (see :class:`IncrementalNormalizer`). One instance per turn id, so a
        second concurrent turn never shares (or corrupts) another's cache.
        """
        normalizer = self._normalizers.get(turn_id)
        if normalizer is None:
            normalizer = IncrementalNormalizer()
            self._normalizers[turn_id] = normalizer
        return normalizer.update(text)

    def set_message_handler(self, handler: Any) -> None:
        """Stage safe local reply media while preserving Hermes' response."""

        async def wrapped(event: Any) -> Any:
            response = await handler(event)
            chat_id = getattr(getattr(event, "source", None), "chat_id", None)
            turn_id = self._active_turn.get(chat_id) if isinstance(chat_id, str) else None
            if turn_id and isinstance(response, str):
                self._stage_response_media(turn_id, response)
            return response

        self._message_handler = wrapped  # harness-defined callback slot

    def _stage_response_media(self, turn_id: str, response: str) -> None:
        """Mirror Hermes' safe extraction without altering its delivery input.

        The draft still holds the marker lines here, so this is also the ONE moment
        that can see where the author put each attachment. The block index is captured
        alongside the path; the terminal send puts it on the wire only if the delivered
        text still agrees with this snapshot.
        """
        try:
            media, cleaned = self.extract_media(response)  # type: ignore[attr-defined]
            explicit = [
                path
                for path, _is_voice in self.filter_media_delivery_paths(media)  # type: ignore[attr-defined]
            ]
        except Exception:  # noqa: BLE001 - a staging fault must not lose text
            logger.debug("attach: terminal media staging failed", exc_info=True)
            return
        paths = list(dict.fromkeys(str(path) for path in explicit if path))
        if not paths:
            return
        staged = paths[:16]
        self._turn_media[turn_id] = staged
        self._turn_media_positions.pop(turn_id, None)
        try:
            positions = _media_positions_for_draft(response, str(cleaned or ""), staged)
        except Exception:  # noqa: BLE001 - placement is a nicety; the picture is not
            logger.debug("attach: inline media positions unavailable", exc_info=True)
            return
        if positions is None:
            return
        self._turn_media_positions[turn_id] = (
            normalize_text_to_blocks(str(cleaned or "")),
            dict(zip(staged, positions)),
        )

    def _staged_positions(self, turn_id: str, paths: List[str]) -> Optional[List[int]]:
        """The staged block positions for exactly ``paths``, or ``None``.

        All or nothing: a turn whose attachments arrived from more than one place (a
        staged draft marker plus a path handed in by metadata) has no single authored
        order to honor, so the whole delivery falls back to legacy placement rather
        than positioning some attachments and stacking the rest.
        """
        staged = self._turn_media_positions.get(turn_id)
        if staged is None:
            return None
        _blocks, positions = staged
        if any(path not in positions for path in paths):
            return None
        return [positions[path] for path in paths]

    def _positions_still_true(self, turn_id: str, blocks: List[Any]) -> bool:
        """Whether the sealed blocks are still the draft the positions were measured on.

        The measured blocks must remain a PREFIX of what is being sealed, which lets the
        one legitimate late edit through (the "I could not attach ..." sentence appended
        after a refused upload) while rejecting any rewrite that would move the indices.
        A holding prefix also keeps every position in range, since each one was counted
        inside those measured blocks.
        """
        staged = self._turn_media_positions.get(turn_id)
        if staged is None:
            return False
        measured, _positions = staged
        return list(blocks[: len(measured)]) == list(measured)

    @staticmethod
    def _media_family(path: str) -> str:
        family = (mimetypes.guess_type(path)[0] or "application/octet-stream").partition("/")[0]
        return family if family in {"image", "audio", "video"} else "file"

    @staticmethod
    def _media_key(path: str) -> str:
        return os.path.realpath(os.path.expanduser(path))

    def _remember_absorbed_media(self, path: str) -> None:
        key = self._media_key(path)
        self._absorbed_media[key] = None
        self._absorbed_media.move_to_end(key)
        while len(self._absorbed_media) > self._absorbed_media_max:
            self._absorbed_media.popitem(last=False)

    def _consume_absorbed_media(self, path: str) -> bool:
        key = self._media_key(path)
        if key not in self._absorbed_media:
            return False
        self._absorbed_media.pop(key)
        return True

    # -- connection lifecycle -------------------------------------------------
    async def connect(self, *, is_reconnect: bool = False) -> bool:
        # The harness forwards a keyword-only ``is_reconnect`` flag on every dial.
        # A dial here is always a fresh connection, so the distinction needs no
        # special handling.
        del is_reconnect
        if not self.gateway_url or not self.token:
            logger.error("attach: COZYGATEWAY_URL and COZYGATEWAY_TOKEN must be set")
            self._set_fatal_error(  # type: ignore[attr-defined]
                "config_missing",
                "COZYGATEWAY_URL and COZYGATEWAY_TOKEN must be set",
                retryable=False,
            )
            return False
        self._closing = False
        if self._spool is None:
            spool_path = self._spool_path or os.path.join(
                os.path.expanduser("~"), ".hermes", "cozygateway-attach-v1.sqlite"
            )
            self._spool = AttachSpool(str(spool_path))
        if not self._spool.acquire_transport_lease():
            self._set_fatal_error(  # type: ignore[attr-defined]
                "transport_owned",
                "another CozyGateway adapter owns this durable spool",
                retryable=True,
            )
            return False
        self._client = AttachV1Client(
            AttachV1ClientConfig(
                gateway_url=self.gateway_url,
                token=self.token,
                token_provider=lambda: _fresh_attach_token(self.token),
                spool=self._spool,
                ca_file=self.ca_file,
                on_turn=self._on_turn,
                on_steer=self._on_steer,
                on_interrupt=self._on_interrupt,
                on_approval=self._dispatch_approval_command,
                on_clarify=self._dispatch_clarify_command,
                on_memory=self._on_memory_command,
                on_ready=self._on_transport_ready,
                commands=hermes_gateway_commands(),
            )
        )
        try:
            await self._client.connect()
        except AttachAuthError as exc:
            self._spool.release_transport_lease()
            logger.error("attach: dial rejected (%s)", exc)
            self._set_fatal_error(  # type: ignore[attr-defined]
                "auth_rejected", str(exc), retryable=False
            )
            return False
        except Exception as exc:  # noqa: BLE001
            self._spool.release_transport_lease()
            logger.error("attach-v1: failed to dial /attach/v1 -- %s", exc)
            self._set_fatal_error(  # type: ignore[attr-defined]
                "connect_failed", str(exc), retryable=True
            )
            return False
        if self._watcher is not None and not self._watcher.done():
            self._watcher.cancel()
        self._loop = asyncio.get_running_loop()
        self._watcher = asyncio.create_task(self._watch_loop())
        try:
            await asyncio.wait_for(
                self._ready.wait(),
                2 * HELLO_ACK_TIMEOUT_SECONDS + 0.5,
            )
        except asyncio.TimeoutError:
            await self.disconnect()
            self._set_fatal_error(  # type: ignore[attr-defined]
                "handshake_timeout",
                "attach-v1 did not become writable",
                retryable=True,
            )
            return False
        return True

    def _on_transport_ready(self) -> None:
        """Publish connected state only after the server accepts the hello."""
        if self._closing:
            return
        self._ready.set()
        self._mark_connected()  # type: ignore[attr-defined]
        _register_active_adapter(self)
        logger.info("attach-v1: connected and writable at %s", self.gateway_url)

    async def _watch_loop(self) -> None:
        """Drain the socket; re-dial on a benign drop, stop on a fatal close."""
        while not self._closing:
            client = self._client
            if client is None:
                return
            try:
                await client.watch()
            except AttachSupersededError:
                logger.warning("attach: connection superseded; stopping")
                await self.disconnect()
                return
            except AttachAuthError:
                logger.warning("attach: credential rejected; retrying with bounded backoff")
            if self._closing:
                return
            self._ready.clear()
            _unregister_active_adapter(self)
            self._mark_disconnected()  # type: ignore[attr-defined]
            logger.warning("attach-v1: /attach/v1 dropped; reconnecting")
            if not await self._redial():
                return

    async def _redial(self) -> bool:
        """Re-dial with capped, jittered exponential backoff.

        Returns True once reconnected, or False if we stop because the adapter is
        closing or the dial hit a fatal (auth / superseded) condition. A jittered
        floor delay runs before every dial so an accept-then-close gateway cannot
        spin a hot loop and a fleet cannot stampede a just-restarted gateway.
        """
        delay = self._reconnect_initial
        while not self._closing:
            await self._reconnect_sleep(delay * (1.0 + self._reconnect_jitter()))
            if self._closing:
                return False
            client = self._client
            if client is None:
                return False
            try:
                await client.connect()
            except AttachSupersededError as exc:
                logger.warning("attach: reconnect superseded (%s); stopping", exc)
                await self.disconnect()
                return False
            except AttachAuthError as exc:
                logger.warning(
                    "attach: reconnect credential rejected (%s); retrying (backoff ~%.1fs)",
                    exc,
                    delay,
                )
                delay = min(delay * 2, self._reconnect_max)
                continue
            except Exception as exc:  # noqa: BLE001 - transient: back off and retry
                logger.warning(
                    "attach: reconnect failed (%s); retrying (backoff ~%.1fs)", exc, delay
                )
                delay = min(delay * 2, self._reconnect_max)
                continue
            logger.info("attach-v1: re-dialed %s; awaiting hello_ack", self.gateway_url)
            return True
        return False

    async def disconnect(self) -> None:
        self._closing = True
        self._ready.clear()
        _unregister_active_adapter(self)
        self._mark_disconnected()  # type: ignore[attr-defined]
        watcher = self._watcher
        self._watcher = None
        # The watch loop itself calls disconnect() on a fatal close; cancelling and
        # awaiting the CURRENT task would self-cancel mid-teardown, so skip it there
        # (the loop returns right after this call).
        if watcher is not None and watcher is not asyncio.current_task():
            watcher.cancel()
            try:
                await watcher
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._client is not None:
            await self._client.close()
            self._client = None
        if self._spool is not None:
            self._spool.release_transport_lease()
            self._spool.close()
            self._spool = None

    async def request_device_status(self, thread_id: str, turn_id: str) -> Dict[str, Any]:
        """One live-turn Mobile Node request; no client means no phone action."""
        client = self._client
        loop = self._loop
        if client is None or loop is None or loop.is_closed():
            return {"status": "device_unavailable"}
        pending = None
        try:
            if asyncio.get_running_loop() is loop:
                return await client.request_device_status(thread_id, turn_id)
            pending = asyncio.run_coroutine_threadsafe(
                client.request_device_status(thread_id, turn_id), loop,
            )
            return await asyncio.wrap_future(pending)
        except asyncio.CancelledError:
            if pending is not None:
                pending.cancel()
            return {"status": "cancelled"}
        except Exception:  # noqa: BLE001 - an attach fault is never a tool crash
            return {"status": "device_unavailable"}

    async def request_location(self, thread_id: str, turn_id: str, purpose: str) -> Dict[str, Any]:
        client = self._client
        loop = self._loop
        if client is None or loop is None or loop.is_closed():
            return {"status": "device_unavailable"}
        pending = None
        try:
            if asyncio.get_running_loop() is loop:
                return await client.request_location(thread_id, turn_id, purpose)
            pending = asyncio.run_coroutine_threadsafe(
                client.request_location(thread_id, turn_id, purpose), loop,
            )
            return await asyncio.wrap_future(pending)
        except asyncio.CancelledError:
            if pending is not None:
                pending.cancel()
            return {"status": "cancelled"}
        except Exception:  # noqa: BLE001 - an attach fault is never a tool crash
            return {"status": "device_unavailable"}

    def _inbound_source(self, thread_id: str) -> Any:
        """Build the synthetic-inbound ``source`` shared by turn, steer, and interrupt.

        ``_handle_turn``, ``_handle_steer``, and ``_handle_interrupt`` each inject a message on
        the SAME thread and must resolve to the SAME harness session -- a steer or interrupt that
        landed on a different chat id, user id, or authorization than the turn it targets would
        either miss the running session or (worse) silently open a new one. Routing all three
        through one helper keeps that same-session-identity invariant in lockstep: a future field
        added to the source only has to change here, and cannot drift between call sites.

        ``chat_id`` is the thread key, so all three frame types resume the one harness session.
        A non-empty user id plus ``role_authorized`` carries the upstream (gateway-issued token)
        authorization through the harness's per-message auth gate; the turn was already
        authorized by the gateway that issued the token, so the identity here is deliberately
        neutral (see ``INBOUND_USER``).
        """
        return self.build_source(  # type: ignore[attr-defined]
            chat_id=thread_id,
            chat_type="dm",
            user_name=INBOUND_USER,
            user_id=INBOUND_USER,
            role_authorized=True,
        )

    # -- inbound turn ---------------------------------------------------------
    def _on_turn(self, turn: TurnFrame) -> None:
        """Bound to the client's ``on_turn``: schedule the inject as a task.

        Runs on the drain loop; the actual inject is fired-and-forgotten so a slow
        turn never blocks the socket. Deduplicated on (threadId, turnId) within a
        bounded retention window: the dedupe set is capped, evicting the oldest
        entry once it overflows, so a replay arriving after `_seen_turns_max` other
        distinct turns is treated as new rather than deduped (see ``_seen_turns``
        for the exact boundary).
        """
        key = (turn.thread_id, turn.turn_id)
        if key in self._seen_turns:
            # Not moved to MRU here: a duplicate delivery does not extend its own
            # retention window.
            logger.debug("attach: dropping duplicate turn %s", key)
            return
        self._seen_turns[key] = None
        while len(self._seen_turns) > self._seen_turns_max:
            self._seen_turns.popitem(last=False)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return  # not in an event loop (defensive)
        self._spawn_background(loop, self._handle_turn(turn))

    async def _handle_turn(self, turn: TurnFrame) -> None:
        """Inject one turn frame as a synthetic inbound message."""
        from gateway.platforms.base import MessageEvent, cache_media_bytes  # harness-defined identifiers

        self._active_turn[turn.thread_id] = turn.turn_id
        # See _inbound_source for why turn/steer/interrupt share one source builder.
        # message_id is the per-turn reply anchor.
        source = self._inbound_source(turn.thread_id)
        media_urls: List[str] = []
        media_types: List[str] = []
        client = self._client
        if client is not None:
            for media_id in turn.media_ids:
                try:
                    data, filename, mime = await client.download_media(media_id)
                    cached = cache_media_bytes(data, filename=filename, mime_type=mime)
                    if cached is not None:
                        media_urls.append(cached.path)
                        media_types.append(cached.media_type)
                except Exception:  # noqa: BLE001 - one bad attachment must not drop the turn
                    logger.debug("attach: could not materialize inbound media %s", media_id, exc_info=True)
        event = MessageEvent(
            text=turn.text,
            source=source,
            message_id=turn.turn_id,
            media_urls=media_urls,
            media_types=media_types,
        )
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - best-effort failed, then clean up
            logger.debug("attach: handle_message raised", exc_info=True)
            await self._safe_failed(turn.thread_id, turn.turn_id, "turn error")
            self._cleanup_turn(turn.thread_id, turn.turn_id)

    # -- mid-turn steer -------------------------------------------------------
    def _on_steer(self, frame: SteerFrame) -> None:
        """Bound to the client's ``on_steer``: schedule the injection as a task."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_steer(frame))

    async def _handle_steer(self, frame: SteerFrame) -> None:
        """Inject a mid-turn steer as another inbound message on the same thread.

        Deliberately does NOT touch ``_active_turn``, ``_seen_turns``, or seal anything: with the
        agent-side config ``busy_input_mode=steer``, the harness's busy handler routes this
        injection into the running turn natively, and the continued reply keeps streaming under
        the original ``turn_id`` (still held in ``_active_turn[thread_id]``).
        """
        from gateway.platforms.base import MessageEvent  # harness-defined identifier

        # See _inbound_source for why turn/steer/interrupt share one source builder.
        source = self._inbound_source(frame.thread_id)
        # A distinct message_id for the injected message; the running turn's reply anchor is left
        # untouched so continued drafts still anchor to the original turn.
        event = MessageEvent(text=frame.text, source=source, message_id=f"{frame.turn_id}:steer")
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - a steer must never crash the drain loop
            logger.debug("attach: steer injection raised", exc_info=True)

    # -- hard interrupt -------------------------------------------------------
    def _on_interrupt(self, frame: InterruptFrame) -> None:
        """Bound to the client's ``on_interrupt``: schedule the native stop as a task."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_interrupt(frame))

    async def _handle_interrupt(self, frame: InterruptFrame) -> None:
        """Hard-stop the thread's running turn via an injected native ``/stop`` command.

        The harness exposes no callable interrupt entry point; its real hard-stop seam is an
        injected ``/stop`` slash-command message. ``stop`` is a member of the harness's
        ``ACTIVE_SESSION_BYPASS_COMMANDS``, so a ``/stop`` message delivered through
        ``handle_message`` on a busy session bypasses the queue and dispatches the harness's
        native interrupt-and-clear path (hard-stopping the run); on an idle session it is a
        clean no-op. This is the same injected-command seam ``_handle_steer`` rides to inject
        steer text, so it needs no extra harness import and this module stays importable
        without the harness on the path.

        The gateway independently records ``turn.interrupted`` on its side, so this only needs
        to stop the live run. A failed inject must never crash the drain loop, so it degrades to
        a best-effort no-op (debug-log-and-return).
        """
        from gateway.platforms.base import MessageEvent  # harness-defined identifier

        # See _inbound_source for why turn/steer/interrupt share one source builder.
        source = self._inbound_source(frame.thread_id)
        # A slash command, not a turn: the injected text must be exactly "/stop" (the harness
        # recognizes the command from the message text via MessageEvent.get_command), and no
        # reply anchor is attached -- a command carries no turn-derived message_id, and the
        # running turn's anchor is left untouched.
        event = MessageEvent(text="/stop", source=source)
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - an interrupt must never crash the drain loop
            logger.debug("attach: interrupt injection raised", exc_info=True)

    def _on_approval_command(self, command: Dict[str, Any]) -> None:
        """Resolve a durable v1 approval through Hermes' native slash-command seam."""
        thread_id = command.get("threadId")
        decision = command.get("decision")
        if not isinstance(thread_id, str) or decision not in {"approve", "deny"}:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_approval_command(thread_id, decision))

    async def _dispatch_approval_command(self, command: Dict[str, Any]) -> None:
        thread_id = command.get("threadId")
        decision = command.get("decision")
        if isinstance(thread_id, str) and decision in {"approve", "deny"}:
            await self._handle_approval_command(thread_id, decision)

    async def _handle_approval_command(self, thread_id: str, decision: str) -> None:
        from gateway.platforms.base import MessageEvent  # harness-defined identifier

        event = MessageEvent(
            text="/approve" if decision == "approve" else "/deny",
            source=self._inbound_source(thread_id),
        )
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            logger.debug("attach: approval command injection raised", exc_info=True)
            raise

    def _on_clarify_command(self, command: Dict[str, Any]) -> None:
        """Feed the selected stable option back into the same native conversation."""
        thread_id = command.get("threadId")
        turn_id = command.get("turnId")
        clarify_id = command.get("clarifyId")
        option_id = command.get("optionId")
        if not all(isinstance(value, str) and value for value in (thread_id, turn_id, clarify_id, option_id)):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_clarify_command(thread_id, turn_id, clarify_id, option_id))

    #: Operations that change memory, and so must not be applied twice for one request id.
    _MEMORY_MUTATIONS = ("create", "update", "delete")

    def _on_memory_command(self, command: Dict[str, Any]) -> None:
        """Hand the request to a background task so the receive loop keeps reading.

        The client awaits this callback inline, so serving the request here would
        hold up every other frame on the socket for the duration of a vault scan.
        """
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._spawn_background(loop, self._handle_memory_command(command))

    def _remember_memory_result(
        self, request_id: str, status: str, result: Optional[Dict[str, Any]] = None,
        message: Optional[str] = None, current: Optional[Dict[str, Any]] = None,
    ) -> None:
        self._memory_results[request_id] = (status, result, message, current)
        self._memory_results.move_to_end(request_id)
        while len(self._memory_results) > self._memory_results_max:
            self._memory_results.popitem(last=False)

    async def _handle_memory_command(self, command: Dict[str, Any]) -> None:
        """Serve an ephemeral request while the authenticated attach socket is live.

        The work itself runs on a worker thread: a full-vault scan is filesystem
        work measured in seconds, and doing it inline would stall this profile's
        heartbeats and turn traffic behind one search keystroke.
        """
        request_id, operation, input = command.get("requestId"), command.get("operation"), command.get("input")
        client = self._client
        if not isinstance(request_id, str) or not isinstance(operation, str) or not isinstance(input, dict) or not isinstance(client, AttachV1Client):
            return
        mutation = operation in self._MEMORY_MUTATIONS
        replayed = self._memory_results.get(request_id) if mutation else None
        if replayed is not None:
            status, result, message, current = replayed
            await client.send_memory_result(request_id, status, result=result, message=message, current=current)
            return
        if self._memory_busy is not None and self._memory_busy != request_id:
            await client.send_memory_result(
                request_id, "unavailable",
                message="memory is busy with another request; try again in a moment",
            )
            return
        self._memory_busy = request_id
        try:
            try:
                result = await asyncio.to_thread(self._memory_manager.execute, operation, input)
                if mutation: self._remember_memory_result(request_id, "ok", result=result)
                await client.send_memory_result(request_id, "ok", result=result)
            except MemoryConflict as error:
                if mutation: self._remember_memory_result(request_id, "conflict", message=str(error), current=error.current)
                await client.send_memory_result(request_id, "conflict", message=str(error), current=error.current)
            except MemoryError as error:
                if mutation: self._remember_memory_result(request_id, error.status, message=str(error))
                await client.send_memory_result(request_id, error.status, message=str(error))
            except Exception as error:
                # Named by exception class, never with exc_info: a UnicodeDecodeError
                # carries the offending file bytes in its args. A generic "source
                # unavailable" here is what hid a TypeError for a whole adapter.
                logger.debug("attach: memory management failed (%s: %s)", operation, type(error).__name__)
                await client.send_memory_result(
                    request_id, "unavailable",
                    message=f"the memory request could not be completed ({type(error).__name__})",
                )
        finally:
            if self._memory_busy == request_id: self._memory_busy = None

    async def _dispatch_clarify_command(self, command: Dict[str, Any]) -> None:
        thread_id = command.get("threadId")
        turn_id = command.get("turnId")
        clarify_id = command.get("clarifyId")
        option_id = command.get("optionId")
        if all(isinstance(value, str) and value for value in (thread_id, turn_id, clarify_id, option_id)):
            await self._handle_clarify_command(thread_id, turn_id, clarify_id, option_id)

    async def _handle_clarify_command(
        self, thread_id: str, turn_id: str, clarify_id: str, option_id: str,
    ) -> None:
        # Resolve Hermes' actual blocking clarify primitive. Injecting the option id as ordinary
        # chat text can be rejected as an invalid selection and can start/steer an unrelated turn.
        # The pending map is established by send_clarify below and uses stable wire ids.
        try:
            from tools.clarify_gateway import resolve_gateway_clarify  # harness-defined identifier

            choices = self._clarify_choices.get(clarify_id, {})
            context = self._clarify_context.get(clarify_id)
            answer = choices.get(option_id)
            client = self._client
            if not clarify_id or answer is None or context is None or not isinstance(client, AttachV1Client):
                raise RuntimeError("clarification mapping is unavailable")
            if not resolve_gateway_clarify(clarify_id, answer):
                raise RuntimeError("Hermes no longer has the clarification pending")
            prompt, options = context
            if await client.send_clarify_resolved(
                thread_id, turn_id, clarify_id, prompt, options, option_id,
            ) is None:
                raise RuntimeError("clarification confirmation could not be journaled")
            self._clarify_choices.pop(clarify_id, None)
            self._clarify_context.pop(clarify_id, None)
        except Exception:  # noqa: BLE001
            logger.debug("attach: clarify response injection raised", exc_info=True)
            raise

    async def send_clarify(
        self,
        chat_id: str,
        question: str,
        choices: Optional[List[Any]],
        clarify_id: str,
        session_key: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Project Hermes' blocking clarify callback into attach-v1 instead of plain chat text."""
        del session_key, metadata
        from gateway.platforms.base import SendResult  # harness-defined identifier

        client = self._client
        turn_id = self._active_turn.get(chat_id)
        labels = [str(choice).strip()[:512] for choice in (choices or []) if str(choice).strip()]
        if not isinstance(client, AttachV1Client) or not turn_id or not labels:
            return SendResult(success=False, error="attach-v1 clarification requires an active turn and choices")
        wire_options = [{"id": f"option-{index}", "label": label} for index, label in enumerate(labels[:20], start=1)]
        self._clarify_choices[clarify_id] = {item["id"]: item["label"] for item in wire_options}
        wire_prompt = str(question)[:4096]
        self._clarify_context[clarify_id] = (wire_prompt, wire_options)
        expires_at: Optional[int] = None
        try:
            from tools.clarify_gateway import get_clarify_timeout  # harness-defined identifier

            expires_at = int((time.time() + float(get_clarify_timeout())) * 1000)
        except Exception:
            pass
        queued = await client.send_clarify(
            chat_id, turn_id, clarify_id, wire_prompt, wire_options, expires_at,
        )
        if queued is None:
            self._clarify_choices.pop(clarify_id, None)
            self._clarify_context.pop(clarify_id, None)
            return SendResult(success=False, error="clarification turn is already terminal")
        return SendResult(success=True, message_id=clarify_id)

    def observe_approval_event(
        self,
        chat_id: str,
        approval_id: str,
        name: str,
        status: str,
    ) -> None:
        loop = self._loop
        if loop is None:
            return
        turn_id = self._active_turn.get(chat_id)
        client = self._client
        if not turn_id or not isinstance(client, AttachV1Client):
            return
        try:
            asyncio.run_coroutine_threadsafe(
                client.send_approval(chat_id, turn_id, approval_id, approval_id, name, status),
                loop,
            )
        except Exception:  # noqa: BLE001
            logger.debug("attach: approval lifecycle emit failed", exc_info=True)

    # -- streaming drafts -----------------------------------------------------
    def supports_draft_streaming(
        self, chat_type: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None
    ) -> bool:
        """This platform renders a live draft preview for every chat type."""
        return True

    def streaming_overflow_limit(self) -> int:
        """A large split budget so a long reply is never fragmented into many sends."""
        return 1_000_000

    async def send_draft(
        self,
        chat_id: str,
        draft_id: int,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Emit one ephemeral ``draft`` for the full accumulated text.

        The harness calls this per flush with the FULL text (not a delta). It must
        stay ephemeral: a ``done`` here would fragment the reply (the terminal
        commit is owned by ``send()``). A failure returns ``success=False`` so the
        harness backs off cleanly; it never raises into the consumer.
        """
        from gateway.platforms.base import SendResult  # harness-defined identifier

        turn_id = self._active_turn.get(chat_id)
        if self._client is None or not turn_id:
            # No live socket or no anchor yet: skip this frame without disabling
            # the transport (success keeps drafts flowing).
            return SendResult(success=True)
        self._turn_text[turn_id] = content
        blocks = self._normalize(turn_id, content)
        chips = self._chips(turn_id)
        if not blocks and not chips:
            return SendResult(success=True)  # nothing materialized yet
        self._content_seen[turn_id] = True
        try:
            await self._client.send_draft(chat_id, turn_id, blocks, tool_calls=chips)
        except (AttachAuthError, AttachSupersededError) as exc:
            return SendResult(success=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - degrade to a clean back-off
            logger.debug("attach: send_draft failed", exc_info=True)
            return SendResult(success=False, error=str(exc))
        return SendResult(success=True)

    # -- tool-chip tap --------------------------------------------------------
    def observe_tool_event(
        self,
        chat_id: str,
        phase: str,
        tool_name: str,
        detail: Optional[str],
        call_id: Optional[str] = None,
    ) -> None:
        """Sync entry from the agent worker thread (the native tool hooks). Never raises.

        Hops the fold and emit onto the adapter's event loop so all tracker and
        draft work happens single-threaded. A missing loop degrades silently.
        """
        loop = self._loop
        if loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(
                self._apply_tool_event(chat_id, str(phase), str(tool_name), detail, call_id),
                loop,
            )
        except Exception:  # noqa: BLE001 - a dead loop must degrade silently
            logger.debug("attach: observe_tool_event schedule failed", exc_info=True)

    async def _apply_tool_event(
        self,
        chat_id: str,
        phase: str,
        tool_name: str,
        detail: Optional[str],
        call_id: Optional[str] = None,
    ) -> None:
        """Fold one tool event into this turn's tracker, then emit a draft."""
        turn_id = self._active_turn.get(chat_id)
        if not turn_id:
            return
        tracker = self._tool_chips.setdefault(turn_id, ToolChipTracker())
        if phase == "start":
            tracker.open(tool_name, detail, call_id=call_id)
        else:
            tracker.close(tool_name, ok=(phase != "error"), detail=detail, call_id=call_id)
        self._content_seen[turn_id] = True
        await self._emit_tool_draft(chat_id, turn_id)

    async def _emit_tool_draft(self, chat_id: str, turn_id: str) -> None:
        """Push one draft carrying the current text plus tool chips. Never raises."""
        if self._client is None:
            return
        blocks = self._normalize(turn_id, self._turn_text.get(turn_id, ""))
        chips = self._chips(turn_id)
        if not blocks and not chips:
            return
        try:
            await self._client.send_draft(chat_id, turn_id, blocks, tool_calls=chips)
        except (AttachAuthError, AttachSupersededError):
            return
        except Exception:  # noqa: BLE001 - a chip is presentation-only
            logger.debug("attach: tool-chip draft failed", exc_info=True)

    def _chips(self, turn_id: str) -> Optional[List[Any]]:
        tracker = self._tool_chips.get(turn_id)
        chips = tracker.chips() if tracker else []
        return chips or None

    def _caller_active_turn(self, chat_id: str) -> Optional[str]:
        """The in-flight turn on ``chat_id`` -- only when the caller belongs to it.

        A scheduled/proactive send (a cron report, any caller with no turn
        affiliation) must never ride an in-flight turn it does not own; it takes the
        session-independent scheduled path exactly as it would with no turn active.
        See ``_caller_owns_active_turn``.
        """
        turn_id = self._active_turn.get(chat_id)
        if turn_id and not _caller_owns_active_turn(turn_id):
            return None
        return turn_id

    # -- terminal reply -------------------------------------------------------
    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Deliver one reply of a turn: a full draft, then ``done``.

        The gateway commits the latest draft as a durable message. That commit also SEALS the
        turn, unless this is a reply the agent produced part-way through its run, in which case
        it is marked ``continues`` and the turn keeps running (see ``_hermes_final_delivery``).
        An empty terminal reply with no prior visible content sends ``failed`` instead. Any
        exception on the path sends a best-effort ``failed``; per-message state is dropped in
        ``finally``, so the next reply of the same turn starts from a clean draft.
        """
        from gateway.platforms.base import SendResult  # harness-defined identifier

        client = self._client
        active_turn = self._caller_active_turn(chat_id)
        turn_id = reply_to or active_turn
        # An interim reply commits its message and leaves the turn running. See
        # ``_hermes_final_delivery`` for how the two are told apart.
        continues = bool(
            active_turn
            and turn_id == active_turn
            and not _hermes_final_delivery(reply_to, active_turn, metadata)
        )
        if client is None:
            return SendResult(success=False, error="attach not connected")
        if isinstance(metadata, dict) and metadata.get("_interim_send") and active_turn:
            # Hermes emits error/status notices through the ordinary platform
            # send surface while the agent keeps working. Render the latest
            # notice into the mutable draft, but never seal or clean up the
            # turn; the final reply below remains the sole owner of ``done``.
            base_text = self._turn_text.get(active_turn, "")
            notice = content.strip() if content else ""
            draft_text = "\n\n".join(part for part in (base_text, notice) if part)
            blocks = self._normalize(active_turn, draft_text)
            chips = self._chips(active_turn)
            if blocks or chips:
                self._content_seen[active_turn] = True
                try:
                    await client.send_draft(chat_id, active_turn, blocks, tool_calls=chips)
                except (AttachAuthError, AttachSupersededError) as exc:
                    return SendResult(success=False, error=str(exc))
                except Exception as exc:  # noqa: BLE001 - status is best-effort
                    logger.debug("attach: interim draft failed", exc_info=True)
                    return SendResult(success=False, error=str(exc))
            return SendResult(success=True)
        if not turn_id:
            # Hermes' cron "live adapter delivery" calls this surface with no in-flight
            # turn and a placeholder chat id. A thread-scoped scheduled event is only
            # accepted for the gateway's CURRENT native session, so an unpinned target
            # must ride the session-independent canonical-home form instead; otherwise
            # the placeholder (or a stale thread) is quarantined as unauthorized_target.
            metadata_thread = metadata.get("thread_id") if isinstance(metadata, dict) else None
            pinned_thread = str(metadata_thread or "").strip()
            canonical_home = not pinned_thread
            target_thread = pinned_thread or str(chat_id or "").strip()
            blocks = normalize_text_to_blocks(content)
            if not isinstance(client, AttachV1Client) or not blocks:
                return SendResult(success=False, error="no in-flight turn")
            if not canonical_home and not target_thread:
                return SendResult(success=False, error="no in-flight turn")
            delivery_key = ""
            try:
                from gateway.session_context import get_session_env  # harness-defined identifier

                delivery_key = str(
                    get_session_env("HERMES_SESSION_ID")
                    or get_session_env("HERMES_SESSION_KEY")
                    or ""
                ).strip()
            except Exception:
                pass
            if not delivery_key:
                delivery_key = hashlib.sha256(
                    f"{chat_id}\0{target_thread}\0{content}".encode("utf-8")
                ).hexdigest()
            delivery_id = "scheduled:" + delivery_key
            message_id = "scheduled-" + hashlib.sha256(
                delivery_id.encode("utf-8")
            ).hexdigest()[:32]
            frame = await client.send_scheduled(
                target_thread or None,
                delivery_id,
                message_id,
                blocks,
                canonical_home=canonical_home,
            )
            if frame is None:
                return SendResult(success=False, error="scheduled delivery unavailable")
            # Journaled and durable. Projection is asynchronous (spec finding 4): a
            # receipt arriving later upgrades the durable row, and ``delivery_state``
            # answers "did it land". Blocking the caller here only ever taught a slow
            # projection to look like a failure.
            receipt = _durable_receipt(self._spool, delivery_id)
            if receipt == "blocked":
                return SendResult(success=False, error="scheduled delivery blocked")
            if receipt == "failed":
                return SendResult(success=False, error="scheduled delivery failed")
            result = SendResult(success=True, message_id=message_id)
            if receipt != "projected":
                # Accepted-pending, exactly as the proactive-media path reports it.
                # Hermes core reads any non-network false result as a FORMATTING
                # failure and posts a second plain-text copy of the same reply, so a
                # durable acceptance returned as false duplicated a message that was
                # about to be displayed (incident 2026-08-24). Acceptance is what this
                # surface can honestly report; the lifecycle stays in the spool rows
                # and ``delivery_state``, which only move on a receipt.
                _decorate_send_result(
                    result,
                    "delivery_lifecycle",
                    {
                        "state": "journaled",
                        "accepted_pending": True,
                        "deliveryId": delivery_id,
                        "messageId": message_id,
                    },
                )
            return result
        keep_active = continues
        try:
            # The authoritative terminal text, or the last streamed buffer when the
            # terminal content is empty or whitespace (a draft-only turn).
            final_text = content if (content and content.strip()) else self._turn_text.get(
                turn_id, ""
            )
            chips = self._chips(turn_id)
            media_ids: List[str] = []
            media_positions: Optional[List[int]] = None
            uploaded_paths: List[str] = []
            media_result: Optional[Dict[str, Any]] = None
            service: Optional[MediaUploadService] = None
            raw_media: List[Any] = list(self._turn_media.get(turn_id, []))
            if isinstance(metadata, dict):
                metadata_media = metadata.get("media_files") or metadata.get("media") or []
                if isinstance(metadata_media, (list, tuple)):
                    raw_media.extend(metadata_media)
            if isinstance(client, AttachV1Client):
                paths = list(dict.fromkeys(path for path in raw_media if isinstance(path, str) and path))
                service = MediaUploadService(
                    client,
                    delivery_id=TURN_DELIVERY_PREFIX + turn_id,
                    destination=MediaDestination("active_turn", chat_id),
                    spool=self._spool,
                )
                sendable = paths[:16]
                batch = await service.upload(
                    sendable, self._staged_positions(turn_id, sendable)
                )
                media_ids = batch.media_ids
                media_positions = batch.media_positions
                uploaded_paths = [str(entry["source"]) for entry in batch.uploaded]
                if batch.failed:
                    # The text still commits, but it says so. Committing a reply that
                    # silently lost its central artifact is the failure mode spec
                    # finding 2 was written about.
                    for line in batch.error_lines:
                        logger.warning(
                            "attach: one reply media upload failed (%s); committing the remaining reply",
                            line,
                        )
                    sentence = batch.failure_sentence()
                    final_text = "\n\n".join(
                        part for part in (final_text.strip(), sentence) if part
                    )
                    media_result = batch.partial_result(turn_id)
            blocks = self._normalize(turn_id, final_text)
            if media_positions is not None and not self._positions_still_true(turn_id, blocks):
                # The delivered text is not the draft the positions were measured
                # against. Ship the attachments the way they have always shipped.
                media_positions = None
            had_content = self._content_seen.get(turn_id, False)
            if blocks or chips or media_ids:
                # Full replace with the reply's view, then commit it. The commit seals the turn
                # unless this is an interim reply, which only projects its message.
                await client.send_draft(chat_id, turn_id, blocks, tool_calls=chips)
                if isinstance(client, AttachV1Client):
                    await client.send_done(
                        chat_id, turn_id, media_ids=media_ids,
                        media_positions=media_positions, continues=continues,
                    )
                else:
                    # attach-v0 has no additive field to say "keep the turn open", so it keeps
                    # its historic terminal meaning rather than being quietly misreported.
                    await client.send_done(chat_id, turn_id)
            elif had_content:
                # Nothing new to draw, but earlier drafts carried content: commit the
                # latest good draft. Do not send an empty draft (it would wipe it).
                if isinstance(client, AttachV1Client):
                    await client.send_done(
                        chat_id, turn_id, media_ids=media_ids,
                        media_positions=media_positions, continues=continues,
                    )
                else:
                    await client.send_done(chat_id, turn_id)
            elif continues:
                # An interim reply with nothing in it is a no-op, not a failed turn: the agent
                # is still working and owns the terminal outcome.
                return SendResult(success=True)
            else:
                # No content ever materialized for this turn.
                await client.send_failed(chat_id, turn_id, "empty reply")
                return SendResult(success=True)
            if service is not None and media_ids:
                # A turn walks journaled -> displayed with nothing in between. `projected` is a
                # state the wire has no receipt for on this path: the gateway commits a turn from
                # the same frame that seals it, so there is no separate projection signal to
                # report. The next honest fact about these attachments is a phone saying it drew
                # them, which arrives as a delivery_receipt keyed by this same delivery id.
                service.mark_journaled(media_ids)
            for uploaded_path in uploaded_paths:
                self._remember_absorbed_media(uploaded_path)
        except (AttachAuthError, AttachSupersededError) as exc:
            return SendResult(success=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - best-effort failed on the way out
            # `failed` seals the turn, interim or not, so the anchor goes with it.
            keep_active = False
            await self._safe_failed(chat_id, turn_id, "turn error")
            return SendResult(success=False, error=str(exc))
        finally:
            self._cleanup_turn(chat_id, turn_id, keep_active=keep_active)
        result = SendResult(success=True, message_id=turn_id)
        if media_result is not None:
            _decorate_send_result(result, "media_result", media_result)
        return result

    async def send_or_update_status(
        self,
        chat_id: str,
        status_key: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Render Hermes lifecycle status into the mutable draft, never as a terminal reply."""
        del status_key
        interim_metadata = dict(metadata or {})
        interim_metadata["_interim_send"] = True
        return await self.send(chat_id, content, metadata=interim_metadata)

    async def send_proactive(
        self,
        chat_id: str,
        message: str,
        media_files: List[str],
        *,
        canonical_home: bool,
        delivery_key: str,
        media_positions: Optional[List[int]] = None,
    ) -> Dict[str, Any]:
        """Commit one tool-originated delivery through the resident writable socket.

        ``media_positions``, when given, is aligned index-for-index with ``media_files``
        and says which block each attachment renders before.
        """
        client = self._client
        if not isinstance(client, AttachV1Client) or not self._ready.is_set():
            return _proactive_failure("attach_not_writable")
        delivery_id, message_id = _proactive_identity(delivery_key)
        if len(media_files) > 16:
            return _proactive_failure("media_count_exceeded", delivery_id, message_id)
        service = MediaUploadService(
            client,
            delivery_id=delivery_id,
            destination=MediaDestination(
                "canonical_home" if canonical_home else "thread", chat_id
            ),
            spool=self._spool,
        )
        sendable = list(media_files[:16])
        batch = await service.upload(
            sendable,
            list(media_positions[:16]) if media_positions is not None else None,
        )
        media_ids = batch.media_ids
        if batch.failed:
            await client.rollback_uploaded_media(media_ids)
            service.mark_blocked(media_ids, "atomic occurrence abandoned before journal")
            return _proactive_failure(
                "media_upload_failed", delivery_id, message_id, batch.error_lines
            )
        blocks = normalize_text_to_blocks(message)
        if not blocks and not media_ids:
            return _proactive_failure("empty_delivery", delivery_id, message_id)
        frame = await client.send_scheduled(
            chat_id,
            delivery_id,
            message_id,
            blocks,
            media_ids,
            canonical_home=canonical_home,
            media_positions=batch.media_positions,
        )
        if frame is None:
            return _proactive_failure("scheduled_delivery_unavailable", delivery_id, message_id)
        service.mark_journaled(media_ids)
        result: Dict[str, Any] = {
            "state": "journaled",
            "accepted_pending": True,
            "deliveryId": delivery_id,
            "messageId": message_id,
            "eventId": frame["eventId"],
        }
        # Projection is asynchronous and durable (spec finding 4). The delivery is
        # accepted and pending; the receipts machinery upgrades the rows when the
        # gateway answers, and a timeout is never reinterpreted as a failure.
        receipt = _durable_receipt(self._spool, delivery_id)
        if receipt == "projected":
            result["state"] = "projected"
            result["accepted_pending"] = False
        elif receipt in {"blocked", "failed"}:
            # A terminal rejection that already landed is not an acceptance. Say so
            # here, or the caller reads "journaled" and reports a success the person
            # will never see.
            result["state"] = receipt
            result["accepted_pending"] = False
        return result

    async def _safe_failed(self, chat_id: str, turn_id: str, message: str) -> None:
        """Emit a ``failed`` frame, swallowing any error (best-effort teardown)."""
        client = self._client
        if client is None:
            return
        try:
            await client.send_failed(chat_id, turn_id, message)
        except Exception:  # noqa: BLE001 - already failing; nothing more to do
            logger.debug("attach: failed frame emit failed", exc_info=True)

    def _cleanup_turn(self, chat_id: str, turn_id: str, keep_active: bool = False) -> None:
        """Drop the per-MESSAGE state a reply leaves behind, and by default the turn with it.

        ``keep_active`` is for an interim reply: its message is complete, so the draft buffer,
        chips and staged media go, but the turn is still running and the thread's reply anchor
        must survive. Without it the drafts and tool chips the agent produces for the REST of the
        run find no active turn and are dropped on the floor.
        """
        self._turn_text.pop(turn_id, None)
        self._turn_media.pop(turn_id, None)
        self._turn_media_positions.pop(turn_id, None)
        self._tool_chips.pop(turn_id, None)
        self._normalizers.pop(turn_id, None)
        self._content_seen.pop(turn_id, None)
        if not keep_active and self._active_turn.get(chat_id) == turn_id:
            self._active_turn.pop(chat_id, None)

    async def _proactive_media_send(
        self,
        chat_id: str,
        path: str,
        caption: Optional[str],
        metadata: Optional[Dict[str, Any]],
    ) -> Any:
        """Deliver one standalone file that no in-flight turn owns.

        Hermes calls the per-media surfaces outside a turn too (a scheduled report, a
        resend of an earlier attachment). The base adapter has no attach transport and
        reports "native ... send unavailable", so route through the same proactive
        upload/commit machinery the tool path uses. Without a caller-pinned thread the
        delivery is session independent (canonical home), because a thread-scoped
        scheduled event is only accepted for the gateway's current native session.
        """
        from gateway.platforms.base import SendResult  # harness-defined identifier

        metadata_thread = metadata.get("thread_id") if isinstance(metadata, dict) else None
        pinned_thread = str(metadata_thread or "").strip()
        canonical_home = not pinned_thread
        target_thread = pinned_thread or str(chat_id or "").strip()
        if not canonical_home and not target_thread:
            return SendResult(success=False, error="no delivery target")
        text = caption or ""
        # Idempotent per file plus occurrence, exactly as the send_message tool path is:
        # a retry of the same occurrence must not double-post the attachment.
        delivery_key = "media:" + hashlib.sha256(
            "\0".join(
                [
                    _occurrence_key(),
                    PLATFORM_NAME,
                    target_thread,
                    "canonical_home" if canonical_home else "thread",
                    self._media_key(path),
                    text,
                ]
            ).encode("utf-8")
        ).hexdigest()
        if self._ready.is_set() and isinstance(self._client, AttachV1Client):
            result = await self.send_proactive(
                target_thread,
                text,
                [path],
                canonical_home=canonical_home,
                delivery_key=delivery_key,
            )
        else:
            result = await enqueue_proactive_delivery(
                getattr(self, "_pconfig", None),
                thread_id=target_thread,
                delivery_key=delivery_key,
                message=text,
                media_files=[path],
                canonical_home=canonical_home,
            )
        state = result.get("state")
        media_errors = result.get("media_errors") or []
        if state in {"projected", "displayed"}:
            self._remember_absorbed_media(path)
            return SendResult(success=True, message_id=result.get("messageId"))
        if state == "suppressed":
            return SendResult(success=True)
        if result.get("accepted_pending") and not media_errors:
            # Durably journaled with every attachment uploaded. This is Hermes' own
            # media surface, where a False result makes it emit "native ... send
            # unavailable" and try again; that would fire on every healthy delivery
            # now that projection is asynchronous. The truthful lifecycle lives in the
            # media_lifecycle rows and delivery_state(), which stay at "journaled"
            # until a receipt says otherwise: this is an acceptance, not a receipt.
            self._remember_absorbed_media(path)
            pending = SendResult(success=True, message_id=result.get("messageId"))
            _decorate_send_result(pending, "delivery_lifecycle", dict(result))
            return pending
        if state == "blocked":
            error = "scheduled media delivery blocked"
        elif state == "failed":
            error = str(result.get("error") or "scheduled media delivery failed")
        else:
            error = "scheduled media delivery journaled; projection not yet confirmed"
        if media_errors:
            detail = "; ".join(str(entry) for entry in media_errors)[:512]
            error = f"{error} ({detail})"
        return SendResult(success=False, error=error)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """Acknowledge video already committed atomically by ``send``, else deliver it."""
        if self._consume_absorbed_media(video_path):
            from gateway.platforms.base import SendResult  # harness-defined identifier

            return SendResult(success=True)
        turn_id = self._caller_active_turn(chat_id)
        if turn_id and video_path in self._turn_media.get(turn_id, []):
            result = await self.send(chat_id, caption or "", reply_to=turn_id, metadata=metadata)
            if getattr(result, "success", False):
                self._consume_absorbed_media(video_path)
            return result
        return await self._proactive_media_send(chat_id, video_path, caption, metadata)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: Optional[str] = None,
        file_name: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """Acknowledge a document already committed atomically by ``send``, else deliver it."""
        if self._consume_absorbed_media(file_path):
            from gateway.platforms.base import SendResult  # harness-defined identifier

            return SendResult(success=True)
        turn_id = self._caller_active_turn(chat_id)
        if turn_id and file_path in self._turn_media.get(turn_id, []):
            result = await self.send(chat_id, caption or "", reply_to=turn_id, metadata=metadata)
            if getattr(result, "success", False):
                self._consume_absorbed_media(file_path)
            return result
        return await self._proactive_media_send(chat_id, file_path, caption, metadata)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """Acknowledge audio already committed atomically by ``send``, else deliver it."""
        if self._consume_absorbed_media(audio_path):
            from gateway.platforms.base import SendResult  # harness-defined identifier

            return SendResult(success=True)
        turn_id = self._caller_active_turn(chat_id)
        if turn_id and audio_path in self._turn_media.get(turn_id, []):
            result = await self.send(chat_id, caption or "", reply_to=turn_id, metadata=metadata)
            if getattr(result, "success", False):
                self._consume_absorbed_media(audio_path)
            return result
        return await self._proactive_media_send(chat_id, audio_path, caption, metadata)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: Optional[str] = None,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        **kwargs: Any,
    ) -> Any:
        """Acknowledge a local image already committed atomically by ``send``, else deliver it."""
        if self._consume_absorbed_media(image_path):
            from gateway.platforms.base import SendResult  # harness-defined identifier

            return SendResult(success=True)
        turn_id = self._caller_active_turn(chat_id)
        if turn_id and image_path in self._turn_media.get(turn_id, []):
            result = await self.send(chat_id, caption or "", reply_to=turn_id, metadata=metadata)
            if getattr(result, "success", False):
                self._consume_absorbed_media(image_path)
            return result
        return await self._proactive_media_send(chat_id, image_path, caption, metadata)

    # -- no-op surfaces the protocol does not model ---------------------------
    async def send_typing(self, chat_id: str, metadata: Any = None) -> None:
        """The attach protocol has no typing indicator; a no-op that cannot fail."""
        return None

    async def stop_typing(self, chat_id: str) -> None:
        """The attach protocol has no typing indicator; a no-op that cannot fail."""
        return None

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        # A thread renders as a dm-shaped surface keyed by its id.
        return {"name": chat_id, "type": "dm", "chat_id": chat_id}

    def format_message(self, content: str) -> str:
        # Normalization happens in text_blocks; deliver content unchanged.
        return content


# ---------------------------------------------------------------------------
# Native tool-lifecycle hook wiring.
#
# The harness exposes process-global pre_tool_call / post_tool_call hooks. They do
# not carry a chat id, but the harness binds the per-turn (platform, chat_id) into
# task-local session context and propagates it into the tool worker thread, so a
# hook recovers the same thread id the turn was injected under. The hooks route to
# every active adapter via the registry below; each adapter is enrolled at connect
# and withdrawn at disconnect.
# ---------------------------------------------------------------------------

_ACTIVE_ADAPTERS: "Set[Any]" = set()
_ACTIVE_ADAPTERS_LOCK = threading.Lock()
_CURRENT_TOOL_OCCURRENCE: ContextVar[Optional[str]] = ContextVar(
    "cozygateway_tool_occurrence", default=None
)


def _register_active_adapter(adapter: Any) -> None:
    with _ACTIVE_ADAPTERS_LOCK:
        _ACTIVE_ADAPTERS.add(adapter)


def _unregister_active_adapter(adapter: Any) -> None:
    with _ACTIVE_ADAPTERS_LOCK:
        _ACTIVE_ADAPTERS.discard(adapter)


def _active_adapters_snapshot() -> List[Any]:
    with _ACTIVE_ADAPTERS_LOCK:
        return list(_ACTIVE_ADAPTERS)


def _current_turn_platform_and_chat() -> Tuple[Optional[str], Optional[str]]:
    """Read (platform, chat_id) for the current turn from the harness session context.

    Imported lazily so this module stays importable without the harness installed.
    """
    from gateway.session_context import get_session_env  # harness-defined identifier

    return (
        get_session_env(SESSION_PLATFORM_KEY) or None,
        get_session_env(SESSION_CHAT_ID_KEY) or None,
    )


def _current_turn_message_and_cron() -> Tuple[Optional[str], bool, Optional[str]]:
    """The injected message id is the active turn id; cron never has one."""
    from gateway.session_context import get_session_env  # harness-defined identifier

    return (
        get_session_env("HERMES_SESSION_MESSAGE_ID") or None,
        _truthy(get_session_env("HERMES_CRON_SESSION")),
        get_session_env("HERMES_SESSION_PROFILE") or None,
    )


def _hermes_final_delivery(
    reply_to: Optional[str],
    active_turn: str,
    metadata: Optional[Dict[str, Any]],
) -> bool:
    """True when this ``send`` is Hermes's OWN terminal delivery for ``active_turn``.

    A Hermes agent loop can reply several times before it is finished: ``send_message`` to the
    current chat during iteration 5 of 90 arrives on this same surface as the answer that ends
    the turn. The frame is identical, so the gateway cannot tell them apart -- it used to seal
    the turn on the first one, discard every later tool event and draft, and force-terminalize
    the still-running tool steps ("1 did not finish"). This adapter can tell them apart, because
    Hermes stamps its terminal delivery twice over and nothing else carries either mark:

    * ``reply_to`` is the turn's own reply anchor. ``_handle_turn`` injects the turn with
      ``message_id=turn_id``, and Hermes replies to that anchor
      (``_reply_anchor_for_event`` -> ``event.message_id``) only for the final response.
    * ``metadata["notify"]`` is Hermes's "this is user-visible final content" marker
      (``_mark_notify_metadata``), applied to every terminal reply and to nothing else.

    A mid-run ``send_message`` carries neither: the tool builds its own metadata
    (``thread_id`` at most) and passes no ``reply_to``. Both marks are checked because either one
    alone would be a single point of failure, and the cost of a false negative is only that the
    turn waits for its configured timeout instead of sealing at once.
    """
    if reply_to and reply_to == active_turn:
        return True
    return isinstance(metadata, dict) and metadata.get("notify") is True


def _caller_owns_active_turn(turn_id: str) -> bool:
    """True when the CALLER's own session is the session that owns ``turn_id``.

    ``send`` is a shared platform surface. A live turn's terminal reply arrives on
    it from inside that turn's own session, but Hermes also delivers a cron/routine
    report through the very same surface with no turn affiliation at all, from a
    session whose context is a cron run. ``_active_turn`` is keyed by chat id alone,
    so without this check a scheduled delivery that lands on a chat with an
    unrelated turn in flight is absorbed by that turn: its text replaces the live
    draft, ``done`` seals it, ``_cleanup_turn`` steals the turn from its real owner,
    and ``send`` returns success -- so no ``scheduled`` frame is ever journaled and
    the scheduler records a delivery that never happened.

    The harness binds the turn's message id (``HERMES_SESSION_MESSAGE_ID``) into the
    task-local session context of the turn that is running, and marks a cron run with
    ``HERMES_CRON_SESSION``; a cron session has no message id. A steer injects
    ``<turn_id>:steer`` as the message id while the original turn keeps streaming, so
    the prefix form counts as the same turn. When the harness context is unavailable
    (a standalone import, a test without the harness stubs) the historic behaviour is
    preserved: the active turn is adopted.
    """
    try:
        message_id, cron, _profile = _current_turn_message_and_cron()
    except Exception:  # noqa: BLE001 - no harness context to judge affiliation by
        return True
    if cron:
        return False
    if not message_id:
        return True
    return message_id == turn_id or message_id.startswith(f"{turn_id}:")


def _mobile_tool_result(status: str, result: Optional[Dict[str, Any]] = None) -> str:
    payload: Dict[str, Any] = {"status": status}
    if result is not None:
        payload["result"] = result
    return json.dumps(payload, separators=(",", ":"))


async def _cozy_device_status(_args: Dict[str, Any], **_kwargs: Any) -> str:
    """The one MN-0 tool: only a live CozyGateway turn may reach the phone."""
    return await _cozy_mobile(lambda adapter, chat_id, turn_id: adapter.request_device_status(chat_id, turn_id))


async def _cozy_request_location(args: Dict[str, Any], **_kwargs: Any) -> str:
    purpose = normalize_location_purpose(args.get("purpose"))
    if purpose is None:
        return _mobile_tool_result("policy_blocked")
    return await _cozy_mobile(lambda adapter, chat_id, turn_id: adapter.request_location(chat_id, turn_id, purpose), location=True)


async def _cozy_mobile(request: Any, location: bool = False) -> str:
    try:
        platform, chat_id = _current_turn_platform_and_chat()
        message_id, cron, profile = _current_turn_message_and_cron()
    except Exception:  # noqa: BLE001 - an unavailable harness context is noninteractive
        return _mobile_tool_result("policy_blocked")
    if platform != PLATFORM_NAME or not chat_id or cron:
        return _mobile_tool_result("policy_blocked")
    adapters = [
        adapter for adapter in _active_adapters_snapshot()
        if getattr(adapter, "_active_turn", {}).get(chat_id)
    ]
    if len(adapters) != 1 or not profile or profile != getattr(adapters[0], "_profile", None):
        return _mobile_tool_result("policy_blocked")
    turn_id = adapters[0]._active_turn[chat_id]
    if message_id != turn_id:
        return _mobile_tool_result("policy_blocked")
    try:
        outcome = await request(adapters[0], chat_id, turn_id)
    except asyncio.CancelledError:
        return _mobile_tool_result("cancelled")
    status = outcome.get("status")
    result = outcome.get("result")
    if status == "ok" and (not _is_location(result) if location else result != {"foreground": True}):
        status, result = "device_unavailable", None
    return _mobile_tool_result(
        status if isinstance(status, str) and status in MOBILE_STATUS_VALUES else "device_unavailable",
        result if isinstance(result, dict) else None,
    )


def _preview(value: Any, limit: int = 200) -> Optional[str]:
    """A short string preview of a hook payload, truncated, or None when absent."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    else:
        try:
            import json

            text = json.dumps(value, default=str)
        except Exception:  # noqa: BLE001
            text = str(value)
    text = text.strip()
    if not text:
        return None
    return text[:limit]


def _tool_call_id(kwargs: Dict[str, Any]) -> Optional[str]:
    """The harness's real per-call id from a hook payload, or None if absent.

    The harness always passes the key (see ``TOOL_CALL_ID_KEY``), defaulting it to
    ``""`` when it has no id to give, so an empty/blank value means "no id" the
    same as a missing key.
    """
    raw = kwargs.get(TOOL_CALL_ID_KEY)
    if not raw:
        return None
    text = str(raw).strip()
    return text or None


def _dispatch_tool_hook(phase: str, kwargs: Dict[str, Any]) -> None:
    """Forward one native tool hook firing to the active adapters. Never raises.

    Runs on the agent tool worker thread. Filters to this platform's turns via the
    session context and hands ``(chat_id, phase, tool_name, detail, call_id)`` to
    every active adapter, which hops it back onto its own loop.
    """
    try:
        platform, chat_id = _current_turn_platform_and_chat()
        if platform != PLATFORM_NAME or not chat_id:
            # Deliberately silent: these process-global hooks fire for every
            # platform's turns, so logging here would spam legitimate traffic.
            return
        adapters = _active_adapters_snapshot()
        if not adapters:
            return
        tool_name = str(kwargs.get("tool_name") or "")
        if not tool_name:
            return
        call_id = _tool_call_id(kwargs)
        if phase == "start":
            detail = _preview(kwargs.get("args"))
        elif str(kwargs.get("status") or "").lower() == "error":
            detail = _preview(kwargs.get("error_message") or kwargs.get("result"))
            phase = "error"
        else:
            detail = _preview(kwargs.get("result"))
            phase = "complete"
        for adapter in adapters:
            adapter.observe_tool_event(chat_id, phase, tool_name, detail, call_id)
    except Exception:  # noqa: BLE001 - a chip must never crash the tool loop
        logger.debug("attach: tool-hook dispatch failed", exc_info=True)


def _pre_tool_call(**kwargs: Any) -> None:
    """``pre_tool_call`` hook: the chip-open leg. Observer only (returns None)."""
    if str(kwargs.get("tool_name") or "") == "send_message":
        _CURRENT_TOOL_OCCURRENCE.set(_tool_call_id(kwargs))
    _dispatch_tool_hook("start", kwargs)


def _post_tool_call(**kwargs: Any) -> None:
    """``post_tool_call`` hook: the chip-close leg (carries the outcome)."""
    try:
        _dispatch_tool_hook("complete", kwargs)
    finally:
        if str(kwargs.get("tool_name") or "") == "send_message":
            _CURRENT_TOOL_OCCURRENCE.set(None)


#: The Hermes approval surfaces whose prompt this platform actually answers.
#:
#: Both of these route through ``tools/approval.py::_await_gateway_decision``: the
#: request is parked on the session's approval queue, the platform is told about it
#: through ``notify_cb``, and the agent blocks on that queue entry until the
#: canonical approval timeout elapses. A ``/approve`` or ``/deny`` injected by
#: ``_handle_approval_command`` resolves exactly that entry, so a card drawn for one
#: of these is a card a tap can settle.
ANSWERABLE_APPROVAL_SURFACES = frozenset({"gateway", "mcp-elicitation"})


def _is_answerable_approval(kwargs: Dict[str, Any]) -> bool:
    """True when THIS platform's approve/deny is the thing being waited on.

    Hermes fires ``pre_approval_request`` / ``post_approval_response`` for every
    approval surface, and most of them are decided somewhere no phone can reach:

    * ``surface="smart"`` -- ``approvals.mode: smart`` asks an auxiliary LLM
      guardian first. The pre hook fires, the aux model answers a second or two
      later, and the post hook fires with ``choice="smart_approve"`` /
      ``"smart_deny"``. A human was never in that loop.
    * ``surface="cli"`` -- an interactive prompt on the operator's own terminal.
    * ``surface="transport:<name>"`` -- a registered approval transport plugin has
      replaced every built-in prompt surface, including this one.
    * ``coalesced=True`` -- a FOLLOWER of an identical concurrent approval. It only
      adopts whatever the leader is answered with; it has no prompt of its own.

    Forwarding those is what made an Approve/Deny card appear and vanish before the
    user could act: the card was a read-out of somebody else's decision, drawn with
    buttons, and terminated the moment that decision landed. Only the surfaces this
    platform is the decider for become cards.
    """
    if kwargs.get("coalesced"):
        return False
    return str(kwargs.get("surface") or "").strip() in ANSWERABLE_APPROVAL_SURFACES


def _dispatch_approval_hook(phase: str, kwargs: Dict[str, Any]) -> None:
    """Observer-only Hermes approval hook → attach-v1 lifecycle event."""
    try:
        platform, chat_id = _current_turn_platform_and_chat()
        if platform != PLATFORM_NAME or not chat_id:
            return
        if not _is_answerable_approval(kwargs):
            return
        approval_id = _tool_call_id(kwargs)
        if approval_id is None:
            return
        if phase == "pending":
            status = "pending"
        else:
            choice = str(kwargs.get("choice") or "").lower()
            status = (
                "approved" if choice in {"once", "session", "always", "approve", "approved", "allow"}
                else "denied" if choice in {"deny", "denied"}
                else "expired" if choice in {"timeout", "expired"}
                else "cancelled"
            )
        name = str(kwargs.get("pattern_key") or kwargs.get("tool_name") or "tool")
        for adapter in _active_adapters_snapshot():
            adapter.observe_approval_event(chat_id, approval_id, name, status)
    except Exception:  # noqa: BLE001
        logger.debug("attach: approval-hook dispatch failed", exc_info=True)


def _pre_approval_request(**kwargs: Any) -> None:
    _dispatch_approval_hook("pending", kwargs)


def _post_approval_response(**kwargs: Any) -> None:
    _dispatch_approval_hook("resolved", kwargs)


# ---------------------------------------------------------------------------
# Registration.
# ---------------------------------------------------------------------------


def _make_adapter_class() -> type:
    """Build the concrete platform-adapter subclass (imports the harness lazily)."""
    from gateway.config import Platform  # harness-defined identifier
    from gateway.platforms.base import BasePlatformAdapter  # harness-defined identifier

    class _AttachPlatformAdapter(AttachAdapter, BasePlatformAdapter):
        def __init__(self, config: Any, **_kwargs: Any) -> None:
            try:
                platform = Platform(PLATFORM_NAME)
            except ValueError:
                # The core Platform enum is closed; a plugin platform registers its
                # name with the loader, so fall back to a generic value if present.
                platform = getattr(Platform, "WEBHOOK", None) or next(iter(Platform))
            BasePlatformAdapter.__init__(self, config=config, platform=platform)
            self._attach_init(config)

    return _AttachPlatformAdapter


def check_requirements() -> bool:
    """Dependency check: the outbound client needs ``websockets``."""
    try:
        import websockets  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def is_connected(*_args: Any) -> bool:
    """Configured iff both the gateway URL and the token are present."""
    return bool(os.getenv("COZYGATEWAY_URL") and os.getenv("COZYGATEWAY_TOKEN"))


async def _standalone_send(
    pconfig: Any,
    chat_id: str,
    message: str,
    *,
    thread_id: Optional[str] = None,
    media_files: Optional[List[str]] = None,
    force_document: bool = False,
    delivery_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Compatibility wrapper for Hermes' out-of-process cron sender.

    Cron and the live gateway share the Hermes home directory, so this process appends to the same
    WAL-backed event spool. The live adapter notices it on the next heartbeat and delivers it with
    the stream's one monotonic sequence; opening a competing socket here would incorrectly
    supersede the resident adapter.
    """
    del force_document
    target_thread = str(thread_id or chat_id or "").strip()
    # A cron session id is caller-owned and unique per execution while remaining stable across
    # delivery retries. Fall back to a content-addressed key for older harnesses that do not
    # expose session context; this still prevents retry duplication without inventing a clock.
    run_key = str(delivery_key or "").strip()
    try:
        from gateway.session_context import get_session_env  # harness-defined identifier

        if not run_key:
            run_key = str(get_session_env("HERMES_SESSION_ID") or get_session_env("HERMES_SESSION_KEY") or "").strip()
    except Exception:
        pass
    if not run_key:
        run_key = hashlib.sha256(f"{target_thread}\0{message}".encode("utf-8")).hexdigest()
    result = await enqueue_proactive_delivery(
        pconfig,
        thread_id=target_thread,
        delivery_key=run_key,
        message=message,
        media_files=media_files,
        canonical_home=True,
    )
    return result


async def _hermes_standalone_send(*args: Any, **kwargs: Any) -> Dict[str, Any]:
    """Translate durable Cozy states into upstream Hermes' success/error ABI."""
    return _hermes_delivery_result(await _standalone_send(*args, **kwargs))


def _hermes_delivery_result(result: Dict[str, Any]) -> Dict[str, Any]:
    """Translate a durable Cozy delivery state into upstream Hermes' success/error ABI.

    Confirmed projection and durable acceptance both report success. Reporting an
    accepted-pending occurrence as an error taught every caller that a healthy delivery
    had failed: hermes core retried it as a formatting failure and duplicated the
    message, and the scheduler kept the projection-timeout string as the run's delivery
    error long after the occurrence reached ``displayed`` (incident 2026-08-24). Only a
    rejection is an error now; ``delivery_state()`` still answers "did it land".
    """
    state = result.get("state")
    if state == "projected":
        return {**result, "success": True}
    if state == "suppressed":
        return {**result, "success": True, "delivered": False}
    if result.get("error"):
        return result
    if state == "blocked":
        return {**result, "error": "delivery was blocked before projection"}
    if state == "journaled_partial":
        # Journaled, but an attachment was lost on the way. A partial occurrence is
        # still a failure of the delivery the caller asked for.
        return {
            **result,
            "error": "delivery is partially journaled and projection is not yet confirmed",
        }
    if state == "journaled" and result.get("accepted_pending"):
        return {**result, "success": True, "pending": True}
    return {
        **result,
        "error": "delivery is durable but projection is not yet confirmed",
    }


def _resident_adapter() -> Optional[AttachAdapter]:
    with _ACTIVE_ADAPTERS_LOCK:
        return next(
            (
                adapter
                for adapter in _ACTIVE_ADAPTERS
                if isinstance(adapter, AttachAdapter) and not adapter._closing
            ),
            None,
        )


def _occurrence_key(args: Optional[Dict[str, Any]] = None) -> str:
    """The caller-owned occurrence id a delivery key is derived from.

    Stable across retries of one occurrence and distinct between occurrences: the active
    tool call first, then the caller's own idempotency fields, then the harness session
    identifiers. An empty result is honest; callers still mix in their own material.
    """
    key = str(_CURRENT_TOOL_OCCURRENCE.get() or "").strip()
    if not key and isinstance(args, dict):
        key = str(args.get("tool_call_id") or args.get("idempotency_key") or "").strip()
    if not key:
        try:
            from gateway.session_context import get_session_env  # harness-defined identifier

            key = str(
                get_session_env("HERMES_SESSION_MESSAGE_ID")
                or get_session_env("HERMES_SESSION_ID")
                or get_session_env("HERMES_SESSION_KEY")
                or ""
            ).strip()
        except Exception:
            pass
    return key



# The upstream frame that owns every Hermes platform send. A plugin
# ``send_message_handler`` is invoked from there on BOTH lanes (see
# ``_upstream_send_payload``), but only the tool lane fills ``args``.
#
# Both halves matter. The module alone is not enough: ``tools.send_message_tool``
# also owns ``_handle_send``, ``_send_via_adapter`` and ``_registry_standalone_send``,
# and each of those holds a DIFFERENT ``message``/``media_files`` binding (or none at
# all). ``_send_to_platform`` is the one function that provably holds the complete
# outbound request -- it is the ``def`` that takes ``message`` and ``media_files`` as
# parameters and calls the handler itself.
_UPSTREAM_SEND_MODULE = "tools.send_message_tool"
_UPSTREAM_SEND_FUNCTION = "_send_to_platform"

# How far above the handler the upstream sender can sit. The handler is reached
# through ``_send_message_handler`` -> ``_scheduler_lane_send`` -> here, so the
# sender is normally three frames up; the margin absorbs any future in-plugin or
# upstream wrapper without letting the search wander into unrelated callers.
_UPSTREAM_SEND_MAX_DEPTH = 8


def _normalized_media_paths(media_files: Any) -> List[str]:
    """Accept both media shapes Hermes hands a platform plugin.

    The in-plugin callers pass plain paths. The upstream ``standalone_sender_fn``
    contract (and cron's ``_deliver_result``, which forwards
    ``BasePlatformAdapter.extract_media`` output verbatim) passes ``(path, is_voice)``
    pairs instead. Only the string form used to survive, so every attachment on a
    scheduled report was dropped before the upload loop ever saw it.
    """
    paths: List[str] = []
    for entry in media_files or []:
        if isinstance(entry, (tuple, list)):
            entry = entry[0] if entry else None
        if isinstance(entry, str) and entry:
            paths.append(entry)
    return paths


def _upstream_send_payload() -> Optional[Dict[str, Any]]:
    """Recover the outbound payload Hermes does not hand a plugin send handler.

    ``tools/send_message_tool.py::_send_to_platform`` (the ``def`` at :925) routes EVERY
    non-builtin platform through ``entry.send_message_handler`` and returns whatever it
    returns, with no fallback to ``standalone_sender_fn``. It fills ``args`` only on the
    ``send_message`` TOOL lane; cron's ``_deliver_result`` calls the same function with
    ``args=None`` and the report in the positional ``message`` parameter. A registered
    handler therefore shadows this plugin's standalone cron sender and is handed an EMPTY
    request: the report is journaled nowhere, and "no text and no media" reads as silence,
    which the scheduler records as a delivered run with no error (hermes 0.20.5).

    Read the payload the caller already holds instead of inventing an empty one. The
    recovery is deliberately narrow: only the ``_send_to_platform`` frame is trusted, and
    any other caller yields ``None`` so the handler fails loudly rather than delivering
    nothing quietly.

    Two details of that frame decide what a scheduled report actually carries:

    * ``message`` is the WHOLE outbound text; ``chunk`` is only the current slice of the
      platform-limit loop. Upstream ``return``s inside that loop on the handler lane
      (send_message_tool.py:1289-1297), so recovering ``chunk`` delivers slice one and
      silently drops the rest. Recovering ``message`` delivers the report intact and
      keeps the derived delivery key identical on every invocation, so media rides
      exactly one durable occurrence even if a future upstream drops that early return.
    * ``media_files`` is read from the SAME frame as the text, so the attachments always
      belong to the message they were extracted from.
    """
    frame = inspect.currentframe()
    try:
        for _ in range(_UPSTREAM_SEND_MAX_DEPTH):
            frame = frame.f_back if frame is not None else None
            if frame is None:
                return None
            if frame.f_globals.get("__name__") != _UPSTREAM_SEND_MODULE:
                continue
            if frame.f_code.co_name != _UPSTREAM_SEND_FUNCTION:
                continue
            local_vars = frame.f_locals
            for key in ("message", "chunk"):
                text = local_vars.get(key)
                if isinstance(text, str) and text.strip():
                    return {
                        "message": text,
                        "media_files": local_vars.get("media_files"),
                        "thread_id": local_vars.get("thread_id"),
                    }
            return None
        return None
    finally:
        del frame


async def _scheduler_lane_send(chat_id: str, pconfig: Any) -> Dict[str, Any]:
    """Serve a send that carries no tool request: cron, routines, any upstream caller.

    This is the lane ``standalone_sender_fn`` would own if the registered handler did not
    shadow it, so it delivers through exactly that sender.
    """
    payload = _upstream_send_payload()
    if payload is None:
        logger.warning(
            "attach: send_message handler invoked with no message payload and no "
            "recoverable upstream text; refusing to report a delivery",
        )
        return {
            "error": (
                "cozygateway received a send with no message payload: the caller passed "
                "no send_message args and no recoverable text, so nothing was delivered"
            ),
        }
    return _hermes_delivery_result(
        await _standalone_send(
            pconfig,
            chat_id,
            payload["message"],
            thread_id=payload.get("thread_id"),
            media_files=payload.get("media_files"),
        )
    )


async def _send_message_handler(
    args: Dict[str, Any], chat_id: str, platform_name: str, pconfig: Any
) -> Dict[str, Any]:
    """Own Hermes ``send_message`` so Cozy media is never dropped as unsupported.

    Upstream routes every plugin-platform send through this one hook, tool call or not.
    A request with no ``message`` key is not a tool call: it is the cron/scheduler lane
    this handler shadows, and it is served by the standalone sender instead.
    """
    request = args or {}
    if "message" not in request:
        return await _scheduler_lane_send(chat_id, pconfig)

    from gateway.platforms.base import BasePlatformAdapter  # harness-defined identifier

    raw_message = str(request.get("message") or "")
    extracted, cleaned = BasePlatformAdapter.extract_media(raw_message)
    filtered = BasePlatformAdapter.filter_media_delivery_paths(extracted)
    media_files = [str(path) for path, _is_voice in filtered]
    # The tool's raw message still holds the marker lines, so this lane can place its
    # attachments in the block flow exactly the way the terminal reply lane does.
    media_positions = _media_positions_for_draft(raw_message, cleaned, media_files)
    target = str(request.get("target") or "").strip().lower()
    canonical_home = target == platform_name
    key_material = "\0".join([platform_name, chat_id, cleaned, *media_files])
    occurrence_key = _occurrence_key(request)
    delivery_key = "tool:" + hashlib.sha256(
        f"{occurrence_key}\0{key_material}".encode("utf-8")
    ).hexdigest()
    resident = _resident_adapter()
    if resident is not None and resident._ready.is_set():
        return _hermes_delivery_result(
            await resident.send_proactive(
                chat_id,
                cleaned,
                media_files,
                canonical_home=canonical_home,
                delivery_key=delivery_key,
                media_positions=media_positions,
            )
        )
    return _hermes_delivery_result(
        await enqueue_proactive_delivery(
            pconfig,
            thread_id=chat_id,
            delivery_key=delivery_key,
            message=cleaned,
            media_files=media_files,
            media_positions=media_positions,
            canonical_home=canonical_home,
        )
    )


def _proactive_spool_path(pconfig: Any, spool_path: Optional[str]) -> str:
    if spool_path:
        return spool_path
    extra = getattr(pconfig, "extra", {}) or {}
    return str(
        extra.get("spool_path")
        or os.getenv("COZYGATEWAY_SPOOL_PATH")
        or os.path.join(os.path.expanduser("~"), ".hermes", "cozygateway-attach-v1.sqlite")
    )


def _proactive_media_id(delivery_id: str, index: int, sha256: Optional[str] = None) -> str:
    """Mint a scheduled attachment id in the ONE shape the device can fetch back.

    The bytes of a scheduled attachment are stored and retained exactly like a live-turn
    attachment's, but the device-facing fetch route validates the id before it looks
    anything up (``isPhotoFileId`` / ``FILE_ID_RE`` = 32 lowercase hex,
    packages/gateway/src/hermes-bridge/photos.ts:308-312, used at
    packages/gateway/src/hermes-bridge/routes.ts:1250). A ``scheduled_media_``-prefixed
    id passes the permissive upload validator but fails that one, so the photo rendered
    from the delivery and then read as "no longer available" on every later visit --
    a fetch rejection, never an expiry or a rollback.

    A live-turn attachment once used ``uuid.uuid4().hex`` (32 hex). This id is the
    deterministic counterpart of that shape, and every path now mints ids here: the same
    digest as before, minus the prefix, so it stays stable across retries of one
    occurrence (retries must reuse the id, not upload a second copy) while being servable
    for as long as the message lives.

    ``sha256`` makes the id content addressed. Retrying an occurrence reuses the id, but
    a file rewritten in place between attempts is different bytes and so gets a different
    id: one id must never point at two different payloads.
    """
    material = f"{delivery_id}\0{index}" if sha256 is None else f"{delivery_id}\0{index}\0{sha256}"
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


def _durable_receipt(spool: Optional[AttachSpool], delivery_id: str) -> Optional[str]:
    """The projection state a receipt has ALREADY established, without waiting for one.

    Replaces the two-second projection stall (spec finding 4): a receipt that arrived
    while the upload was in flight still counts, and one that has not arrived leaves the
    delivery pending rather than failed.
    """
    if spool is None:
        return None
    try:
        row = spool.delivery_receipt_row(delivery_id)
    except Exception:  # noqa: BLE001 - an unreadable receipt is simply not one
        logger.debug("attach: durable receipt read failed", exc_info=True)
        return None
    if not row:
        return None
    state = str(row.get("state") or "")
    if state == "displayed":
        return "projected"
    if state == "failed" and row.get("stage") == "authorization":
        return "blocked"
    return state or None


def _decorate_send_result(result: Any, field: str, payload: Dict[str, Any]) -> None:
    """Carry structured detail on the harness' SendResult when it allows it.

    ``media_result`` is the media outcome; ``delivery_lifecycle`` is the accepted-pending
    state a durable send has no upstream field for (``SendResult`` models success and
    error only). Hermes owns that class, so a slotted or frozen build simply does not
    carry either one: the committed reply text, the durable spool rows and
    ``delivery_state()`` remain the authority.
    """
    try:
        setattr(result, field, payload)
    except Exception:  # noqa: BLE001 - decoration is never worth failing a send for
        logger.debug("attach: could not decorate SendResult with %s", field, exc_info=True)


def _proactive_identity(delivery_key: str) -> Tuple[str, str]:
    delivery_id = "scheduled:" + delivery_key
    message_id = "scheduled-" + hashlib.sha256(
        delivery_id.encode("utf-8")
    ).hexdigest()[:32]
    return delivery_id, message_id


def _apply_projection(
    result: Dict[str, Any], receipt: Optional[Dict[str, Any]]
) -> Dict[str, Any]:
    if receipt is None:
        return result
    if receipt.get("state") in {"projected", "blocked"}:
        result["state"] = receipt["state"]
        result["accepted_pending"] = False
        if receipt["state"] == "projected":
            result["projectedAt"] = receipt.get("projectedAt")
        else:
            result["attempts"] = receipt.get("attempts")
    return _merge_receipt_extensions(result, receipt)


def _merge_receipt_extensions(
    result: Dict[str, Any], receipt: Dict[str, Any]
) -> Dict[str, Any]:
    """Surface the additive receipt fields when the gateway sends them.

    "projected" remains the cron-ABI success. These fields only ever add detail, so a gateway that
    predates durable receipts (and omits them) leaves the result exactly as it was.
    """
    displayed_at = receipt.get("displayedAt")
    if isinstance(displayed_at, int) and not isinstance(displayed_at, bool):
        result["displayedAt"] = displayed_at
    terminal = receipt.get("terminal")
    if isinstance(terminal, dict) and isinstance(terminal.get("state"), str):
        result["terminal"] = dict(terminal)
    return result


def delivery_state(pconfig: Any, delivery_key: str) -> Dict[str, Any]:
    """Read the locally persisted terminal state of one delivery occurrence.

    ``delivery_key`` is the same key the send used (the Hermes session id, or the caller-supplied
    key), so ops and Cleo can ask "did that 3:03 AM report ever land?" without a live socket. A key
    already carrying the ``turn:`` prefix names a REPLY made in a live conversation, whose media is
    journaled under that same id; it is answerable the moment the phone reports the row on screen,
    which is the question an agent actually gets asked ("did you see the picture?").

    Returns ``{"state": "unknown", ...}`` when no receipt has arrived yet. ``media`` is present only
    when the occurrence carried attachments, so the scheduled reading is unchanged for text.
    """
    if delivery_key.startswith(TURN_DELIVERY_PREFIX):
        delivery_id = delivery_key
        message_id = delivery_key[len(TURN_DELIVERY_PREFIX):]
    else:
        delivery_id, message_id = _proactive_identity(delivery_key)
    spool = AttachSpool(_proactive_spool_path(pconfig, None))
    try:
        row = spool.delivery_receipt_row(delivery_id)
        media = spool.media_rows(delivery_id)
    finally:
        spool.close()
    result: Dict[str, Any] = dict(row) if row is not None else {"state": "unknown"}
    result["deliveryId"] = delivery_id
    result["messageId"] = message_id
    if media:
        result["media"] = media
    return result


def _proactive_media_error(
    path: str, exc: Exception, descriptor: Optional[MediaDescriptor] = None
) -> str:
    """One bounded, human-readable upload failure line. Never carries payload bytes.

    An HTTP rejection (notably ``415`` for a type the gateway does not accept) also
    names the file's detected MIME and family, because "io_error" on its own left
    production guessing which attachment the gateway refused and why.
    """
    name = os.path.basename(path)[:128] or "attachment"
    if isinstance(exc, HTTPError):
        mime = descriptor.mime if descriptor is not None else (
            mimetypes.guess_type(path)[0] or "application/octet-stream"
        )
        family = descriptor.family if descriptor is not None else AttachAdapter._media_family(path)
        phrase = str(getattr(exc, "reason", "") or "")[:64].strip()
        detail = f"http_{exc.code}"
        if phrase:
            detail = f"{detail} {phrase}"
        return f"{name} ({mime}, family={family}): {detail}"
    if isinstance(exc, FileNotFoundError):
        reason = "not_found"
    elif isinstance(exc, PermissionError):
        reason = "access_denied"
    elif isinstance(exc, ValueError) and "size cap" in str(exc):
        reason = "size_limit"
    elif isinstance(exc, OSError):
        reason = "io_error"
    else:
        reason = "upload_failed"
    return f"{name}: {reason}"


def _proactive_failure(error: str, delivery_id: Optional[str] = None, message_id: Optional[str] = None, media_errors: Optional[List[str]] = None) -> Dict[str, Any]:
    result: Dict[str, Any] = {"state": "failed", "accepted_pending": False, "error": error}
    if delivery_id is not None:
        result["deliveryId"] = delivery_id
    if message_id is not None:
        result["messageId"] = message_id
    if media_errors:
        result["media_errors"] = media_errors
    return result


async def _proactive_projection(client: AttachV1Client, delivery_id: str, timeout_seconds: float) -> Optional[Dict[str, Any]]:
    deadline = time.monotonic() + max(0.0, min(timeout_seconds, 2.0))
    while True:
        remaining = deadline - time.monotonic()
        if remaining < 0:
            return None
        try:
            receipt = await client.delivery_receipt(delivery_id, max(0.05, remaining))
        except Exception:  # noqa: BLE001 - journaled state remains the honest fallback
            return None
        if receipt is not None and receipt.get("state") in {"projected", "blocked"}:
            return receipt
        if remaining <= 0:
            return None
        await asyncio.sleep(min(0.05, remaining))


def _release_one_shot_transport(spool: AttachSpool) -> None:
    spool.release_transport_lease()
    spool.close()


def _retain_one_shot_cleanup(task: asyncio.Task) -> asyncio.Task:
    _ONE_SHOT_CLEANUP_TASKS.add(task)
    task.add_done_callback(_ONE_SHOT_CLEANUP_TASKS.discard)
    return task


def _defer_one_shot_transport_release(
    client: AttachV1Client, watch_task: asyncio.Task, spool: AttachSpool
) -> None:
    """Retain a stuck one-shot lease until socket and watcher have stopped."""

    async def release_when_settled() -> None:
        try:
            await asyncio.shield(watch_task)
        except BaseException:  # A failed/cancelled watcher is still settled.
            pass
        await client.wait_closed()
        _release_one_shot_transport(spool)

    _retain_one_shot_cleanup(asyncio.create_task(release_when_settled()))


async def _wait_one_shot_watcher(watch_task: asyncio.Task) -> bool:
    try:
        await asyncio.wait_for(asyncio.shield(watch_task), _ONE_SHOT_CLEANUP_SECONDS)
        return True
    except asyncio.TimeoutError:
        watch_task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(watch_task), _ONE_SHOT_CLEANUP_SECONDS)
            return True
        except asyncio.TimeoutError:
            return False
        except (asyncio.CancelledError, Exception):
            return True
    except (asyncio.CancelledError, Exception):
        return True


async def _wait_one_shot_socket(client: AttachV1Client) -> bool:
    try:
        await asyncio.wait_for(client.wait_closed(), _ONE_SHOT_CLEANUP_SECONDS)
        return True
    except asyncio.TimeoutError:
        return False


async def _settle_one_shot_transport(
    client: AttachV1Client, watch_task: asyncio.Task, spool: AttachSpool
) -> None:
    """Close a one-shot client before releasing its exclusive spool lease.

    The normal path waits briefly for a graceful watcher exit.  A pathological
    watcher cannot make a cancelled cron task hang: it is cancelled after the
    first bound and its lease is held by a small deferred finalizer until it
    finally exits.
    """
    try:
        await asyncio.wait_for(client.close(), _ONE_SHOT_CLEANUP_SECONDS)
    except asyncio.CancelledError:
        _defer_one_shot_transport_release(client, watch_task, spool)
        raise
    except Exception:
        logger.debug("attach: one-shot client close did not complete cleanly", exc_info=True)

    if not await _wait_one_shot_watcher(watch_task):
        _defer_one_shot_transport_release(client, watch_task, spool)
        return
    if not await _wait_one_shot_socket(client):
        _defer_one_shot_transport_release(client, watch_task, spool)
        return
    _release_one_shot_transport(spool)


async def enqueue_proactive_delivery(
    pconfig: Any,
    *,
    thread_id: str,
    delivery_key: str,
    message: str,
    media_files: Optional[List[str]] = None,
    media_positions: Optional[List[int]] = None,
    media_policy: str = "atomic",
    spool_path: Optional[str] = None,
    canonical_home: bool = False,
) -> Dict[str, Any]:
    """Journal one unanchored delivery for any proactive agent trigger.

    ``delivery_key`` is owned by the trigger producer and must stay stable across retries. Hermes
    cron is the implemented producer; deeper agent hooks may use this public seam with their own
    durable occurrence ids when they are added.
    """
    text = str(message)
    target_thread = thread_id.strip() if isinstance(thread_id, str) else ""
    key = delivery_key.strip() if isinstance(delivery_key, str) else ""
    if not target_thread and not canonical_home:
        return _proactive_failure("target_required")
    if not key:
        return _proactive_failure("delivery_key_required")
    paths = _normalized_media_paths(media_files)
    if media_policy not in {"atomic", "allow_partial_media"}:
        return _proactive_failure("invalid_media_policy")
    delivery_id, message_id = _proactive_identity(key)
    if len(paths) > 16:
        return _proactive_failure("media_count_exceeded", delivery_id, message_id)
    # Silence is success, not an empty transcript row or a newly-created spool.
    if not text.strip() and not paths:
        return {"state": "suppressed", "accepted_pending": False}
    extra = getattr(pconfig, "extra", {}) or {}
    try:
        receipt_timeout = min(2.0, max(0.0, float(extra.get("receipt_timeout_seconds", 0.25))))
    except (TypeError, ValueError):
        receipt_timeout = 0.25
    spool = AttachSpool(_proactive_spool_path(pconfig, spool_path))
    watch_task: Optional[asyncio.Task] = None
    try:
        media_ids: List[str] = []
        media_errors: List[str] = []
        configured_token = os.getenv("COZYGATEWAY_TOKEN") or extra.get("token", "")
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=(os.getenv("COZYGATEWAY_URL") or extra.get("gateway_url") or "").rstrip("/"),
            token=configured_token,
            token_provider=lambda: _fresh_attach_token(configured_token),
            spool=spool,
            ca_file=os.getenv("COZYGATEWAY_CA_FILE") or extra.get("ca_file") or None,
        ))
        service = MediaUploadService(
            client,
            delivery_id=delivery_id,
            destination=MediaDestination(
                "canonical_home" if canonical_home else "thread", target_thread
            ),
            spool=spool,
        )
        positions: Optional[List[int]] = None
        if paths:
            sendable = paths[:16]
            aligned = (
                list(media_positions[: len(sendable)])
                if media_positions is not None and len(media_positions) == len(paths)
                else None
            )
            batch = await service.upload(sendable, aligned)
            media_ids = batch.media_ids
            positions = batch.media_positions
            media_errors = batch.error_lines
            if media_errors and media_policy == "atomic":
                # A later upload failure abandons the entire occurrence. Roll
                # back every earlier successful upload before reporting the
                # original failure; the client persists failed remote deletes
                # for safe reconnect retry.
                try:
                    await client.rollback_uploaded_media(media_ids)
                except Exception:  # noqa: BLE001 - preserve the media failure as the public result
                    logger.warning("attach: atomic scheduled-media rollback failed", exc_info=True)
                service.mark_blocked(media_ids, "atomic occurrence abandoned before journal")
                return _proactive_failure("media_upload_failed", delivery_id, message_id, media_errors)
        blocks = normalize_text_to_blocks(text)
        if not blocks and not media_ids:
            return _proactive_failure("media_upload_failed", delivery_id, message_id, media_errors)
        frame = await client.send_scheduled(
            target_thread,
            delivery_id,
            message_id,
            blocks,
            media_ids,
            canonical_home=canonical_home,
            media_positions=positions,
        )
        if frame is None:
            return _proactive_failure("scheduled_not_supported", delivery_id, message_id, media_errors)
        service.mark_journaled(media_ids)
        result: Dict[str, Any] = {
            "state": "journaled_partial" if media_errors else "journaled",
            "accepted_pending": True,
            "deliveryId": delivery_id,
            "messageId": message_id,
            "eventId": frame["eventId"],
        }
        if media_errors:
            result["media_errors"] = media_errors
        if spool.acquire_transport_lease():
            try:
                await client.connect()
                watch_task = asyncio.create_task(client.watch())
            except Exception:  # noqa: BLE001 - the durable local journal remains replayable
                spool.release_transport_lease()
        receipt = await _proactive_projection(client, delivery_id, receipt_timeout) if watch_task is not None else None
        return _apply_projection(result, receipt)
    finally:
        if watch_task is None:
            spool.close()
        else:
            # Shield only teardown: the caller still receives its original
            # CancelledError, but cannot release the shared transport lease
            # while this socket/watch pair remains live.
            cleanup = _retain_one_shot_cleanup(
                asyncio.create_task(_settle_one_shot_transport(client, watch_task, spool))
            )
            await asyncio.shield(cleanup)


def register(ctx: Any) -> None:
    """Plugin entry point: register the platform and the tool-chip hooks.

    The adapter is built lazily so importing this module (e.g. to call ``register``)
    never requires the harness to be fully initialized.
    """
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="CozyGateway",
        adapter_factory=lambda cfg: _make_adapter_class()(cfg),
        check_fn=check_requirements,
        is_connected=is_connected,
        required_env=["COZYGATEWAY_URL", "COZYGATEWAY_TOKEN"],
        install_hint="Needs the 'websockets' package (pip install websockets)",
        emoji="🧵",
        pii_safe=True,
        cron_deliver_env_var="COZYGATEWAY_HOME_CHANNEL",
        standalone_sender_fn=_hermes_standalone_send,
        send_message_handler=_send_message_handler,
        platform_hint=(
            "You are in a live session. Your reply streams live and is committed to "
            "the conversation. Markdown renders richly: use ## headings, - bullet / "
            "1. numbered / - [ ] task lists, | pipe | tables |, fenced code blocks, "
            "and $$ math. Inline bold and links show as literal text, so prefer the "
            "block forms above."
        ),
    )
    ctx.register_tool(
        name="cozy_device_status",
        toolset="cozygateway",
        schema={
            "name": "cozy_device_status",
            "description": "Request one consented status reading from the phone that started this live chat turn.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        handler=_cozy_device_status,
        is_async=True,
        description="Request one consented device-status reading in the active CozyGateway turn.",
        emoji="📱",
    )
    ctx.register_tool(
        name="cozy_request_location",
        toolset="cozygateway",
        schema={
            "name": "cozy_request_location",
            "description": "Request one consented approximate phone location in the active CozyGateway turn.",
            "parameters": {
                "type": "object",
                "properties": {"purpose": {"type": "string", "minLength": 1, "maxLength": 160}},
                "required": ["purpose"], "additionalProperties": False,
            },
        },
        handler=_cozy_request_location,
        is_async=True,
        description="Request one consented approximate location in the active CozyGateway turn.",
        emoji="📍",
    )
    # Register the tool-lifecycle hooks that feed the live tool-chip tap. If the
    # harness build does not support hook registration, degrade gracefully: the
    # platform still streams text, only the chips are absent.
    try:
        ctx.register_hook("pre_tool_call", _pre_tool_call)
        ctx.register_hook("post_tool_call", _post_tool_call)
        ctx.register_hook("pre_approval_request", _pre_approval_request)
        ctx.register_hook("post_approval_response", _post_approval_response)
    except Exception:  # noqa: BLE001 - no chips, never crash
        logger.debug("attach: tool-lifecycle hooks unavailable; chips disabled", exc_info=True)

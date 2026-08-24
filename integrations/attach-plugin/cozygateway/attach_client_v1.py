"""Harness-free attach-v1 client with a durable SQLite spool."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import mimetypes
import os
import re
import ssl
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Literal, Optional, TypedDict, Union
from urllib.error import HTTPError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from websockets.exceptions import ConnectionClosed

from .attach_client import (
    AttachAuthError,
    AttachSupersededError,
    InterruptFrame,
    POLICY_CLOSE_CODE,
    RichBlock,
    SteerFrame,
    SUPERSEDED_CLOSE_CODE,
    ToolChip,
    TurnFrame,
    _close_code,
    _close_reason,
    _default_connect,
    _http_status,
    derive_attach_ws_url,
    parse_interrupt_frame,
    parse_steer_frame,
    parse_turn_frame,
)
from .attach_spool import AttachSpool, TerminalSealed


logger = logging.getLogger(__name__)


MobileStatus = Literal[
    "ok", "denied", "expired", "cancelled", "device_unavailable",
    "foreground_required", "policy_blocked",
]
MOBILE_STATUS_VALUES = frozenset(MobileStatus.__args__)
MOBILE_STATUS_TIMEOUT_SECONDS = 30
# How long to wait for hello_ack before concluding the handshake stalled and re-dialing with the
# same hello. The gateway gives a peer 5 seconds to say hello; this is the matching budget in the
# other direction.
HELLO_ACK_TIMEOUT_SECONDS = 5
# The single hello shape. One version, one capability set, no negotiated subset: a gateway that
# cannot accept this refuses the socket, which is the only honest outcome for a capability loss.
HELLO_VERSION = 2
HELLO_CAPABILITIES = (
    "draft", "media", "tools", "approvals", "clarify", "scheduled",
    "mobile_node", "mobile_location", "memory_management", "delivery_receipts",
)
# Terminal states a delivery_receipt command may carry, and the stages a failure may name.
RECEIPT_STATES = frozenset({"displayed", "failed"})

# What one delivery receipt means for each of that delivery's attachments. "projected"
# only ever arrives on the HTTP receipt read; the socket command carries the terminals.
_MEDIA_STATE_FOR_RECEIPT = {
    "projected": "projected",
    "displayed": "displayed",
    "blocked": "blocked",
    "failed": "blocked",
}
RECEIPT_STAGES = frozenset({"authorization", "projection"})
RECEIPT_REASON_MAX_CHARS = 256
# Matches the gateway's shared Id schema, so a legal deliveryId is never dropped locally.
RECEIPT_ID_MAX_CHARS = 256
ATTACH_IMAGE_MAX_BYTES = 8 * 1024 * 1024
ATTACH_AUDIO_VIDEO_MAX_BYTES = 40 * 1024 * 1024
ATTACH_FILE_MAX_BYTES = 20 * 1024 * 1024


class MobileDeviceStatusResult(TypedDict, total=False):
    status: MobileStatus
    result: Union["DeviceStatus", "Location"]


class DeviceStatus(TypedDict):
    foreground: Literal[True]


class Location(TypedDict):
    latitude: float
    longitude: float


@dataclass
class AttachV1ClientConfig:
    gateway_url: str
    token: str
    spool: AttachSpool
    token_provider: Optional[Callable[[], str]] = None
    path: str = "/attach/v1"
    ca_file: Optional[str] = None
    on_turn: Optional[Callable[[TurnFrame], None]] = None
    on_steer: Optional[Callable[[SteerFrame], None]] = None
    on_interrupt: Optional[Callable[[InterruptFrame], None]] = None
    on_approval: Optional[Callable[[Dict[str, Any]], None]] = None
    on_clarify: Optional[Callable[[Dict[str, Any]], None]] = None
    on_memory: Optional[Callable[[Dict[str, Any]], None]] = None
    on_ready: Optional[Callable[[], None]] = None
    connect_factory: Optional[Callable[..., Any]] = None
    max_in_flight_events: int = 64
    max_in_flight_bytes: int = 4 * 1024 * 1024
    commands: List[Dict[str, str]] = field(default_factory=list)


class AttachV1Client:
    def __init__(self, config: AttachV1ClientConfig) -> None:
        self._config = config
        self._spool = config.spool
        self._ws_url = derive_attach_ws_url(config.gateway_url, config.path)
        self._ws: Any = None
        # ``close()`` may be wrapped in a timeout by a one-shot producer.  Keep
        # the raw socket close task strongly reachable after the public caller
        # is cancelled so a shared spool cannot be handed to a second socket
        # while the first file descriptor is still live.
        self._socket_close_task: Optional[asyncio.Task] = None
        self._closed = False
        self._negotiated = False
        self._capabilities: set[str] = set()
        self._send_lock = asyncio.Lock()
        self._flow_lock = asyncio.Lock()
        self._max_events = config.max_in_flight_events
        self._max_bytes = config.max_in_flight_bytes
        self._sent_events: Dict[int, int] = {}
        self._sent_event_bytes = 0
        self._latest_blocks: Dict[str, List[Dict[str, Any]]] = {}
        self._latest_tools: Dict[str, Dict[str, tuple[str, str, Optional[str]]]] = {}
        # One re-dial per connect, so a stalled handshake gets a second chance without spinning.
        self._hello_retried = False
        # Mobile requests are intentionally outside the durable spool: a phone action
        # must not replay after a reconnect or plugin restart.
        self._mobile_requests: Dict[str, tuple[str, asyncio.Future[MobileDeviceStatusResult]]] = {}

    def _ssl_context(self) -> Any:
        if self._config.ca_file and self._ws_url.startswith("wss://"):
            context = ssl.create_default_context()
            context.load_verify_locations(self._config.ca_file)
            return context
        return None

    def _current_token(self) -> str:
        token = self._config.token
        if self._config.token_provider is not None:
            try:
                token = self._config.token_provider().strip() or token
            except Exception:
                logger.warning("attach-v1: credential refresh failed; using last known token")
        return token

    async def connect(self) -> None:
        # A caller that timed out `close()` left its raw socket close task alive.
        # Do not overwrite that ownership with a new connection.
        await self.wait_closed()
        self._closed = False
        self._negotiated = False
        self._capabilities.clear()
        self._sent_events.clear()
        self._sent_event_bytes = 0
        self._hello_retried = False
        try:
            await self._open()
        except Exception as exc:
            if _http_status(exc) == 401:
                raise AttachAuthError("attach-v1 rejected (HTTP 401)") from exc
            raise

        # A prior atomic occurrence may have crashed after descriptor rollback but before its
        # authenticated HTTP delete. Cleanup is durable and retried on each healthy reconnect.
        await self._drain_media_cleanup()

        # A command ACKed before a crash remains in the inbox until execution was recorded.
        for frame in self._spool.pending_commands():
            await self._dispatch_command(frame, replay=True)

    async def _open(self) -> None:
        """Dial and send the one hello. There is no reduced shape and no downgrade path: if the
        gateway cannot accept this hello it closes the socket and the failure is visible."""
        headers = {"Authorization": f"Bearer {self._current_token()}"}
        factory = self._config.connect_factory or _default_connect
        self._ws = await factory(self._ws_url, headers, self._ssl_context())
        hello: Dict[str, Any] = {
            "kind": "hello",
            "version": HELLO_VERSION,
            "instanceId": self._spool.instance_id,
            "capabilities": list(HELLO_CAPABILITIES),
            "resume": {"eventSequence": self._spool.event_cursor, "commandSequence": self._spool.command_cursor},
            "limits": {"maxInFlightEvents": self._max_events, "maxInFlightBytes": self._max_bytes},
            # Present even when empty so a newly authenticated profile can clear a catalog cached
            # from its previous plugin process.
            "commands": self._config.commands[:512],
            "telemetry": self._spool.health_snapshot(),
        }
        await self._send(hello)

    async def request_device_status(self, thread_id: str, turn_id: str) -> MobileDeviceStatusResult:
        """Request one ephemeral status result for this live turn, never via the spool."""
        return await self._request_mobile("device.status", thread_id, turn_id)

    async def request_location(self, thread_id: str, turn_id: str, purpose: str) -> MobileDeviceStatusResult:
        """Request one approximate foreground location, never via the spool."""
        purpose = normalize_location_purpose(purpose)
        if not purpose:
            return {"status": "policy_blocked"}
        return await self._request_mobile("location.current", thread_id, turn_id, purpose)

    async def _request_mobile(self, command: str, thread_id: str, turn_id: str, purpose: Optional[str] = None) -> MobileDeviceStatusResult:
        required_capability = "mobile_location" if command == "location.current" else "mobile_node"
        if not self._negotiated or required_capability not in self._capabilities:
            return {"status": "device_unavailable"}
        request_id = str(uuid.uuid4())
        future: asyncio.Future[MobileDeviceStatusResult] = asyncio.get_running_loop().create_future()
        self._mobile_requests[request_id] = (command, future)
        try:
            frame: Dict[str, Any] = {
                "kind": "mobile_request", "requestId": request_id,
                "command": command, "threadId": thread_id, "turnId": turn_id,
                "expiresAt": int(time.time() * 1000) + MOBILE_STATUS_TIMEOUT_SECONDS * 1000,
            }
            if purpose is not None:
                frame["purpose"] = purpose
            await self._send(frame)
            return await asyncio.wait_for(asyncio.shield(future), MOBILE_STATUS_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            await self._cancel_mobile_request(request_id)
            return {"status": "expired"}
        except asyncio.CancelledError:
            await self._cancel_mobile_request(request_id)
            return {"status": "cancelled"}
        except Exception:
            return {"status": "device_unavailable"}
        finally:
            self._mobile_requests.pop(request_id, None)

    async def _send(self, frame: Dict[str, Any]) -> None:
        if self._ws is None or self._closed:
            raise RuntimeError("attach-v1 client is not connected")
        async with self._send_lock:
            await self._ws.send(json.dumps(frame, separators=(",", ":")))

    async def replay(self) -> None:
        async with self._flow_lock:
            self._sent_events.clear()
            self._sent_event_bytes = 0
        await self._drain_events()

    async def _drain_events(self) -> None:
        """Refill only free negotiated slots. Durable rows stay queued until their matching ACK."""
        async with self._flow_lock:
            if self._ws is None or self._closed or not self._negotiated:
                return
            capacity = self._max_events - len(self._sent_events)
            if capacity <= 0:
                return
            frames = self._spool.pending_events(self._max_events + len(self._sent_events), self._max_bytes)
            for frame in frames:
                event = frame.get("event")
                required = _event_capabilities(event) if isinstance(event, dict) else []
                if any(capability not in self._capabilities for capability in required):
                    break
                sequence = frame.get("sequence")
                if not isinstance(sequence, int) or sequence in self._sent_events:
                    continue
                encoded = json.dumps(frame, separators=(",", ":"))
                byte_count = len(encoded.encode("utf-8"))
                if len(self._sent_events) >= self._max_events:
                    break
                if self._sent_event_bytes + byte_count > self._max_bytes:
                    break
                await self._send(frame)
                self._sent_events[sequence] = byte_count
                self._sent_event_bytes += byte_count

    @staticmethod
    def _wire_blocks(blocks: List[RichBlock]) -> List[Dict[str, Any]]:
        return [block.to_wire() if hasattr(block, "to_wire") else dict(block) for block in blocks]

    async def _queue_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        required = _event_capabilities(event)
        if self._negotiated and any(capability not in self._capabilities for capability in required):
            return None
        try:
            frame = self._spool.enqueue_event(event)
        except TerminalSealed:
            return None
        await self._drain_events()
        return frame

    async def send_draft(self, thread_id: str, turn_id: str, blocks: List[RichBlock], tool_calls: Optional[List[ToolChip]] = None) -> None:
        wire = self._wire_blocks(blocks)
        self._latest_blocks[turn_id] = wire
        await self._queue_event({"kind": "draft", "threadId": thread_id, "turnId": turn_id, "blocks": wire, "replace": True})
        # Hermes supplies the current tool snapshot with each draft. Attach-v1 carries only the
        # lifecycle changes needed to reach that state.
        tool_states = self._latest_tools.setdefault(turn_id, {})
        for chip in tool_calls or []:
            state = (chip.name, chip.status, chip.detail)
            if tool_states.get(chip.id) == state:
                continue
            event = {"kind": "tool", "threadId": thread_id, "turnId": turn_id, "callId": chip.id, "name": chip.name, "status": chip.status}
            if chip.detail is not None:
                event["detail"] = chip.detail
            if await self._queue_event(event) is not None:
                tool_states[chip.id] = state

    async def send_done(self, thread_id: str, turn_id: str, media_ids: Optional[List[str]] = None) -> None:
        blocks = self._latest_blocks.pop(turn_id, [])
        self._latest_tools.pop(turn_id, None)
        event: Dict[str, Any] = {
            "kind": "commit", "threadId": thread_id, "turnId": turn_id,
            "messageId": str(uuid.uuid4()), "blocks": blocks,
        }
        if media_ids:
            event["mediaIds"] = list(media_ids[:16])
        await self._queue_event(event)

    async def send_failed(self, thread_id: str, turn_id: str, message: str) -> None:
        self._latest_blocks.pop(turn_id, None)
        self._latest_tools.pop(turn_id, None)
        await self._queue_event({
            "kind": "failed", "threadId": thread_id, "turnId": turn_id,
            "messageId": str(uuid.uuid4()), "message": message[:4096],
        })

    async def send_tool(self, thread_id: str, turn_id: str, call_id: str, name: str, status: str, detail: Optional[str] = None) -> None:
        event: Dict[str, Any] = {"kind": "tool", "threadId": thread_id, "turnId": turn_id, "callId": call_id, "name": name[:128], "status": status}
        if detail:
            event["detail"] = detail[:1024]
        await self._queue_event(event)

    async def send_scheduled(
        self,
        thread_id: Optional[str],
        delivery_id: str,
        message_id: str,
        blocks: List[RichBlock],
        media_ids: Optional[List[str]] = None,
        canonical_home: bool = False,
    ) -> Optional[Dict[str, Any]]:
        event: Dict[str, Any] = {
            "kind": "scheduled", "deliveryId": delivery_id,
            "messageId": message_id, "blocks": self._wire_blocks(blocks),
        }
        if canonical_home:
            event["target"] = {"kind": "canonical_home"}
        elif thread_id:
            event["threadId"] = thread_id
        else:
            return None
        if media_ids:
            event["mediaIds"] = list(media_ids[:16])
        return await self._queue_event(event)

    async def send_approval(self, thread_id: str, turn_id: str, approval_id: str, call_id: str, name: str, status: str) -> None:
        await self._queue_event({
            "kind": "approval", "threadId": thread_id, "turnId": turn_id,
            "approvalId": approval_id, "callId": call_id, "name": (name or "tool")[:128],
            "status": status,
        })

    async def send_clarify(
        self,
        thread_id: str,
        turn_id: str,
        clarify_id: str,
        prompt: str,
        options: List[Dict[str, str]],
        expires_at: Optional[int] = None,
    ) -> Optional[Dict[str, Any]]:
        event: Dict[str, Any] = {
            "kind": "clarify", "threadId": thread_id, "turnId": turn_id,
            "clarifyId": clarify_id, "prompt": prompt, "options": options, "status": "pending",
        }
        if expires_at is not None:
            event["expiresAt"] = expires_at
        return await self._queue_event(event)

    async def send_clarify_resolved(
        self,
        thread_id: str,
        turn_id: str,
        clarify_id: str,
        prompt: str,
        options: List[Dict[str, str]],
        selected_option_id: str,
    ) -> Optional[Dict[str, Any]]:
        event = {
            "kind": "clarify", "threadId": thread_id, "turnId": turn_id,
            "clarifyId": clarify_id, "prompt": prompt, "options": options,
            "status": "resolved", "selectedOptionId": selected_option_id,
        }
        if self._negotiated and "clarify" not in self._capabilities:
            return None
        try:
            frame = self._spool.enqueue_event(event)
        except TerminalSealed:
            return None
        try:
            await self._drain_events()
        except Exception:  # noqa: BLE001 - the journaled event replays after reconnect
            pass
        return frame

    async def send_memory_result(
        self, request_id: str, status: str, *, result: Optional[Dict[str, Any]] = None,
        message: Optional[str] = None, current: Optional[Dict[str, Any]] = None,
    ) -> Optional[Dict[str, Any]]:
        """Return one live management reply without writing memory to either spool."""
        event: Dict[str, Any] = {"kind": "memory_result", "requestId": request_id, "status": status}
        if result is not None: event["result"] = result
        if message: event["message"] = message[:512]
        if current is not None: event["current"] = current
        if self._negotiated and "memory_management" not in self._capabilities:
            return None
        try:
            await self._send(event)
        except Exception:
            return None
        return event

    async def upload_media(
        self,
        media_id: str,
        path: str,
        family: str,
        expires_at: Optional[int] = None,
        mime: Optional[str] = None,
        sha256: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upload bytes through the authenticated HTTP side channel; WS carries only metadata.

        ``mime`` is the type the bytes were PROVEN to be (see media_descriptor.probe).
        Callers that have not probed fall back to the extension guess, which is what the
        gateway allowlist and the client renderer then have to disagree about.

        ``sha256`` is the digest the probe already computed. Passing it means the file is
        read once for the whole send instead of twice, and the digest of the bytes that
        actually go on the wire is checked against it, so a file rewritten between the
        probe and the upload fails here rather than becoming a wrong attachment. Nothing
        is buffered: the body streams from disk on a worker thread, which is also what
        keeps a 40 MiB video off the event loop that carries heartbeats and tool events.
        """
        mime = mime or mimetypes.guess_type(path)[0] or "application/octet-stream"
        limit = _media_byte_limit(mime)
        size_bytes = os.stat(path).st_size
        if size_bytes > limit:
            raise ValueError("media exceeds size cap")
        descriptor = await asyncio.to_thread(
            self._upload_media_sync, media_id, path, mime, size_bytes, sha256, expires_at,
        )
        await self._queue_event({"kind": "media", "media": descriptor})
        return descriptor

    async def rollback_uploaded_media(self, media_ids: List[str]) -> None:
        """Durably abandon an atomic occurrence's uploaded media.

        Local descriptor rows disappear before HTTP cleanup is attempted, and failed cleanup stays
        in the spool for the next reconnect. The return value is the still-pending remote cleanup
        ids. Callers surface the original media failure and never call the occurrence sent.
        """
        async with self._flow_lock:
            sequences = self._spool.begin_media_cleanup(media_ids)
            for sequence in sequences:
                byte_count = self._sent_events.pop(sequence, 0)
                self._sent_event_bytes = max(0, self._sent_event_bytes - byte_count)
        await self._drain_media_cleanup()

    async def download_media(self, media_id: str, max_bytes: int = ATTACH_AUDIO_VIDEO_MAX_BYTES) -> tuple[bytes, str, str]:
        """Fetch one gateway-owned attachment through the same bearer side channel.

        The cap is enforced while reading so a malformed server response cannot make the plugin
        buffer an arbitrary file before Hermes has a chance to classify it.
        """
        return await asyncio.to_thread(self._download_media_sync, media_id, max_bytes)

    async def delivery_receipt(self, delivery_id: str, timeout_seconds: float) -> Optional[Dict[str, Any]]:
        receipt = await asyncio.to_thread(self._delivery_receipt_sync, delivery_id, timeout_seconds)
        if receipt is not None:
            self._upgrade_media_rows(delivery_id, str(receipt.get("state") or ""))
        return receipt

    def _upgrade_media_rows(self, delivery_id: str, receipt_state: str) -> None:
        """Carry one delivery receipt down onto its attachments' durable rows.

        A receipt is the only authority that may move media past ``journaled``, and it
        arrives on two channels: the ``delivery_receipt`` command and this HTTP read.
        Both land here so a late or duplicated receipt is applied exactly once: the
        spool's own monotonic guard drops a repeat as "duplicate" and refuses to walk a
        settled row backwards.
        """
        state = _MEDIA_STATE_FOR_RECEIPT.get(receipt_state)
        if state is None:
            return
        spool = getattr(self, "_spool", None)
        if spool is None:
            return
        try:
            for row in spool.media_rows(delivery_id):
                spool.media_mark(delivery_id, str(row["mediaId"]), state)
        except Exception:  # noqa: BLE001 - a receipt must never break the read that carried it
            logger.debug("attach-v1: media lifecycle upgrade failed", exc_info=True)

    def _delivery_receipt_sync(self, delivery_id: str, timeout_seconds: float) -> Optional[Dict[str, Any]]:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        request = Request(f"{origin}/attach/v1/deliveries/{quote(delivery_id, safe='')}", headers={
            "Authorization": f"Bearer {self._current_token()}",
            "User-Agent": "CozyGateway-Attach/1.0",
        })
        context = self._ssl_context() if origin.startswith("https://") else None
        try:
            with urlopen(request, context=context, timeout=max(0.05, min(timeout_seconds, 1.0))) as response:
                return dict(json.loads(response.read()))
        except HTTPError as exc:
            if exc.code == 404:
                return None
            raise

    def _download_media_sync(self, media_id: str, max_bytes: int) -> tuple[bytes, str, str]:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        request = Request(f"{origin}/attach/v1/media/{quote(media_id, safe='')}", headers={
            "Authorization": f"Bearer {self._current_token()}",
            "User-Agent": "CozyGateway-Attach/1.0",
        })
        context = self._ssl_context() if origin.startswith("https://") else None
        with urlopen(request, context=context, timeout=60) as response:
            declared = response.headers.get("Content-Length")
            if declared is not None and int(declared) > max_bytes:
                raise ValueError("gateway attachment exceeds configured cap")
            data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise ValueError("gateway attachment exceeds configured cap")
            mime = response.headers.get_content_type()
            disposition = response.headers.get("Content-Disposition", "")
            marker = "filename*=UTF-8''"
            filename = "attachment"
            if marker in disposition:
                from urllib.parse import unquote
                filename = unquote(disposition.split(marker, 1)[1].split(";", 1)[0].strip()) or filename
            return data, filename, mime

    def _upload_media_sync(
        self,
        media_id: str,
        path: str,
        mime: str,
        size_bytes: int,
        digest: Optional[str],
        expires_at: Optional[int],
    ) -> Dict[str, Any]:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        headers = {
            "Authorization": f"Bearer {self._current_token()}",
            "Content-Type": mime,
            # urllib's default Python-urllib signature is blocked by common
            # Cloudflare Browser Integrity rules (error 1010). Identify this
            # non-browser protocol client explicitly so the authenticated media
            # side channel follows the same public route as the WebSocket.
            "User-Agent": "CozyGateway-Attach/1.0",
            "X-Attach-Filename": os.path.basename(path),
        }
        if expires_at is not None:
            headers["X-Attach-Expires-At"] = str(expires_at)
        with open(path, "rb") as handle:
            if digest is None:
                digest = _file_digest(handle)
            headers["X-Attach-Sha256"] = digest
            headers["Content-Length"] = str(size_bytes)
            body = _HashingReader(handle, size_bytes)
            request = Request(
                f"{origin}/attach/v1/media/{quote(media_id, safe='')}",
                data=body, headers=headers, method="POST",
            )
            context = self._ssl_context() if origin.startswith("https://") else None
            with urlopen(request, context=context, timeout=60) as response:
                descriptor = dict(json.loads(response.read())["media"])
        if body.complete and body.hexdigest() != digest:
            # The bytes on the wire are not the bytes that were probed, so the delivery is
            # abandoned before it is journaled and the caller rolls the upload back.
            raise ValueError("media changed on disk during upload")
        return descriptor

    def _delete_media_sync(self, media_id: str) -> None:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        request = Request(
            f"{origin}/attach/v1/media/{quote(media_id, safe='')}",
            headers={
                "Authorization": f"Bearer {self._current_token()}",
                "User-Agent": "CozyGateway-Attach/1.0",
            },
            method="DELETE",
        )
        context = self._ssl_context() if origin.startswith("https://") else None
        try:
            with urlopen(request, context=context, timeout=15):
                return
        except HTTPError as exc:
            # Missing means an earlier retry won; conflict proves a separately committed event
            # references the object, so it is not orphan media and must stay reachable.
            if exc.code in {404, 409}:
                return
            raise

    async def _drain_media_cleanup(self) -> None:
        for media_id in self._spool.pending_media_cleanups():
            try:
                await asyncio.to_thread(self._delete_media_sync, media_id)
            except Exception:
                continue
            self._spool.mark_media_cleanup_complete(media_id)

    async def watch(self) -> None:
        if self._ws is None:
            return
        try:
            while self._ws is not None:
                socket = self._ws
                iterator = socket.__aiter__()
                try:
                    raw = await asyncio.wait_for(
                        anext(iterator),
                        None if self._negotiated else HELLO_ACK_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    if not await self._retry_hello(
                        socket, f"no hello_ack within {HELLO_ACK_TIMEOUT_SECONDS}s"
                    ):
                        return
                    continue
                except StopAsyncIteration:
                    if await self._retry_hello(socket, "socket ended before hello_ack"):
                        continue
                    return
                except ConnectionClosed as exc:
                    # A policy close before hello_ack is the gateway refusing this hello on
                    # purpose. Re-dialing the same shape cannot change that answer, so say what
                    # the gateway said and let it surface instead of retrying into a loop.
                    if _close_code(exc) == POLICY_CLOSE_CODE:
                        logger.error(
                            "attach-v1: gateway refused the hello (%s). "
                            "The plugin and gateway do not agree on the attach contract",
                            _close_reason(exc).strip() or "no reason given",
                        )
                        raise
                    if await self._retry_hello(
                        socket, f"socket closed before hello_ack (code {_close_code(exc)})"
                    ):
                        continue
                    raise
                await self._dispatch_inbound(raw)
        except Exception as exc:
            code = _close_code(exc)
            if code == SUPERSEDED_CLOSE_CODE:
                raise AttachSupersededError("connection superseded by a newer attach-v1") from exc
            if code == POLICY_CLOSE_CODE and _close_reason(exc).strip().lower() == "unauthorized":
                raise AttachAuthError("attach-v1 rejected (policy close 1008)") from exc
        finally:
            self._closed = True
            self._negotiated = False
            self._capabilities.clear()
            self._settle_mobile_requests("device_unavailable")

    async def _retry_hello(self, socket: Any, reason: str = "hello failed") -> bool:
        """Re-dial once with the SAME hello after the handshake stalls before its ack.

        There is exactly one hello shape, so a retry can never cost this connection a capability.
        A gateway that refuses the hello on policy grounds is a contract skew, not a slow
        handshake: it is logged as an error and left to the caller rather than retried into a loop.
        """
        if self._negotiated or self._hello_retried:
            return False
        self._hello_retried = True
        self._capabilities.clear()
        logger.warning("attach-v1: %s; re-dialing with the same hello", reason)
        try:
            await socket.close()
            await self._open()
        except Exception as exc:  # noqa: BLE001 - the caller re-dials from scratch
            logger.warning("attach-v1: hello retry could not be dialed (%s)", exc)
            return False
        return True

    async def _dispatch_inbound(self, raw: Any) -> None:
        try:
            frame = json.loads(raw)
        except Exception:
            return
        if not isinstance(frame, dict):
            return
        kind = frame.get("kind")
        if kind == "hello_ack":
            resume = frame.get("resume")
            if isinstance(resume, dict):
                event_sequence = resume.get("eventSequence")
                command_sequence = resume.get("commandSequence")
                if isinstance(event_sequence, int) and isinstance(command_sequence, int):
                    self._spool.reconcile_server_resume(event_sequence, command_sequence)
            offered = frame.get("capabilities")
            self._capabilities = {str(item) for item in offered} if isinstance(offered, list) else set()
            self._negotiated = True
            # The negotiated set decides which surfaces work for the life of this connection and is
            # otherwise invisible from the Hermes side, so record it once at handshake time.
            logger.info(
                "attach-v1: negotiated hello v%s with capabilities [%s]",
                HELLO_VERSION, ", ".join(sorted(self._capabilities)),
            )
            # The gateway intersects what it offers with what it allows. A missing capability is
            # a silent surface outage on the Hermes side, so it has to be visible at handshake
            # time rather than inferred from a 503 hours later.
            missing = sorted(set(HELLO_CAPABILITIES) - self._capabilities)
            if missing:
                logger.warning(
                    "attach-v1: gateway did not negotiate [%s]; those surfaces stay OFF for this connection",
                    ", ".join(missing),
                )
            limits = frame.get("limits")
            if isinstance(limits, dict):
                self._max_events = min(self._max_events, int(limits.get("maxInFlightEvents", self._max_events)))
                self._max_bytes = min(self._max_bytes, int(limits.get("maxInFlightBytes", self._max_bytes)))
            if self._config.on_ready is not None:
                self._config.on_ready()
            await self._drain_events()
        elif kind == "mobile_result":
            self._settle_mobile_result(frame)
        elif kind == "memory_request" and self._config.on_memory is not None:
            try:
                outcome = self._config.on_memory(frame)
                if inspect.isawaitable(outcome):
                    await outcome
            except Exception:
                return
        elif kind == "ack" and frame.get("channel") == "event":
            if isinstance(frame.get("sequence"), int) and isinstance(frame.get("id"), str):
                async with self._flow_lock:
                    if frame["sequence"] in self._sent_events and self._spool.ack_event(frame["sequence"], frame["id"]):
                        byte_count = self._sent_events.pop(frame["sequence"], 0)
                        self._sent_event_bytes = max(0, self._sent_event_bytes - byte_count)
                        if frame.get("discarded") is True:
                            logger.warning(
                                "attach-v1: gateway quarantined event (%s)",
                                frame.get("reason", "unknown"),
                            )
                    else:
                        byte_count = None
                if byte_count is not None:
                    await self._drain_events()
        elif kind == "command":
            status = self._spool.accept_command(frame)
            if status in {"accepted", "duplicate"}:
                ack: Dict[str, Any] = {"kind": "ack", "channel": "command", "sequence": frame["sequence"], "id": frame["commandId"]}
                if status == "duplicate":
                    ack["duplicate"] = True
                await self._send(ack)
                if status == "accepted":
                    await self._dispatch_command(frame, replay=False)
            elif status == "gap":
                await self._send({"kind": "gap", "channel": "command", "requestedAfter": self._spool.command_cursor, "earliestAvailable": self._spool.command_cursor + 1, "latestAvailable": frame["sequence"]})
        elif kind == "heartbeat":
            await self._send({
                "kind": "heartbeat", "sentAt": frame.get("sentAt", 0),
                "telemetry": self._spool.health_snapshot(),
            })
            await self._drain_events()
        elif kind == "gap" and frame.get("channel") == "event":
            await self.replay()

    async def _dispatch_command(self, frame: Dict[str, Any], replay: bool) -> None:
        command = frame.get("command")
        if not isinstance(command, dict):
            return
        handler: Optional[Callable[[Any], None]] = None
        parsed: Any = None
        if command.get("kind") == "turn":
            handler, parsed = self._config.on_turn, parse_turn_frame(command)
        elif command.get("kind") == "steer":
            handler, parsed = self._config.on_steer, parse_steer_frame(command)
        elif command.get("kind") == "interrupt":
            handler, parsed = self._config.on_interrupt, parse_interrupt_frame(command)
        elif command.get("kind") == "resolve_approval" and self._config.on_approval is not None:
            handler, parsed = self._config.on_approval, command
        elif command.get("kind") == "resolve_clarify" and self._config.on_clarify is not None:
            handler, parsed = self._config.on_clarify, command
        elif command.get("kind") == "delivery_receipt":
            # Receipts have no handler callback: the durable record IS the effect. The ACK has
            # already been sent by the command-inbox machinery above.
            self._record_delivery_receipt(command)
            self._spool.mark_command_processed(str(frame.get("commandId", "")))
            return
        if handler is not None and parsed is not None:
            try:
                outcome = handler(parsed)
                if inspect.isawaitable(outcome):
                    await outcome
            except Exception:
                return
        self._spool.mark_command_processed(str(frame.get("commandId", "")))

    def _record_delivery_receipt(self, command: Dict[str, Any]) -> None:
        """Validate and persist one delivery_receipt command, then log a single INFO line."""
        delivery_id = command.get("deliveryId")
        state = command.get("state")
        at = command.get("at")
        stage = command.get("stage")
        reason = command.get("reason")
        if not isinstance(delivery_id, str) or not delivery_id or len(delivery_id) > RECEIPT_ID_MAX_CHARS:
            logger.warning("attach-v1: dropping delivery_receipt with an unusable deliveryId")
            return
        if state not in RECEIPT_STATES or not isinstance(at, int) or isinstance(at, bool) or at < 0:
            logger.warning("attach-v1: dropping malformed delivery_receipt for %s", delivery_id)
            return
        if stage is not None and stage not in RECEIPT_STAGES:
            logger.warning("attach-v1: dropping delivery_receipt for %s with unknown stage", delivery_id)
            return
        if reason is not None and not isinstance(reason, str):
            logger.warning("attach-v1: dropping delivery_receipt for %s with a non-string reason", delivery_id)
            return
        outcome = self._spool.record_delivery_receipt(
            delivery_id,
            str(state),
            at,
            stage=str(stage) if isinstance(stage, str) else None,
            reason=reason[:RECEIPT_REASON_MAX_CHARS] if isinstance(reason, str) else None,
        )
        self._upgrade_media_rows(delivery_id, str(state))
        logger.info(
            "attach-v1: delivery receipt %s state=%s stage=%s (%s)",
            delivery_id, state, stage or "-", outcome,
        )

    async def _close_socket(self, ws: Any) -> None:
        try:
            await ws.close()
        except Exception:
            pass

    def _begin_close(self) -> None:
        self._closed = True
        self._settle_mobile_requests("device_unavailable")
        if self._socket_close_task is not None:
            return
        ws, self._ws = self._ws, None
        if ws is not None:
            self._socket_close_task = asyncio.create_task(self._close_socket(ws))

    async def wait_closed(self) -> None:
        """Wait for the raw websocket close task, even after a caller timeout."""
        task = self._socket_close_task
        if task is not None:
            try:
                await asyncio.shield(task)
            finally:
                if task.done() and self._socket_close_task is task:
                    self._socket_close_task = None

    async def close(self) -> None:
        self._begin_close()
        await self.wait_closed()

    def _settle_mobile_result(self, frame: Dict[str, Any]) -> None:
        request_id = frame.get("requestId")
        status = frame.get("status")
        if not isinstance(request_id, str) or not isinstance(status, str) or status not in MOBILE_STATUS_VALUES:
            return
        pending = self._mobile_requests.pop(request_id, None)
        if pending is None:
            return
        command, future = pending
        if future.done():
            return
        result: MobileDeviceStatusResult = {"status": status}
        payload = frame.get("result")
        if status == "ok":
            if (command == "device.status" and not _is_device_status(payload)) or (command == "location.current" and not _is_location(payload)):
                future.set_result({"status": "device_unavailable"})
                return
            result["result"] = payload
        future.set_result(result)

    def _settle_mobile_requests(self, status: MobileStatus) -> None:
        pending, self._mobile_requests = self._mobile_requests, {}
        for _command, future in pending.values():
            if not future.done():
                future.set_result({"status": status})

    async def _cancel_mobile_request(self, request_id: str) -> None:
        try:
            await self._send({"kind": "mobile_cancel", "requestId": request_id})
        except Exception:
            pass


def _is_device_status(value: Any) -> bool:
    return isinstance(value, dict) and value == {"foreground": True}


def _is_location(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {"latitude", "longitude"}:
        return False
    latitude, longitude = value["latitude"], value["longitude"]
    return (
        isinstance(latitude, (int, float)) and not isinstance(latitude, bool)
        and isinstance(longitude, (int, float)) and not isinstance(longitude, bool)
        and -90 <= latitude <= 90 and -180 <= longitude <= 180
        and abs(latitude * 100 - round(latitude * 100)) < 1e-8
        and abs(longitude * 100 - round(longitude * 100)) < 1e-8
    )


def normalize_location_purpose(value: Any) -> Optional[str]:
    if not isinstance(value, str) or re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        return None
    purpose = " ".join(value.strip().split())
    return purpose if purpose and len(purpose.encode("utf-8")) <= 160 else None


class _HashingReader:
    """A read-only view of an open file that digests what it hands out.

    http.client pulls the request body through ``read(n)``, so this is where the bytes
    that reach the socket can be hashed without a second pass over the file. It also
    never hands out more than ``limit``: the request declared that many bytes, and a
    file that grew since it was measured must not desynchronize the framing or slip
    past the size cap that number came from.
    """

    # http.client asks for 8 KiB at a time. Answering with more is allowed and is what
    # keeps a 32 MiB attachment from becoming four thousand read/send round trips.
    BLOCK = 1024 * 1024

    def __init__(self, handle: Any, limit: int) -> None:
        self._handle = handle
        self._remaining = limit
        self._digest = hashlib.sha256()

    def read(self, size: int = -1) -> bytes:
        if self._remaining <= 0:
            return b""
        want = self._remaining if size is None or size < 0 else min(
            max(size, self.BLOCK), self._remaining,
        )
        chunk = self._handle.read(want)
        self._remaining -= len(chunk)
        self._digest.update(chunk)
        return chunk

    @property
    def complete(self) -> bool:
        """Whether the whole declared body was handed out. A short read means the
        transport never sent it, and the response already says why."""
        return self._remaining <= 0

    def hexdigest(self) -> str:
        return self._digest.hexdigest()


def _file_digest(handle: Any) -> str:
    """sha256 of an open file, leaving it rewound. Only for callers that did not probe."""

    digest = hashlib.sha256()
    for chunk in iter(lambda: handle.read(1024 * 1024), b""):
        digest.update(chunk)
    handle.seek(0)
    return digest.hexdigest()


def _media_byte_limit(mime: str) -> int:
    if mime.startswith("image/"):
        return ATTACH_IMAGE_MAX_BYTES
    if mime.startswith("audio/") or mime.startswith("video/"):
        return ATTACH_AUDIO_VIDEO_MAX_BYTES
    return ATTACH_FILE_MAX_BYTES


def _event_capabilities(event: Dict[str, Any]) -> List[str]:
    kind = event.get("kind")
    if kind == "media":
        return ["media"]
    if kind == "tool":
        return ["tools"]
    if kind == "approval":
        return ["approvals"]
    if kind == "clarify":
        return ["clarify"]
    if kind == "scheduled":
        return ["scheduled"] + (["media"] if event.get("mediaIds") else [])
    if kind == "presence":
        return []
    return ["draft"] + (["media"] if kind == "commit" and event.get("mediaIds") else [])

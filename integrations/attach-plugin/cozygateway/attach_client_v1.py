"""Harness-free attach-v1 client with a durable SQLite spool."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import mimetypes
import os
import re
import ssl
import time
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Literal, Optional, TypedDict, Union
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
    _default_connect,
    _http_status,
    derive_attach_ws_url,
    parse_interrupt_frame,
    parse_steer_frame,
    parse_turn_frame,
)
from .attach_spool import AttachSpool, TerminalSealed


MobileStatus = Literal[
    "ok", "denied", "expired", "cancelled", "device_unavailable",
    "foreground_required", "policy_blocked",
]
MOBILE_STATUS_VALUES = frozenset(MobileStatus.__args__)
MOBILE_STATUS_TIMEOUT_SECONDS = 30
MOBILE_HELLO_ACK_TIMEOUT_SECONDS = 1


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
    path: str = "/attach/v1"
    ca_file: Optional[str] = None
    on_turn: Optional[Callable[[TurnFrame], None]] = None
    on_steer: Optional[Callable[[SteerFrame], None]] = None
    on_interrupt: Optional[Callable[[InterruptFrame], None]] = None
    on_approval: Optional[Callable[[Dict[str, Any]], None]] = None
    on_clarify: Optional[Callable[[Dict[str, Any]], None]] = None
    connect_factory: Optional[Callable[..., Any]] = None
    max_in_flight_events: int = 64
    max_in_flight_bytes: int = 4 * 1024 * 1024


class AttachV1Client:
    def __init__(self, config: AttachV1ClientConfig) -> None:
        self._config = config
        self._spool = config.spool
        self._ws_url = derive_attach_ws_url(config.gateway_url, config.path)
        self._ws: Any = None
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
        self._hello_version = 2
        self._hello_fallback_used = False
        # Mobile requests are intentionally outside the durable spool: a phone action
        # must not replay after a reconnect or plugin restart.
        self._mobile_requests: Dict[str, tuple[str, asyncio.Future[MobileDeviceStatusResult]]] = {}

    def _ssl_context(self) -> Any:
        if self._config.ca_file and self._ws_url.startswith("wss://"):
            context = ssl.create_default_context()
            context.load_verify_locations(self._config.ca_file)
            return context
        return None

    async def connect(self) -> None:
        self._closed = False
        self._negotiated = False
        self._capabilities.clear()
        self._sent_events.clear()
        self._sent_event_bytes = 0
        self._hello_version = 2
        self._hello_fallback_used = False
        try:
            await self._open(self._hello_version)
        except Exception as exc:
            if _http_status(exc) == 401:
                raise AttachAuthError("attach-v1 rejected (HTTP 401)") from exc
            raise

        # A command ACKed before a crash remains in the inbox until execution was recorded.
        for frame in self._spool.pending_commands():
            await self._dispatch_command(frame, replay=True)

    async def _open(self, version: int) -> None:
        headers = {"Authorization": f"Bearer {self._config.token}"}
        factory = self._config.connect_factory or _default_connect
        self._ws = await factory(self._ws_url, headers, self._ssl_context())
        await self._send({
            "kind": "hello",
            "version": version,
            "instanceId": self._spool.instance_id,
            "capabilities": ["draft", "media", "tools", "approvals", "clarify", "scheduled", "mobile_node", *( ["mobile_location"] if version >= 2 else [] )],
            "resume": {"eventSequence": self._spool.event_cursor, "commandSequence": self._spool.command_cursor},
            "limits": {"maxInFlightEvents": self._max_events, "maxInFlightBytes": self._max_bytes},
        })

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
        # v1 tools are independent lifecycle events. Snapshot chips are projected into transitions
        # for compatibility with harnesses that expose only the older draft-chip tap.
        for chip in tool_calls or []:
            event = {"kind": "tool", "threadId": thread_id, "turnId": turn_id, "callId": chip.id, "name": chip.name, "status": chip.status}
            if chip.detail is not None:
                event["detail"] = chip.detail
            await self._queue_event(event)

    async def send_done(self, thread_id: str, turn_id: str, media_ids: Optional[List[str]] = None) -> None:
        blocks = self._latest_blocks.pop(turn_id, [])
        event: Dict[str, Any] = {
            "kind": "commit", "threadId": thread_id, "turnId": turn_id,
            "messageId": str(uuid.uuid4()), "blocks": blocks,
        }
        if media_ids:
            event["mediaIds"] = list(media_ids[:16])
        await self._queue_event(event)

    async def send_failed(self, thread_id: str, turn_id: str, message: str) -> None:
        self._latest_blocks.pop(turn_id, None)
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
        thread_id: str,
        delivery_id: str,
        message_id: str,
        blocks: List[RichBlock],
    ) -> None:
        await self._queue_event({
            "kind": "scheduled", "threadId": thread_id, "deliveryId": delivery_id,
            "messageId": message_id, "blocks": self._wire_blocks(blocks),
        })

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

    async def upload_media(self, media_id: str, path: str, family: str, expires_at: Optional[int] = None) -> Dict[str, Any]:
        """Upload bytes through the authenticated HTTP side channel; WS carries only metadata."""
        with open(path, "rb") as handle:
            data = handle.read()
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        digest = hashlib.sha256(data).hexdigest()
        descriptor = await asyncio.to_thread(self._upload_media_sync, media_id, path, mime, digest, data, expires_at)
        await self._queue_event({"kind": "media", "media": descriptor})
        return descriptor

    async def download_media(self, media_id: str, max_bytes: int = 20 * 1024 * 1024) -> tuple[bytes, str, str]:
        """Fetch one gateway-owned attachment through the same bearer side channel.

        The cap is enforced while reading so a malformed server response cannot make the plugin
        buffer an arbitrary file before Hermes has a chance to classify it.
        """
        return await asyncio.to_thread(self._download_media_sync, media_id, max_bytes)

    def _download_media_sync(self, media_id: str, max_bytes: int) -> tuple[bytes, str, str]:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        request = Request(f"{origin}/attach/v1/media/{quote(media_id, safe='')}", headers={
            "Authorization": f"Bearer {self._config.token}",
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

    def _upload_media_sync(self, media_id: str, path: str, mime: str, digest: str, data: bytes, expires_at: Optional[int]) -> Dict[str, Any]:
        parsed = urlparse(self._config.gateway_url)
        origin = f"{parsed.scheme or 'http'}://{parsed.netloc or parsed.path}"
        headers = {
            "Authorization": f"Bearer {self._config.token}",
            "Content-Type": mime,
            # urllib's default Python-urllib signature is blocked by common
            # Cloudflare Browser Integrity rules (error 1010). Identify this
            # non-browser protocol client explicitly so the authenticated media
            # side channel follows the same public route as the WebSocket.
            "User-Agent": "CozyGateway-Attach/1.0",
            "X-Attach-Sha256": digest,
            "X-Attach-Filename": os.path.basename(path),
        }
        if expires_at is not None:
            headers["X-Attach-Expires-At"] = str(expires_at)
        request = Request(f"{origin}/attach/v1/media/{quote(media_id, safe='')}", data=data, headers=headers, method="POST")
        context = self._ssl_context() if origin.startswith("https://") else None
        with urlopen(request, context=context, timeout=60) as response:
            return dict(json.loads(response.read())["media"])

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
                        None if self._negotiated else MOBILE_HELLO_ACK_TIMEOUT_SECONDS,
                    )
                except asyncio.TimeoutError:
                    if not await self._fallback_to_v1(socket):
                        return
                    continue
                except StopAsyncIteration:
                    if await self._fallback_to_v1(socket):
                        continue
                    return
                except ConnectionClosed:
                    if await self._fallback_to_v1(socket):
                        continue
                    raise
                await self._dispatch_inbound(raw)
        except Exception as exc:
            code = _close_code(exc)
            if code == SUPERSEDED_CLOSE_CODE:
                raise AttachSupersededError("connection superseded by a newer attach-v1") from exc
            if code == POLICY_CLOSE_CODE:
                raise AttachAuthError("attach-v1 rejected (policy close 1008)") from exc
        finally:
            self._closed = True
            self._settle_mobile_requests("device_unavailable")

    async def _fallback_to_v1(self, socket: Any) -> bool:
        """Reconnect once with the frozen v1 hello after v2 fails before its ack."""
        if self._negotiated or self._hello_version != 2 or self._hello_fallback_used:
            return False
        self._hello_fallback_used = True
        self._hello_version = 1
        self._capabilities.clear()
        try:
            await socket.close()
            await self._open(1)
        except Exception:
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
            limits = frame.get("limits")
            if isinstance(limits, dict):
                self._max_events = min(self._max_events, int(limits.get("maxInFlightEvents", self._max_events)))
                self._max_bytes = min(self._max_bytes, int(limits.get("maxInFlightBytes", self._max_bytes)))
            await self._drain_events()
        elif kind == "mobile_result":
            self._settle_mobile_result(frame)
        elif kind == "ack" and frame.get("channel") == "event":
            if isinstance(frame.get("sequence"), int) and isinstance(frame.get("id"), str):
                async with self._flow_lock:
                    if frame["sequence"] in self._sent_events and self._spool.ack_event(frame["sequence"], frame["id"]):
                        byte_count = self._sent_events.pop(frame["sequence"], 0)
                        self._sent_event_bytes = max(0, self._sent_event_bytes - byte_count)
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
            await self._send({"kind": "heartbeat", "sentAt": frame.get("sentAt", 0)})
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
        if handler is not None and parsed is not None:
            try:
                outcome = handler(parsed)
                if inspect.isawaitable(outcome):
                    await outcome
            except Exception:
                return
        self._spool.mark_command_processed(str(frame.get("commandId", "")))

    async def close(self) -> None:
        self._closed = True
        self._settle_mobile_requests("device_unavailable")
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:
                pass

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

"""Scriptable in-process fake attach gateway for media integration tests.

The media hardening work needs a gateway that can be told, per request, exactly how to
misbehave: refuse authorization, reject a MIME type, run out of quota, drop the socket
mid-upload, or answer a projection receipt late. A live gateway cannot be steered that
way, and a mocked client hides the wire behaviour under test. This stands up the real
wire instead: a websockets server speaking attach-v1 and a stdlib HTTP server serving the
authenticated media side channel, both reachable through one ``http://`` base URL so the
production ``AttachV1Client`` dials it unmodified.

Conventions match the rest of ``tests/``: stdlib ``unittest``, asyncio and ``websockets``
only. No pytest, no aiohttp, no new dependencies.

One port, two protocols
-----------------------
``AttachV1Client`` derives its websocket URL from the same host and port as its HTTP base
(``derive_attach_ws_url``), so the fake cannot just run two servers on two ports. A small
asyncio front door reads the request head and relays the connection to the websockets
backend when it carries ``Upgrade: websocket`` and to the HTTP backend otherwise. Both
backends stay ordinary and the relay is a dumb byte pump, so a scripted abrupt close
reaches the client as an abrupt close.

Usage::

    from tests.fake_gateway import FakeGateway, upload_ok, upload_rate_limited

    async with FakeGateway() as gateway:
        gateway.script_upload(upload_rate_limited(retry_after=1), upload_ok())
        client = AttachV1Client(AttachV1ClientConfig(
            gateway_url=gateway.http_url, token=gateway.token, spool=spool,
        ))
        await client.connect()
        watcher = asyncio.create_task(client.watch())
        await gateway.wait_for(lambda: gateway.hellos, what="hello")
        ...
        self.assertEqual(gateway.upload_content_types, ["image/png"])
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import socket
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import unquote, urlparse

from websockets.asyncio.server import serve as ws_serve
from websockets.exceptions import ConnectionClosed

# Capabilities a healthy gateway offers. Tests narrow this to prove a surface goes dark.
DEFAULT_CAPABILITIES = (
    "draft", "media", "tools", "approvals", "clarify", "scheduled",
    "mobile_node", "mobile_location", "memory_management", "delivery_receipts",
)
DEFAULT_LIMITS = {"maxInFlightEvents": 64, "maxInFlightBytes": 4 * 1024 * 1024}
# Everything here is loopback and in-process, so a wait that reaches this bound is a real
# failure rather than a slow machine.
DEFAULT_WAIT_SECONDS = 5.0

# A genuinely valid 1x1 PNG, so a byte-sniffing probe agrees with the .png extension.
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f"
    "15c4890000000d49444154789c63f8cfc0f01f00050001ff89993d1d0000"
    "000049454e44ae426082"
)


def _error_body(code: str, message: str) -> Dict[str, Any]:
    """The gateway's shared error envelope (packages/gateway/src/http.ts errorBody)."""
    return {"error": {"code": code, "message": message}}


def _family_for(mime: str) -> str:
    for prefix in ("image", "audio", "video"):
        if mime.startswith(f"{prefix}/"):
            return prefix
    return "file"


# --------------------------------------------------------------------------------------
# Scripted HTTP responses
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class HttpResponse:
    """One scripted answer to one HTTP request.

    ``behaviour`` decides what the server physically does: ``respond`` writes
    ``status``/``body`` after reading the request body, ``descriptor`` writes the 200 body
    the real gateway computes, ``drop_before_body`` closes the socket without reading the
    body, and ``drop_after_body`` reads the whole body then closes without answering.
    """

    label: str
    behaviour: str = "respond"
    status: int = 200
    body: Optional[Dict[str, Any]] = None
    headers: Dict[str, str] = field(default_factory=dict)
    delay_s: float = 0.0


def upload_ok(*, status: int = 201, delay_s: float = 0.0) -> HttpResponse:
    """Accept the upload and answer with the descriptor the real gateway would build.

    ``delay_s`` holds the request open after the body arrives, which is how overlapping
    uploads are made observable to :attr:`FakeGateway.peak_upload_concurrency`.
    """
    return HttpResponse(label="ok", behaviour="descriptor", status=status, delay_s=delay_s)


def upload_forbidden(*, message: str = "attach media is not authorized") -> HttpResponse:
    return HttpResponse(label="403", status=403, body=_error_body("forbidden", message))


def upload_too_large(limit_bytes: int) -> HttpResponse:
    """413 whose body names the limit, so a caller can put it in a user-facing error."""
    body = _error_body("invalid_request", "media is over the size cap")
    body["reason"], body["limitBytes"] = "too_large", int(limit_bytes)
    return HttpResponse(label="413", status=413, body=body)


def upload_unsupported_mime(mime: str) -> HttpResponse:
    """415 whose body names the rejected MIME type."""
    body = _error_body("invalid_request", "disallowed media type")
    body["reason"], body["mimeType"] = "content_type", mime
    return HttpResponse(label="415", status=415, body=body)


def upload_rate_limited(*, retry_after: int = 2) -> HttpResponse:
    body = _error_body("rate_limited", "too many media uploads")
    body["retryAfter"] = int(retry_after)
    return HttpResponse(
        label="429", status=429, body=body, headers={"Retry-After": str(int(retry_after))},
    )


def upload_server_error(*, status: int = 500) -> HttpResponse:
    """500 or 502, the two transient shapes the spec asks for."""
    return HttpResponse(
        label=str(status), status=status, body=_error_body("internal", "media store is unavailable"),
    )


def upload_drop_before_body() -> HttpResponse:
    return HttpResponse(label="drop_before_body", behaviour="drop_before_body")


def upload_drop_after_body() -> HttpResponse:
    return HttpResponse(label="drop_after_body", behaviour="drop_after_body")


def receipt_missing() -> HttpResponse:
    """404, which the client turns into ``None``: this delivery is not journaled yet."""
    return HttpResponse(
        label="404", status=404, body=_error_body("not_found", "no such attach delivery"),
    )


def receipt(
    state: str,
    *,
    message_id: str = "message-1",
    thread_id: str = "thread-1",
    canonical_home: bool = False,
    projected_at: Optional[int] = None,
    terminal: Optional[Dict[str, Any]] = None,
    delay_s: float = 0.0,
) -> HttpResponse:
    """A scheduled-delivery receipt body in the gateway's shape.

    ``state`` is ``admitted``, ``projected`` or ``blocked``; ``delay_s`` holds the response
    open, which is how a late projection is scripted. ``deliveryId`` is filled in per
    request, so one scripted body serves any delivery.
    """
    body: Dict[str, Any] = {
        "deliveryId": "", "messageId": message_id, "state": state,
        "admittedAt": 1_700_000_000_000,
        "target": (
            {"kind": "canonical_home", "sessionId": thread_id} if canonical_home
            else {"kind": "thread", "threadId": thread_id}
        ),
    }
    if projected_at is not None:
        body["projectedAt"] = projected_at
    if terminal is not None:
        body["terminal"] = dict(terminal)
    return HttpResponse(label=f"receipt:{state}", status=200, body=body, delay_s=delay_s)


@dataclass
class UploadRecord:
    """One POST the fake saw, whatever it answered."""

    media_id: str
    content_type: str
    size_bytes: int
    sha256: Optional[str]
    filename: Optional[str]
    body_read: bool
    outcome: str


class _ScriptQueue:
    """A queue of scripted responses plus the trail of what each request consumed.

    An exhausted queue falls back to ``default``; a ``sticky`` queue repeats its last
    answer instead, so a poll loop that outlives the script keeps seeing the terminal
    state rather than a sudden 404.
    """

    def __init__(self, default: Optional[HttpResponse] = None, sticky: bool = False) -> None:
        self._default, self._sticky = default, sticky
        self._queued: List[HttpResponse] = []
        self._last: Optional[HttpResponse] = None
        self.consumed: List[str] = []

    def extend(self, responses: List[HttpResponse]) -> None:
        self._queued.extend(responses)

    def take(self) -> Optional[HttpResponse]:
        if self._queued:
            response = self._queued.pop(0)
        elif self._sticky and self._last is not None:
            response = self._last
        else:
            response = self._default
        self._last = response
        self.consumed.append("default" if response is None else response.label)
        return response

    @property
    def pending(self) -> int:
        return len(self._queued)


# --------------------------------------------------------------------------------------
# HTTP side channel
# --------------------------------------------------------------------------------------


class _MediaHandler(BaseHTTPRequestHandler):
    """POST/DELETE /attach/v1/media/:id and GET /attach/v1/deliveries/:id."""

    protocol_version = "HTTP/1.1"
    gateway: "FakeGateway"

    def log_message(self, *_args: Any) -> None:  # keep the suite quiet
        return

    def handle_one_request(self) -> None:
        # A scripted socket drop makes the response flush fail. That is the script working,
        # not a server bug, so it must not reach socketserver's error handler.
        try:
            super().handle_one_request()
        except (OSError, ValueError):
            self.close_connection = True

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler naming
        self._route(self._suffix("/attach/v1/media/"), self.gateway._handle_upload)

    def do_DELETE(self) -> None:  # noqa: N802
        self._route(self._suffix("/attach/v1/media/"), self.gateway._handle_delete)

    def do_GET(self) -> None:  # noqa: N802
        self._route(self._suffix("/attach/v1/deliveries/"), self.gateway._handle_receipt)

    def _route(self, resource: Optional[str], action: Callable[["_MediaHandler", str], None]) -> None:
        if resource is None:
            self.send_json(404, _error_body("not_found", "no such route"))
        elif self.headers.get("Authorization") != f"Bearer {self.gateway.token}":
            self.send_json(401, _error_body("unauthorized", "attach token rejected"))
        else:
            action(self, resource)

    def _suffix(self, prefix: str) -> Optional[str]:
        path = urlparse(self.path).path
        return unquote(path[len(prefix):]) or None if path.startswith(prefix) else None

    def read_body(self) -> bytes:
        remaining, chunks = self.declared_length(), []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def declared_length(self) -> int:
        try:
            return int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return 0

    def drop(self) -> None:
        """Close the connection abruptly, with no response line at all."""
        self.close_connection = True
        for close in (lambda: self.connection.shutdown(socket.SHUT_RDWR), self.connection.close):
            try:
                close()
            except OSError:
                pass

    def send_json(
        self, status: int, body: Optional[Dict[str, Any]], headers: Optional[Dict[str, str]] = None,
    ) -> None:
        payload = b"" if body is None else json.dumps(body).encode("utf-8")
        self.send_response(status)
        if payload:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if payload:
            self.wfile.write(payload)


class _QuietHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request: Any, client_address: Any) -> None:
        # Scripted drops leave broken pipes behind. The recorded surface is the truth here,
        # so a stack trace on stderr would only be noise.
        return


# --------------------------------------------------------------------------------------
# The fake gateway
# --------------------------------------------------------------------------------------


class FakeGateway:
    """An in-process attach gateway whose per-request behaviour is scripted.

    Start it with ``await gateway.start()`` (or ``async with``), point a real
    ``AttachV1ClientConfig`` at ``gateway.http_url`` with ``gateway.token``, and script the
    responses before the client acts.
    """

    def __init__(
        self,
        *,
        token: str = "fake-attach-token",
        capabilities: Optional[List[str]] = None,
        auto_hello_ack: bool = True,
        auto_ack_events: bool = True,
        enforce_event_sequence: bool = False,
        host: str = "127.0.0.1",
    ) -> None:
        self.token = token
        self.capabilities = list(DEFAULT_CAPABILITIES if capabilities is None else capabilities)
        self.auto_hello_ack = auto_hello_ack
        self.auto_ack_events = auto_ack_events
        # Off by default so existing tests keep scripting sequences freely. Turned on, this is the
        # real gateway's admission rule: strictly contiguous or a gap reply, never a skip.
        self.enforce_event_sequence = enforce_event_sequence
        self._host = host

        # Assertion surface. The HTTP threads and the event loop both append, so every
        # mutation takes the lock and every reader copies under it.
        self._lock = threading.Lock()
        self._uploads: List[UploadRecord] = []
        self._deletes: List[str] = []
        self._receipt_requests: List[str] = []
        self._frames: List[Dict[str, Any]] = []
        self._gaps_sent: List[int] = []

        self._upload_in_flight = 0
        self._peak_upload_concurrency = 0
        self._upload_script = _ScriptQueue(default=upload_ok())
        self._receipt_scripts: Dict[str, _ScriptQueue] = {}

        self._connections: List[Any] = []
        self._command_sequence = 0
        self._event_cursor = 0
        self._admitted_event_ids: set[str] = set()
        self._scheduled: List[asyncio.Task] = []

        self._http: Optional[_QuietHTTPServer] = None
        self._http_thread: Optional[threading.Thread] = None
        self._ws_server: Any = None
        self._front: Optional[asyncio.AbstractServer] = None
        self.port = 0

    # -- lifecycle ----------------------------------------------------------------

    @property
    def http_url(self) -> str:
        return f"http://{self._host}:{self.port}"

    async def __aenter__(self) -> "FakeGateway":
        await self.start()
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.stop()

    async def start(self) -> None:
        self._http = _QuietHTTPServer(
            (self._host, 0), type("_BoundHandler", (_MediaHandler,), {"gateway": self}),
        )
        self._http_thread = threading.Thread(
            target=self._http.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True,
        )
        self._http_thread.start()
        self._ws_server = await ws_serve(
            self._ws_handler, self._host, 0, process_request=self._process_request,
        )
        self._front = await asyncio.start_server(self._relay, self._host, 0)
        self.port = self._front.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        for task in self._scheduled:
            task.cancel()
        self._scheduled.clear()
        for connection in list(self._connections):
            try:
                await connection.close()
            except Exception:  # noqa: BLE001 - teardown is best effort
                pass
        self._connections.clear()
        if self._front is not None:
            self._front.close()
            await self._front.wait_closed()
            self._front = None
        if self._ws_server is not None:
            self._ws_server.close()
            await self._ws_server.wait_closed()
            self._ws_server = None
        if self._http is not None:
            self._http.shutdown()
            self._http.server_close()
            self._http = None
        if self._http_thread is not None:
            self._http_thread.join(timeout=5)
            self._http_thread = None

    # -- one port, two protocols ---------------------------------------------------

    async def _relay(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Read the request head, then pump bytes to whichever backend owns it."""
        head = b""
        try:
            while b"\r\n\r\n" not in head and len(head) < 65536:
                chunk = await reader.read(4096)
                if not chunk:
                    break
                head += chunk
        except OSError:
            head = b""
        if not head or self._http is None or self._ws_server is None:
            writer.close()
            return
        backend = (
            self._ws_server.sockets[0].getsockname()[1]
            if b"upgrade: websocket" in head.lower()
            else self._http.server_address[1]
        )
        try:
            back_reader, back_writer = await asyncio.open_connection(self._host, backend)
        except OSError:
            writer.close()
            return
        try:
            back_writer.write(head)
            await back_writer.drain()
            await asyncio.gather(
                self._pump(reader, back_writer), self._pump(back_reader, writer),
                return_exceptions=True,
            )
        finally:
            for stream in (back_writer, writer):
                try:
                    stream.close()
                except OSError:
                    pass

    @staticmethod
    async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                chunk = await reader.read(65536)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
        except OSError:
            return
        finally:
            try:
                if writer.can_write_eof():
                    writer.write_eof()
            except OSError:
                pass

    # -- websocket side ------------------------------------------------------------

    def _process_request(self, connection: Any, request: Any) -> Any:
        if getattr(request, "path", "") != "/attach/v1":
            return connection.respond(404, "no such attach path\n")
        if request.headers.get("Authorization") != f"Bearer {self.token}":
            return connection.respond(401, "unauthorized\n")
        return None

    async def _ws_handler(self, connection: Any) -> None:
        self._connections.append(connection)
        try:
            async for raw in connection:
                await self._on_frame(connection, raw)
        except ConnectionClosed:
            return
        finally:
            if connection in self._connections:
                self._connections.remove(connection)

    async def _on_frame(self, connection: Any, raw: Any) -> None:
        try:
            frame = json.loads(raw)
        except Exception:  # noqa: BLE001 - a malformed frame is still evidence
            frame = {"kind": "unparseable", "raw": str(raw)[:512]}
        if not isinstance(frame, dict):
            return
        with self._lock:
            self._frames.append(frame)
        if frame.get("kind") == "hello" and self.auto_hello_ack:
            await self.send_hello_ack(connection=connection)
        elif frame.get("kind") == "event" and self.enforce_event_sequence:
            await self._admit_event(frame, connection)
        elif frame.get("kind") == "event" and self.auto_ack_events:
            await self.ack_event(frame, connection)

    async def _send(self, frame: Dict[str, Any], connection: Optional[Any] = None) -> bool:
        target = connection or (self._connections[-1] if self._connections else None)
        if target is None:
            return False
        try:
            await target.send(json.dumps(frame, separators=(",", ":")))
        except ConnectionClosed:
            return False
        return True

    async def send_hello_ack(
        self,
        *,
        capabilities: Optional[List[str]] = None,
        resume: Optional[Dict[str, int]] = None,
        connection: Optional[Any] = None,
    ) -> bool:
        return await self._send({
            "kind": "hello_ack",
            "capabilities": list(self.capabilities if capabilities is None else capabilities),
            "resume": dict(resume or {"eventSequence": 0, "commandSequence": 0}),
            "limits": dict(DEFAULT_LIMITS),
        }, connection)

    async def _admit_event(self, frame: Dict[str, Any], connection: Optional[Any] = None) -> bool:
        """Admit one event the way the gateway does: contiguous or gapped, duplicates tolerated."""
        sequence, event_id = frame.get("sequence"), frame.get("eventId")
        if not isinstance(sequence, int) or not isinstance(event_id, str):
            return False
        if event_id in self._admitted_event_ids:
            return await self._send(
                {"kind": "ack", "channel": "event", "sequence": sequence, "id": event_id, "duplicate": True},
                connection,
            )
        if sequence != self._event_cursor + 1:
            self._record(self._gaps_sent, sequence)
            return await self._send({
                "kind": "gap", "channel": "event", "requestedAfter": self._event_cursor,
                "earliestAvailable": self._event_cursor + 1, "latestAvailable": self._event_cursor,
            }, connection)
        self._event_cursor = sequence
        self._admitted_event_ids.add(event_id)
        return await self.ack_event(frame, connection)

    @property
    def admitted_event_cursor(self) -> int:
        """The highest strictly contiguous event sequence this gateway has admitted."""
        return self._event_cursor

    @property
    def gaps_sent(self) -> List[int]:
        """The event sequence that triggered each gap reply, in order."""
        with self._lock:
            return list(self._gaps_sent)

    async def ack_event(self, frame: Dict[str, Any], connection: Optional[Any] = None) -> bool:
        sequence, event_id = frame.get("sequence"), frame.get("eventId")
        if not isinstance(sequence, int) or not isinstance(event_id, str):
            return False
        return await self._send(
            {"kind": "ack", "channel": "event", "sequence": sequence, "id": event_id}, connection,
        )

    async def push_command(self, command: Dict[str, Any], connection: Optional[Any] = None) -> Dict[str, Any]:
        """Send one command frame. Sequences advance from 1, as a real inbox requires."""
        self._command_sequence += 1
        frame = {
            "kind": "command", "sequence": self._command_sequence,
            "commandId": str(uuid.uuid4()), "command": dict(command),
        }
        await self._send(frame, connection)
        return frame

    async def push_delivery_receipt(
        self,
        delivery_id: str,
        state: str,
        *,
        at: Optional[int] = None,
        stage: Optional[str] = None,
        reason: Optional[str] = None,
        delay_s: float = 0.0,
        repeat: int = 1,
        connection: Optional[Any] = None,
    ) -> Dict[str, Any]:
        """Push a ``delivery_receipt`` command over the socket.

        ``delay_s`` is the late-receipt case; ``repeat`` above one is the duplicate case,
        re-sending the same commandId and sequence, which is exactly the replay the
        client's command inbox has to absorb.
        """
        command: Dict[str, Any] = {
            "kind": "delivery_receipt", "deliveryId": delivery_id, "state": state,
            "at": int(time.time() * 1000) if at is None else at,
        }
        if stage is not None:
            command["stage"] = stage
        if reason is not None:
            command["reason"] = reason
        if delay_s > 0:
            await asyncio.sleep(delay_s)
        frame = await self.push_command(command, connection)
        for _ in range(max(0, repeat - 1)):
            await self._send(frame, connection)
        return frame

    def schedule_delivery_receipt(self, delivery_id: str, state: str, **kwargs: Any) -> asyncio.Task:
        """Fire ``push_delivery_receipt`` in the background, for a receipt that lands late."""
        task = asyncio.get_running_loop().create_task(
            self.push_delivery_receipt(delivery_id, state, **kwargs)
        )
        self._scheduled.append(task)
        return task

    # -- HTTP scripting ------------------------------------------------------------

    def script_upload(self, *responses: HttpResponse) -> None:
        """Queue per-request upload behaviour. An exhausted queue answers 201 with a descriptor."""
        self._upload_script.extend(list(responses))

    def script_receipt(self, delivery_id: str, *responses: HttpResponse) -> None:
        """Queue receipt answers for one delivery. The last one repeats once exhausted."""
        self._receipt_scripts.setdefault(
            delivery_id, _ScriptQueue(default=receipt_missing(), sticky=True),
        ).extend(list(responses))

    # -- HTTP handlers -------------------------------------------------------------

    def _handle_upload(self, handler: _MediaHandler, media_id: str) -> None:
        with self._in_flight_upload():
            self._upload(handler, media_id)

    @contextmanager
    def _in_flight_upload(self):
        """Count concurrent uploads, so a bounded producer can be proven bounded."""
        with self._lock:
            self._upload_in_flight += 1
            self._peak_upload_concurrency = max(
                self._peak_upload_concurrency, self._upload_in_flight,
            )
        try:
            yield
        finally:
            with self._lock:
                self._upload_in_flight -= 1

    def _upload(self, handler: _MediaHandler, media_id: str) -> None:
        response = self._upload_script.take()
        content_type = (handler.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        record = UploadRecord(
            media_id=media_id, content_type=content_type, size_bytes=handler.declared_length(),
            sha256=handler.headers.get("X-Attach-Sha256"),
            filename=handler.headers.get("X-Attach-Filename"),
            body_read=False, outcome="",
        )
        behaviour = "respond" if response is None else response.behaviour

        if behaviour == "drop_before_body":
            record.outcome = "drop_before_body"
            self._record(self._uploads, record)
            handler.drop()
            return

        data = handler.read_body()
        record.body_read, record.size_bytes = True, len(data)
        if response is not None and response.delay_s > 0:
            time.sleep(response.delay_s)
        if behaviour == "drop_after_body":
            record.outcome = "drop_after_body"
            self._record(self._uploads, record)
            handler.drop()
            return

        status = 201 if response is None else response.status
        if behaviour == "descriptor" or response is None:
            mime = content_type or "application/octet-stream"
            body: Optional[Dict[str, Any]] = {"media": {
                "mediaId": media_id, "mimeType": mime, "byteCount": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "filename": record.filename or "attachment", "family": _family_for(mime),
            }}
        else:
            body = response.body
        record.outcome = "ok" if status < 400 else str(status)
        self._record(self._uploads, record)
        handler.send_json(status, body, {} if response is None else dict(response.headers))

    def _handle_delete(self, handler: _MediaHandler, media_id: str) -> None:
        """Atomic producer rollback. An absent id is success, so a retry stays convergent."""
        self._record(self._deletes, media_id)
        handler.send_json(204, None)

    def _handle_receipt(self, handler: _MediaHandler, delivery_id: str) -> None:
        queue = self._receipt_scripts.setdefault(
            delivery_id, _ScriptQueue(default=receipt_missing(), sticky=True),
        )
        response = queue.take()
        body = dict(response.body) if response is not None and response.body else None
        if body is not None and "deliveryId" in body:
            # Scripted bodies are written without knowing the id under test.
            body["deliveryId"] = delivery_id
        self._record(self._receipt_requests, delivery_id)
        if response is not None and response.delay_s > 0:
            time.sleep(response.delay_s)
        handler.send_json(404 if response is None else response.status, body)

    def _record(self, sink: List[Any], value: Any) -> None:
        with self._lock:
            sink.append(value)

    # -- assertion surface ---------------------------------------------------------

    @property
    def uploads(self) -> List[UploadRecord]:
        with self._lock:
            return list(self._uploads)

    @property
    def peak_upload_concurrency(self) -> int:
        """The most uploads this gateway ever had open at once."""
        with self._lock:
            return self._peak_upload_concurrency

    @property
    def upload_media_ids(self) -> List[str]:
        return [record.media_id for record in self.uploads]

    @property
    def upload_sizes(self) -> List[int]:
        return [record.size_bytes for record in self.uploads]

    @property
    def upload_content_types(self) -> List[str]:
        return [record.content_type for record in self.uploads]

    @property
    def deleted_media_ids(self) -> List[str]:
        """Rollback DELETEs the fake saw, in order."""
        with self._lock:
            return list(self._deletes)

    @property
    def receipt_requests(self) -> List[str]:
        with self._lock:
            return list(self._receipt_requests)

    @property
    def frames(self) -> List[Dict[str, Any]]:
        """Every inbound websocket frame, in arrival order."""
        with self._lock:
            return list(self._frames)

    def frames_of_kind(self, kind: str) -> List[Dict[str, Any]]:
        return [frame for frame in self.frames if frame.get("kind") == kind]

    @property
    def hellos(self) -> List[Dict[str, Any]]:
        return self.frames_of_kind("hello")

    @property
    def command_acks(self) -> List[Dict[str, Any]]:
        return [frame for frame in self.frames_of_kind("ack") if frame.get("channel") == "command"]

    @property
    def events(self) -> List[Dict[str, Any]]:
        """The inner event payloads of every event frame, in arrival order."""
        return [
            frame["event"] for frame in self.frames_of_kind("event")
            if isinstance(frame.get("event"), dict)
        ]

    @property
    def event_kinds(self) -> List[str]:
        return [str(event.get("kind")) for event in self.events]

    def events_of_kind(self, kind: str) -> List[Dict[str, Any]]:
        return [event for event in self.events if event.get("kind") == kind]

    @property
    def media_event_ids(self) -> List[str]:
        return [
            str(event["media"].get("mediaId")) for event in self.events_of_kind("media")
            if isinstance(event.get("media"), dict)
        ]

    @property
    def consumed_upload_script(self) -> List[str]:
        return list(self._upload_script.consumed)

    @property
    def pending_upload_script(self) -> int:
        return self._upload_script.pending

    def consumed_receipt_script(self, delivery_id: str) -> List[str]:
        queue = self._receipt_scripts.get(delivery_id)
        return [] if queue is None else list(queue.consumed)

    # -- waiters -------------------------------------------------------------------

    async def wait_for(
        self,
        predicate: Callable[[], Any],
        *,
        timeout: float = DEFAULT_WAIT_SECONDS,
        what: str = "condition",
    ) -> None:
        """Poll until ``predicate`` is truthy. Loopback only, so a timeout is a real failure."""
        deadline = time.monotonic() + timeout
        while not predicate():
            if time.monotonic() >= deadline:
                raise AssertionError(f"fake gateway timed out waiting for {what}")
            await asyncio.sleep(0.005)

    async def wait_for_uploads(self, count: int = 1, **kwargs: Any) -> None:
        await self.wait_for(
            lambda: len(self.uploads) >= count, what=f"{count} upload(s)", **kwargs,
        )

    async def wait_for_event_kind(self, kind: str, count: int = 1, **kwargs: Any) -> None:
        await self.wait_for(
            lambda: len(self.events_of_kind(kind)) >= count, what=f"{count} {kind} event(s)", **kwargs,
        )

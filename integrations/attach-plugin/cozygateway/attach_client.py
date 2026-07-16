"""Outbound ``/attach`` WebSocket client for the gateway attach protocol.

This is the transport half of the adapter and holds NO harness imports, so it can
be exercised in isolation with only ``websockets`` installed.

What it speaks:

* It dials OUT to ``<gateway origin>/attach`` (http/https swapped to ws/wss) and
  authenticates header-only with ``Authorization: Bearer <token>``. The token is
  never placed in the URL, so it can never ride a log or referrer.
* The gateway pushes ``turn`` frames down the socket; the client parses each one
  and hands a :class:`TurnFrame` to the ``on_turn`` callback. Malformed or
  unknown inbound frames are dropped (defense in depth).
* The client sends ``{"threadId": str, "update": SessionUpdate}`` frames where
  ``update`` is one of ``draft`` | ``done`` | ``failed``. Each ``draft`` carries
  the COMPLETE current view of the turn (full replace); the gateway keeps the
  latest and seals it on ``done``.

Two fatal close conditions are surfaced as distinct exceptions:

* :class:`AttachAuthError` -- the dial was rejected (HTTP 401), or the socket
  closed with code 1008 (policy: bad or revoked token). Either way the
  credential is bad; there is no point retrying.
* :class:`AttachSupersededError` -- the socket closed with code 4000, meaning a
  newer connection now owns this agent. Retrying would fight that owner, so the
  adapter stops reconnecting.

Every other close is a benign disconnect (gateway restart, network blip) that the
adapter re-dials with backoff.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)

# The gateway closes the socket with this code when a newer connection supersedes
# this one; the adapter treats it as terminal.
SUPERSEDED_CLOSE_CODE = 4000

# The gateway closes the socket with this code when the bearer token is bad or
# revoked; fatal, no redial with the same credentials.
POLICY_CLOSE_CODE = 1008


class AttachAuthError(RuntimeError):
    """Raised when the gateway rejects the dial (HTTP 401 or a policy refusal).

    The bearer token is invalid or revoked; the adapter must not retry.
    """


class AttachSupersededError(RuntimeError):
    """Raised when the socket closes with code 4000 (superseded by a newer connection).

    Another instance now owns this agent; the adapter must stop reconnecting.
    """


# ---------------------------------------------------------------------------
# Rich block union (the closed set the gateway renders). The adapter never emits
# the 7th "attachment" type, so it is deliberately absent here.
# ---------------------------------------------------------------------------


@dataclass
class ParagraphBlock:
    """A ``paragraph`` block: a run of plain text."""

    text: str

    def to_wire(self) -> Dict[str, Any]:
        return {"type": "paragraph", "text": self.text}


@dataclass
class CodeBlock:
    """A fenced ``code`` block. ``language`` is omitted from the wire when absent."""

    code: str
    language: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]:
        block: Dict[str, Any] = {"type": "code", "code": self.code}
        if self.language:
            block["language"] = self.language
        return block


@dataclass
class HeadingBlock:
    """A ``heading`` block. ``level`` is always 1, 2, or 3 (deeper input is clamped)."""

    level: int
    text: str

    def to_wire(self) -> Dict[str, Any]:
        return {"type": "heading", "level": self.level, "text": self.text}


@dataclass
class ListItemBlock:
    """One ``list`` item. ``checked`` present means a task item; absent means a plain
    bullet, in which case it MUST be omitted from the wire rather than serialized as
    JSON ``null`` (the renderer requires a boolean or no key at all)."""

    text: str
    checked: Optional[bool] = None

    def to_wire(self) -> Dict[str, Any]:
        item: Dict[str, Any] = {"text": self.text}
        if self.checked is not None:
            item["checked"] = self.checked
        return item


@dataclass
class ListBlock:
    """A ``list`` block: bullet or ordered, with optional task items. ``ordered`` is
    always emitted (true or false) so the renderer can pick the list style."""

    items: List[ListItemBlock]
    ordered: bool = False

    def to_wire(self) -> Dict[str, Any]:
        return {
            "type": "list",
            "items": [item.to_wire() for item in self.items],
            "ordered": self.ordered,
        }


@dataclass
class TableBlock:
    """A ``table`` block: a header row plus body rows of plain-text cells."""

    header: List[str]
    rows: List[List[str]]

    def to_wire(self) -> Dict[str, Any]:
        return {
            "type": "table",
            "header": list(self.header),
            "rows": [list(row) for row in self.rows],
        }


@dataclass
class MathBlock:
    """A ``math`` block: a display-math LaTeX expression."""

    latex: str

    def to_wire(self) -> Dict[str, Any]:
        return {"type": "math", "latex": self.latex}


# Any of the block dataclasses above (each carries ``to_wire()``).
RichBlock = Any


@dataclass
class ToolChip:
    """A single tool-call chip on a draft: an id, a name, a status, and an optional
    short detail preview. ``detail`` is omitted from the wire when absent."""

    id: str
    name: str
    status: str  # "running" | "ok" | "error"
    detail: Optional[str] = None

    def to_wire(self) -> Dict[str, Any]:
        wire: Dict[str, Any] = {"id": self.id, "name": self.name, "status": self.status}
        if self.detail is not None:
            wire["detail"] = self.detail
        return wire


@dataclass
class TurnFrame:
    """A parsed inbound ``turn`` frame: start one agent turn.

    ``thread_id`` is the stable conversation key (used as the harness chat id so a
    thread resumes the same session). ``turn_id`` correlates every frame the
    adapter sends back for this turn.
    """

    thread_id: str
    turn_id: str
    text: str


def parse_turn_frame(frame: Any) -> Optional[TurnFrame]:
    """Parse a decoded inbound frame into a :class:`TurnFrame`, or return None to drop it.

    Accepts only a well-formed ``turn`` frame: a dict with ``kind == "turn"`` and
    string ``threadId`` / ``turnId`` / ``text``. Anything else is dropped.
    """
    if not isinstance(frame, dict) or frame.get("kind") != "turn":
        return None
    thread_id = frame.get("threadId")
    turn_id = frame.get("turnId")
    text = frame.get("text")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    if not isinstance(turn_id, str) or not turn_id:
        return None
    if not isinstance(text, str):
        return None
    return TurnFrame(thread_id=thread_id, turn_id=turn_id, text=text)


@dataclass
class SteerFrame:
    """A parsed inbound ``steer`` frame: inject text into the running turn ``turn_id`` on
    ``thread_id``. Carries the SAME ``turn_id`` as the in-flight turn."""

    thread_id: str
    turn_id: str
    text: str


@dataclass
class InterruptFrame:
    """A parsed inbound ``interrupt`` frame: hard-stop the running turn ``turn_id`` on
    ``thread_id``."""

    thread_id: str
    turn_id: str


def parse_steer_frame(frame: Any) -> Optional[SteerFrame]:
    """Parse a decoded inbound frame into a :class:`SteerFrame`, or None to drop it."""
    if not isinstance(frame, dict) or frame.get("kind") != "steer":
        return None
    thread_id = frame.get("threadId")
    turn_id = frame.get("turnId")
    text = frame.get("text")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    if not isinstance(turn_id, str) or not turn_id:
        return None
    if not isinstance(text, str):
        return None
    return SteerFrame(thread_id=thread_id, turn_id=turn_id, text=text)


def parse_interrupt_frame(frame: Any) -> Optional[InterruptFrame]:
    """Parse a decoded inbound frame into an :class:`InterruptFrame`, or None to drop it."""
    if not isinstance(frame, dict) or frame.get("kind") != "interrupt":
        return None
    thread_id = frame.get("threadId")
    turn_id = frame.get("turnId")
    if not isinstance(thread_id, str) or not thread_id:
        return None
    if not isinstance(turn_id, str) or not turn_id:
        return None
    return InterruptFrame(thread_id=thread_id, turn_id=turn_id)


@dataclass
class AttachClientConfig:
    """Connection inputs for :class:`AttachClient`.

    ``gateway_url`` is the gateway's HTTP(S) base; the ``/attach`` WS path hangs off
    its origin. ``token`` is presented header-only. ``on_turn`` receives each parsed
    inbound :class:`TurnFrame`. ``on_steer`` and ``on_interrupt`` receive their parsed
    frame kinds. ``connect_factory`` is a test seam.
    """

    gateway_url: str
    token: str
    path: str = "/attach"
    ca_file: Optional[str] = None
    on_turn: Optional[Callable[[TurnFrame], None]] = None
    on_steer: Optional[Callable[[SteerFrame], None]] = None
    on_interrupt: Optional[Callable[[InterruptFrame], None]] = None
    # Test seam: an async factory (ws_url, headers, ssl_ctx) -> connection.
    connect_factory: Optional[Callable[..., Any]] = None


def derive_attach_ws_url(gateway_url: str, path: str = "/attach") -> str:
    """Derive ``ws(s)://host/<path>`` from the gateway's HTTP base.

    Takes the origin (scheme + host) of the configured URL, swaps http to ws (and
    https to wss), and appends the attach path. Any sub-path on the configured URL
    is dropped: the attach endpoint hangs off the origin.
    """
    from urllib.parse import urlparse

    parsed = urlparse(gateway_url)
    scheme = "wss" if parsed.scheme in ("https", "wss") else "ws"
    netloc = parsed.netloc or parsed.path  # tolerate a bare "host:port" with no scheme
    clean_path = path if path.startswith("/") else f"/{path}"
    return f"{scheme}://{netloc}{clean_path}"


class AttachClient:
    """An outbound, single-socket client to the gateway ``/attach`` WS.

    Lifecycle: ``await connect()`` then ``watch()`` (drains inbound turns until the
    socket closes) with ``send_draft`` / ``send_done`` / ``send_failed`` called
    concurrently, then ``await close()``. The raw send is serialized behind a lock
    because two coroutines may emit frames on the one socket at once.
    """

    def __init__(self, config: AttachClientConfig) -> None:
        self._config = config
        self._ws: Any = None
        self._ws_url = derive_attach_ws_url(config.gateway_url, config.path)
        self._closed = False
        # websockets forbids concurrent send() on one connection, and both the
        # streaming path and the tool-chip tap can send at once; serialize them.
        self._send_lock = asyncio.Lock()

    async def connect(self) -> None:
        """Dial OUT to the gateway ``/attach`` WS, header-only auth.

        Raises :class:`AttachAuthError` if the handshake is rejected with HTTP 401.
        Any other dial failure is raised as-is (a benign transient the adapter
        backs off on).
        """
        headers = {"Authorization": f"Bearer {self._config.token}"}
        ssl_ctx = self._build_ssl_context()
        factory = self._config.connect_factory or _default_connect
        try:
            self._ws = await factory(self._ws_url, headers, ssl_ctx)
        except AttachAuthError:
            raise
        except Exception as exc:  # noqa: BLE001 - classify a 401 as fatal auth
            if _http_status(exc) == 401:
                raise AttachAuthError("attach rejected (HTTP 401)") from exc
            raise
        self._closed = False

    def _build_ssl_context(self) -> Any:
        if self._config.ca_file and self._ws_url.startswith("wss://"):
            import ssl

            ctx = ssl.create_default_context()
            ctx.load_verify_locations(self._config.ca_file)
            return ctx
        return None

    async def _send_update(self, thread_id: str, update: Dict[str, Any]) -> None:
        if self._ws is None or self._closed:
            raise RuntimeError("attach client is not connected")
        frame = {"threadId": thread_id, "update": update}
        async with self._send_lock:
            await self._ws.send(json.dumps(frame))

    async def send_draft(
        self,
        thread_id: str,
        turn_id: str,
        blocks: List[RichBlock],
        tool_calls: Optional[List[ToolChip]] = None,
    ) -> None:
        """Emit one full-replace ``draft`` for the turn: the complete blocks so far
        plus the complete tool-call list so far. ``toolCalls`` is omitted when empty."""
        update: Dict[str, Any] = {
            "kind": "draft",
            "turnId": turn_id,
            "blocks": [block.to_wire() for block in blocks],
        }
        if tool_calls:
            update["toolCalls"] = [chip.to_wire() for chip in tool_calls]
        await self._send_update(thread_id, update)

    async def send_done(self, thread_id: str, turn_id: str) -> None:
        """End a successful turn. The gateway seals the latest draft as the reply."""
        await self._send_update(thread_id, {"kind": "done", "turnId": turn_id})

    async def send_failed(self, thread_id: str, turn_id: str, message: str) -> None:
        """Report that the turn errored or produced no visible content."""
        await self._send_update(
            thread_id, {"kind": "failed", "turnId": turn_id, "message": message}
        )

    async def watch(self) -> None:
        """Drain inbound frames until the socket closes.

        Each decoded frame is dispatched to ``on_turn`` (dropped if malformed or not
        a turn). Returns normally on a benign close. Raises
        :class:`AttachSupersededError` if the socket closed with code 4000, or
        :class:`AttachAuthError` if the socket closed with code 1008 (policy: bad
        or revoked token).
        """
        if self._ws is None:
            return
        try:
            async for raw in self._ws:
                self._dispatch_inbound(raw)
        except Exception as exc:  # noqa: BLE001 - classify the close code
            code = _close_code(exc)
            if code == SUPERSEDED_CLOSE_CODE:
                self._closed = True
                raise AttachSupersededError("connection superseded by a newer attach") from exc
            if code == POLICY_CLOSE_CODE:
                self._closed = True
                raise AttachAuthError("attach rejected (policy close 1008)") from exc
        finally:
            self._closed = True
        close_code = getattr(self._ws, "close_code", None)
        if close_code == SUPERSEDED_CLOSE_CODE:
            raise AttachSupersededError("connection superseded by a newer attach")
        if close_code == POLICY_CLOSE_CODE:
            raise AttachAuthError("attach rejected (policy close 1008)")

    @staticmethod
    def _safe_call(handler: Callable[[Any], None], arg: Any) -> None:
        try:
            handler(arg)
        except Exception:  # noqa: BLE001 - a handler error must never kill the drain loop
            logger.debug("attach: inbound handler raised", exc_info=True)

    def _dispatch_inbound(self, raw: Any) -> None:
        try:
            frame = json.loads(raw)
        except Exception:  # noqa: BLE001 - malformed inbound frame, drop
            logger.debug("attach: dropping non-JSON inbound frame")
            return
        kind = frame.get("kind") if isinstance(frame, dict) else None
        if kind == "turn":
            turn = parse_turn_frame(frame)
            if turn is not None and self._config.on_turn is not None:
                self._safe_call(self._config.on_turn, turn)
            return
        if kind == "steer":
            steer = parse_steer_frame(frame)
            if steer is not None and self._config.on_steer is not None:
                self._safe_call(self._config.on_steer, steer)
            return
        if kind == "interrupt":
            interrupt = parse_interrupt_frame(frame)
            if interrupt is not None and self._config.on_interrupt is not None:
                self._safe_call(self._config.on_interrupt, interrupt)
            return
        logger.debug("attach: dropping unknown/malformed inbound frame")

    async def close(self) -> None:
        self._closed = True
        ws = self._ws
        self._ws = None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001 - already closing
                pass


def _http_status(exc: Exception) -> Optional[int]:
    """Extract an HTTP status code from a websockets handshake-rejection exception.

    Reads ``exc.response.status_code`` (modern websockets) or ``exc.status_code``
    (older). Returns None for non-handshake errors.
    """
    response = getattr(exc, "response", None)
    if response is not None:
        code = getattr(response, "status_code", None)
        if isinstance(code, int):
            return code
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _close_code(exc: Exception) -> Optional[int]:
    """Extract a WS close code from a websockets ConnectionClosed exception.

    Reads the received close frame (``rcvd.code``) or the sent one (``sent.code``).
    Falls back to None for non-WS errors.
    """
    rcvd = getattr(exc, "rcvd", None)
    if rcvd is not None and getattr(rcvd, "code", None) is not None:
        return rcvd.code
    sent = getattr(exc, "sent", None)
    if sent is not None and getattr(sent, "code", None) is not None:
        return sent.code
    return None


async def _default_connect(
    ws_url: str, headers: Dict[str, str], ssl_ctx: Any
) -> Any:
    """Default outbound dialer using the modern websockets asyncio client."""
    from websockets.asyncio.client import connect

    kwargs: Dict[str, Any] = {"additional_headers": headers}
    if ssl_ctx is not None:
        kwargs["ssl"] = ssl_ctx
    return await connect(ws_url, **kwargs)

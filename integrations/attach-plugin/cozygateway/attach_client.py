"""Shared attach-v1 wire values and transport helpers.

The executable client lives in :mod:`attach_client_v1`. This module contains only
the rich-block values, command parsers, close classifications, URL derivation and
WebSocket dial helper it uses; there is no legacy transport implementation.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional

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


def derive_attach_ws_url(gateway_url: str, path: str = "/attach/v1") -> str:
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

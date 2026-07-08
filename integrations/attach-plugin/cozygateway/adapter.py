"""Platform adapter for the gateway attach protocol.

This is the only module that imports the harness tree, and it does so LAZILY inside
methods so the package stays importable (e.g. to call :func:`register`) without the
harness on the path. The wire logic lives in the harness-free siblings:
:mod:`.attach_client` (transport), :mod:`.text_blocks` (markdown to blocks), and
:mod:`.tool_chips` (the tool-chip tracker).

How the harness's native stream maps onto the attach protocol:

* The adapter dials OUT to the gateway ``/attach`` WS and authenticates header-only
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
import logging
import math
import os
import random
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Set, Tuple

from .attach_client import (
    AttachAuthError,
    AttachClient,
    AttachClientConfig,
    AttachSupersededError,
    TurnFrame,
)
from .text_blocks import IncrementalNormalizer
from .tool_chips import ToolChipTracker

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


class AttachAdapter:
    """The platform methods, mixed into a concrete adapter subclass by the factory.

    Kept as a plain class so the wire logic is readable and testable in isolation;
    :func:`_make_adapter_class` produces the concrete subclass the plugin registers.
    """

    # The stream consumer splits a reply that exceeds this into multiple sends, and
    # each send commits once. This platform renders any length, so the cap is raised
    # far above any reply to keep a turn a single commit.
    MAX_MESSAGE_LENGTH = 1_000_000

    # -- construction ---------------------------------------------------------
    def _attach_init(self, config: Any) -> None:
        extra = getattr(config, "extra", {}) or {}
        self.gateway_url: str = (
            os.getenv("COZYGATEWAY_URL") or extra.get("gateway_url", "")
        ).rstrip("/")
        # The attach bearer token. Header-only; never logged, never in a URL.
        self.token: str = os.getenv("COZYGATEWAY_TOKEN") or extra.get("token", "")
        self.ca_file: Optional[str] = (
            os.getenv("COZYGATEWAY_CA_FILE") or extra.get("ca_file") or None
        )
        self._client: Optional[AttachClient] = None
        self._watcher: Optional[asyncio.Task] = None
        self._closing: bool = False
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
        # Strong refs to fire-and-forget tasks; the loop keeps only a weak ref to a
        # bare create_task result, so hold each here until it finishes.
        self._background_tasks: Set[asyncio.Task] = set()

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
        self._client = AttachClient(
            AttachClientConfig(
                gateway_url=self.gateway_url,
                token=self.token,
                ca_file=self.ca_file,
                on_turn=self._on_turn,
            )
        )
        try:
            await self._client.connect()
        except AttachAuthError as exc:
            logger.error("attach: dial rejected (%s)", exc)
            self._set_fatal_error(  # type: ignore[attr-defined]
                "auth_rejected", str(exc), retryable=False
            )
            return False
        except Exception as exc:  # noqa: BLE001
            logger.error("attach: failed to dial /attach -- %s", exc)
            self._set_fatal_error(  # type: ignore[attr-defined]
                "connect_failed", str(exc), retryable=True
            )
            return False
        if self._watcher is not None and not self._watcher.done():
            self._watcher.cancel()
        self._loop = asyncio.get_running_loop()
        self._watcher = asyncio.create_task(self._watch_loop())
        self._mark_connected()  # type: ignore[attr-defined]
        _register_active_adapter(self)
        logger.info("attach: connected /attach to %s", self.gateway_url)
        return True

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
                logger.warning("attach: token rejected mid-session; stopping")
                await self.disconnect()
                return
            if self._closing:
                return
            self._mark_disconnected()  # type: ignore[attr-defined]
            logger.warning("attach: /attach dropped; reconnecting")
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
            except (AttachAuthError, AttachSupersededError) as exc:
                logger.warning("attach: reconnect refused (%s); stopping", exc)
                await self.disconnect()
                return False
            except Exception as exc:  # noqa: BLE001 - transient: back off and retry
                logger.warning(
                    "attach: reconnect failed (%s); retrying (backoff ~%.1fs)", exc, delay
                )
                delay = min(delay * 2, self._reconnect_max)
                continue
            self._mark_connected()  # type: ignore[attr-defined]
            logger.info("attach: reconnected /attach to %s", self.gateway_url)
            return True
        return False

    async def disconnect(self) -> None:
        self._closing = True
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
        from gateway.platforms.base import MessageEvent  # harness-defined identifier

        self._active_turn[turn.thread_id] = turn.turn_id
        # build_source stamps this adapter's platform onto the source; chat_id is
        # the thread key, message_id is the per-turn reply anchor. A non-empty
        # user id plus role_authorized carries the upstream authorization through
        # the harness auth gate.
        source = self.build_source(  # type: ignore[attr-defined]
            chat_id=turn.thread_id,
            chat_type="dm",
            user_name=INBOUND_USER,
            user_id=INBOUND_USER,
            role_authorized=True,
        )
        event = MessageEvent(
            text=turn.text,
            source=source,
            message_id=turn.turn_id,
        )
        try:
            await self.handle_message(event)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - best-effort failed, then clean up
            logger.debug("attach: handle_message raised", exc_info=True)
            await self._safe_failed(turn.thread_id, turn.turn_id, "turn error")
            self._cleanup_turn(turn.thread_id, turn.turn_id)

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

    # -- terminal reply -------------------------------------------------------
    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Any:
        """Deliver the turn's terminal reply: a final full draft, then ``done``.

        The gateway seals the latest draft as the durable reply. An empty reply with
        no prior visible content sends ``failed`` instead. Any exception on the path
        sends a best-effort ``failed``; per-turn state is dropped in ``finally``.
        """
        from gateway.platforms.base import SendResult  # harness-defined identifier

        client = self._client
        turn_id = reply_to or self._active_turn.get(chat_id)
        if client is None:
            return SendResult(success=False, error="attach not connected")
        if not turn_id:
            logger.warning("attach: refusing send for %r -- no in-flight turn", chat_id)
            return SendResult(success=False, error="no in-flight turn")
        try:
            # The authoritative terminal text, or the last streamed buffer when the
            # terminal content is empty or whitespace (a draft-only turn).
            final_text = content if (content and content.strip()) else self._turn_text.get(
                turn_id, ""
            )
            blocks = self._normalize(turn_id, final_text)
            chips = self._chips(turn_id)
            had_content = self._content_seen.get(turn_id, False)
            if blocks or chips:
                # Full replace with the final view, then seal it.
                await client.send_draft(chat_id, turn_id, blocks, tool_calls=chips)
                await client.send_done(chat_id, turn_id)
            elif had_content:
                # Nothing new to draw, but earlier drafts carried content: seal the
                # latest good draft. Do not send an empty draft (it would wipe it).
                await client.send_done(chat_id, turn_id)
            else:
                # No content ever materialized for this turn.
                await client.send_failed(chat_id, turn_id, "empty reply")
                return SendResult(success=True)
        except (AttachAuthError, AttachSupersededError) as exc:
            return SendResult(success=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001 - best-effort failed on the way out
            await self._safe_failed(chat_id, turn_id, "turn error")
            return SendResult(success=False, error=str(exc))
        finally:
            self._cleanup_turn(chat_id, turn_id)
        return SendResult(success=True, message_id=turn_id)

    async def _safe_failed(self, chat_id: str, turn_id: str, message: str) -> None:
        """Emit a ``failed`` frame, swallowing any error (best-effort teardown)."""
        client = self._client
        if client is None:
            return
        try:
            await client.send_failed(chat_id, turn_id, message)
        except Exception:  # noqa: BLE001 - already failing; nothing more to do
            logger.debug("attach: failed frame emit failed", exc_info=True)

    def _cleanup_turn(self, chat_id: str, turn_id: str) -> None:
        """Drop a turn's per-turn state once it commits, fails, or is dropped."""
        self._turn_text.pop(turn_id, None)
        self._tool_chips.pop(turn_id, None)
        self._normalizers.pop(turn_id, None)
        self._content_seen.pop(turn_id, None)
        if self._active_turn.get(chat_id) == turn_id:
            self._active_turn.pop(chat_id, None)

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
    _dispatch_tool_hook("start", kwargs)


def _post_tool_call(**kwargs: Any) -> None:
    """``post_tool_call`` hook: the chip-close leg (carries the outcome)."""
    _dispatch_tool_hook("complete", kwargs)


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
        platform_hint=(
            "You are in a live session. Your reply streams live and is committed to "
            "the conversation. Markdown renders richly: use ## headings, - bullet / "
            "1. numbered / - [ ] task lists, | pipe | tables |, fenced code blocks, "
            "and $$ math. Inline bold and links show as literal text, so prefer the "
            "block forms above."
        ),
    )
    # Register the tool-lifecycle hooks that feed the live tool-chip tap. If the
    # harness build does not support hook registration, degrade gracefully: the
    # platform still streams text, only the chips are absent.
    try:
        ctx.register_hook("pre_tool_call", _pre_tool_call)
        ctx.register_hook("post_tool_call", _post_tool_call)
    except Exception:  # noqa: BLE001 - no chips, never crash
        logger.debug("attach: tool-lifecycle hooks unavailable; chips disabled", exc_info=True)

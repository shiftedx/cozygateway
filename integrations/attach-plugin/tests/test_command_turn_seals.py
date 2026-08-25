"""A turn Hermes consumes as a command always seals, and so does an acked interrupt.

Issue #190, live: ``/compact`` typed in the CozyChat composer opened a durable native turn, the
plugin handed it to Hermes, Hermes dispatched it from the command registry (no agent turn ran,
no draft, no reply), and nothing ever sealed the turn. The app showed "thinking" for 75 minutes
across a container restart, and three interrupts were acked on the wire without producing a
terminal either. These tests pin both seals -- and pin that the ordinary command notice, which
already seals through Hermes' own reply path, keeps sealing that way instead of double-sending.
"""

import asyncio
import sys
import types
import unittest

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _Source:
    def __init__(self, chat_id):
        self.chat_id = chat_id


class _Event:
    """The shape of the harness MessageEvent this adapter reads."""

    def __init__(self, text, chat_id="thread", message_id=None, source=None):
        self.text = text
        self.source = source if source is not None else _Source(chat_id)
        self.message_id = message_id

    def get_command(self):
        text = (self.text or "").lstrip()
        if not text.startswith("/"):
            return None
        name = text.split(maxsplit=1)[0][1:].lower()
        return name or None


class _EphemeralReply:
    def __init__(self, text):
        self.text = text


class _CommandDef:
    def __init__(self, name):
        self.name = name


class _EventClient(AttachV1Client):
    """Records the durable events the real client would spool."""

    def __init__(self):
        self.events = []
        self._latest_blocks = {}
        self._latest_tools = {}

    async def _queue_event(self, event):
        self.events.append(event)
        return {"eventId": f"event-{len(self.events)}"}

    def kinds(self):
        return [event["kind"] for event in self.events]


class _SealHarness(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved = {
            key: sys.modules.get(key)
            for key in (
                "gateway",
                "gateway.platforms",
                "gateway.platforms.base",
                "hermes_cli",
                "hermes_cli.commands",
            )
        }
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.SendResult = _SendResult
        base.MessageEvent = _Event
        gateway.platforms = platforms
        platforms.base = base
        sys.modules["gateway"] = gateway
        sys.modules["gateway.platforms"] = platforms
        sys.modules["gateway.platforms.base"] = base

        # The registry the adapter reads its command truth from.
        hermes_cli = types.ModuleType("hermes_cli")
        commands = types.ModuleType("hermes_cli.commands")
        known = {"compress", "compact", "start", "stop", "new"}
        commands.resolve_command = lambda name: (
            _CommandDef("compress") if name in {"compress", "compact"}
            else (_CommandDef(name) if name in known else None)
        )
        commands.is_gateway_known_command = lambda name: name in known
        hermes_cli.commands = commands
        sys.modules["hermes_cli"] = hermes_cli
        sys.modules["hermes_cli.commands"] = commands

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    def _adapter(self, handler):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        client = _EventClient()
        adapter._client = client
        adapter._active_turn["thread"] = "turn"
        adapter._interrupt_seal_grace = 0.0
        adapter._interrupt_sleep = lambda _seconds: asyncio.sleep(0)
        adapter.extract_media = lambda text: ([], text)
        adapter.filter_media_delivery_paths = lambda media: []
        adapter.build_source = lambda **kwargs: _Source(kwargs.get("chat_id", "thread"))
        adapter.set_message_handler(handler)
        adapter.handle_message = lambda event: adapter._message_handler(event)
        return adapter, client

    async def _dispatch(self, handler, text="/compact"):
        adapter, client = self._adapter(handler)
        event = _Event(text, message_id="turn")
        return adapter, client, event


class CommandTurnSealTests(_SealHarness):
    async def test_a_command_that_says_nothing_still_seals_its_turn(self):
        async def handler(_event):
            return ""

        adapter, client, event = await self._dispatch(handler)

        await adapter._message_handler(event)

        self.assertEqual(client.kinds(), ["cancelled"])
        self.assertEqual(client.events[0]["turnId"], "turn")
        self.assertEqual(adapter._active_turn, {})

    async def test_a_command_handler_returning_none_seals_its_turn(self):
        async def handler(_event):
            return None

        adapter, client, event = await self._dispatch(handler)

        await adapter._message_handler(event)

        self.assertEqual(client.kinds(), ["cancelled"])

    async def test_a_raising_command_handler_seals_the_turn_failed(self):
        async def handler(_event):
            raise RuntimeError("compress provider unreachable")

        adapter, client, event = await self._dispatch(handler)

        with self.assertRaises(RuntimeError):
            await adapter._message_handler(event)

        self.assertEqual(client.kinds(), ["failed"])
        self.assertIn("/compress", client.events[0]["message"])
        self.assertEqual(adapter._active_turn, {})

    async def test_a_command_notice_is_left_to_hermes_own_reply_path(self):
        # The path Kyle's screenshots show working: Hermes returns the notice, delivers it
        # through ``send`` with the turn's anchor and its notify marker, and THAT commit seals.
        async def handler(_event):
            return "Compressed 42 messages."

        adapter, client, event = await self._dispatch(handler)

        response = await adapter._message_handler(event)

        self.assertEqual(response, "Compressed 42 messages.")
        self.assertEqual(client.kinds(), [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

        await adapter.send("thread", response, reply_to="turn", metadata={"notify": True})
        self.assertEqual(client.kinds(), ["draft", "commit"])
        self.assertEqual(adapter._active_turn, {})

    async def test_an_ephemeral_notice_is_also_left_to_hermes(self):
        async def handler(_event):
            return _EphemeralReply("New session started.")

        adapter, client, event = await self._dispatch(handler)

        await adapter._message_handler(event)

        self.assertEqual(client.kinds(), [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

    async def test_an_ordinary_agent_turn_is_never_sealed_early(self):
        async def handler(_event):
            return ""  # already streamed; the terminal send owns this turn

        adapter, client, event = await self._dispatch(handler, text="audit every sensor")

        await adapter._message_handler(event)

        self.assertEqual(client.kinds(), [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

    async def test_an_unknown_slash_word_is_text_not_a_command(self):
        async def handler(_event):
            return ""

        adapter, client, event = await self._dispatch(handler, text="/notacommand please")

        await adapter._message_handler(event)

        self.assertEqual(client.kinds(), [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})

    async def test_a_steer_injection_never_seals_the_turn_it_rides(self):
        async def handler(_event):
            return ""

        adapter, client = self._adapter(handler)

        await adapter._message_handler(_Event("/compact", message_id="turn:steer"))

        self.assertEqual(client.kinds(), [])
        self.assertEqual(adapter._active_turn, {"thread": "turn"})


class InterruptSealTests(_SealHarness):
    async def test_an_acked_interrupt_with_no_live_work_emits_the_terminal(self):
        async def handler(_event):
            return None  # /stop on an idle session: a clean no-op, nothing sealed

        adapter, client = self._adapter(handler)
        from cozygateway.attach_client import InterruptFrame

        await adapter._handle_interrupt(InterruptFrame(thread_id="thread", turn_id="turn"))

        self.assertIn("interrupted", client.kinds())
        self.assertEqual(client.events[-1]["turnId"], "turn")
        self.assertEqual(adapter._active_turn, {})

    async def test_an_interrupt_leaves_a_turn_hermes_already_sealed_alone(self):
        async def handler(_event):
            return None

        adapter, client = self._adapter(handler)
        from cozygateway.attach_client import InterruptFrame

        # Hermes' own stop notice sealed the turn during the grace window.
        async def _sealed(_seconds):
            await adapter.send("thread", "Stopped.", reply_to="turn", metadata={"notify": True})

        adapter._interrupt_seal_grace = 0.01
        adapter._interrupt_sleep = _sealed

        await adapter._handle_interrupt(InterruptFrame(thread_id="thread", turn_id="turn"))

        self.assertEqual(client.kinds(), ["draft", "commit"])

    async def test_an_interrupt_seals_even_when_the_stop_inject_raises(self):
        async def handler(_event):
            raise RuntimeError("session gone")

        adapter, client = self._adapter(handler)
        from cozygateway.attach_client import InterruptFrame

        await adapter._handle_interrupt(InterruptFrame(thread_id="thread", turn_id="turn"))

        self.assertIn("interrupted", client.kinds())


if __name__ == "__main__":
    unittest.main()

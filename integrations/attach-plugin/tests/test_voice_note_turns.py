"""A phone voice note (``com.cozylabs.chat-audio`` 1) on its way into Hermes and back.

The gateway relays a voice note as attach media and serves it as ``audio/*`` under a name that
carries the canonical extension. The plugin hands both to Hermes, which classifies the file and
transcribes it with its own STT. Hermes then echoes each transcript to the chat as ``🎙️ "…"``
through the ordinary ``send`` surface, with no reply anchor and no ``notify`` mark, which this
adapter would otherwise commit as an extra bot message the phone never asked for.

Run with:
    cd integrations/attach-plugin && python3 -m unittest tests.test_voice_note_turns -v
"""

import importlib.util
import os
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest
from pathlib import Path

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import TurnFrame
from cozygateway.attach_client_v1 import AttachV1Client

try:
    HERMES_AVAILABLE = importlib.util.find_spec("hermes_cli.config") is not None
except ModuleNotFoundError:
    HERMES_AVAILABLE = False
PLUGIN_ROOT = Path(__file__).resolve().parents[1]
M4A = b"\x00\x00\x00\x14ftypM4A \x00\x00\x00\x00"
ECHO = '\U0001F399️ "turn the hall lights off"'


class _SendResult:
    def __init__(self, success, message_id=None, error=None):
        self.success = success
        self.message_id = message_id
        self.error = error


class _MessageEvent:
    def __init__(self, text, source, message_id=None, media_urls=None, media_types=None, metadata=None):
        self.text = text
        self.source = source
        self.message_id = message_id
        self.media_urls = media_urls or []
        self.media_types = media_types or []
        self.metadata = metadata or {}


class _Client(AttachV1Client):
    """Serves one inbound attachment and records the durable events the real client would spool."""

    def __init__(self, media):
        self.media = media
        self.events = []
        self._latest_blocks = {}
        self._latest_tools = {}

    async def download_media(self, media_id):
        return self.media

    async def _queue_event(self, event):
        self.events.append(event)
        return {"eventId": f"event-{len(self.events)}"}

    def commits(self):
        return [event for event in self.events if event["kind"] == "commit"]


class TranscriptEchoTests(unittest.IsolatedAsyncioTestCase):
    _MODULE_KEYS = ("gateway", "gateway.platforms", "gateway.platforms.base")

    def setUp(self):
        self._saved = {key: sys.modules.get(key) for key in self._MODULE_KEYS}
        gateway = types.ModuleType("gateway")
        platforms = types.ModuleType("gateway.platforms")
        base = types.ModuleType("gateway.platforms.base")
        base.SendResult = _SendResult
        base.MessageEvent = _MessageEvent
        base.cache_media_bytes = lambda data, *, filename, mime_type: types.SimpleNamespace(
            path=f"/cache/{filename}", media_type=mime_type)
        gateway.platforms = platforms
        platforms.base = base
        for key, module in zip(self._MODULE_KEYS, (gateway, platforms, base)):
            sys.modules[key] = module

    def tearDown(self):
        for key, value in self._saved.items():
            if value is None:
                sys.modules.pop(key, None)
            else:
                sys.modules[key] = value

    async def _turn(self, media):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra={}))
        adapter._profile = "profile-1"
        adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)

        async def handle_message(event):
            adapter.injected = event

        adapter.handle_message = handle_message
        client = _Client(media)
        adapter._client = client
        await adapter._handle_turn(TurnFrame(thread_id="chat-1", turn_id="turn-1", text="listen", media_ids=["m1"]))
        return adapter, client

    async def test_the_echo_of_a_voice_note_transcript_is_not_a_bot_message(self):
        adapter, client = await self._turn((M4A, "voice.m4a", "audio/mp4"))

        echoed = await adapter.send("chat-1", ECHO)
        final = await adapter.send("chat-1", "Done.", reply_to="turn-1", metadata={"notify": True})

        self.assertTrue(echoed.success)
        self.assertTrue(final.success)
        commits = client.commits()
        self.assertEqual(len(commits), 1, commits)
        self.assertEqual(commits[0]["blocks"], [{"type": "paragraph", "text": "Done."}])

    async def test_only_as_many_echoes_as_voice_notes_are_dropped(self):
        adapter, client = await self._turn((M4A, "voice.m4a", "audio/mp4"))

        await adapter.send("chat-1", ECHO)
        await adapter.send("chat-1", ECHO)

        self.assertEqual(len(client.commits()), 1)
        self.assertIs(client.commits()[0]["continues"], True)

    async def test_the_same_text_on_a_turn_without_a_voice_note_is_still_a_message(self):
        adapter, client = await self._turn((b"%PDF-1.7\n", "report.pdf", "application/pdf"))

        await adapter.send("chat-1", ECHO)

        self.assertEqual(len(client.commits()), 1)
        self.assertIs(client.commits()[0]["continues"], True)


@unittest.skipUnless(HERMES_AVAILABLE, "requires the pinned Hermes environment")
class PinnedHermesVoiceNoteTests(unittest.TestCase):
    """The real ``cache_media_bytes`` and STT gate, in a throwaway ``HERMES_HOME``."""

    def test_a_voice_note_reaches_hermes_as_audio_it_will_transcribe(self):
        script = textwrap.dedent(
            """
            import asyncio, types
            from cozygateway.adapter import AttachAdapter
            from cozygateway.attach_client import TurnFrame
            from gateway.run import _event_media_is_stt_input

            adapter = AttachAdapter()
            adapter._attach_init(types.SimpleNamespace(extra={}))
            adapter._profile = "profile-1"
            adapter.build_source = lambda **kwargs: types.SimpleNamespace(**kwargs)
            injected = []

            async def handle_message(event):
                injected.append(event)

            adapter.handle_message = handle_message

            class Client:
                async def download_media(self, media_id):
                    return %r, "voice.m4a", "audio/mp4"

            adapter._client = Client()
            asyncio.run(adapter._handle_turn(
                TurnFrame(thread_id="chat-1", turn_id="turn-1", text="listen", media_ids=["m1"])))
            event = injected[0]
            assert event.media_types == ["audio/mp4"], event.media_types
            assert event.media_urls[0].endswith(".m4a"), event.media_urls
            assert _event_media_is_stt_input(event, 0), "Hermes would not transcribe this voice note"
            """
            % (M4A,)
        )
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ)
            env["HERMES_HOME"] = home
            env["PYTHONPATH"] = os.pathsep.join(
                [str(PLUGIN_ROOT), value] if (value := env.get("PYTHONPATH")) else [str(PLUGIN_ROOT)]
            )
            completed = subprocess.run(
                [sys.executable, "-c", script], env=env, text=True, capture_output=True,
                timeout=300, check=False,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)


if __name__ == "__main__":
    unittest.main()

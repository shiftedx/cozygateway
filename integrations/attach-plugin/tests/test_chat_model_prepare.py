import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace, ModuleType
from unittest.mock import patch

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client import TurnFrame
from cozygateway.provider_connections import ProviderConnectionStore


class _Store:
    def __init__(self): self.writes = []
    async def get_or_create_session(self, _source): return SimpleNamespace(session_key="session-key")
    async def set_model_override(self, key, value): self.writes.append((key, value))


class _Runner:
    def __init__(self):
        self.async_session_store = _Store(); self.state = SimpleNamespace(conversation=SimpleNamespace(model_override=None)); self.evicted = []; self.efforts = []
    def _session_state(self, _key): return self.state
    def _evict_cached_agent(self, key): self.evicted.append(key)
    def _set_session_reasoning_override(self, key, value): self.efforts.append((key, value))


class ChatModelPrepareTests(unittest.IsolatedAsyncioTestCase):
    def _adapter(self):
        adapter = object.__new__(AttachAdapter); adapter._profile = "profile"; adapter._active_turn = {}; adapter._client = None
        adapter.gateway_runner = _Runner(); adapter._inbound_source = lambda _thread: object()
        return adapter

    async def test_model_prepare_writes_one_session_override_and_evicts_only_that_agent(self):
        adapter = self._adapter()
        result = await adapter._on_config_request({"operation":"chat.configuration.prepare", "input":{"configuration":{"sessionId":"chat-1","workspace":None,"model":{"providerId":"provider","modelId":"model"}}}})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(adapter.gateway_runner.async_session_store.writes, [("session-key", {"model":"model", "provider":"provider"})])
        self.assertEqual(adapter.gateway_runner.evicted, ["session-key"])

    async def test_model_prepare_writes_supported_effort_on_only_that_session(self):
        adapter = self._adapter()
        constants = ModuleType("hermes_constants")
        constants.parse_reasoning_effort = lambda effort: {"enabled": True, "effort": effort} if effort == "high" else None
        with patch.dict(sys.modules, {"hermes_constants": constants}):
            result = await adapter._on_config_request({"operation":"chat.configuration.prepare", "input":{"configuration":{"sessionId":"chat-1","workspace":None,"model":{"providerId":"provider","modelId":"model","effort":"high"}}}})
        self.assertEqual(result["status"], "ok")
        self.assertEqual(adapter.gateway_runner.efforts, [("session-key", {"enabled": True, "effort": "high"})])

    async def test_model_prepare_rejects_unknown_effort_before_mutating_model(self):
        adapter = self._adapter()
        constants = ModuleType("hermes_constants")
        constants.parse_reasoning_effort = lambda effort: None
        with patch.dict(sys.modules, {"hermes_constants": constants}):
            result = await adapter._on_config_request({"operation":"chat.configuration.prepare", "input":{"configuration":{"sessionId":"chat-1","workspace":None,"model":{"providerId":"provider","modelId":"model","effort":"made-up"}}}})
        self.assertEqual(result["status"], "invalid_request")
        self.assertEqual(adapter.gateway_runner.async_session_store.writes, [])

    async def test_custom_provider_keeps_key_in_runtime_session_not_persisted_store(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"COZYGATEWAY_PROVIDER_CONNECTIONS_PATH": str(Path(directory) / "providers.json")}, clear=False):
            row = ProviderConnectionStore().save({"name":"Local", "baseUrl":"http://localhost:1234/v1", "apiKey":"secret"})["connections"][0]
            adapter = self._adapter()
            result = await adapter._on_config_request({"operation":"chat.configuration.prepare", "input":{"configuration":{"sessionId":"chat-1","workspace":None,"model":{"providerId":row["id"],"modelId":"custom-model"}}}})
            self.assertEqual(result["status"], "ok")
            self.assertEqual(adapter.gateway_runner.async_session_store.writes[0][1], {"model":"custom-model", "provider":row["id"]})
            self.assertEqual(adapter.gateway_runner.state.conversation.model_override["api_key"], "secret")

    async def test_custom_bot_default_is_resolved_into_only_the_dispatch_session(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "COZYGATEWAY_PROVIDER_CONNECTIONS_PATH": str(Path(directory) / "providers.json"),
            "COZYGATEWAY_BOT_MODEL_PATH": str(Path(directory) / "bot-model.json"),
        }, clear=False):
            row = ProviderConnectionStore().save({"name":"Local", "baseUrl":"http://localhost:1234/v1", "apiKey":"secret", "manualModels":["custom-model"]})["connections"][0]
            adapter = self._adapter()
            saved = await adapter._on_config_request({"operation":"model.write", "input":{"model":f'{row["id"]}:custom-model'}})
            self.assertEqual(saved["status"], "ok")
            self.assertEqual(saved["result"]["model"], f'{row["id"]}:custom-model')
            self.assertTrue(await adapter._apply_bot_default_model(TurnFrame("chat-1", "turn-1", "hello"), object()))
            self.assertEqual(adapter.gateway_runner.async_session_store.writes, [("session-key", {"model":"custom-model", "provider":row["id"]})])
            self.assertEqual(adapter.gateway_runner.state.conversation.model_override["api_key"], "secret")
            self.assertEqual(adapter.gateway_runner.evicted, ["session-key"])

    async def test_execution_launch_model_is_installed_on_its_own_session(self):
        adapter = self._adapter(); adapter._execution_session_id = "chat-1"
        with patch.dict(os.environ, {"COZYGATEWAY_EXECUTION_MODEL_JSON": '{"providerId":"provider","modelId":"model"}'}, clear=False):
            self.assertTrue(await adapter._apply_execution_launch_model(object()))
        self.assertEqual(adapter.gateway_runner.async_session_store.writes, [("session-key", {"model":"model", "provider":"provider"})])
        self.assertEqual(adapter.gateway_runner.evicted, ["session-key"])

    async def test_chat_context_model_wins_over_the_bot_default(self):
        adapter = self._adapter()
        adapter._bot_model_defaults = SimpleNamespace(read=lambda: {"model": "custom-deadbeef:ignored", "effort": None})
        self.assertTrue(await adapter._apply_bot_default_model(TurnFrame("chat-1", "turn-1", "hello", chat_context={"model":{"providerId":"provider","modelId":"model"}}), object()))
        self.assertEqual(adapter.gateway_runner.async_session_store.writes, [])

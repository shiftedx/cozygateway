import json
import os
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from cozygateway.adapter import AttachAdapter
from cozygateway.attach_client_v1 import AttachV1Client, AttachV1ClientConfig
from cozygateway.attach_spool import AttachSpool


class FakeSocket:
    def __init__(self):
        self.sent = []

    async def send(self, value):
        self.sent.append(json.loads(value))

    async def close(self):
        pass


class SendResult:
    def __init__(self, success, error=None, message_id=None):
        self.success = success
        self.error = error
        self.message_id = message_id


class ClarifyAdapterTests(unittest.IsolatedAsyncioTestCase):
    async def test_send_and_resolution_bridge_the_real_hermes_clarify_primitive(self):
        with tempfile.TemporaryDirectory() as directory:
            spool = AttachSpool(os.path.join(directory, "spool.sqlite"))
            socket = FakeSocket()

            async def connect_factory(_url, _headers, _ssl):
                return socket

            client = AttachV1Client(AttachV1ClientConfig(
                gateway_url="http://gateway", token="secret", spool=spool,
                connect_factory=connect_factory,
            ))
            await client.connect()
            await client._dispatch_inbound(json.dumps({"kind": "hello_ack", "capabilities": ["draft", "clarify"], "limits": {"maxInFlightEvents": 64, "maxInFlightBytes": 4194304}}))

            adapter = AttachAdapter()
            adapter._client = client
            adapter._active_turn = {"thread": "turn"}
            adapter._clarify_choices = {}
            resolved = []
            base = types.ModuleType("gateway.platforms.base")
            base.SendResult = SendResult
            gateway = types.ModuleType("gateway")
            platforms = types.ModuleType("gateway.platforms")
            clarify = types.ModuleType("tools.clarify_gateway")
            tools = types.ModuleType("tools")
            clarify.get_clarify_timeout = lambda: 60
            def resolve(clarify_id, answer):
                resolved.append((clarify_id, answer))
                return True
            clarify.resolve_gateway_clarify = resolve

            with patch.dict(sys.modules, {"gateway": gateway, "gateway.platforms": platforms, "gateway.platforms.base": base, "tools": tools, "tools.clarify_gateway": clarify}):
                result = await adapter.send_clarify("thread", "Which?", ["Alpha", "Beta"], "question-1", "session")
                self.assertTrue(result.success)
                event = [frame for frame in socket.sent if frame.get("kind") == "event"][-1]["event"]
                self.assertEqual(event["clarifyId"], "question-1")
                self.assertEqual(event["options"], [{"id": "option-1", "label": "Alpha"}, {"id": "option-2", "label": "Beta"}])
                self.assertGreater(event["expiresAt"], 0)
                await adapter._dispatch_clarify_command({"threadId": "thread", "clarifyId": "question-1", "optionId": "option-2"})
                self.assertEqual(resolved, [("question-1", "Beta")])
                self.assertNotIn("question-1", adapter._clarify_choices)
            await client.close()
            spool.close()


if __name__ == "__main__":
    unittest.main()

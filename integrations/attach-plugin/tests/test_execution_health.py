from __future__ import annotations
import json
import socket
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen
from cozygateway.execution_health import ExecutionHealth

class ExecutionHealthTests(unittest.TestCase):
    def test_ready_requires_attach_and_configuration(self) -> None:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        health = ExecutionHealth(agent_id="chatx_0123456789abcdef0123456789abcdef", incarnation="inc-1", port=port, transfer_required=True)
        health.start()
        with self.assertRaises(HTTPError) as failed:
            urlopen(f"http://127.0.0.1:{port}/ready")
        with failed.exception:
            body = json.loads(failed.exception.read())
        self.assertEqual(body["attach"]["state"], "connecting")
        self.assertEqual(body["model"]["probe"]["reason"], "credentials_pending")
        health.mark_attach_online(); health.mark_configuration_ready()
        with urlopen(f"http://127.0.0.1:{port}/ready") as response:
            ready = json.loads(response.read())
        self.assertTrue(ready["ready"])
        self.assertEqual(ready["agentId"], "chatx_0123456789abcdef0123456789abcdef")
        self.assertEqual(ready["incarnation"], "inc-1")
        self.assertEqual(ready["attach"]["state"], "online")

if __name__ == "__main__": unittest.main()

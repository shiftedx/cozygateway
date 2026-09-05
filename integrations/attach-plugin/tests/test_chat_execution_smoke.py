"""Opt-in process smoke for the isolated Hermes chat-execution bootstrap.

This exercises the public ``hermes gateway run --force`` command against the same
attach-v1 fake used by the protocol tests.  It is intentionally opt-in: normal unit
test environments do not carry a complete Hermes installation.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from cozygateway.chat_execution import prepare_execution
from tests.fake_gateway import FakeGateway


def _ready(port: int) -> tuple[int, dict]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}/ready")
    try:
        with urllib.request.urlopen(request, timeout=1) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read())


@unittest.skipUnless(
    os.getenv("COZYGATEWAY_RUN_HERMES_SMOKE") == "1" and shutil.which("hermes"),
    "requires COZYGATEWAY_RUN_HERMES_SMOKE=1 and a local Hermes installation",
)
class ChatExecutionProcessSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_connected_prepare_is_ready_session_scoped_and_stops_on_lease_eof(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
          async with FakeGateway(capabilities=[
              "bot_config", "chat_configuration", "provider_connections",
          ]) as gateway:
            root = Path(raw)
            workspace = root / "workspace"
            workspace.mkdir()
            spec_path = root / "execution.json"
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as reserved:
                reserved.bind(("127.0.0.1", 0))
                health_port = reserved.getsockname()[1]
            spec_path.write_text(json.dumps({
                "executionId": "chatx_0123456789abcdef0123456789abcdef",
                "sourceBotId": "source-bot",
                "sessionId": "session-1",
                "attachUrl": gateway.http_url,
                "attachToken": gateway.token,
                "workspacePath": str(workspace),
                "workspace": {"computerId": "computer-1", "projectId": "project-1", "mode": "direct"},
                "sourceProfile": {"soul": "# Source persona"},
                "transferRequired": False,
                "healthPort": health_port,
            }), encoding="utf-8")
            spec_path.chmod(0o600)
            read_fd, write_fd = os.pipe()
            process: subprocess.Popen[str] | None = None
            try:
                with patch.dict(os.environ, {
                    "COZYAGENTS_INCARNATION": "smoke-incarnation",
                    "COZYAGENTS_PARENT_LEASE_FD": str(read_fd),
                }, clear=False):
                    plan = prepare_execution(spec_path)
                process = subprocess.Popen(
                    plan.argv, cwd=plan.cwd, env=plan.environment, pass_fds=(read_fd,),
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                )
                os.close(read_fd)
                await gateway.wait_for(lambda: gateway.hellos, timeout=20, what="Hermes attach hello")

                # The transport is up, but readiness waits for the one-session preparation.
                await self._wait_ready(health_port, expected=503)
                await gateway._send({
                    "kind": "config_request", "requestId": "prepare-bound",
                    "operation": "chat.configuration.prepare",
                    "input": {"configuration": {
                        "sessionId": "session-1",
                        "workspace": {"computerId": "computer-1", "projectId": "project-1", "mode": "direct"},
                        "model": {"providerId": "openrouter", "modelId": "example/model", "effort": "high"},
                    }},
                })
                await gateway.wait_for(lambda: any(
                    frame.get("kind") == "config_result" and frame.get("requestId") == "prepare-bound"
                    for frame in gateway.frames
                ), timeout=10, what="bound configuration result")
                bound = next(frame for frame in gateway.frames if frame.get("requestId") == "prepare-bound")
                self.assertEqual(bound.get("status"), "ok")
                ready = await self._wait_ready(health_port, expected=200)
                self.assertEqual(ready["agentId"], "chatx_0123456789abcdef0123456789abcdef")
                self.assertEqual(ready["incarnation"], "smoke-incarnation")
                self.assertEqual(ready["attach"]["state"], "online")
                self.assertTrue(ready["ready"])

                # The child must refuse a second source chat before it reaches Hermes.
                await gateway._send({
                    "kind": "config_request", "requestId": "prepare-other",
                    "operation": "chat.configuration.prepare",
                    "input": {"configuration": {"sessionId": "other-session", "workspace": None, "model": None}},
                })
                await gateway.wait_for(lambda: any(
                    frame.get("kind") == "config_result" and frame.get("requestId") == "prepare-other"
                    for frame in gateway.frames
                ), timeout=10, what="cross-session refusal")
                other = next(frame for frame in gateway.frames if frame.get("requestId") == "prepare-other")
                self.assertEqual(other.get("status"), "invalid_request")

                await gateway.push_command({"kind": "turn", "threadId": "other-session", "turnId": "turn-other", "text": "must not dispatch"})
                await asyncio.sleep(0.2)
                self.assertFalse(any(
                    event.get("threadId") == "other-session" for event in gateway.events
                ))
            finally:
                try:
                    os.close(write_fd)  # runner death: lease watcher must stop the dedicated child.
                except OSError:
                    pass
                if process is not None:
                    try:
                        await asyncio.wait_for(asyncio.to_thread(process.wait), timeout=10)
                    except TimeoutError:
                        process.terminate()
                        await asyncio.to_thread(process.wait)
                    if process.stdout is not None:
                        process.stdout.close()
                    if process.stderr is not None:
                        process.stderr.close()
                try:
                    os.close(read_fd)
                except OSError:
                    pass

    async def _wait_ready(self, port: int, *, expected: int) -> dict:
        deadline = time.monotonic() + 20
        last: tuple[int, dict] | None = None
        while time.monotonic() < deadline:
            try:
                last = await asyncio.to_thread(_ready, port)
            except OSError:
                await asyncio.sleep(0.05)
                continue
            if last[0] == expected:
                return last[1]
            await asyncio.sleep(0.05)
        self.fail(f"health never returned {expected}; last={last}")


if __name__ == "__main__":
    unittest.main()

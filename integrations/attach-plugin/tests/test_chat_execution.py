"""Filesystem-only tests for isolated Hermes execution bootstrap."""
from __future__ import annotations

import json
import os
import stat
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from cozygateway.adapter import AttachAdapter
from cozygateway.chat_execution import ChatExecutionBootstrapError, prepare_execution


class ChatExecutionBootstrapTests(unittest.TestCase):
    def _spec(self, directory: Path, workspace: Path) -> Path:
        path = directory / "execution.json"
        path.write_text(json.dumps({
            "executionId": "chatx_0123456789abcdef0123456789abcdef",
            "sourceBotId": "source-bot",
            "sessionId": "session-1",
            "attachUrl": "https://gateway.example.test/",
            "attachToken": "private-attach-token",
            "workspacePath": str(workspace),
            "workspace": {"computerId": "computer-1", "projectId": "project-1", "mode": "direct"},
            "sourceProfile": {"soul": "# Source persona", "disabledSkills": ["deploy"], "enabledSkills": ["source-skill"], "enabledToolsets": ["files"]},
            "model": {"id": "example-model", "endpoint": "https://models.example.test/v1"},
            "transferRequired": True,
            "healthPort": 19091,
        }), encoding="utf-8")
        path.chmod(0o600)
        return path

    def test_prepares_isolated_home_plugin_persona_and_single_session_environment(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            workspace = root / "workspace"; workspace.mkdir()
            with patch.dict(os.environ, {"OPENAI_API_KEY": "source-secret", "HERMES_HOME": "/source/home", "COZYAGENTS_INCARNATION": "inc-1", "COZYAGENTS_PARENT_LEASE_FD": "3"}):
                plan = prepare_execution(self._spec(root, workspace))
            self.assertEqual(plan.argv, ("hermes", "gateway", "run", "--force"))
            self.assertEqual(plan.cwd, workspace.resolve())
            self.assertEqual(plan.environment["HERMES_HOME"], str(plan.home))
            self.assertEqual(plan.environment["COZYGATEWAY_EXECUTION_SESSION_ID"], "session-1")
            self.assertEqual(plan.environment["COZYGATEWAY_TOKEN"], "private-attach-token")
            self.assertNotIn("OPENAI_API_KEY", plan.environment)
            self.assertNotEqual(plan.environment["HOME"], "/source/home")
            self.assertEqual(plan.environment["COZYAGENTS_HEALTH_PORT"], "19091")
            self.assertEqual(plan.environment["COZYAGENTS_INCARNATION"], "inc-1")
            self.assertEqual(plan.environment["COZYAGENTS_PARENT_LEASE_FD"], "3")
            self.assertEqual(json.loads(plan.environment["COZYGATEWAY_EXECUTION_MODEL_JSON"])["id"], "example-model")
            registry = json.loads(plan.environment["HERMES_CHAT_PROJECTS_JSON"])
            self.assertEqual(registry, [{"computerId": "computer-1", "projectId": "project-1", "mode": "direct", "root": str(workspace.resolve()), "name": "workspace"}])
            self.assertTrue((plan.home / "plugins" / "cozygateway" / "plugin.yaml").is_file())
            self.assertEqual((plan.home / "SOUL.md").read_text(encoding="utf-8"), "# Source persona")
            self.assertNotIn("private-attach-token", (plan.home / "config.yaml").read_text(encoding="utf-8"))
            self.assertEqual(stat.S_IMODE((plan.home / "config.yaml").stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE((plan.home / "SOUL.md").stat().st_mode), 0o600)
            config = (plan.home / "config.yaml").read_text(encoding="utf-8")
            self.assertIn("skills:", config)
            self.assertIn("platform_toolsets:", config)
            self.assertNotIn("skills:\n  enabled", config)  # Hermes has no `skills.enabled` config surface.

    def test_accepts_large_persona_below_the_execution_spec_cap(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            workspace = root / "workspace"; workspace.mkdir()
            spec_path = self._spec(root, workspace)
            spec = json.loads(spec_path.read_text(encoding="utf-8"))
            spec["sourceProfile"]["soul"] = "x" * 199_000
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            spec_path.chmod(0o600)
            with patch.dict(os.environ, {"COZYAGENTS_INCARNATION": "inc-1", "COZYAGENTS_PARENT_LEASE_FD": "3"}):
                plan = prepare_execution(spec_path)
            self.assertEqual((plan.home / "SOUL.md").stat().st_size, 199_000)

    def test_rejects_soul_over_its_explicit_limit(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            workspace = root / "workspace"; workspace.mkdir()
            spec_path = self._spec(root, workspace)
            spec = json.loads(spec_path.read_text(encoding="utf-8"))
            spec["sourceProfile"]["soul"] = "x" * 200_001
            spec_path.write_text(json.dumps(spec), encoding="utf-8")
            spec_path.chmod(0o600)
            with self.assertRaisesRegex(ChatExecutionBootstrapError, "soul"):
                prepare_execution(spec_path)

    def test_execution_adapter_guard_allows_only_its_bound_session(self) -> None:
        adapter = object.__new__(AttachAdapter)
        adapter._execution_session_id = "session-1"
        self.assertTrue(adapter._execution_thread_allowed("session-1"))
        self.assertFalse(adapter._execution_thread_allowed("session-2"))
        adapter._execution_session_id = None
        self.assertTrue(adapter._execution_thread_allowed("session-2"))

    def test_rejects_symlink_execution_spec(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            workspace = root / "workspace"; workspace.mkdir()
            target = self._spec(root, workspace)
            linked = root / "linked.json"; linked.symlink_to(target)
            with self.assertRaisesRegex(ChatExecutionBootstrapError, "unreadable"):
                prepare_execution(linked)

    def test_rejects_group_or_world_readable_execution_spec(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            workspace = root / "workspace"; workspace.mkdir()
            path = self._spec(root, workspace)
            path.chmod(0o644)
            with self.assertRaisesRegex(ChatExecutionBootstrapError, "must not"):
                prepare_execution(path)


if __name__ == "__main__":
    unittest.main()

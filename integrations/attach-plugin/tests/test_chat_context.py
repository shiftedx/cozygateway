import json
import os
import subprocess
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from cozygateway.chat_context import ChatContextError, HermesChatContext, set_hermes_session_cwd


class ChatContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name) / "project"; self.root.mkdir()
        self.env = {"HERMES_CHAT_COMPUTER_ID": "computer", "HERMES_CHAT_PROJECTS_JSON": json.dumps([{"computerId":"computer","projectId":"project","root":str(self.root)}])}

    def tearDown(self): self.tmp.cleanup()

    def test_direct_allows_non_git_folder_and_never_changes_process_cwd(self):
        with patch.dict(os.environ, self.env, clear=False):
            context = HermesChatContext("profile")
            before = Path.cwd(); result = context.prepare_workspace({"computerId":"computer","projectId":"project","mode":"direct"}, "session")
            self.assertEqual(result, self.root.resolve()); self.assertEqual(Path.cwd(), before)
            self.assertEqual(context.projects("computer")[0]["isGitRepository"], False)

    def test_dirty_direct_checkout_is_accepted_but_other_branch_is_refused(self):
        subprocess.run(["git", "init", str(self.root)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.email", "test@example.com"], check=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.name", "Test"], check=True)
        (self.root / "a").write_text("one"); subprocess.run(["git", "-C", str(self.root), "add", "."], check=True); subprocess.run(["git", "-C", str(self.root), "commit", "-m", "one"], check=True, capture_output=True)
        (self.root / "a").write_text("dirty")
        branch = subprocess.check_output(["git", "-C", str(self.root), "branch", "--show-current"], text=True).strip()
        with patch.dict(os.environ, self.env, clear=False):
            context = HermesChatContext("profile")
            self.assertEqual(context.prepare_workspace({"computerId":"computer","projectId":"project","mode":"direct","branch":branch}, "session"), self.root.resolve())
            with self.assertRaises(ChatContextError): context.prepare_workspace({"computerId":"computer","projectId":"project","mode":"direct","branch":"other"}, "session")

    def test_worktrees_are_unique_and_do_not_switch_source(self):
        subprocess.run(["git", "init", str(self.root)], check=True, capture_output=True)
        subprocess.run(["git", "-C", str(self.root), "config", "user.email", "test@example.com"], check=True); subprocess.run(["git", "-C", str(self.root), "config", "user.name", "Test"], check=True)
        (self.root / "a").write_text("one"); subprocess.run(["git", "-C", str(self.root), "add", "."], check=True); subprocess.run(["git", "-C", str(self.root), "commit", "-m", "one"], check=True, capture_output=True)
        branch = subprocess.check_output(["git", "-C", str(self.root), "branch", "--show-current"], text=True).strip()
        with patch.dict(os.environ, {**self.env, "COZYGATEWAY_CHAT_WORKTREES_DIR": str(Path(self.tmp.name) / "worktrees")}, clear=False):
            context = HermesChatContext("profile"); selection = {"computerId":"computer","projectId":"project","mode":"worktree","branch":branch}
            first, second = context.prepare_workspace(selection, "session"), context.prepare_workspace(selection, "session")
            self.assertNotEqual(first, second); self.assertEqual(subprocess.check_output(["git", "-C", str(self.root), "branch", "--show-current"], text=True).strip(), branch)

    def test_session_cwd_refuses_stale_or_running_session_before_calling_hermes_setter(self):
        package = types.ModuleType("tui_gateway"); package.__path__ = []
        server = types.ModuleType("tui_gateway.server")
        server._sessions_lock = threading.Lock()
        server._sessions = {"live": {"session_key": "live", "running": False}}
        workdir = types.ModuleType("tui_gateway.session_workdir")
        workdir._set_session_cwd = MagicMock()
        modules = {"tui_gateway": package, "tui_gateway.server": server, "tui_gateway.session_workdir": workdir}
        with patch.dict(sys.modules, modules):
            self.assertFalse(set_hermes_session_cwd("stale", self.root))
            server._sessions["live"]["running"] = True
            self.assertFalse(set_hermes_session_cwd("live", self.root))
            server._sessions["live"]["running"] = False
            self.assertTrue(set_hermes_session_cwd("live", self.root))
        workdir._set_session_cwd.assert_called_once_with(server._sessions["live"], str(self.root))

"""Local opaque-project resolution for CozyGateway's Hermes attachment.

The wire carries opaque ids only.  Roots arrive solely from local operator configuration, are
resolved before use, and every selected path is checked again before Hermes receives it.
"""
from __future__ import annotations

import json
import os
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional


class ChatContextError(Exception): pass


@dataclass(frozen=True)
class Project:
    computer_id: str
    project_id: str
    root: Path
    name: str


def _env_projects() -> List[Project]:
    raw = os.getenv("HERMES_CHAT_PROJECTS_JSON") or os.getenv("COZYGATEWAY_CHAT_PROJECTS_JSON") or "[]"
    try: entries = json.loads(raw)
    except json.JSONDecodeError as exc: raise ChatContextError("local chat project registry is invalid") from exc
    if not isinstance(entries, list): raise ChatContextError("local chat project registry must be an array")
    result: List[Project] = []
    for item in entries:
        if not isinstance(item, dict): raise ChatContextError("local chat project entry is invalid")
        computer_id, project_id, root = item.get("computerId"), item.get("projectId"), item.get("root")
        if not all(isinstance(value, str) and value for value in (computer_id, project_id, root)):
            raise ChatContextError("local chat project entry is incomplete")
        resolved = Path(root).expanduser().resolve(strict=True)
        configured = Path(root).expanduser()
        if configured.is_symlink() or not resolved.is_dir(): raise ChatContextError("configured project root is not a real directory")
        result.append(Project(computer_id, project_id, resolved, str(item.get("name") or resolved.name)))
    if not result and (default_root := os.getenv("HERMES_CHAT_WORKSPACE_ROOT")):
        configured = Path(default_root).expanduser()
        resolved = configured.resolve(strict=True)
        if configured.is_symlink() or not resolved.is_dir(): raise ChatContextError("configured Hermes workspace root is not a real directory")
        result.append(Project(
            os.getenv("HERMES_CHAT_COMPUTER_ID") or "hermes:default",
            os.getenv("HERMES_CHAT_PROJECT_ID") or "default", resolved,
            os.getenv("HERMES_CHAT_PROJECT_NAME") or resolved.name,
        ))
    return result


class HermesChatContext:
    def __init__(self, profile: str) -> None:
        self._profile = profile or "default"

    @property
    def computer_id(self) -> str: return os.getenv("HERMES_CHAT_COMPUTER_ID") or f"hermes:{self._profile}"
    @property
    def computer_name(self) -> str: return os.getenv("HERMES_CHAT_COMPUTER_NAME") or "This Hermes computer"
    @property
    def computer_available(self) -> bool: return any(project.computer_id == self.computer_id for project in _env_projects())

    def projects(self, computer_id: str) -> List[Dict[str, Any]]:
        if computer_id != self.computer_id: raise ChatContextError("unknown computer")
        return [self._project_row(project) for project in _env_projects() if project.computer_id == computer_id]

    def branches(self, computer_id: str, project_id: str) -> List[Dict[str, Any]]:
        project = self._project(computer_id, project_id)
        if not self._git(project.root): return []
        current = self._git_text(project.root, "branch", "--show-current")
        names = [line.strip() for line in self._git_text(project.root, "for-each-ref", "--format=%(refname:short)", "refs/heads").splitlines() if line.strip()]
        return [{"name": name, "isCurrent": name == current} for name in names]

    def prepare_workspace(self, selection: Dict[str, Any], session_id: str) -> Path:
        project = self._project(str(selection.get("computerId") or ""), str(selection.get("projectId") or ""))
        mode, requested = selection.get("mode"), selection.get("branch")
        if mode not in {"direct", "worktree"}: raise ChatContextError("unknown workspace mode")
        if requested is not None and (not isinstance(requested, str) or not requested or any(c in requested for c in "\\\x00\r\n")):
            raise ChatContextError("invalid branch")
        if mode == "direct":
            if requested is not None and self._git(project.root) and requested != self._git_text(project.root, "branch", "--show-current"):
                raise ChatContextError("direct workspace may use only its current branch")
            return project.root
        if not self._git(project.root): raise ChatContextError("worktree mode requires a git project")
        source = requested or self._git_text(project.root, "branch", "--show-current")
        if not source or self._git_run(project.root, "rev-parse", "--verify", f"refs/heads/{source}", check=False) is None:
            raise ChatContextError("selected source branch does not exist")
        base = Path(os.getenv("COZYGATEWAY_CHAT_WORKTREES_DIR") or (Path.home() / ".hermes" / "cozygateway-worktrees")).expanduser()
        base.mkdir(mode=0o700, parents=True, exist_ok=True)
        base = base.resolve(strict=True)
        target = base / f"{session_id[:40]}-{uuid.uuid4().hex[:10]}"
        branch = f"cozygateway/{session_id[:32]}-{uuid.uuid4().hex[:8]}"
        self._git_run(project.root, "worktree", "add", "-b", branch, str(target), source)
        resolved = target.resolve(strict=True)
        if resolved.parent != base or resolved.is_symlink(): raise ChatContextError("worktree escaped its local registry")
        return resolved

    def _project(self, computer_id: str, project_id: str) -> Project:
        if computer_id != self.computer_id: raise ChatContextError("unknown computer")
        for project in _env_projects():
            if project.computer_id == computer_id and project.project_id == project_id: return project
        raise ChatContextError("unknown project")

    def _project_row(self, project: Project) -> Dict[str, Any]:
        git = self._git(project.root)
        return {"id": project.project_id, "name": project.name, "displayPath": str(project.root), "isGitRepository": git,
                **({"currentBranch": self._git_text(project.root, "branch", "--show-current")} if git and self._git_text(project.root, "branch", "--show-current") else {})}

    @staticmethod
    def _git(root: Path) -> bool: return HermesChatContext._git_run(root, "rev-parse", "--is-inside-work-tree", check=False) == "true"
    @staticmethod
    def _git_text(root: Path, *args: str) -> str: return HermesChatContext._git_run(root, *args) or ""
    @staticmethod
    def _git_run(root: Path, *args: str, check: bool = True) -> Optional[str]:
        completed = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
        if completed.returncode and check: raise ChatContextError((completed.stderr.strip() or "git operation failed")[:300])
        return completed.stdout.strip() if completed.returncode == 0 else None


def set_hermes_session_cwd(session_key: str, cwd: Path) -> bool:
    """Use Hermes' session setter only for the matching idle TUI session.

    The gateway runner does not expose a generic CWD mutator. If this Hermes build has no TUI
    session registry, callers must refuse preparation rather than change process CWD.
    """
    try:
        import tui_gateway.server as server  # type: ignore[import-not-found]
        from tui_gateway.session_workdir import _set_session_cwd  # type: ignore[import-not-found]
        lock, sessions = server._sessions_lock, server._sessions
        with lock:
            session = next((entry for entry in sessions.values() if entry.get("session_key") == session_key), None)
            if session is None or session.get("running"): return False
            _set_session_cwd(session, str(cwd))
        return True
    except Exception:
        return False

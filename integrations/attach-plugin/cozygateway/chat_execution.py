"""Private bootstrap for one remote CozyGateway chat execution.

The runner starts this module in a new OS process::

    python -m cozygateway.chat_execution --spec /private/path/spec.json

It creates an isolated ``HERMES_HOME``, copies the installed CozyGateway directory
plugin into that home, writes only non-secret Hermes configuration, and execs the
public ``hermes gateway run --force`` command.  The attach token remains in the
child process environment; credentials for custom model providers arrive later via
the execution-scoped provider-transfer lane.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


class ChatExecutionBootstrapError(ValueError):
    """The runner supplied an invalid or unsafe private execution specification."""


@dataclass(frozen=True)
class ChatExecutionSpec:
    execution_id: str
    source_bot_id: str
    session_id: str
    attach_url: str
    attach_token: str
    workspace_path: Path
    workspace: dict[str, Any]
    source_profile: dict[str, Any]
    model: dict[str, Any] | None
    transfer_required: bool
    health_port: int


@dataclass(frozen=True)
class ChatExecutionPlan:
    home: Path
    cwd: Path
    argv: tuple[str, ...]
    environment: dict[str, str]


_EXECUTION_ID = re.compile(r"^chatx_[0-9a-f]{32}$")
_MAX_SPEC_BYTES = 512 * 1024
_MAX_SOUL_BYTES = 200_000


def _nonempty(value: Any, name: str, *, maximum: int = 200) -> str:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or len(value.strip()) > maximum:
        raise ChatExecutionBootstrapError(f"{name} is required")
    return value.strip()


def _profile_list(profile: Mapping[str, Any], name: str) -> list[str]:
    value = profile.get(name)
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 512:
        raise ChatExecutionBootstrapError(f"sourceProfile.{name} is invalid")
    cleaned: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip() or "\x00" in item or len(item.strip()) > 200:
            raise ChatExecutionBootstrapError(f"sourceProfile.{name} is invalid")
        cleaned.append(item.strip())
    return cleaned


def _private_spec_bytes(path: Path) -> bytes:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:
        raise ChatExecutionBootstrapError("execution spec is unreadable") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ChatExecutionBootstrapError("execution spec must be a regular file")
        if stat.S_IMODE(info.st_mode) & 0o077:
            raise ChatExecutionBootstrapError("execution spec must not be group- or world-readable")
        with os.fdopen(fd, "rb", closefd=False) as handle:
            return handle.read(_MAX_SPEC_BYTES + 1)
    finally:
        os.close(fd)


def load_spec(path: Path) -> ChatExecutionSpec:
    """Load a runner-owned 0600 spec without following a symlink or echoing its token."""
    try:
        encoded = _private_spec_bytes(path)
        if len(encoded) > _MAX_SPEC_BYTES:
            raise ChatExecutionBootstrapError("execution spec is too large")
        raw = json.loads(encoded.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ChatExecutionBootstrapError("execution spec is not valid JSON") from exc
    if not isinstance(raw, dict): raise ChatExecutionBootstrapError("execution spec must be an object")
    execution_id = _nonempty(raw.get("executionId"), "executionId", maximum=38)
    if not _EXECUTION_ID.fullmatch(execution_id): raise ChatExecutionBootstrapError("executionId is invalid")
    workspace = raw.get("workspace")
    if not isinstance(workspace, dict): raise ChatExecutionBootstrapError("workspace is required")
    computer_id = _nonempty(workspace.get("computerId"), "workspace.computerId", maximum=200)
    project_id = _nonempty(workspace.get("projectId"), "workspace.projectId", maximum=200)
    mode = workspace.get("mode")
    if mode not in {"direct", "worktree"}: raise ChatExecutionBootstrapError("workspace.mode is invalid")
    branch = workspace.get("branch")
    if branch is not None and (not isinstance(branch, str) or not branch.strip() or len(branch.strip()) > 200 or any(c in branch for c in "\\\x00\r\n")):
        raise ChatExecutionBootstrapError("workspace.branch is invalid")
    raw_workspace_path = Path(_nonempty(raw.get("workspacePath"), "workspacePath", maximum=4096)).expanduser()
    try: workspace_path = raw_workspace_path.resolve(strict=True)
    except OSError as exc: raise ChatExecutionBootstrapError("workspacePath is unavailable") from exc
    if raw_workspace_path.is_symlink() or not workspace_path.is_dir(): raise ChatExecutionBootstrapError("workspacePath must be a real directory")
    source_profile = raw.get("sourceProfile") or {}
    if not isinstance(source_profile, dict): raise ChatExecutionBootstrapError("sourceProfile must be an object")
    soul = source_profile.get("soul")
    if soul is not None and (not isinstance(soul, str) or len(soul.encode("utf-8")) > _MAX_SOUL_BYTES):
        raise ChatExecutionBootstrapError("sourceProfile.soul is invalid")
    normalized_profile: dict[str, Any] = {}
    if isinstance(soul, str):
        normalized_profile["soul"] = soul
    for field in ("disabledSkills", "enabledSkills", "enabledToolsets", "enabledMcpServers"):
        values = _profile_list(source_profile, field)
        if values:
            normalized_profile[field] = values
    guardrail = source_profile.get("guardrailLevel")
    if guardrail is not None:
        normalized_profile["guardrailLevel"] = _nonempty(guardrail, "sourceProfile.guardrailLevel", maximum=64)
    model = raw.get("model")
    if model is not None and not isinstance(model, dict): raise ChatExecutionBootstrapError("model must be an object")
    try: health_port = int(raw.get("healthPort") if raw.get("healthPort") is not None else os.getenv("COZYAGENTS_HEALTH_PORT", "0"))
    except (TypeError, ValueError): health_port = 0
    if not 1 <= health_port <= 65535: raise ChatExecutionBootstrapError("healthPort is required")
    return ChatExecutionSpec(
        execution_id=execution_id, source_bot_id=_nonempty(raw.get("sourceBotId"), "sourceBotId", maximum=64),
        session_id=_nonempty(raw.get("sessionId"), "sessionId", maximum=200),
        attach_url=_nonempty(raw.get("attachUrl"), "attachUrl", maximum=2048).rstrip("/"),
        attach_token=_nonempty(raw.get("attachToken"), "attachToken", maximum=4096), workspace_path=workspace_path,
        workspace={"computerId": computer_id, "projectId": project_id, "mode": mode, **({"branch": branch.strip()} if isinstance(branch, str) else {})},
        source_profile=normalized_profile, model=dict(model) if isinstance(model, dict) else None,
        transfer_required=bool(raw.get("transferRequired", False)), health_port=health_port,
    )

def _secure_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass


def _write_private(path: Path, content: str) -> None:
    _secure_dir(path.parent)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        # os.fdopen closes normally; this only protects an exception before it takes ownership.
        try:
            os.close(fd)
        except OSError:
            pass



def _yaml_list(values: Any, indent: str = "    ") -> str:
    return "".join(f"{indent}- {json.dumps(value)}\n" for value in values if isinstance(value, str) and value.strip()) if isinstance(values, list) else ""


def _write_config(home: Path, profile: Mapping[str, Any]) -> None:
    # Supported Hermes profile settings are translated into the isolated profile. Source
    # credentials and unsupported fields never become config.yaml.
    config = "plugins:\n  enabled:\n    - cozygateway\nplatforms:\n  cozygateway:\n    enabled: true\ngateway:\n  write_sessions_json: false\n"
    disabled = _yaml_list(profile.get("disabledSkills"))
    # Hermes has a supported disabled-skill list only. An enabledSkills snapshot remains
    # private metadata because this isolated home does not receive the source profile's
    # skill bundle; inventing a `skills.enabled` key would claim a filter Hermes does not have.
    if disabled:
        config += "skills:\n  disabled:\n" + _yaml_list(profile.get("disabledSkills"), indent="    ")
    toolsets = _yaml_list(profile.get("enabledToolsets"))
    if toolsets: config += "platform_toolsets:\n  cozygateway:\n" + toolsets
    _write_private(home / "config.yaml", config)


def _write_source_persona(home: Path, profile: Mapping[str, Any]) -> None:
    soul = profile.get("soul")
    if isinstance(soul, str) and soul.strip():
        _write_private(home / "SOUL.md", soul)
    # These fields are runner metadata, not a safe translation to Hermes config. Keep a
    # private snapshot for the plugin/process lifecycle without claiming Hermes will honour
    # unavailable toolset/MCP controls in this execution.
    _write_private(home / "cozygateway-source-profile.json", json.dumps(dict(profile), separators=(",", ":")))


def _write_launch_metadata(home: Path, spec: ChatExecutionSpec) -> None:
    # Contains no credentials. The plugin's provider import is the only credential path.
    payload = {"executionId": spec.execution_id, "sourceBotId": spec.source_bot_id,
               "sessionId": spec.session_id, "model": spec.model,
               "transferRequired": spec.transfer_required}
    _write_private(home / "cozygateway-launch.json", json.dumps(payload, separators=(",", ":")))


def _copy_plugin(home: Path) -> Path:
    plugin_root = Path(__file__).resolve().parent.parent
    target = home / "plugins" / "cozygateway"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(
        plugin_root, target,
        ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.pyc"),
        copy_function=shutil.copy2,
    )
    for directory, _, files in os.walk(target):
        Path(directory).chmod(0o700)
        for filename in files:
            try:
                (Path(directory) / filename).chmod(0o600)
            except OSError:
                pass
    return target


def prepare_execution(spec_path: Path) -> ChatExecutionPlan:
    """Materialize the isolated child profile and return its public CLI invocation."""
    spec_path = spec_path.expanduser().absolute()
    spec = load_spec(spec_path)
    # A runner makes one 0600 spec per execution. Keeping state beside it makes cleanup
    # deterministic and prevents the child from ever reading the operator's normal HERMES_HOME.
    home = spec_path.parent / f"hermes-{spec.execution_id}"
    _secure_dir(spec_path.parent)
    _secure_dir(home)
    _write_config(home, spec.source_profile)
    _write_source_persona(home, spec.source_profile)
    _write_launch_metadata(home, spec)
    _copy_plugin(home)
    registry = [{**spec.workspace, "root": str(spec.workspace_path), "name": spec.workspace_path.name}]
    incarnation = _nonempty(os.getenv("COZYAGENTS_INCARNATION"), "COZYAGENTS_INCARNATION", maximum=200)
    parent_lease_fd = _nonempty(os.getenv("COZYAGENTS_PARENT_LEASE_FD"), "COZYAGENTS_PARENT_LEASE_FD", maximum=12)
    try:
        if int(parent_lease_fd) < 0: raise ValueError
    except ValueError as exc:
        raise ChatExecutionBootstrapError("COZYAGENTS_PARENT_LEASE_FD is invalid") from exc
    # Do not inherit the source bot's provider keys, profile path, or proxy credentials.
    # The new process gets exactly the transport token and private values materialized below.
    allowed_environment = {"PATH", "LANG", "TERM", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "NO_PROXY", "no_proxy"}
    env = {key: value for key, value in os.environ.items() if key in allowed_environment or key.startswith("LC_")}
    env.update({
        "HOME": str(home),
        "XDG_CACHE_HOME": str(home / "cache"),
        "XDG_CONFIG_HOME": str(home / "config"),
        "HERMES_HOME": str(home),
        "HERMES_CHAT_PROJECTS_JSON": json.dumps(registry, separators=(",", ":")),
        "HERMES_CHAT_COMPUTER_ID": spec.workspace["computerId"],
        "HERMES_CHAT_COMPUTER_NAME": f"CozyGateway execution {spec.execution_id}",
        "COZYGATEWAY_URL": spec.attach_url,
        "COZYGATEWAY_TOKEN": spec.attach_token,
        "COZYGATEWAY_EXECUTION_ID": spec.execution_id,
        "COZYGATEWAY_EXECUTION_SESSION_ID": spec.session_id,
        "COZYGATEWAY_SPOOL_PATH": str(home / "cozygateway-attach-v1.sqlite"),
        "COZYGATEWAY_PROVIDER_CONNECTIONS_PATH": str(home / "cozygateway-provider-connections.json"),
        "COZYGATEWAY_BOT_MODEL_PATH": str(home / "cozygateway-bot-model.json"),
        "COZYGATEWAY_EXECUTION_WORKSPACE_ROOT": str(spec.workspace_path),
        "COZYGATEWAY_EXECUTION_MODEL_JSON": json.dumps(spec.model or {}, separators=(",", ":")),
        "COZYGATEWAY_SOURCE_PROFILE_JSON": json.dumps(spec.source_profile, separators=(",", ":")),
        "COZYGATEWAY_TRANSFER_REQUIRED": "1" if spec.transfer_required else "0",
        "COZYAGENTS_HEALTH_PORT": str(spec.health_port),
        "COZYAGENTS_INCARNATION": incarnation,
        "COZYAGENTS_PARENT_LEASE_FD": parent_lease_fd,
    })
    return ChatExecutionPlan(home=home, cwd=spec.workspace_path,
                             argv=("hermes", "gateway", "run", "--force"), environment=env)


def execute(spec_path: Path) -> None:
    plan = prepare_execution(spec_path)
    os.chdir(plan.cwd)
    os.execvpe(plan.argv[0], list(plan.argv), plan.environment)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="start one isolated CozyGateway Hermes chat execution")
    parser.add_argument("--spec", required=True, help="runner-owned 0600 execution spec JSON")
    args = parser.parse_args(argv)
    try:
        execute(Path(args.spec))
    except ChatExecutionBootstrapError as exc:
        print(f"cozygateway chat execution bootstrap failed: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

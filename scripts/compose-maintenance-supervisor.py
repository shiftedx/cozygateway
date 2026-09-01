#!/usr/bin/env python3
"""Host-owned Docker Compose maintenance supervisor for CozyGateway.

This runs on the Docker host, not in the gateway container. The gateway receives only a mounted
Unix-socket request channel; it never receives Docker credentials or executes Compose itself.
"""

import json
import os
import re
import socket
import stat
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

HANDOFF_DELAY_SECONDS = 5
MAX_REQUEST_BYTES = 2_048
OPERATION_ID = re.compile(r"^maintenance_[a-f0-9]{32}$")
OPERATION_RETENTION_SECONDS = 24 * 60 * 60


def required(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"maintenance supervisor requires {name}")
    return value


SOCKET_PATH = required("COZYGATEWAY_MAINTENANCE_SOCKET")
CURRENT_VERSION = required("COZYGATEWAY_MAINTENANCE_CURRENT_VERSION")
# Docker deployments use this fixed-container mode. It permits exactly one Docker Engine API call
# and gives the gateway no Docker credentials. Compose-list mode remains for host supervisors.
CONTAINER_NAME = os.environ.get("COZYGATEWAY_MAINTENANCE_CONTAINER_NAME", "")
if CONTAINER_NAME and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", CONTAINER_NAME) is None:
    raise RuntimeError("COZYGATEWAY_MAINTENANCE_CONTAINER_NAME is invalid")
DOCKER_SOCKET = os.environ.get("COZYGATEWAY_MAINTENANCE_DOCKER_SOCKET", "/var/run/docker.sock")
COMPOSE_DIR: Optional[Path] = None
DOCKER: Optional[str] = None
BASE_COMPOSE_FILES: list[Path] = []
if not CONTAINER_NAME:
    COMPOSE_DIR = Path(required("COZYGATEWAY_MAINTENANCE_COMPOSE_DIR")).resolve()
    DOCKER = os.environ.get("COZYGATEWAY_DOCKER_BIN", "docker")
    BASE_COMPOSE_FILES = [Path(value).resolve() for value in required("COZYGATEWAY_MAINTENANCE_COMPOSE_FILES").split(",") if value]
    if not BASE_COMPOSE_FILES or any(not path.is_file() for path in BASE_COMPOSE_FILES):
        raise RuntimeError("maintenance supervisor requires existing ordered compose files")

LATEST_VERSION = os.environ.get("COZYGATEWAY_MAINTENANCE_LATEST_VERSION", "")
ACTIVE = threading.Lock()
STATE_LOCK = threading.Lock()
SCHEDULED: set[str] = set()
STATE_FILE = Path(required("COZYGATEWAY_MAINTENANCE_STATE_FILE")).resolve()
ALLOWED_UID = int(required("COZYGATEWAY_MAINTENANCE_ALLOWED_UID"))


def compose_args(files: list[Path]) -> list[str]:
    if COMPOSE_DIR is None:
        raise RuntimeError("Compose maintenance is not configured")
    args = ["compose", "--project-directory", str(COMPOSE_DIR)]
    for path in files:
        args.extend(["-f", str(path)])
    return args


def status() -> dict:
    if LATEST_VERSION == CURRENT_VERSION:
        update = {"state": "upToDate", "checkedAt": int(time.time() * 1000)}
    else:
        update = {"state": "unavailable", "checkedAt": int(time.time() * 1000)}
    return {"currentVersion": CURRENT_VERSION, "restartSupported": True, "update": update}


def run_compose(arguments: list[str]) -> None:
    if DOCKER is None or COMPOSE_DIR is None:
        raise RuntimeError("Compose maintenance is not configured")
    subprocess.run(
        [DOCKER, *compose_args(BASE_COMPOSE_FILES), *arguments],
        cwd=COMPOSE_DIR,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=300,
        check=True,
    )


def restart_fixed_container() -> None:
    """Restart the one operator-configured container through the Docker Unix API.

    No phone request can provide a target. This deliberately invokes neither a shell nor Docker
    CLI; the only path component is the validated startup environment value.
    """
    if not CONTAINER_NAME:
        raise RuntimeError("fixed-container maintenance is not configured")
    request = (
        f"POST /containers/{CONTAINER_NAME}/restart HTTP/1.1\r\n"
        "Host: docker\r\n"
        "Content-Length: 0\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as docker_socket:
        docker_socket.settimeout(30)
        docker_socket.connect(DOCKER_SOCKET)
        docker_socket.sendall(request)
        response = b""
        while b"\r\n" not in response:
            chunk = docker_socket.recv(512)
            if not chunk:
                break
            response += chunk
            if len(response) > 4_096:
                break
    status_line = response.split(b"\r\n", 1)[0]
    if not re.fullmatch(rb"HTTP/1\.[01] 204(?: .*)?", status_line):
        raise RuntimeError("Docker Engine did not acknowledge the fixed container restart")


def load_operations() -> dict[str, dict]:
    try:
        raw = json.loads(STATE_FILE.read_text())
        records = raw.get("operations", {}) if isinstance(raw, dict) else {}
        return records if isinstance(records, dict) else {}
    except (OSError, ValueError, AttributeError):
        return {}


def save_operations(records: dict[str, dict]) -> None:
    STATE_FILE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = STATE_FILE.with_name(f".{STATE_FILE.name}.{os.getpid()}.tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        os.chmod(temporary, 0o600)
        json.dump({"operations": records}, handle, separators=(",", ":"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, STATE_FILE)


def record_operation(operation_id: str, action: str) -> str:
    """Persist schedule intent before ACK. A retried id cannot schedule a second action."""
    with STATE_LOCK:
        records = load_operations()
        cutoff = int(time.time()) - OPERATION_RETENTION_SECONDS
        records = {key: value for key, value in records.items()
                   if isinstance(value, dict) and isinstance(value.get("at"), int) and value["at"] >= cutoff}
        prior = records.get(operation_id)
        if prior is not None:
            return "duplicate" if prior.get("action") == action else "conflict"
        records[operation_id] = {"action": action, "state": "scheduled", "at": int(time.time())}
        save_operations(records)
        return "new"


def existing_operation(operation_id: str, action: str) -> Optional[str]:
    with STATE_LOCK:
        record = load_operations().get(operation_id)
        if record is None:
            return None
        return "duplicate" if isinstance(record, dict) and record.get("action") == action else "conflict"


def complete_operation(operation_id: str) -> None:
    with STATE_LOCK:
        records = load_operations()
        record = records.get(operation_id)
        if isinstance(record, dict):
            record["state"] = "completed"
            save_operations(records)


def restart() -> None:
    if CONTAINER_NAME:
        restart_fixed_container()
    else:
        run_compose(["restart", "gateway"])


def delayed(operation_id: str, action) -> None:
    # This is a conservative, tested bounded handoff window: it lets the gateway consume the ACK,
    # persist its 24-hour idempotency receipt, and flush HTTP 202 before Compose can terminate its
    # listener. It is not a distributed commit guarantee and is never client supplied.
    time.sleep(HANDOFF_DELAY_SECONDS)
    try:
        action()
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        complete_operation(operation_id)
        SCHEDULED.discard(operation_id)
        ACTIVE.release()


def send(connection: socket.socket, payload: dict) -> None:
    connection.sendall((json.dumps(payload, separators=(",", ":")) + "\n").encode())


def allowed_peer(connection: socket.socket) -> bool:
    # Linux production has SO_PEERCRED. Refuse a mismatched container/process UID before parsing
    # any request; non-Linux development hosts remain protected by the 0600 mounted socket.
    if not hasattr(socket, "SO_PEERCRED"):
        return True
    credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    _pid, uid, _gid = struct.unpack("3i", credentials)
    return uid == ALLOWED_UID


def handle(connection: socket.socket) -> None:
    with connection:
        if not allowed_peer(connection):
            return
        data = b""
        while b"\n" not in data:
            chunk = connection.recv(min(512, MAX_REQUEST_BYTES + 1 - len(data)))
            if not chunk:
                return
            data += chunk
            if len(data) > MAX_REQUEST_BYTES:
                send(connection, {"ok": False, "code": "invalid_request"})
                return
        try:
            request = json.loads(data.split(b"\n", 1)[0])
        except (UnicodeDecodeError, json.JSONDecodeError):
            send(connection, {"ok": False, "code": "invalid_request"})
            return
        if not isinstance(request, dict):
            send(connection, {"ok": False, "code": "invalid_request"})
            return
        if request == {"action": "status"}:
            send(connection, {"ok": True, "status": status()})
            return
        operation_id = request.get("operationId")
        if not isinstance(operation_id, str) or OPERATION_ID.fullmatch(operation_id) is None:
            send(connection, {"ok": False, "code": "invalid_request"})
            return
        if request == {"action": "restart", "operationId": operation_id}:
            recorded = existing_operation(operation_id, "restart")
            if recorded == "conflict":
                send(connection, {"ok": False, "code": "invalid_request"})
                return
            if recorded == "duplicate":
                send(connection, {"ok": True})
                return
            if not ACTIVE.acquire(blocking=False):
                send(connection, {"ok": False, "code": "operation_in_progress"})
                return
            recorded = record_operation(operation_id, "restart")
            if recorded != "new":
                ACTIVE.release()
                send(connection, {"ok": True if recorded == "duplicate" else False, **({} if recorded == "duplicate" else {"code": "invalid_request"})})
                return
            SCHEDULED.add(operation_id)
            send(connection, {"ok": True})
            threading.Thread(target=delayed, args=(operation_id, restart), daemon=True).start()
            return
        if request.get("action") == "restart":
            # In particular, do not accept a caller-provided container/image/command field.
            send(connection, {"ok": False, "code": "invalid_request"})
            return
        send(connection, {"ok": False, "code": "update_unavailable"})


def healthcheck() -> int:
    """Local liveness probe used by the Docker sidecar healthcheck."""
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(1)
            connection.connect(SOCKET_PATH)
            connection.sendall(b'{"action":"status"}\n')
            response = connection.recv(512)
        return 0 if b'"ok":true' in response else 1
    except OSError:
        return 1


def main() -> None:
    socket_path = Path(SOCKET_PATH)
    socket_path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    if socket_path.exists():
        if not stat.S_ISSOCK(socket_path.stat().st_mode):
            raise RuntimeError("maintenance socket path exists and is not a socket")
        socket_path.unlink()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o600)
        listener.listen()
        print(f"CozyGateway maintenance supervisor listening on {SOCKET_PATH}", flush=True)
        while True:
            connection, _ = listener.accept()
            threading.Thread(target=handle, args=(connection,), daemon=True).start()


if __name__ == "__main__":
    if "--healthcheck" in sys.argv[1:]:
        raise SystemExit(healthcheck())
    main()

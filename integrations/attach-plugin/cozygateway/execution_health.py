"""Loopback readiness and parent-lease supervision for one execution child."""
from __future__ import annotations

import json
import os
import signal
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional


class ExecutionHealth:
    def __init__(self, *, agent_id: str, incarnation: str, port: int, transfer_required: bool) -> None:
        self.agent_id, self.incarnation, self.port = agent_id, incarnation, port
        self.transfer_required = transfer_required
        self._lock = threading.Lock()
        self._attach_online = False
        self._configured = False
        self._server: Optional[ThreadingHTTPServer] = None

    def ready_payload(self) -> tuple[int, dict[str, Any]]:
        with self._lock:
            ready = self._attach_online and self._configured
            payload: dict[str, Any] = {
                "agentId": self.agent_id, "incarnation": self.incarnation, "ready": ready,
                "attach": {"state": "online" if self._attach_online else "connecting"},
            }
            if not ready:
                payload["model"] = {"probe": {"reason": "credentials_pending" if self.transfer_required else "configuration_pending"}}
            return (HTTPStatus.OK if ready else HTTPStatus.SERVICE_UNAVAILABLE, payload)

    def mark_attach_online(self) -> None:
        with self._lock: self._attach_online = True

    def mark_configuration_ready(self) -> None:
        with self._lock: self._configured = True

    def start(self) -> None:
        health = self
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path != "/ready":
                    self.send_error(HTTPStatus.NOT_FOUND); return
                status, payload = health.ready_payload()
                body = json.dumps(payload, separators=(",", ":")).encode()
                self.send_response(status); self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
            def log_message(self, _fmt: str, *_args: object) -> None: pass
        self._server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        threading.Thread(target=self._server.serve_forever, daemon=True, name="cozygateway-execution-health").start()


_current: Optional[ExecutionHealth] = None
_lock = threading.Lock()


def start_from_environment() -> Optional[ExecutionHealth]:
    global _current
    execution_id = os.getenv("COZYGATEWAY_EXECUTION_ID", "").strip()
    incarnation = os.getenv("COZYAGENTS_INCARNATION", "").strip()
    try: port = int(os.getenv("COZYAGENTS_HEALTH_PORT", ""))
    except ValueError: port = 0
    if not execution_id or not incarnation or not 1 <= port <= 65535:
        return None
    with _lock:
        if _current is not None: return _current
        current = ExecutionHealth(agent_id=execution_id, incarnation=incarnation, port=port,
                                  transfer_required=os.getenv("COZYGATEWAY_TRANSFER_REQUIRED") == "1")
        current.start(); _current = current
        _watch_parent_lease()
        return current


def current() -> Optional[ExecutionHealth]: return _current


def _watch_parent_lease() -> None:
    try: fd = int(os.getenv("COZYAGENTS_PARENT_LEASE_FD", ""))
    except ValueError: return
    if fd < 0: return
    def watch() -> None:
        try:
            while os.read(fd, 1): pass
        except OSError:
            return
        # SIGTERM gives Hermes gateway its ordinary drain/cleanup path.
        os.kill(os.getpid(), signal.SIGTERM)
    threading.Thread(target=watch, daemon=True, name="cozygateway-parent-lease").start()

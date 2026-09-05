"""Private, local storage for OpenAI-compatible provider connections."""
from __future__ import annotations

import json
import os
import ssl
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): raise HTTPError(req.full_url, code, "redirect refused", headers, fp)


class ProviderConnectionStore:
    def __init__(self, path: Optional[Path] = None) -> None:
        home = Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))
        self._path = path or Path(os.getenv("COZYGATEWAY_PROVIDER_CONNECTIONS_PATH") or (home / "cozygateway-provider-connections.json"))

    def catalog(self) -> Dict[str, List[Dict[str, Any]]]: return {"connections": [self._public(row) for row in self._read()]}

    def save(self, input_value: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
        rows = self._read(); requested = input_value.get("id")
        row = next((item for item in rows if item["id"] == requested), None)
        if requested is not None and row is None:
            raise KeyError(requested)
        if row is None:
            row = {"id": requested or f"custom-{uuid.uuid4()}", "models": [], "status": "unchecked"}; rows.append(row)
        row.update({key: input_value[key] for key in ("name", "baseUrl")})
        if "apiKey" in input_value:
            if input_value["apiKey"] is None: row.pop("apiKey", None)
            else: row["apiKey"] = input_value["apiKey"]
        if "manualModels" in input_value: row["manualModels"] = list(input_value["manualModels"] or [])
        row.setdefault("manualModels", []); row.setdefault("models", []); row.setdefault("status", "unchecked")
        self._write(rows); return self.catalog()

    def transfer_payload(self, identifier: str) -> Dict[str, Any]:
        """Private one-time payload. The caller must send it directly to the authenticated
        Gateway transfer endpoint; it is never an attach config result or durable frame."""
        row = next((item for item in self._read() if item.get("id") == identifier), None)
        if row is None: raise KeyError(identifier)
        manual = sorted(set(row.get("manualModels") or []) | set(row.get("models") or []))
        value = {"id": row["id"], "name": row["name"], "baseUrl": row["baseUrl"], "manualModels": manual}
        if isinstance(row.get("apiKey"), str) and row["apiKey"]: value["apiKey"] = row["apiKey"]
        return value

    def import_connection(self, input_value: Dict[str, Any]) -> Dict[str, List[Dict[str, Any]]]:
        """Accept only a gateway handoff's original custom identity for a scoped execution."""
        identifier = input_value.get("id")
        if not isinstance(identifier, str) or not identifier.startswith("custom-"):
            raise KeyError(identifier)
        rows = self._read()
        if any(row.get("id") == identifier for row in rows): raise KeyError(identifier)
        required = ("name", "baseUrl")
        if any(not isinstance(input_value.get(key), str) or not input_value[key] for key in required):
            raise ValueError("provider handoff is incomplete")
        manual = input_value.get("manualModels")
        if manual is not None and (not isinstance(manual, list) or any(not isinstance(item, str) or not item for item in manual)):
            raise ValueError("provider handoff models are invalid")
        row = {"id": identifier, "name": input_value["name"], "baseUrl": input_value["baseUrl"],
               "manualModels": sorted(set(manual or [])), "models": [], "status": "unchecked"}
        if isinstance(input_value.get("apiKey"), str) and input_value["apiKey"]: row["apiKey"] = input_value["apiKey"]
        rows.append(row); self._write(rows); return self.catalog()

    def remove(self, identifier: str) -> Dict[str, List[Dict[str, Any]]]:
        self._write([row for row in self._read() if row.get("id") != identifier]); return self.catalog()

    def test(self, identifier: str) -> Dict[str, List[Dict[str, Any]]]:
        rows = self._read(); row = next((item for item in rows if item.get("id") == identifier), None)
        if row is None: raise KeyError(identifier)
        try:
            url = str(row["baseUrl"]).rstrip("/") + "/models"
            headers = {"accept": "application/json"}
            if row.get("apiKey"): headers["authorization"] = f"Bearer {row['apiKey']}"
            opener = build_opener(_NoRedirect(), HTTPSHandler(context=ssl.create_default_context()))
            with opener.open(Request(url, headers=headers, method="GET"), timeout=8) as response:
                payload = json.loads(response.read(1_000_000).decode("utf-8"))
            models = payload.get("data", []) if isinstance(payload, dict) else []
            row["models"] = sorted({item.get("id") for item in models if isinstance(item, dict) and isinstance(item.get("id"), str) and item["id"]})
            row["status"] = "connected"; row["lastCheckedAt"] = int(time.time() * 1000)
        except (HTTPError, URLError, OSError, ValueError, json.JSONDecodeError):
            row["status"] = "unreachable"; row["lastCheckedAt"] = int(time.time() * 1000)
        self._write(rows); return self.catalog()

    def runtime_override(self, identifier: str, model: str) -> Optional[Dict[str, str]]:
        """A process-local override for one running Hermes session; never serialize this result."""
        row = next((item for item in self._read() if item.get("id") == identifier), None)
        if row is None: return None
        value = {"provider": identifier, "model": model, "base_url": str(row["baseUrl"])}
        if isinstance(row.get("apiKey"), str) and row["apiKey"]: value["api_key"] = row["apiKey"]
        return value

    def _read(self) -> List[Dict[str, Any]]:
        try:
            data = json.loads(self._path.read_text())
            return data if isinstance(data, list) else []
        except (OSError, ValueError): return []

    def _write(self, rows: List[Dict[str, Any]]) -> None:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".provider-", dir=self._path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as handle: json.dump(rows, handle, separators=(",", ":"))
            os.replace(temporary, self._path); os.chmod(self._path, 0o600)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)

    @staticmethod
    def _public(row: Dict[str, Any]) -> Dict[str, Any]:
        return {"id": row["id"], "name": row["name"], "baseUrl": row["baseUrl"], "hasApiKey": bool(row.get("apiKey")),
                "models": list(row.get("models") or []), "manualModels": list(row.get("manualModels") or []),
                "status": row.get("status", "unchecked"), **({"lastCheckedAt": row["lastCheckedAt"]} if isinstance(row.get("lastCheckedAt"), int) else {})}


class BotModelDefaultStore:
    """Profile-local, non-secret default selected through the bot model surface.

    Hermes owns ordinary provider configuration.  A CozyGateway custom connection is deliberately
    separate, so its selected ``custom-uuid:model`` reference lives beside that private connection
    catalog.  This file never contains an endpoint credential; resolution happens at turn time.
    """
    def __init__(self, path: Optional[Path] = None) -> None:
        home = Path(os.getenv("HERMES_HOME") or (Path.home() / ".hermes"))
        self._path = path or Path(os.getenv("COZYGATEWAY_BOT_MODEL_PATH") or (home / "cozygateway-bot-model.json"))

    def read(self) -> Dict[str, Optional[str]]:
        try:
            value = json.loads(self._path.read_text())
        except (OSError, ValueError):
            value = {}
        if not isinstance(value, dict): value = {}
        model = value.get("model")
        return {"model": model if isinstance(model, str) and model else None, "effort": None}

    def write(self, model: Optional[str]) -> Dict[str, Optional[str]]:
        self._path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".bot-model-", dir=self._path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w") as handle: json.dump({"model": model}, handle, separators=(",", ":"))
            os.replace(temporary, self._path); os.chmod(self._path, 0o600)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)
        return self.read()

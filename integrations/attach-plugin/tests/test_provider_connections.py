import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from cozygateway.adapter import AttachAdapter
from cozygateway.provider_connections import ProviderConnectionStore
from cozygateway import private_files


class ProviderConnectionTests(unittest.TestCase):
    def test_catalog_projects_no_secret_and_manual_models_survive_discovery_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "providers.json"; store = ProviderConnectionStore(path)
            catalog = store.save({"name":"Local","baseUrl":"http://127.0.0.1:1/v1","apiKey":"secret","manualModels":["manual"]})
            row = catalog["connections"][0]; self.assertTrue(row["hasApiKey"]); self.assertNotIn("apiKey", row); self.assertEqual(row["manualModels"], ["manual"])
            catalog = store.test(row["id"]); self.assertEqual(catalog["connections"][0]["status"], "unreachable"); self.assertEqual(catalog["connections"][0]["manualModels"], ["manual"])
            self.assertIn("secret", path.read_text())
            with path.open("rb") as handle:
                private_files.assert_private_fd(handle.fileno())
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_privacy_failure_closes_empty_temp_and_preserves_existing_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "providers.json"
            store = ProviderConnectionStore(path)
            row = store.save({"name": "Local", "baseUrl": "https://example.test/v1", "apiKey": "old-secret"})["connections"][0]
            original = path.read_bytes()
            closed = []
            secure = private_files.secure_path

            def refuse_file(candidate, *, directory=False, fd=None):
                if directory:
                    return secure(candidate, directory=True)
                self.assertEqual(os.fstat(fd).st_size, 0, "privacy precedes secret bytes")
                closed.append(fd)
                raise PermissionError("privacy refused")

            with patch.object(private_files, "secure_path", side_effect=refuse_file):
                with self.assertRaisesRegex(PermissionError, "privacy refused"):
                    store.save({"id": row["id"], "name": "Local", "baseUrl": "https://example.test/v1", "apiKey": "new-secret"})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.glob(".private-*")), [])
            for fd in closed:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_temp_is_private_before_credentials_are_written(self):
        with tempfile.TemporaryDirectory() as directory:
            secure = private_files.secure_path
            inspected = []

            def inspect(candidate, *, directory=False, fd=None):
                secure(candidate, directory=directory, fd=fd)
                if fd is not None:
                    self.assertEqual(os.fstat(fd).st_size, 0)
                    private_files.assert_private_fd(fd)
                    inspected.append(candidate)

            with patch.object(private_files, "secure_path", side_effect=inspect):
                ProviderConnectionStore(Path(directory) / "providers.json").save({"name": "Local", "baseUrl": "https://example.test/v1", "apiKey": "secret"})
            self.assertEqual(len(inspected), 1)

    def test_linked_store_parent_cannot_read_or_overwrite_an_outside_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            outside = root / "outside"; outside.mkdir()
            path = outside / "providers.json"
            ProviderConnectionStore(path).save({"name": "Local", "baseUrl": "https://example.test/v1", "apiKey": "outside-secret"})
            original = path.read_bytes()
            linked = root / "linked"
            if os.name == "nt":
                subprocess.run(["cmd", "/c", "mklink", "/J", str(linked), str(outside)], check=True, capture_output=True)
            else:
                linked.symlink_to(outside, target_is_directory=True)
            store = ProviderConnectionStore(linked / "providers.json")
            with self.assertRaisesRegex(OSError, "link or reparse"):
                store.catalog()
            with self.assertRaisesRegex(OSError, "link or reparse"):
                store.save({"name": "Local", "baseUrl": "https://example.test/v1", "apiKey": "replacement"})
            self.assertEqual(path.read_bytes(), original)

    def test_custom_runtime_override_is_private_and_complete(self):
        with tempfile.TemporaryDirectory() as directory:
            store = ProviderConnectionStore(Path(directory) / "providers.json")
            row = store.save({"name":"Local","baseUrl":"https://example.test/v1","apiKey":"secret"})["connections"][0]
            self.assertEqual(store.runtime_override(row["id"], "model"), {"provider":row["id"],"model":"model","base_url":"https://example.test/v1","api_key":"secret"})

    def test_transfer_payload_merges_discovered_models_and_import_preserves_the_custom_id(self):
        with tempfile.TemporaryDirectory() as directory:
            source = ProviderConnectionStore(Path(directory) / "source.json")
            saved = source.save({"name":"Local","baseUrl":"https://example.test/v1","apiKey":"secret","manualModels":["manual"]})
            identifier = saved["connections"][0]["id"]
            rows = source._read(); rows[0]["models"] = ["discovered"]; source._write(rows)
            payload = source.transfer_payload(identifier)
            self.assertEqual(payload["id"], identifier); self.assertEqual(payload["manualModels"], ["discovered", "manual"])
            target = ProviderConnectionStore(Path(directory) / "target.json")
            catalog = target.import_connection(payload)
            self.assertEqual(catalog["connections"][0]["id"], identifier)
            self.assertEqual(catalog["connections"][0]["manualModels"], ["discovered", "manual"])
            with self.assertRaises(KeyError): target.save({"id":"custom-unknown","name":"Nope","baseUrl":"https://example.test"})


class ProviderTransferAdapterTests(unittest.IsolatedAsyncioTestCase):
    def _adapter(self, store, client, execution_id=None):
        adapter = object.__new__(AttachAdapter)
        adapter._provider_connections = store; adapter._client = client; adapter._execution_id = execution_id
        return adapter

    async def test_transfer_posts_private_payload_and_import_is_scoped(self):
        class SourceClient:
            def __init__(self): self.sent = None
            async def transfer_provider_connection(self, execution_id, payload): self.sent = (execution_id, payload); return "handoff"
        class TargetClient:
            async def fetch_provider_handoff(self, handoff_id):
                return {"id":identifier,"name":"Local","baseUrl":"https://example.test/v1","apiKey":"secret","manualModels":["manual"]} if handoff_id == "handoff" else None
        with tempfile.TemporaryDirectory() as directory:
            source = ProviderConnectionStore(Path(directory) / "source.json")
            identifier = source.save({"name":"Local","baseUrl":"https://example.test/v1","apiKey":"secret","manualModels":["manual"]})["connections"][0]["id"]
            client = SourceClient()
            result = await self._adapter(source, client)._on_config_request({"operation":"providers.connections.transfer","input":{"id":identifier,"executionId":"execution"}})
            self.assertEqual(result, {"status":"ok","result":{"handoffId":"handoff"}}); self.assertEqual(client.sent[0], "execution"); self.assertEqual(client.sent[1]["apiKey"], "secret")
            target = ProviderConnectionStore(Path(directory) / "target.json")
            imported = await self._adapter(target, TargetClient(), "execution")._on_config_request({"operation":"providers.connections.import","input":{"handoffId":"handoff"}})
            self.assertEqual(imported["status"], "ok"); self.assertEqual(imported["result"]["connections"][0]["id"], identifier)
            refused = await self._adapter(ProviderConnectionStore(Path(directory) / "third.json"), TargetClient())._on_config_request({"operation":"providers.connections.import","input":{"handoffId":"handoff"}})
            self.assertEqual(refused["status"], "unavailable")

    def test_discovery_projects_models_without_exposing_the_bearer_or_losing_manual_fallback(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *_args): return None
            def read(self, _limit): return b'{"data":[{"id":"remote"},{"id":"remote"}]}'
        class Opener:
            def __init__(self): self.request = None
            def open(self, request, timeout): self.request = request; return Response()
        with tempfile.TemporaryDirectory() as directory:
            opener = Opener(); store = ProviderConnectionStore(Path(directory) / "providers.json")
            row = store.save({"name":"Local","baseUrl":"https://example.test/v1","apiKey":"secret","manualModels":["manual"]})["connections"][0]
            with patch("cozygateway.provider_connections.build_opener", return_value=opener):
                catalog = store.test(row["id"])
            public = catalog["connections"][0]
            self.assertEqual(public["status"], "connected"); self.assertEqual(public["models"], ["remote"])
            self.assertEqual(public["manualModels"], ["manual"]); self.assertNotIn("secret", repr(public))
            self.assertEqual(opener.request.get_header("Authorization"), "Bearer secret")

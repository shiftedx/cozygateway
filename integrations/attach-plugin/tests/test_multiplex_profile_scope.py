"""One multiplexed Hermes gateway, many profiles: each attach uses its OWN profile's settings.

A multiplexed Hermes gateway (``gateway.multiplex_profiles: true``) serves every profile from one
process whose ``os.environ`` is the launch (default) profile's. A secondary profile's ``.env`` never
enters ``os.environ``; Hermes binds it around that profile's config load, ``_create_adapter`` and
``connect`` instead (``gateway/run.py::_profile_runtime_scope``: a context-local home override plus
``agent.secret_scope.set_secret_scope`` built from ``<profile home>/.env``). Built-in platforms read
their credentials through that scope (``gateway/config.py::_getenv``), and so must this plugin.

These cases bind the scope with Hermes' own API, the way ``_profile_runtime_scope`` does, and so
need Hermes importable (run the suite with Hermes' venv python, as tests/README.md says). They
deliberately avoid importing ``gateway.*``: other files in this suite replace those modules.
"""

import contextlib
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from cozygateway import adapter as adapter_module
from cozygateway.adapter import AttachAdapter

try:
    from agent import secret_scope as hermes_secret_scope
    import hermes_constants
except Exception:  # noqa: BLE001 - no Hermes on this interpreter
    hermes_secret_scope = None
    hermes_constants = None

_KEYS = (
    "COZYGATEWAY_URL", "COZYGATEWAY_TOKEN", "COZYGATEWAY_SPOOL_PATH", "COZYGATEWAY_HOME_CHANNEL",
    "COZYGATEWAY_CA_FILE", "COZYGATEWAY_RECONNECT_MAX_SECONDS", "COZYGATEWAY_PROVIDER_CONNECTIONS_PATH",
    "COZYGATEWAY_BOT_MODEL_PATH", "HERMES_PROFILE",
)


@unittest.skipIf(hermes_secret_scope is None, "needs Hermes importable (run with Hermes' venv python)")
class MultiplexedProfileScopeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name) / "hermes"
        # The host process: launched as the default profile, whose .env Hermes loaded into
        # os.environ. Its attach settings must never reach another profile's adapter.
        env = {key: "" for key in _KEYS}
        env.update({
            "HERMES_HOME": str(self.root),
            "COZYGATEWAY_URL": "http://default-gateway.invalid:1",
            "COZYGATEWAY_TOKEN": "default-token",
            "COZYGATEWAY_SPOOL_PATH": str(self.root / "default-spool.sqlite"),
        })
        patcher = patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        for key in [k for k, v in env.items() if v == ""]:
            os.environ.pop(key, None)
        self.alpha = self._profile("alpha", {
            "COZYGATEWAY_URL": "http://alpha-gateway.invalid:2",
            "COZYGATEWAY_TOKEN": "alpha-token",
            "COZYGATEWAY_SPOOL_PATH": str(self.root / "profiles/alpha/plugin-data/attach-v1.sqlite"),
            "COZYGATEWAY_RECONNECT_MAX_SECONDS": "7",
        })
        self.beta = self._profile("beta", {
            "COZYGATEWAY_URL": "http://beta-gateway.invalid:3",
            "COZYGATEWAY_TOKEN": "beta-token",
            "COZYGATEWAY_SPOOL_PATH": str(self.root / "profiles/beta/plugin-data/attach-v1.sqlite"),
        })
        self.addCleanup(hermes_secret_scope.set_multiplex_active, False)

    def _profile(self, name, values):
        home = self.root / "profiles" / name
        home.mkdir(parents=True)
        (home / ".env").write_text("".join(f"{k}={v}\n" for k, v in values.items()))
        return home

    @contextlib.contextmanager
    def _served(self, home):
        """What ``gateway/run.py::_profile_runtime_scope`` binds on a multiplexed gateway."""
        hermes_secret_scope.set_multiplex_active(True)
        home_token = hermes_constants.set_hermes_home_override(str(home))
        mapping = hermes_secret_scope.load_env_file(Path(home) / ".env")
        secret_token = hermes_secret_scope.set_secret_scope(mapping, profile_home=str(home))
        try:
            yield
        finally:
            hermes_secret_scope.reset_secret_scope(secret_token)
            hermes_constants.reset_hermes_home_override(home_token)

    def _adapter(self, extra=None):
        adapter = AttachAdapter()
        adapter._attach_init(types.SimpleNamespace(extra=dict(extra or {})))
        return adapter

    def test_a_served_profile_is_configured_from_its_own_env(self):
        # Hermes enables a plugin platform only when is_connected() says so, evaluated while
        # loading that profile's config under its scope (gateway/config_env.py
        # _enable_plugin_platform). Reading os.environ here is why cleo got no cozygateway.
        os.environ.pop("COZYGATEWAY_URL"); os.environ.pop("COZYGATEWAY_TOKEN")
        with self._served(self.alpha):
            self.assertTrue(adapter_module.is_connected())

    def test_each_served_profile_gets_its_own_token_url_spool_and_identity(self):
        with self._served(self.alpha):
            alpha = self._adapter()
        with self._served(self.beta):
            beta = self._adapter()
        self.assertEqual((alpha.gateway_url, alpha.token), ("http://alpha-gateway.invalid:2", "alpha-token"))
        self.assertEqual((beta.gateway_url, beta.token), ("http://beta-gateway.invalid:3", "beta-token"))
        self.assertEqual(alpha._spool_path, str(self.root / "profiles/alpha/plugin-data/attach-v1.sqlite"))
        self.assertEqual(beta._spool_path, str(self.root / "profiles/beta/plugin-data/attach-v1.sqlite"))
        self.assertEqual((alpha._profile, beta._profile), ("alpha", "beta"))
        # Every COZYGATEWAY_* knob follows the owning profile too, not the host env.
        self.assertEqual(alpha._reconnect_max, 7.0)
        self.assertEqual(beta._reconnect_max, 30.0)

    def test_a_profile_missing_its_own_values_never_borrows_the_host_token(self):
        (self.beta / ".env").write_text("")
        with self._served(self.beta):
            self.assertFalse(adapter_module.is_connected())
            beta = self._adapter()
        self.assertEqual((beta.gateway_url, beta.token), ("", ""))
        self.assertIsNone(beta._spool_path)

    async def test_a_profile_missing_its_values_does_not_start(self):
        (self.beta / ".env").write_text("")
        with self._served(self.beta):
            beta = self._adapter()
        beta._set_fatal_error = lambda *args, **kwargs: setattr(beta, "fatal", args)
        self.assertFalse(await beta.connect())
        self.assertEqual(beta.fatal[0], "config_missing")

    def test_unset_spool_defaults_under_the_owning_profile_not_the_shared_host_path(self):
        (self.beta / ".env").write_text("COZYGATEWAY_URL=http://b.invalid:3\nCOZYGATEWAY_TOKEN=beta-token\n")
        with self._served(self.beta):
            path = adapter_module._proactive_spool_path(types.SimpleNamespace(extra={}), None)
        self.assertEqual(path, str(self.beta / "cozygateway-attach-v1.sqlite"))

    def test_proactive_sender_resolves_the_job_owning_profile(self):
        # Hermes cron runs a job under the job-owning profile's scope (run_one_job), then calls
        # this plugin's standalone sender with that profile's PlatformConfig.
        with self._served(self.alpha):
            path = adapter_module._proactive_spool_path(types.SimpleNamespace(extra={}), None)
            settings = adapter_module._attach_settings(types.SimpleNamespace(extra={}))
        self.assertEqual(path, str(self.root / "profiles/alpha/plugin-data/attach-v1.sqlite"))
        self.assertEqual((settings.gateway_url, settings.token), ("http://alpha-gateway.invalid:2", "alpha-token"))

    def test_profile_local_stores_live_under_the_owning_profile(self):
        from cozygateway.provider_connections import BotModelDefaultStore, ProviderConnectionStore

        with self._served(self.alpha):
            connections, defaults = ProviderConnectionStore(), BotModelDefaultStore()
        self.assertEqual(connections._path, self.alpha / "cozygateway-provider-connections.json")
        self.assertEqual(defaults._path, self.alpha / "cozygateway-bot-model.json")

    def test_chat_projects_come_from_the_owning_profile(self):
        from cozygateway.chat_context import HermesChatContext

        host_root, alpha_root = self.root / "host-project", self.root / "alpha-project"
        host_root.mkdir(); alpha_root.mkdir()
        os.environ["COZYGATEWAY_CHAT_PROJECTS_JSON"] = (
            f'[{{"computerId":"hermes:alpha","projectId":"host","root":"{host_root}"}}]')
        with (self.alpha / ".env").open("a") as env:
            env.write(f'COZYGATEWAY_CHAT_PROJECTS_JSON=[{{"computerId":"hermes:alpha","projectId":"mine","root":"{alpha_root}"}}]\n')
        with self._served(self.alpha):
            rows = HermesChatContext("alpha").projects("hermes:alpha")
        self.assertEqual([row["id"] for row in rows], ["mine"])

    def test_token_refresh_rereads_the_owning_profile_even_outside_its_scope(self):
        with self._served(self.alpha):
            alpha = self._adapter()
            provider = alpha._attach_token_provider()
        (self.alpha / ".env").write_text("COZYGATEWAY_TOKEN=alpha-rotated\n")
        self.assertEqual(provider(), "alpha-rotated")
        # Its .env losing the token falls back to what the profile had, never the host's token.
        (self.alpha / ".env").write_text("")
        self.assertEqual(provider(), "alpha-token")

    def test_an_unscoped_read_on_a_multiplexed_host_never_sees_the_host_env(self):
        # Hermes fails closed here (agent/secret_scope.py get_secret raises UnscopedSecretError): an
        # unscoped read on a multiplexer has no owning profile, and os.environ is another's.
        hermes_secret_scope.set_multiplex_active(True)
        from cozygateway.profile_env import profile_env
        self.assertIsNone(profile_env("COZYGATEWAY_TOKEN"))
        self.assertEqual(profile_env("COZYGATEWAY_TOKEN", "unset"), "unset")
        self.assertFalse(adapter_module.is_connected())

    def test_the_launch_profile_adapter_gets_its_settings_from_its_own_config(self):
        # Hermes builds the launch (default) profile's adapter unscoped on a multiplexer, from the
        # PlatformConfig it loaded under that profile's scope (gateway/run.py
        # load_gateway_config_for_runner). env_enablement_fn is how a plugin seeds that config.
        (self.root / ".env").parent.mkdir(parents=True, exist_ok=True)
        (self.root / ".env").write_text(
            "COZYGATEWAY_URL=http://launch-gateway.invalid:4\nCOZYGATEWAY_TOKEN=launch-token\n"
            f"COZYGATEWAY_SPOOL_PATH={self.root}/launch-spool.sqlite\n")
        with self._served(self.root):
            seed = adapter_module._env_enablement()
        self.assertEqual(seed["gateway_url"], "http://launch-gateway.invalid:4")
        self.assertEqual(seed["spool_path"], f"{self.root}/launch-spool.sqlite")
        hermes_secret_scope.set_multiplex_active(True)
        launch = self._adapter(seed)
        self.assertEqual((launch.gateway_url, launch.token), ("http://launch-gateway.invalid:4", "launch-token"))
        self.assertEqual(launch._spool_path, f"{self.root}/launch-spool.sqlite")

    def test_the_seed_is_absent_for_a_profile_without_its_own_attach_settings(self):
        (self.beta / ".env").write_text("")
        with self._served(self.beta):
            self.assertIsNone(adapter_module._env_enablement())


class StandaloneProfileEnvTests(unittest.TestCase):
    """No profile scope bound: a standalone gateway IS its profile, so os.environ is the contract."""

    def test_unscoped_reads_come_from_the_process_env_first(self):
        env = {
            "COZYGATEWAY_URL": "http://standalone.invalid:4", "COZYGATEWAY_TOKEN": "standalone-token",
            "COZYGATEWAY_SPOOL_PATH": "/tmp/standalone-spool.sqlite", "HERMES_HOME": "/srv/hermes/profiles/cleo",
            "HERMES_PROFILE": "",
        }
        with patch.dict(os.environ, env):
            self.assertTrue(adapter_module.is_connected())
            adapter = AttachAdapter()
            adapter._attach_init(types.SimpleNamespace(extra={"gateway_url": "http://extra.invalid", "token": "extra"}))
        self.assertEqual((adapter.gateway_url, adapter.token), ("http://standalone.invalid:4", "standalone-token"))
        self.assertEqual(adapter._spool_path, "/tmp/standalone-spool.sqlite")
        self.assertEqual(adapter._profile, "cleo")

    @unittest.skipIf(hermes_secret_scope is None, "needs Hermes importable (run with Hermes' venv python)")
    def test_a_cron_scope_on_a_standalone_gateway_keeps_the_standalone_token_refresh(self):
        # Hermes cron binds the firing profile's secret scope even on a standalone gateway
        # (cron/scheduler.py), stamped with the process's own home and no home override. That is
        # not a routed profile, so the adapter keeps rereading $HERMES_HOME/.env for a rotated token.
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "profiles" / "cleo"
            home.mkdir(parents=True)
            (home / ".env").write_text("COZYGATEWAY_URL=http://standalone.invalid:5\nCOZYGATEWAY_TOKEN=v1\n")
            with patch.dict(os.environ, {"HERMES_HOME": str(home), "COZYGATEWAY_URL": "", "COZYGATEWAY_TOKEN": ""}):
                mapping = hermes_secret_scope.load_env_file(home / ".env")
                token = hermes_secret_scope.set_secret_scope(mapping, profile_home=str(home))
                try:
                    adapter = AttachAdapter()
                    adapter._attach_init(types.SimpleNamespace(extra={}))
                    provider = adapter._attach_token_provider()
                finally:
                    hermes_secret_scope.reset_secret_scope(token)
                self.assertEqual(adapter.token, "v1")
                (home / ".env").write_text("COZYGATEWAY_URL=http://standalone.invalid:5\nCOZYGATEWAY_TOKEN=v2\n")
                self.assertEqual(provider(), "v2")

    def test_unscoped_default_spool_is_unchanged(self):
        with patch.dict(os.environ, {"COZYGATEWAY_SPOOL_PATH": ""}):
            path = adapter_module._proactive_spool_path(types.SimpleNamespace(extra={}), None)
        self.assertEqual(path, os.path.join(os.path.expanduser("~"), ".hermes", "cozygateway-attach-v1.sqlite"))


if __name__ == "__main__":
    unittest.main()

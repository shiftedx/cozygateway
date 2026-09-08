#!/usr/bin/env python3
"""Disposable verified-bootstrap migration; no real service or gateway calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class NativeHygieneTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cozy-install-hygiene-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / "user"
        self.hermes = self.base / "hermes"
        self.gateway = self.base / "gateway"
        self.bin = self.base / "bin"
        self.assets = self.base / "release"
        self.node = os.environ.get("COZYGATEWAY_TEST_REAL_NODE") or shutil.which("node")
        version = subprocess.check_output([self.node, "-p", "process.versions.node"], text=True)
        self.assertEqual(version.split(".")[0], "24", "run this fixture with Node.js 24 on PATH")
        for path in (self.home, self.bin, self.assets, self.hermes):
            path.mkdir(parents=True)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:" + os.environ["PATH"],
                        COZYGATEWAY_HOME=str(self.gateway), COZYGATEWAY_NODE=self.node,
                        COZYGATEWAY_HERMES_BIN=str(self.bin / "hermes"),
                        COZYGATEWAY_SERVICE_PLATFORM="Darwin", FIXTURE_HERMES=str(self.hermes),
                        FIXTURE_GATEWAY=str(self.gateway), COZYGATEWAY_INSTALL_ASSET_BASE=self.assets.as_uri())
        self.executable("hermes", '''#!/bin/bash
if [ "$1" = status ]; then printf 'Current model: fixture/model\nActive provider: fixture\n'; exit 0; fi
if [ "$1" = -p ] && [ "$3" = config ] && [ "$4" = path ]; then
  if [ "$2" = default ]; then printf '%s/config.yaml\n' "$FIXTURE_HERMES"; else printf '%s/profiles/%s/config.yaml\n' "$FIXTURE_HERMES" "$2"; fi
elif [ "$1" = -p ] && [ "$3" = gateway ] && [ "$4" = status ]; then printf 'Gateway is supervised\n'
elif [ "$1" = -p ] && [ "$3" = config ] && [ "$4" = get ]; then printf '[]\n'
fi
exit 0
''')
        self.executable("launchctl", "#!/bin/sh\nexit 0\n")
        real_curl = shutil.which("curl")
        self.executable("curl", f'''#!/bin/bash
case "$*" in *file://*) exec '{real_curl}' "$@" ;; esac
case "$*" in
 *api/health*) printf 401 ;;
 *api/config*) printf 200 ;;
 *health*) case "$*" in *http_code*) printf 200 ;; *) printf '{{"attach":{{"configured":1,"online":1,"deadLetters":0}}}}' ;; esac ;;
 *) printf 200 ;;
esac
''')
        for name in ("default", "keeper", "retired", "unselected"):
            self.profile(name).mkdir(parents=True, exist_ok=True)
            (self.profile(name) / "config.yaml").write_text("display:\n  streaming: true\n  platforms:\n    cozygateway:\n      streaming: true\nstreaming:\n  edit_interval: 0.05\n  buffer_threshold: 1\n")
        (self.profile("unselected") / ".env").write_text("FOREIGN_SETTING=preserved\n")
        (self.assets / "cozygateway.mjs").write_text("// fixture CLI: service and readiness are isolated doubles\n")
        for source, name in (("scripts/agent-install.sh", "cozygateway-installer.sh"),
                             ("scripts/install.sh", "install.sh"),
                             ("scripts/gateway-supervisor.cjs", "gateway-supervisor.cjs")):
            shutil.copyfile(ROOT / source, self.assets / name)
        with tarfile.open(self.assets / "cozygateway-hermes-attach-plugin.tar.gz", "w:gz") as archive:
            archive.add(ROOT / "integrations/attach-plugin", arcname="attach-plugin")
        for asset in list(self.assets.iterdir()):
            (asset.with_name(asset.name + ".sha256")).write_text(hashlib.sha256(asset.read_bytes()).hexdigest() + "  " + asset.name + "\n")
        self.run_bootstrap("--harness", "hermes", "--profiles", "keeper,retired", "--no-qr")
        self.state = self.gateway / "local/install-state"
        # Older releases have the same recorded ownership fields but no hygiene version.
        self.state.write_text("\n".join(line for line in self.state.read_text().splitlines() if not line.startswith("install_hygiene_version=")) + "\n")
        self.config = self.gateway / "local/cozygateway.config.json"
        self.envfile = self.gateway / "local/gateway.env"
        self.keeper_token = self.envfile.read_text().split("COZYGATEWAY_ATTACH_TOKEN_KEEPER=")[1].splitlines()[0]
        self.envfile.write_text(self.envfile.read_text() + "# operator settings\nSHARED_RUNTIME_TOKEN=preserve-this\nCUSTOM_URL=https://example.invalid\n")
        config = json.loads(self.config.read_text())
        config["operatorSetting"] = {"preserve": True}
        self.config.write_text(json.dumps(config))
        self.history = self.gateway / "local/cozygateway.sqlite"
        self.history.write_bytes(b"keeper and shared room history fixture")
        self.backup = self.hermes / "profile-backups/retired/history.db"
        self.backup.parent.mkdir(parents=True)
        self.backup.write_bytes(b"archived fixture")
        shutil.rmtree(self.profile("retired"))

    def profile(self, name):
        return self.hermes if name == "default" else self.hermes / "profiles" / name

    def executable(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o700)

    def run_bootstrap(self, *args, success=True):
        result = subprocess.run(["bash", str(ROOT / "scripts/install.sh"), *args], env=self.env, capture_output=True, text=True, timeout=40)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def assert_repaired(self):
        config = json.loads(self.config.read_text())
        self.assertEqual(list(config["hermesEndpoints"][0]["profiles"]), ["keeper"])
        self.assertEqual(config["operatorSetting"], {"preserve": True})
        self.assertNotIn("COZYGATEWAY_ATTACH_TOKEN_RETIRED=", self.envfile.read_text())
        self.assertIn("COZYGATEWAY_ATTACH_TOKEN_KEEPER=" + self.keeper_token, self.envfile.read_text())
        self.assertIn("# operator settings\nSHARED_RUNTIME_TOKEN=preserve-this\nCUSTOM_URL=https://example.invalid\n", self.envfile.read_text())
        self.assertIn("profiles=keeper\n", self.state.read_text())
        self.assertIn("profile_scope=keeper\n", self.state.read_text())
        self.assertEqual(self.history.read_bytes(), b"keeper and shared room history fixture")
        self.assertEqual(self.backup.read_bytes(), b"archived fixture")
        self.assertEqual((self.profile("unselected") / ".env").read_text(), "FOREIGN_SETTING=preserved\n")
        self.assertFalse((self.profile("unselected") / "plugins/cozygateway").exists())

    def test_one_line_upgrade_then_installed_repair_and_update(self):
        # Fail the managed env replacement once after the new payload was
        # downloaded. Bootstrap rollback must preserve the old cleanup inventory.
        original = {path: path.read_bytes() for path in (self.state, self.config, self.envfile)}
        marker = self.base / "fail-env-rename"
        marker.touch()
        real_mv = shutil.which("mv")
        self.executable("mv", f'''#!/bin/bash
if [ "${{@: -1}}" = "$FIXTURE_GATEWAY/local/gateway.env" ] && [ -e '{marker}' ]; then rm -f '{marker}'; exit 1; fi
exec '{real_mv}' "$@"
''')
        self.run_bootstrap("--no-qr", success=False)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)
        self.run_bootstrap("--no-qr")
        self.assert_repaired()
        for command in ("repair", "update"):
            result = subprocess.run([str(self.gateway / "bin/cozygateway"), command], env=self.env, capture_output=True, text=True, timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assert_repaired()

    def test_zero_survivors_and_explicit_missing_scope_preserve_state(self):
        original = {path: path.read_bytes() for path in (self.state, self.config, self.envfile)}
        result = self.run_bootstrap("--profiles", "keeper,retired", "--no-qr", success=False)
        self.assertIn("explicit --profiles request is never silently changed", result.stdout + result.stderr)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)
        shutil.rmtree(self.profile("keeper"))
        result = self.run_bootstrap("--no-qr", success=False)
        self.assertIn("no recorded profiles remain", result.stdout + result.stderr)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)

    def test_multiline_custom_value_is_retained_when_cleanup_is_ambiguous(self):
        self.envfile.write_text(self.envfile.read_text() + 'CUSTOM_NOTE="before\nCOZYGATEWAY_ATTACH_TOKEN_RETIRED=note content\nafter"\n')
        original = {path: path.read_bytes() for path in (self.state, self.config, self.envfile)}
        self.run_bootstrap("--no-qr", success=False)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)

    def test_unknown_mapping_blocks_automatic_scope_cleanup(self):
        config = json.loads(self.config.read_text())
        config["hermesEndpoints"][0]["profiles"]["unknown"] = {"tokenEnv": "CUSTOM_UNOWNED_TOKEN"}
        self.config.write_text(json.dumps(config))
        original = {path: path.read_bytes() for path in (self.state, self.config, self.envfile)}
        self.run_bootstrap("--no-qr", success=False)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)

    def test_native_profile_multiline_custom_value_is_retained(self):
        profile_env = self.profile("keeper") / ".env"
        profile_env.write_text(profile_env.read_text() + 'CUSTOM_NOTE="before\nCOZYGATEWAY_TOKEN=note content\nafter"\n')
        original = {path: path.read_bytes() for path in (self.state, self.config, self.envfile, profile_env)}
        self.run_bootstrap("--no-qr", success=False)
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)


class StagedHygieneTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location("deprovision_fixture", ROOT / "scripts/test/bot-deprovision.test.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.fixture = module.DeprovisionTest("test_staged_watcher_batches_and_is_idempotent")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        f = self.fixture
        self.stage = f.base / "stage"
        self.old = (self.stage / "current").resolve()
        # v0.7.8-style installed payload: recorded origin, but missing helper.
        (self.old / "scripts/deprovision-bot.sh").unlink()
        metadata = self.old / "STAGED_FROM"
        metadata.write_text("\n".join(line for line in metadata.read_text().splitlines() if not line.startswith("INSTALL_HYGIENE_PROTOCOL=")) + "\n")
        self.backup = self.stage / "releases/user-backup/history.db"
        self.backup.parent.mkdir(parents=True)
        self.backup.write_bytes(b"unowned recovery copy")
        f.executable("launchctl", '''#!/usr/bin/env python3
import os, plistlib, subprocess, sys
from pathlib import Path
base = Path(os.environ["FIXTURE"])
action = sys.argv[1]
label = sys.argv[2].rsplit("/", 1)[-1] if len(sys.argv) > 2 else ""
agent = "ai.cozylabs.bot-provisioner"
if action == "bootstrap":
    data = plistlib.loads(Path(sys.argv[3]).read_bytes())
    if data["Label"] == agent:
        failure = base / "activation-fail-once"
        if failure.exists():
            failure.unlink()
            sys.exit(1)
        (base / "agent-loaded").touch()
        # launchd RunAtLoad starts the installed payload; its later exit does
        # not turn successful service registration into bootstrap failure.
        subprocess.run(data["ProgramArguments"], env=os.environ, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    sys.exit(0)
if action == "list":
    for entry in (base / "loaded").iterdir():
        print("1 0 " + entry.name)
    sys.exit(0)
file = base / "agent-loaded" if label == agent else base / "loaded" / label
if action == "print":
    sys.exit(0 if file.exists() else 1)
if action == "bootout":
    file.unlink(missing_ok=True)
sys.exit(0)
''')

    def install(self, success=True):
        result = subprocess.run(["bash", str(ROOT / "scripts/install-bot-provisioner.sh"), "--stage-dir", str(self.stage)],
                                env=self.fixture.env, text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_old_payload_upgrade_runs_cleanup_and_preserves_recovery_copies(self):
        self.install()
        self.fixture.assert_clean()
        self.assertTrue((self.stage / "current/scripts/deprovision-bot.sh").is_file())
        self.assertTrue(self.old.exists())
        self.assertEqual(self.backup.read_bytes(), b"unowned recovery copy")
        before = self.fixture.calls.read_text()
        self.install()
        self.fixture.assert_clean()
        self.assertEqual(self.fixture.calls.read_text(), before)
        self.assertEqual(self.backup.read_bytes(), b"unowned recovery copy")

    def test_activation_failure_restores_old_pointer_and_service_then_retries(self):
        plist = self.fixture.home / "Library/LaunchAgents/ai.cozylabs.bot-provisioner.plist"
        before = plist.read_bytes()
        (self.fixture.base / "activation-fail-once").touch()
        self.install(success=False)
        self.assertEqual((self.stage / "current").resolve(), self.old)
        self.assertEqual(plist.read_bytes(), before)
        self.assertTrue(self.old.exists())
        self.install()
        self.fixture.assert_clean()

    def test_ambiguous_service_is_not_replaced_or_cleaned(self):
        plist = self.fixture.home / "Library/LaunchAgents/ai.cozylabs.bot-provisioner.plist"
        import plistlib
        data = plistlib.loads(plist.read_bytes())
        data["ProgramArguments"] = ["/bin/bash", "/unrelated/user-job.sh"]
        plist.write_bytes(plistlib.dumps(data))
        before = plist.read_bytes()
        result = self.install(success=False)
        self.assertIn("ownership is ambiguous", result.stderr)
        self.assertEqual(plist.read_bytes(), before)
        self.assertEqual((self.stage / "current").resolve(), self.old)
        self.assertFalse(self.fixture.calls.exists())
        self.assertEqual(self.backup.read_bytes(), b"unowned recovery copy")


if __name__ == "__main__":
    unittest.main()

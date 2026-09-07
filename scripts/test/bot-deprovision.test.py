#!/usr/bin/env python3
"""Exercise the installed watcher and real remote edit against isolated host doubles."""
import json
import os
from pathlib import Path
import shutil
import signal
import time
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DeprovisionTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cozy-deprovision-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.box = self.base / "box with ' quote"
        self.bin = self.base / "bin"
        self.hermes = self.home / ".hermes"
        self.profiles = self.hermes / "profiles"
        for path in (self.bin, self.profiles, self.box / "local/config", self.home / "Library/LaunchAgents"):
            path.mkdir(parents=True)
        self.config = self.box / "local/config/cozygateway.config.json"
        self.journal = self.config.with_name(self.config.name + ".deprovision-pending.json")
        self.envfile = self.box / ".env"
        self.calls = self.base / "restarts"
        self.loaded = self.base / "loaded"
        self.loaded.mkdir()
        self.env = dict(os.environ, HOME=str(self.home), PATH=f"{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin",
                        HERMES_HOME_ROOT=str(self.hermes), BOX_SSH="fixture", BOX_REPO=str(self.box),
                        COZY_PROVISIONER_LOG=str(self.base / "watch.log"),
                        COZY_PROVISIONER_LOCK=str(self.base / "watch.lock"),
                        COZY_PROVISIONER_RECONCILE_SECONDS="0", VERIFY_TIMEOUT="0", FIXTURE=str(self.base))
        self.executable("hermes", "#!/bin/sh\nexit 0\n")
        self.executable("ssh", '#!/bin/bash\n[ ! -e "$FIXTURE/ssh-fail" ] || exit 1\nif [ -e "$FIXTURE/pause-ssh" ]; then touch "$FIXTURE/ssh-entered"; sleep 30; fi\nshift 3\nexec /bin/bash -c "$1"\n')
        self.executable("docker", '''#!/bin/bash
if [ "$1" = logs ]; then printf 'attach-v1: profile "deleted-a" negotiated hello\n'; exit 0; fi
printf 'restart\n' >> "$FIXTURE/restarts"
[ ! -e "$FIXTURE/restart-fail" ] || exit 1
python3 - "$BOX_REPO/local/config/cozygateway.config.json" "$FIXTURE/ready" <<'PYDOCKER'
import json,sys
count = len(json.load(open(sys.argv[1]))["hermesEndpoints"][0]["profiles"])
open(sys.argv[2], "w").write(json.dumps({"attach": {"configured": count + 2, "hermes": {"configured": count}}}))
PYDOCKER
''')
        self.executable("curl", '#!/bin/sh\n[ ! -e "$FIXTURE/ready-fail" ] || exit 22\ncat "$FIXTURE/ready"\n')
        self.executable("launchctl", '''#!/bin/bash
label="${2##*/}"
case "$1" in
 list) for p in "$FIXTURE/loaded"/*; do [ -f "$p" ] && printf '1 0 %s\n' "${p##*/}"; done; exit 0 ;;
 print) [ -f "$FIXTURE/loaded/$label" ] ;;
 bootout) rm -f "$FIXTURE/loaded/$label" ;;
esac
''')
        # No profile is opted into provisioning in this fixture. Supply that
        # result at the Hermes interpreter seam without requiring host PyYAML.
        interpreter = self.hermes / "hermes-agent/venv/bin/python"
        interpreter.parent.mkdir(parents=True)
        interpreter.write_text('#!/bin/sh\ncat >/dev/null\nexit 1\n')
        interpreter.chmod(0o700)
        subprocess.run([str(ROOT / "scripts/install-bot-provisioner.sh"), "--stage-dir", str(self.base / "stage"), "--no-load"],
                       env=self.env, check=True, capture_output=True)
        self.scripts = self.base / "stage/current/scripts"
        self.seed(["keeper", "deleted-a", "deleted-b"])
        (self.profiles / "keeper").mkdir()
        (self.profiles / "keeper/sessions.db").write_bytes(b"keeper history")
        self.archive = self.hermes / "profile-backups/deleted-a/history.db"
        self.archive.parent.mkdir(parents=True)
        self.archive.write_bytes(b"archived history")
        self.quarantine = self.hermes / "profiles/.deleted/deleted-b/history.db"
        self.quarantine.parent.mkdir(parents=True)
        self.quarantine.write_bytes(b"quarantined history")

    def executable(self, name, source):
        path = self.bin / name
        path.write_text(source)
        path.chmod(0o700)

    def seed(self, names):
        profiles = {name: {"tokenEnv": "COZYGATEWAY_ATTACH_TOKEN_" + name.upper().replace("-", "_")} for name in names}
        self.config.write_text(json.dumps({"hermesEndpoints": [{"profiles": profiles}]}))
        self.envfile.write_text("KEEP=unchanged\n" + "".join(f"{p['tokenEnv']}=fixture-secret\n" for p in profiles.values()))
        for name in names:
            label = f"ai.hermes.gateway-{name}"
            (self.loaded / label).touch()
            (self.home / f"Library/LaunchAgents/{label}.plist").write_text("fixture plist")
        (self.base / "ready").write_text(json.dumps({"attach": {"configured": len(names) + 2, "hermes": {"configured": len(names)}}}))

    def run_script(self, script="bot-provisioner-watch.sh", *args, succeeds=True):
        result = subprocess.run(["bash", str(self.scripts / script), *args], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, succeeds, result.stdout + result.stderr +
                         ((self.base / "watch.log").read_text() if (self.base / "watch.log").exists() else ""))
        return result

    def assert_clean(self):
        data = json.loads(self.config.read_text())
        self.assertEqual(list(data["hermesEndpoints"][0]["profiles"]), ["keeper"])
        self.assertEqual(self.envfile.read_text(), "KEEP=unchanged\nCOZYGATEWAY_ATTACH_TOKEN_KEEPER=fixture-secret\n")
        self.assertEqual([p.name for p in self.loaded.iterdir()], ["ai.hermes.gateway-keeper"])
        self.assertEqual([p.name for p in (self.home / "Library/LaunchAgents").glob("ai.hermes.gateway-*.plist")], ["ai.hermes.gateway-keeper.plist"])
        self.assertEqual((self.profiles / "keeper/sessions.db").read_bytes(), b"keeper history")
        self.assertEqual(self.archive.read_bytes(), b"archived history")
        self.assertEqual(self.quarantine.read_bytes(), b"quarantined history")
        self.assertFalse(self.journal.exists())

    def test_staged_watcher_batches_and_is_idempotent(self):
        # Real Hermes deletes its service with the profile: config-only residue
        # must still be found. Leave one unloaded plist to check its removal.
        for name in ("deleted-a", "deleted-b"):
            (self.loaded / f"ai.hermes.gateway-{name}").unlink()
        (self.home / "Library/LaunchAgents/ai.hermes.gateway-deleted-a.plist").unlink()
        self.run_script()
        self.assert_clean()
        self.assertEqual(self.calls.read_text().splitlines(), ["restart"])
        self.run_script()
        self.assertEqual(self.calls.read_text().splitlines(), ["restart"])

    def test_retry_after_failed_restart_without_config_or_service(self):
        failure = self.base / "restart-fail"
        failure.touch()
        self.run_script(succeeds=False)
        self.assertEqual(sorted(json.loads(self.journal.read_text())), ["deleted-a", "deleted-b"])
        failure.unlink()
        self.run_script()
        self.assert_clean()
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_retry_after_failed_ready_and_count_already_updated(self):
        failure = self.base / "ready-fail"
        failure.touch()
        self.run_script(succeeds=False)
        self.assertTrue(self.journal.exists())
        failure.unlink()
        self.run_script()
        self.assert_clean()

    def test_interrupted_env_write_retains_custom_token_key_for_retry(self):
        data = json.loads(self.config.read_text())
        data["hermesEndpoints"][0]["profiles"]["deleted-a"]["tokenEnv"] = "CUSTOM_DELETED_CREDENTIAL"
        self.config.write_text(json.dumps(data))
        self.envfile.write_text(self.envfile.read_text() + "CUSTOM_DELETED_CREDENTIAL=fixture-secret\n")
        # Inject the crash at the filesystem seam after config rename, before
        # env rename. The real remote cleanup code still performs every edit.
        hooks = self.base / "python-hooks"
        hooks.mkdir()
        (hooks / "sitecustomize.py").write_text('''import os
original_replace = os.replace
def replace(source, destination):
    if str(destination).endswith("/.env"):
        raise OSError("fixture interrupted env rename")
    return original_replace(source, destination)
os.replace = replace
''')
        self.env["PYTHONPATH"] = str(hooks)
        self.run_script(succeeds=False)
        self.assertNotIn("deleted-a", json.loads(self.config.read_text())["hermesEndpoints"][0]["profiles"])
        self.assertIn("CUSTOM_DELETED_CREDENTIAL", json.loads(self.journal.read_text())["deleted-a"])
        del self.env["PYTHONPATH"]
        self.run_script()
        self.assert_clean()

    def test_malformed_config_and_ssh_failure_fail_closed(self):
        original_env = self.envfile.read_bytes()
        for text in ('{broken', '{"hermesEndpoints": []}', '{"hermesEndpoints": [{"profiles": []}]}'):
            self.config.write_text(text)
            self.run_script(succeeds=False)
            self.assertEqual(self.envfile.read_bytes(), original_env)
            self.assertEqual(len(list(self.loaded.iterdir())), 3)
            self.assertFalse(self.calls.exists())
        self.seed(["keeper", "deleted-a", "deleted-b"])
        (self.base / "ssh-fail").touch()
        self.run_script(succeeds=False)
        self.assertEqual(self.envfile.read_bytes(), original_env)

    def test_live_reserved_traversal_and_symlink_are_refused(self):
        for name in ("keeper", "default", "../keeper", "bad.name", "-unsafe"):
            self.run_script("deprovision-bot.sh", "--orphans-only", "--", name, succeeds=False)
        (self.profiles / "linked").symlink_to(self.profiles / "keeper", target_is_directory=True)
        self.run_script("deprovision-bot.sh", "--orphans-only", "linked", succeeds=False)
        self.assertFalse(self.calls.exists())
        self.assertEqual(len(list(self.loaded.iterdir())), 3)

    def test_shared_token_and_final_env_line_are_preserved_or_removed_correctly(self):
        data = json.loads(self.config.read_text())
        data["hermesEndpoints"][0]["profiles"]["deleted-a"]["tokenEnv"] = "COZYGATEWAY_ATTACH_TOKEN_KEEPER"
        self.config.write_text(json.dumps(data))
        self.run_script()
        self.assert_clean()
        shutil.rmtree(self.profiles / "keeper")
        self.envfile.write_text("COZYGATEWAY_ATTACH_TOKEN_KEEPER=fixture-secret")
        self.run_script()
        self.assertEqual(self.envfile.read_text(), "")

    def enable_real_provisioning(self):
        # Config parsing is not under test: fixture configs use YAML's JSON
        # subset, and this tiny parser keeps the test independent of PyYAML.
        hooks = self.base / "yaml-fixture"
        hooks.mkdir()
        (hooks / "yaml.py").write_text("import json\ndef safe_load(text): return json.loads(text)\n")
        self.env["PYTHONPATH"] = str(hooks)
        interpreter = self.hermes / "hermes-agent/venv/bin/python"
        interpreter.write_text('#!/bin/sh\nexec /usr/bin/python3 "$@"\n')
        # Provisioner's existing box commands assume a quote-free path.
        simple_box = self.base / "simple-box"
        simple_box.symlink_to(self.box, target_is_directory=True)
        self.env["BOX_REPO"] = str(simple_box)
        profile = self.profiles / "deleted-a"
        profile.mkdir()
        (profile / "config.yaml").write_text(json.dumps({
            "plugins": {"enabled": ["cozygateway"]},
            "display": {"streaming": True, "platforms": {"cozygateway": {"streaming": True}}},
            "streaming": {"edit_interval": 0.05, "buffer_threshold": 1}}))
        (profile / ".env").write_text(
            f"COZYGATEWAY_TOKEN=inherited-parent-token\nCOZYGATEWAY_SPOOL_PATH={self.hermes}/plugin-data/cozygateway/attach-v1.sqlite\nDISCORD_BOT_TOKEN=inherited-discord\n")
        return profile

    def test_recreated_profile_rotates_only_its_stale_token(self):
        profile = self.enable_real_provisioning()
        self.run_script()
        local = dict(line.split("=", 1) for line in (profile / ".env").read_text().splitlines())
        remote = dict(line.split("=", 1) for line in self.envfile.read_text().splitlines())
        self.assertRegex(local["COZYGATEWAY_TOKEN"], r"^[0-9a-f]{64}$")
        self.assertEqual(local["COZYGATEWAY_TOKEN"], remote["COZYGATEWAY_ATTACH_TOKEN_DELETED_A"])
        self.assertEqual(remote["COZYGATEWAY_ATTACH_TOKEN_KEEPER"], "fixture-secret")
        self.assertEqual(local["DISCORD_BOT_TOKEN"], "")
        self.assertFalse((profile / ".cozygateway-provision-pending").exists())
        before = self.calls.read_text()
        self.run_script()
        self.assertEqual(before, self.calls.read_text())
        self.assertEqual(local["COZYGATEWAY_TOKEN"], dict(line.split("=", 1) for line in (profile / ".env").read_text().splitlines())["COZYGATEWAY_TOKEN"])

    def test_recreated_token_handoff_retries_restart_without_remint(self):
        profile = self.enable_real_provisioning()
        failure = self.base / "restart-fail"
        failure.touch()
        self.run_script("provision-bot.sh", "--no-verify", "deleted-a", succeeds=False)
        first = dict(line.split("=", 1) for line in (profile / ".env").read_text().splitlines())["COZYGATEWAY_TOKEN"]
        self.assertTrue((profile / ".cozygateway-provision-pending").exists())
        failure.unlink()
        self.run_script("provision-bot.sh", "--no-verify", "deleted-a")
        second = dict(line.split("=", 1) for line in (profile / ".env").read_text().splitlines())["COZYGATEWAY_TOKEN"]
        self.assertEqual(first, second)
        self.assertFalse((profile / ".cozygateway-provision-pending").exists())
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)

    def test_recreated_profile_cannot_overwrite_keeper_shared_key(self):
        self.enable_real_provisioning()
        data = json.loads(self.config.read_text())
        data["hermesEndpoints"][0]["profiles"]["keeper"]["tokenEnv"] = "COZYGATEWAY_ATTACH_TOKEN_DELETED_A"
        self.config.write_text(json.dumps(data))
        original = self.envfile.read_bytes()
        self.run_script("provision-bot.sh", "--no-verify", "deleted-a", succeeds=False)
        self.assertEqual(self.envfile.read_bytes(), original)
        self.assertFalse(self.calls.exists())

    def test_advisory_lock_excludes_overlap_and_recovers_after_sigkill(self):
        pause = self.base / "pause-ssh"
        pause.touch()
        # A legacy mkdir lock must not disable the advisory-lock implementation.
        (self.base / "watch.lock.d").mkdir()
        command = ["bash", str(self.scripts / "bot-provisioner-watch.sh")]
        worker = subprocess.Popen(command, env=self.env, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.monotonic() + 5
            while not (self.base / "ssh-entered").exists():
                self.assertIsNone(worker.poll(), "worker exited before reaching fixture SSH")
                self.assertLess(time.monotonic(), deadline, "worker never reached fixture SSH")
                time.sleep(0.01)
            overlapping = subprocess.run(command, env=self.env, capture_output=True, timeout=3)
            self.assertEqual(overlapping.returncode, 0)
            self.assertIn("sweep skipped: another sweep still running", (self.base / "watch.log").read_text())
            self.assertFalse(self.calls.exists())
        finally:
            # Kill the whole worker group, including its outstanding SSH child:
            # no cleanup trap gets to remove or repair a lock file.
            os.killpg(worker.pid, signal.SIGKILL)
            worker.communicate(timeout=3)
            pause.unlink()
        self.run_script()
        self.assert_clean()

    def test_unavailable_profiles_root_is_not_mass_deletion(self):
        shutil.rmtree(self.profiles)
        self.run_script(succeeds=False)
        self.assertFalse(self.calls.exists())
        self.assertEqual(len(json.loads(self.config.read_text())["hermesEndpoints"][0]["profiles"]), 3)


if __name__ == "__main__":
    unittest.main()

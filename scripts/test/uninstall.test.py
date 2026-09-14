"""Exercise the installed uninstall command against disposable homes and fake services."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / 'scripts/agent-install.sh'


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cozygateway-uninstall-')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'user'
        self.gateway = self.home / '.cozygateway'
        self.agents = self.home / '.cozyagents'
        self.bin = self.root / 'tools'
        for path in (self.gateway / 'bin', self.gateway / 'local', self.bin, self.home / '.local/bin'):
            path.mkdir(parents=True, exist_ok=True)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin',
                        COZYGATEWAY_HOME=str(self.gateway), COZYAGENTS_HOME=str(self.agents),
                        CALL_LOG=str(self.root / 'calls'))
        # No real service manager or network is reached, even when running on Linux as root.
        self.script(self.bin / 'id', '#!/bin/bash\necho 501\n')
        self.script(self.bin / 'launchctl', '#!/bin/bash\necho "launchctl $*" >> "$CALL_LOG"\n'
                    'if [ "${FAIL_STOP:-}" = 1 ] && [ "$1" = bootout ]; then exit 1; fi\n')
        self.script(self.bin / 'systemctl', '#!/bin/bash\necho "systemctl $*" >> "$CALL_LOG"\n'
                    'if [ "${FAIL_STOP:-}" = 1 ] && [ "$2" = disable ]; then exit 1; fi\n')
        self.writer = self.root / 'writer.sh'
        self.writer.write_text(INSTALLER.read_text().rsplit('\nmain\n', 1)[0] + '''
NODE_RESOLVED=/missing/node
BUNDLE_PATH=/missing/bundle
write_cli_wrapper
''')
        shutil.copyfile(INSTALLER, self.gateway / 'bin/agent-install.sh')
        (self.gateway / 'local/install-state').write_text('repair_mode=runtime-only\n')
        (self.gateway / 'local/history.sqlite').write_text('history')
        (self.home / 'my-project').write_text('keep me')
        (self.home / '.profile').write_text('export EDITOR=vim\nexport PATH="$HOME/.local/bin:$PATH" # CozyGateway CLI\n')
        self.make_wrapper('Darwin')
        (self.home / '.local/bin/cozygateway').symlink_to(self.gateway / 'bin/cozygateway')

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def script(path, content):
        path.write_text(content)
        path.chmod(0o755)

    def make_wrapper(self, platform):
        result = subprocess.run(['bash', str(self.writer), '--gateway-dir', str(self.gateway),
                                 '--service-platform', platform], env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def run_uninstall(self, *args, success=True):
        result = subprocess.run([str(self.gateway / 'bin/cozygateway'), 'uninstall', *args],
                                env=self.env, text=True, capture_output=True)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def test_mac_removes_home_command_and_own_path_line(self):
        self.run_uninstall('--purge')
        self.assertFalse(self.gateway.exists())
        self.assertFalse((self.home / '.local/bin/cozygateway').is_symlink())
        self.assertEqual((self.home / '.profile').read_text(), 'export EDITOR=vim\n')
        self.assertEqual((self.home / 'my-project').read_text(), 'keep me')

    def test_linux_removal_without_node(self):
        self.make_wrapper('Linux')
        self.run_uninstall('--purge')
        self.assertFalse(self.gateway.exists())
        self.assertIn('systemctl --user disable --now', (self.root / 'calls').read_text())

    def test_preview_does_not_mutate(self):
        result = self.run_uninstall('--purge', '--dry-run')
        self.assertIn('DRY', result.stdout)
        self.assertTrue((self.gateway / 'local/history.sqlite').exists())
        self.assertTrue((self.home / '.local/bin/cozygateway').is_symlink())
        self.assertFalse((self.root / 'calls').exists())

    def test_rejects_extra_arguments_before_cleanup(self):
        self.run_uninstall('--gateway-dir', str(self.home), success=False)
        self.assertTrue((self.gateway / 'local/history.sqlite').exists())
        self.assertFalse((self.root / 'calls').exists())

    def test_live_service_stop_failure_retains_retry_files(self):
        self.env['FAIL_STOP'] = '1'
        self.run_uninstall('--purge', success=False)
        self.assertTrue((self.gateway / 'local/install-state').exists())
        self.assertTrue((self.gateway / 'bin/cozygateway').exists())

    def test_foreign_service_preserved(self):
        plist = self.home / 'Library/LaunchAgents/ai.cozylabs.cozygateway.plist'
        plist.parent.mkdir(parents=True)
        plist.write_text('unrelated service')
        self.run_uninstall('--purge', success=False)
        self.assertEqual(plist.read_text(), 'unrelated service')
        self.assertTrue(self.gateway.exists())

    def setup_agents(self):
        (self.gateway / 'local/install-state').write_text(f'harness=cozyagents\ncozyagents_home={self.agents}\n')
        (self.agents / 'bin').mkdir(parents=True)
        (self.agents / 'bots').mkdir()
        (self.agents / 'bots/keep.txt').write_text('bot')
        self.script(self.agents / 'bin/cozyagents', '''#!/bin/bash
set -eu
echo "agents $*" >> "$CALL_LOG"
[ "${FAIL_AGENTS:-}" != 1 ] || exit 1
for arg in "$@"; do
  if [ "$arg" = --purge ]; then rm -rf "$COZYAGENTS_HOME"; exit 0; fi
done
rm -rf "$COZYAGENTS_HOME/bin"
''')

    def test_purge_delegates_and_removes_bot_files(self):
        self.setup_agents()
        self.run_uninstall('--purge')
        self.assertFalse(self.agents.exists())
        self.assertFalse(self.gateway.exists())
        self.assertIn('--yes --purge', (self.root / 'calls').read_text())

    def test_default_keeps_bots(self):
        self.setup_agents()
        self.run_uninstall()
        self.assertTrue((self.agents / 'bots/keep.txt').exists())
        self.assertNotIn('--purge', (self.root / 'calls').read_text())

    def test_failed_harness_retains_gateway_receipt(self):
        self.setup_agents()
        self.env['FAIL_AGENTS'] = '1'
        self.run_uninstall('--purge', success=False)
        self.assertTrue((self.gateway / 'local/install-state').exists())
        self.assertTrue((self.agents / 'bots/keep.txt').exists())

    def test_missing_harness_is_a_failure(self):
        self.setup_agents()
        (self.agents / 'bin/cozyagents').unlink()
        self.run_uninstall('--purge', success=False)
        self.assertTrue(self.gateway.exists())

    def test_windows_shell_wrapper_routes_to_native_uninstall(self):
        self.script(self.bin / 'cygpath', '#!/bin/bash\necho "$2"\n')
        powershell = self.bin / 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
        self.script(powershell, '#!/bin/bash\nprintf "%s\\n" "$@" > "$CALL_LOG"\necho "$COZYGATEWAY_HOME" >> "$CALL_LOG"\n')
        self.env['COZYGATEWAY_POWERSHELL'] = powershell.name
        self.make_wrapper('Windows')
        self.run_uninstall('--purge', '--dry-run')
        arguments = (self.root / 'calls').read_text().splitlines()
        self.assertIn('-Uninstall', arguments)
        self.assertIn('-Purge', arguments)
        self.assertIn('-DryRun', arguments)
        self.assertEqual(arguments[-1], str(self.gateway))
        cmd = (self.gateway / 'bin/cozygateway.cmd').read_text()
        self.assertIn('goto uninstall', cmd)
        self.assertIn('if errorlevel 1 (exit /b 1) else (exit /b 0)', cmd)
        self.assertTrue(self.gateway.exists())

    def test_missing_install_is_repeat_safe(self):
        self.run_uninstall('--purge')
        result = subprocess.run(['bash', str(INSTALLER), '--uninstall', '--purge',
                                 '--gateway-dir', str(self.gateway), '--service-platform', 'Darwin'],
                                env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.home / 'my-project').read_text(), 'keep me')


if __name__ == '__main__':
    unittest.main()

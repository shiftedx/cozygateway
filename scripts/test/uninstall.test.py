"""Exercise the installed uninstall command against disposable homes and fake services."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
INSTALLER = ROOT / 'scripts/agent-install.sh'
WINDOWS_INSTALLER = ROOT / 'scripts/install.ps1'


class UninstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cozygateway-uninstall-')
        self.root = Path(self.temp.name).resolve()
        self.home = self.root / 'user'
        self.gateway = self.home / '.cozygateway'
        self.bin = self.root / 'tools'
        for path in (self.gateway / 'bin', self.gateway / 'local', self.bin, self.home / '.local/bin'):
            path.mkdir(parents=True, exist_ok=True)
        self.env = dict(os.environ, HOME=str(self.home), PATH=f'{self.bin}:/usr/bin:/bin',
                        COZYGATEWAY_HOME=str(self.gateway), CALL_LOG=str(self.root / 'calls'))
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

    def test_legacy_cozyagents_state_refuses_update_and_uninstall_without_mutation(self):
        state = self.gateway / 'local/install-state'
        config = self.gateway / 'local/cozygateway.config.json'
        config.write_text('{"sentinel":"preserve"}\n')
        for harness in ('cozyagents', 'both'):
            state.write_text(f'harness={harness}\nrepair_mode=runtime-only\n')
            before_state = state.read_bytes()
            before_config = config.read_bytes()
            for arguments in ((), ('--uninstall', '--purge')):
                result = subprocess.run(
                    ['bash', str(INSTALLER), '--gateway-dir', str(self.gateway),
                     '--service-platform', 'Darwin', *arguments],
                    env=self.env, text=True, capture_output=True,
                )
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('retired CozyAgents gateway', result.stdout + result.stderr)
                self.assertEqual(state.read_bytes(), before_state)
                self.assertEqual(config.read_bytes(), before_config)
                self.assertFalse((self.root / 'calls').exists())

    def test_powershell_legacy_cozyagents_state_refuses_before_uninstall_or_upgrade(self):
        powershell = shutil.which('powershell.exe') or shutil.which('pwsh')
        if powershell is None:
            self.skipTest('PowerShell is unavailable')
        state = self.gateway / 'local/install-state'
        config = self.gateway / 'local/cozygateway.config.json'
        config.write_text('{"sentinel":"preserve"}\n')
        script = self.root / 'legacy-state-guard.ps1'
        source = str(WINDOWS_INSTALLER).replace("'", "''")
        state_path = str(state).replace("'", "''")
        config_path = str(config).replace("'", "''")
        script.write_text(f'''$ErrorActionPreference = 'Stop'
$source = [IO.File]::ReadAllText('{source}')
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) {{ throw ($errors | Out-String) }}
$guard = $ast.Find({{ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text -match '\\$legacyHarness -in @\\(''cozyagents'', ''both''\\)' }}, $true)
$uninstall = $ast.Find({{ param($node) $node -is [Management.Automation.Language.IfStatementAst] -and $node.Extent.Text -match '^if \\(\\$isUninstall\\)' }}, $true)
$transaction = $ast.Find({{ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.Extent.Text -match '^Protect-CozyGatewayHome ' }}, $true)
if (-not $guard -or -not $uninstall -or -not $transaction -or $guard.Extent.StartOffset -ge $uninstall.Extent.StartOffset -or $guard.Extent.StartOffset -ge $transaction.Extent.StartOffset) {{ throw 'legacy state guard must precede uninstall and upgrade mutation' }}
function Fail {{ param([string] $Message) throw $Message }}
$statePath = '{state_path}'
$configPath = '{config_path}'
foreach ($harness in @('cozyagents', 'both')) {{
    [IO.File]::WriteAllText($statePath, "harness=$harness`nrepair_mode=runtime-only`n")
    $beforeState = (Get-FileHash -LiteralPath $statePath).Hash
    $beforeConfig = (Get-FileHash -LiteralPath $configPath).Hash
    $blocked = $false
    try {{ . ([scriptblock]::Create($guard.Extent.Text)) }} catch {{ $blocked = $_.Exception.Message -match 'retired CozyAgents gateway' }}
    if (-not $blocked -or (Get-FileHash -LiteralPath $statePath).Hash -ne $beforeState -or (Get-FileHash -LiteralPath $configPath).Hash -ne $beforeConfig) {{ throw "legacy $harness state was not refused without mutation" }}
}}
''')
        result = subprocess.run([powershell, '-NoProfile', '-File', str(script)], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

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
        self.assertIn('(goto) 2>nul &', cmd)
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

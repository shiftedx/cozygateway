import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { test } from 'node:test';

const installer = readFileSync(new URL('../agent-install.sh', import.meta.url), 'utf8');
const supervisor = readFileSync(new URL('../gateway-supervisor.cjs', import.meta.url), 'utf8');
test('Hermes installer fixture hides its detached Windows Dashboard child', () => {
  const suite = readFileSync(new URL('./hermes-installer.test.sh', import.meta.url), 'utf8');
  const source = suite.match(/<<'HERMES_STUB'\r?\n([\s\S]*?)\r?\nHERMES_STUB/)[1];
  const launches = [];
  let detached = false;
  const args = ['dashboard', '-p', 'default', '--host', '127.0.0.1', '--port', '9119', '--no-open', '--skip-build'];
  const childProcess = { spawn(command, args, options) {
    launches.push({ command, args, options });
    return { unref() { detached = true; }, once() {} };
  } };
  const env = {
    COZYGATEWAY_TEST_DASHBOARD_RUNTIME: 'fixture-node.exe',
    COZYGATEWAY_TEST_DASHBOARD_SCRIPT: 'fixture-dashboard.cjs',
    COZYGATEWAY_TEST_DASHBOARD_ENV: 'fixture.env',
    HERMES_HOME: '/fixture', COZYGATEWAY_TEST_EXPECTED_HERMES_HOME: '/fixture',
    HERMES_DASHBOARD_SESSION_TOKEN: 'fixture-token',
  };
  vm.runInNewContext(source, {
    require(name) {
      if (name === 'node:fs') return { appendFileSync() {}, writeFileSync() {}, readFileSync: () => '' };
      if (name === 'node:child_process') return childProcess;
      if (name === 'node:path') return { basename: (value) => value, resolve: (value) => value };
      if (name === 'node:util') return { parseEnv: () => ({ DASHBOARD_SESSION_TOKEN: 'fixture-token' }) };
      throw new Error(name);
    },
    process: { platform: 'win32', argv: ['node', ...args], env, pid: 123, exit(code) { assert.equal(code, 0); } },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].command, 'fixture-node.exe');
  assert.equal(launches[0].options.detached, true);
  assert.equal(detached, true);
  assert.equal(launches[0].options.windowsHide, true);
});
const supervisors = [...installer.matchAll(/<<'NODE'\r?\n([\s\S]*?)\r?\nNODE/g)]
  .map((match) => match[1])
  .filter((source) => source.includes('const spawnGateway =') || source.includes('const child = spawn(hermes, dashboardArgs'));

for (const source of supervisors) {
  const withHermes = source.includes('dashboardChild');
  const standaloneDashboard = source.includes('const child = spawn(hermes, dashboardArgs');
  test(`${standaloneDashboard ? 'Dashboard' : withHermes ? 'Hermes' : 'CozyAgents'} launcher hides Windows children`, async () => {
    const launches = [];
    const proc = new EventEmitter();
    Object.assign(proc, {
      platform: 'win32', execPath: 'node.exe', env: {},
      argv: ['node', '-', 'env', 'dashboard-env', 'root', 'hermes.exe', 'launcher', 'owner', '9119', 'bundle', 'config'],
      exit: () => {},
    });
    const spawn = (command, args, options) => {
      launches.push({ command, args, options });
      const child = new EventEmitter();
      Object.assign(child, { exitCode: null, signalCode: null, pid: 123, unref() {}, kill() {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const context = {
      require: (name) => {
        if (name === 'node:child_process') return { spawn };
        if (name === 'node:fs') return { readFileSync: () => '', watchFile() {}, unwatchFile() {} };
        if (name === 'node:util') return { parseEnv: () => ({ DASHBOARD_SESSION_TOKEN: 'fixture' }) };
        throw new Error(name);
      },
      process: proc, console, setTimeout, clearTimeout, AbortSignal,
      fetch: async (url) => ({ status: url.endsWith('/api/health') ? 503 : 200 }),
    };
    await vm.runInNewContext(source.replaceAll('$windows_dashboard_profile', '1'), context);
    if (!standaloneDashboard) assert.ok(launches.some((launch) => launch.args.includes('serve')));
    if (withHermes || standaloneDashboard) assert.ok(launches.some((launch) => launch.args.includes('dashboard')));
    for (const launch of launches) {
      assert.equal(launch.options.windowsHide, true, `${launch.command} must suppress its console`);
    }
  });
}
assert.equal(supervisors.length, 1, 'exercise initial Dashboard startup from the installer');

for (const withHermes of [false, true]) {
  test(`shared ${withHermes ? 'Hermes' : 'CozyAgents'} supervisor hides Windows children`, async () => {
    const launches = [];
    const spawn = (command, args, options) => {
      launches.push({ command, args, options });
      const child = new EventEmitter();
      Object.assign(child, { exitCode: null, signalCode: null, pid: 123, unref() {}, kill() { this.exitCode = 0; } });
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); });
      return child;
    };
    let requests = 0;
    const context = {
      require: (name) => {
        if (name === 'node:child_process') return { spawn };
        if (name === 'node:fs') return { readFileSync: () => '{}', writeFileSync() {}, renameSync() {}, watchFile() {}, unwatchFile() {} };
        if (name === 'node:util') return { parseEnv: () => ({ DASHBOARD_SESSION_TOKEN: 'fixture' }) };
        if (name === 'node:net') return {};
        throw new Error(name);
      },
      process: { platform: 'win32', execPath: 'node.exe', env: { SystemRoot: 'C:\\Windows' } },
      console, setTimeout, clearTimeout, AbortSignal,
      fetch: async () => ({ status: requests++ === 0 ? 503 : 200 }),
    };
    // Execute the production functions without invoking its long-running main service loop.
    vm.runInNewContext(supervisor.slice(0, supervisor.lastIndexOf('\nmain().catch(')), context);
    const options = {
      bundle: 'gateway.mjs', config: 'config.json',
      ...(withHermes ? { dashboardEnv: 'dashboard.env', hermes: 'hermes.exe', hermesRoot: 'root', hermesLauncher: 'launcher', ownerHelper: 'owner.ps1', dashboardPort: '9119' } : {}),
    };
    await context.startDashboardIfNeeded(options);
    context.gatewayChild(options, {});
    if (withHermes) {
      await context.stopOwnedDashboard({ pid: 123, exitCode: null, signalCode: null, kill() { this.exitCode = 0; } }, options);
      assert.ok(launches.some((launch) => launch.args.includes('dashboard')));
      assert.ok(launches.some((launch) => launch.command.endsWith('taskkill.exe')));
      assert.ok(launches.some((launch) => launch.command === 'powershell.exe'));
    }
    assert.ok(launches.some((launch) => launch.args.includes('serve')));
    for (const launch of launches) assert.equal(launch.options.windowsHide, true, `${launch.command} must suppress its console`);
  });
}

#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, unwatchFile, watchFile } = require('node:fs');
const { parseEnv } = require('node:util');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) throw new Error('invalid supervisor arguments');
    if (flag === '--windows-dashboard-profile') {
      options.windowsDashboardProfile = true;
      index -= 1;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('invalid supervisor arguments');
    options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  for (const name of ['platform', 'gatewayEnv', 'bundle', 'config', 'maintenanceSocket', 'maintenanceWorker', 'database']) {
    if (!options[name]) throw new Error('invalid supervisor arguments');
  }
  if (!['Darwin', 'Linux', 'Windows'].includes(options.platform)) throw new Error('invalid supervisor platform');
  const dashboardNames = ['dashboardEnv', 'hermesRoot', 'hermes', 'hermesLauncher', 'ownerHelper', 'dashboardPort'];
  const dashboardCount = dashboardNames.filter((name) => options[name]).length;
  if (dashboardCount !== 0 && dashboardCount !== dashboardNames.length) throw new Error('incomplete Dashboard arguments');
  return options;
}

async function stopOwnedDashboard(child, options) {
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = `${process.env.SystemRoot || process.env.WINDIR}\\System32\\taskkill.exe`;
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => { killer.once('error', resolve); killer.once('exit', resolve); });
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await wait(100);
    }
    const port = Number(options.dashboardPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid Dashboard port');
    const cleanup = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', options.ownerHelper,
      options.hermesRoot, options.hermes, options.hermesLauncher, String(port),
    ], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => { cleanup.once('error', resolve); cleanup.once('exit', resolve); });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  await wait(1000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function startDashboardIfNeeded(options) {
  if (!options.dashboardEnv) return;
  const dashboard = parseEnv(readFileSync(options.dashboardEnv, 'utf8'));
  const environment = {
    ...process.env,
    HERMES_HOME: options.hermesRoot,
    HERMES_DASHBOARD_SESSION_TOKEN: dashboard.DASHBOARD_SESSION_TOKEN,
  };
  const health = await fetch(`http://127.0.0.1:${options.dashboardPort}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.status === 200 || response.status === 401)
    .catch(() => false);
  let child;
  if (!health) {
    const profile = options.windowsDashboardProfile ? ['-p', 'default'] : [];
    child = spawn(options.hermes, ['dashboard', ...profile, '--host', '127.0.0.1', '--port', options.dashboardPort, '--no-open', '--skip-build'], {
      detached: true, stdio: 'ignore', env: environment,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  try {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      response = await fetch(`http://127.0.0.1:${options.dashboardPort}/api/config`, {
        headers: { 'x-hermes-session-token': dashboard.DASHBOARD_SESSION_TOKEN },
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      if (response?.status === 200) break;
      if (response?.status === 401 || response?.status === 403) throw new Error('Hermes Dashboard rejected the configured local session token');
      await wait(1000);
    }
    if (response?.status !== 200) throw new Error('Hermes Dashboard did not become ready for authenticated local access');
  } catch (error) {
    if (child) await stopOwnedDashboard(child, options);
    throw error;
  }
  child?.unref();
}

function gatewayChild(options, gatewayEnv) {
  return spawn(process.execPath, [options.bundle, 'serve', '--config', options.config], {
    stdio: 'inherit', env: { ...process.env, ...gatewayEnv },
  });
}

async function runGatewayOnce(options, gatewayEnv) {
  const child = gatewayChild(options, gatewayEnv);
  let forwarding;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    forwarding = signal;
    if (child.exitCode === null) child.kill(signal);
  });
  const result = await new Promise((resolve) => {
    child.once('error', () => resolve({ code: 1 }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== null) return result.code;
  return forwarding || result.signal ? 1 : 0;
}

async function superviseGatewayOnWindows(options, gatewayEnv) {
  const crashTimes = [];
  let child;
  let restartTimer;
  let deliberateRestart = false;
  let shuttingDown = false;
  let configBytes = readFileSync(options.config);
  const finished = new Promise((resolve) => {
    const start = () => {
      let finished = false;
      child = gatewayChild(options, gatewayEnv);
      const crashOnce = () => { if (!finished) { finished = true; crashed(); } };
      child.once('error', crashOnce);
      child.once('exit', (code, signal) => {
        if (finished) return;
        finished = true;
        if (shuttingDown) return resolve(code ?? (signal ? 1 : 0));
        if (deliberateRestart) {
          deliberateRestart = false;
          return start();
        }
        crashed();
      });
    };
    const crashed = () => {
      const now = Date.now();
      while (crashTimes[0] !== undefined && now - crashTimes[0] >= 300_000) crashTimes.shift();
      if (crashTimes.length >= 3) return resolve(1);
      crashTimes.push(now);
      restartTimer = setTimeout(() => { restartTimer = undefined; start(); }, 1000);
    };
    watchFile(options.config, { interval: 500 }, () => {
      const next = readFileSync(options.config);
      if (next.equals(configBytes)) return;
      configBytes = next;
      deliberateRestart = true;
      if (child?.exitCode === null) child.kill('SIGTERM');
      else {
        deliberateRestart = false;
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = undefined;
        start();
      }
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      shuttingDown = true;
      unwatchFile(options.config);
      if (restartTimer) clearTimeout(restartTimer);
      if (child?.exitCode === null) child.kill(signal);
      else resolve(0);
    });
    start();
  });
  const code = await finished;
  unwatchFile(options.config);
  return code;
}

async function main() {
  const options = optionsFrom(process.argv.slice(2));
  const gatewayEnv = parseEnv(readFileSync(options.gatewayEnv, 'utf8'));
  await startDashboardIfNeeded(options);
  process.exitCode = options.platform === 'Windows'
    ? await superviseGatewayOnWindows(options, gatewayEnv)
    : await runGatewayOnce(options, gatewayEnv);
}

main().catch(() => {
  console.error('CozyGateway supervisor could not start.');
  process.exitCode = 1;
});

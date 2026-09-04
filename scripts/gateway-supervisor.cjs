#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, renameSync, unwatchFile, watchFile } = require('node:fs');
const { createServer } = require('node:net');
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

function configuredDashboardPort(options) {
  try {
    const config = JSON.parse(readFileSync(options.config, 'utf8'));
    const local = (Array.isArray(config.hermesEndpoints) ? config.hermesEndpoints : [])
      .map((endpoint) => /^ws:\/\/127\.0\.0\.1:(\d+)\/api\/ws$/.exec(endpoint?.url ?? "")?.[1])
      .filter((port) => port !== undefined);
    if (local.length === 1) {
      const port = Number(local[0]);
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
    }
  } catch {}
  return Number(options.dashboardPort);
}

function reconcileDashboardPortState(options, port) {
  if (!options.dashboardPortState) return;
  try {
    if (Number(readFileSync(options.dashboardPortState, 'utf8').trim()) === port) return;
  } catch {}
  const staged = `${options.dashboardPortState}.tmp.${process.pid}`;
  writeFileSync(staged, `${port}\n`, { mode: 0o600 });
  renameSync(staged, options.dashboardPortState);
}

async function dashboardStatus(port, token) {
  return await fetch(`http://127.0.0.1:${port}/api/config`, {
    headers: { 'x-hermes-session-token': token }, signal: AbortSignal.timeout(2000),
  }).then((response) => response.status).catch(() => undefined);
}

async function portIsAvailable(port) {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

function persistDashboardEndpoint(options, currentPort, port) {
  const originalConfig = readFileSync(options.config, 'utf8');
  const config = JSON.parse(originalConfig);
  const endpoints = Array.isArray(config.hermesEndpoints) ? config.hermesEndpoints : [];
  const current = `ws://127.0.0.1:${currentPort}/api/ws`;
  const matches = endpoints.filter((endpoint) => endpoint?.url === current);
  if (matches.length !== 1) throw new Error('CozyGateway could not safely update its private Hermes Dashboard endpoint');
  matches[0].url = `ws://127.0.0.1:${port}/api/ws`;
  if (matches[0].baseUrl === `http://127.0.0.1:${currentPort}`) matches[0].baseUrl = `http://127.0.0.1:${port}`;
  const stagedConfig = `${options.config}.dashboard-port.${process.pid}`;
  writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const stagedState = options.dashboardPortState && `${options.dashboardPortState}.tmp.${process.pid}`;
  if (stagedState) writeFileSync(stagedState, `${port}\n`, { mode: 0o600 });
  let configPromoted = false;
  try {
    renameSync(stagedConfig, options.config);
    configPromoted = true;
    if (stagedState) renameSync(stagedState, options.dashboardPortState);
  } catch (error) {
    if (configPromoted) {
      const rollback = `${options.config}.dashboard-port.rollback.${process.pid}`;
      try {
        writeFileSync(rollback, originalConfig, { mode: 0o600 });
        renameSync(rollback, options.config);
      } catch (rollbackError) {
        throw new Error(`CozyGateway could not persist its private Dashboard endpoint or restore the prior configuration: ${rollbackError.message}`);
      }
    }
    throw error;
  }
}

async function startDashboardIfNeeded(options) {
  if (!options.dashboardEnv) return;
  const dashboard = parseEnv(readFileSync(options.dashboardEnv, 'utf8'));
  const environment = {
    ...process.env,
    HERMES_HOME: options.hermesRoot,
    HERMES_DASHBOARD_SESSION_TOKEN: dashboard.DASHBOARD_SESSION_TOKEN,
  };
  const start = async (port) => {
    const profile = options.windowsDashboardProfile ? ['-p', 'default'] : [];
    const child = spawn(options.hermes, ['dashboard', ...profile, '--host', '127.0.0.1', '--port', String(port), '--no-open', '--skip-build'], {
      detached: true, stdio: 'ignore', env: environment,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    return child;
  };
  const verify = async (port) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await dashboardStatus(port, dashboard.DASHBOARD_SESSION_TOKEN);
      if (status === 200) return;
      if (status === 401 || status === 403) throw new Error('Hermes Dashboard rejected the configured local session token');
      await wait(1000);
    }
    throw new Error('Hermes Dashboard did not become ready for authenticated local access');
  };
  // The endpoint the Gateway reads is the durable authority. The state file is a convenience for
  // installer reruns, so an interruption after the config rename cannot make a later supervisor
  // dial an old port or overwrite a newer endpoint.
  const preferred = configuredDashboardPort(options);
  const existing = await dashboardStatus(preferred, dashboard.DASHBOARD_SESSION_TOKEN);
  if (existing === 200) {
    reconcileDashboardPortState(options, preferred);
    return;
  }
  let child;
  if (existing !== 401 && existing !== 403) {
    child = await start(preferred);
    try {
      await verify(preferred);
      reconcileDashboardPortState(options, preferred);
      child.unref();
      return;
    } catch (error) {
      await stopOwnedDashboard(child, { ...options, dashboardPort: preferred });
      if (error.message !== 'Hermes Dashboard rejected the configured local session token') throw error;
    }
  }
  for (let port = preferred + 1; port <= Math.min(preferred + 64, 65535); port += 1) {
    if (!await portIsAvailable(port)) continue;
    child = await start(port);
    try {
      await verify(port);
      persistDashboardEndpoint(options, preferred, port);
      child.unref();
      console.error(`CozyGateway preserved an incompatible Dashboard on port ${preferred} and started its private control Dashboard on loopback port ${port}.`);
      return;
    } catch (error) {
      await stopOwnedDashboard(child, { ...options, dashboardPort: port });
      throw error;
    }
  }
  throw new Error(`CozyGateway found an incompatible Dashboard on port ${preferred} and no private loopback fallback port is available`);
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

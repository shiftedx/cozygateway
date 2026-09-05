const { readFileSync, unwatchFile, watchFile } = require('node:fs');
const { spawn } = require('node:child_process');
const { parseEnv } = require('node:util');
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function stopOwnedDashboard(child, dashboardPort, hermesRoot, hermes, launcher, ownerHelper) {
  if (process.platform === 'win32') {
    if (child.exitCode === null && child.signalCode === null) {
      const taskkill = (process.env.SystemRoot || process.env.WINDIR) + '\System32\taskkill.exe';
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve) => { killer.once('error', resolve); killer.once('exit', resolve); });
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await wait(100);
    }
    const cleanupPort = Number(dashboardPort);
    if (!Number.isInteger(cleanupPort) || cleanupPort < 1 || cleanupPort > 65535) throw new Error('invalid Hermes Dashboard cleanup port');
    const listenerCleanup = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ownerHelper,
      hermesRoot, hermes, launcher, String(cleanupPort),
    ], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve) => { listenerCleanup.once('error', resolve); listenerCleanup.once('exit', resolve); });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
  await wait(1000);
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function main() {
const [gatewayEnvPath, dashboardEnvPath, hermesRoot, hermes, launcher, ownerHelper, dashboardPort, bundle, config] = process.argv.slice(2);
const gatewayEnv = parseEnv(readFileSync(gatewayEnvPath, 'utf8'));
const dashboard = parseEnv(readFileSync(dashboardEnvPath, 'utf8'));
const dashboardEnv = {
  ...process.env,
  HERMES_HOME: hermesRoot,
  HERMES_DASHBOARD_SESSION_TOKEN: dashboard.DASHBOARD_SESSION_TOKEN,
};
const health = await fetch('http://127.0.0.1:' + dashboardPort + '/api/health', { signal: AbortSignal.timeout(2000) })
  .then((response) => response.status === 200 || response.status === 401)
  .catch(() => false);
let dashboardChild;
if (!health) {
  const dashboardArgs = ['dashboard', ...(1 === 1 ? ['-p', 'default'] : []), '--host', '127.0.0.1', '--port', dashboardPort, '--no-open', '--skip-build'];
  dashboardChild = spawn(hermes, dashboardArgs, { detached: true, stdio: 'ignore', env: dashboardEnv });
  await new Promise((resolve, reject) => { dashboardChild.once('spawn', resolve); dashboardChild.once('error', reject); });
}
try {
  let probe;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    probe = await fetch('http://127.0.0.1:' + dashboardPort + '/api/config', {
      headers: { 'x-hermes-session-token': dashboard.DASHBOARD_SESSION_TOKEN },
      signal: AbortSignal.timeout(2000),
    }).catch(() => undefined);
    if (probe?.status === 200) break;
    if (probe?.status === 401 || probe?.status === 403) throw new Error('Hermes Dashboard rejected the configured local session token');
    await wait(1000);
  }
  if (probe?.status !== 200) throw new Error('Hermes Dashboard did not become ready for authenticated local access');
} catch (error) {
  if (dashboardChild) await stopOwnedDashboard(dashboardChild, dashboardPort, hermesRoot, hermes, launcher, ownerHelper);
  throw error;
}
if (dashboardChild) dashboardChild.unref();
let child;
let restarting = false;
let shuttingDown = false;
let crashRestartTimer;
let configBytes = readFileSync(config);
const restartAfterCrash = () => {
  if (shuttingDown || crashRestartTimer) return;
  crashRestartTimer = setTimeout(() => {
    crashRestartTimer = undefined;
    if (!shuttingDown) spawnGateway();
  }, 1000);
};
const spawnGateway = () => {
  child = spawn(process.execPath, [bundle, 'serve', '--config', config], { stdio: 'inherit', env: { ...process.env, ...gatewayEnv } });
  child.on('error', (error) => { console.error(error); restartAfterCrash(); });
  child.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(code ?? (signal ? 1 : 0));
    if (restarting) {
      if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = undefined; }
      restarting = false;
      spawnGateway();
      return;
    }
    console.error('CozyGateway exited unexpectedly (' + (code ?? signal ?? 'unknown') + '); restarting');
    restartAfterCrash();
  });
};
const restartGateway = () => {
  if (shuttingDown || restarting) return;
  if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = undefined; }
  restarting = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  else { restarting = false; spawnGateway(); }
};
watchFile(config, { interval: 500 }, (current, previous) => {
  if (current.mtimeMs === previous.mtimeMs) return;
  const next = readFileSync(config);
  if (next.equals(configBytes)) return;
  configBytes = next;
  restartGateway();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  shuttingDown = true;
  if (crashRestartTimer) clearTimeout(crashRestartTimer);
  unwatchFile(config);
  if (child && child.exitCode === null) child.kill(signal);
  else process.exit(0);
});
spawnGateway();
}
main();

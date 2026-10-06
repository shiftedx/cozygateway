import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const execFileAsync = promisify(execFile);

test("Windows supervisor allows three restarts in five minutes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cozygateway-supervisor-"));
  const config = join(directory, "config.json");
  const gatewayEnv = join(directory, "gateway.env");
  const log = join(directory, "spawns.log");
  const preload = join(directory, "preload.cjs");
  await writeFile(config, "{}\n");
  await writeFile(gatewayEnv, "FIXTURE=value\n");
  await writeFile(preload, String.raw`
const { appendFileSync } = require('node:fs');
const { EventEmitter } = require('node:events');
require('node:child_process').spawn = () => {
  appendFileSync(process.env.COZYGATEWAY_SPAWN_LOG, 'spawn\n');
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {};
  process.nextTick(() => { child.exitCode = 1; child.emit('exit', 1, null); });
  return child;
};
`);

  await expect(execFileAsync(process.execPath, [
    resolve("../..", "scripts/gateway-supervisor.cjs"),
    "--platform", "Windows",
    "--gateway-env", gatewayEnv,
    "--bundle", join(directory, "bundle.mjs"),
    "--config", config,
    "--maintenance-socket", "unused",
    "--maintenance-worker", "unused",
    "--database", "unused",
  ], {
    env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, COZYGATEWAY_SPAWN_LOG: log },
    timeout: 10_000,
  })).rejects.toMatchObject({ code: 1 });
  expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(4);
}, 15_000);

test("supervisor starts its preferred-port Dashboard isolated from a machine backend", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cozygateway-supervisor-"));
  const config = join(directory, "config.json");
  const gatewayEnv = join(directory, "gateway.env");
  const dashboardEnv = join(directory, "dashboard.env");
  const bundle = join(directory, "bundle.cjs");
  const hermes = join(directory, "hermes");
  const log = join(directory, "hermes.log");
  const port = await new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
  await writeFile(config, "{}\n");
  await writeFile(gatewayEnv, "FIXTURE=value\n");
  await writeFile(dashboardEnv, "DASHBOARD_SESSION_TOKEN=fixture-token-0123456789\n");
  await writeFile(bundle, "");
  // Hermes 0.17+: a plain `dashboard --port N` attaches to the machine-level backend
  // (`hermes serve` on another port) and exits; only --isolated binds N.
  await writeFile(hermes, `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args.includes('--help')) { console.log('  --isolated'); process.exit(0); }
if (!args.includes('--isolated')) process.exit(0);
const server = require('node:http').createServer((request, response) => {
  const ok = request.headers['x-hermes-session-token'] === process.env.HERMES_DASHBOARD_SESSION_TOKEN;
  response.writeHead(ok ? 200 : 401).end();
  if (ok) server.close(() => process.exit(0));
}).listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
`);
  await chmod(hermes, 0o700);

  const { stderr } = await execFileAsync(process.execPath, [
    resolve("../..", "scripts/gateway-supervisor.cjs"),
    "--platform", "Darwin",
    "--gateway-env", gatewayEnv,
    "--bundle", bundle,
    "--config", config,
    "--maintenance-socket", "unused",
    "--maintenance-worker", "unused",
    "--database", "unused",
    "--dashboard-env", dashboardEnv,
    "--hermes-root", directory,
    "--hermes", hermes,
    "--hermes-launcher", hermes,
    "--owner-helper", "unused",
    "--dashboard-port", String(port),
  ], { timeout: 10_000 });
  expect(stderr).toBe("");
  const launches = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[])
    .filter((args) => !args.includes("--help"));
  expect(launches).toEqual([
    ["dashboard", "--host", "127.0.0.1", "--port", String(port), "--no-open", "--skip-build", "--isolated"],
  ]);
}, 15_000);

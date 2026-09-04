import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    resolve("scripts/gateway-supervisor.cjs"),
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

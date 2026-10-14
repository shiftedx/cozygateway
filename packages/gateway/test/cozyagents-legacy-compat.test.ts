// Characterization of what a gateway does today with CozyAgents leftovers (ADR 0087, slice 1).
// Later slices remove the code that wrote these rows, so every fixture here is raw SQL or a raw
// socket frame: nothing below may call insertRuntimeBot, enqueueRunnerOperation or any other
// method those slices delete.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayInfo } from "cozygateway-contract";

import { hashToken } from "../src/auth.ts";
import { RunnerLane } from "../src/runner/lane.ts";
import { RUNNER_V1_VERSION } from "../src/runner/protocol.ts";
import { startGateway } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";

const scratch: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
beforeEach(() => { process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret"; process.env.TEST_ATTACH_TOKEN = "attach-secret"; });
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

const workspace = JSON.stringify({ computerId: "old-mac", projectId: "app", mode: "worktree", branch: "main" });

/** A gateway database a CozyAgents-era gateway left behind. The schema comes from the current
 *  `openStorage`; every legacy row is inserted with SQL so removing the storage methods cannot
 *  break this fixture. */
function legacyDatabase(): { path: string; runnerToken: string } {
  const dir = mkdtempSync(join(tmpdir(), "cozygateway-legacy-cozyagents-"));
  scratch.push(dir);
  const path = join(dir, "gateway.sqlite");
  openStorage(path).close();
  const runnerToken = "legacy-runner-token";
  const db = new DatabaseSync(path);
  db.exec(`
    INSERT INTO runtime_bots (id, name, avatar, token, runtime, spec_generation, created_at)
      VALUES ('legacy-agent', 'Legacy Agent', NULL, 'legacy-bot-token', 'cozyagents', 1, 5);
    INSERT INTO runner_operations (operation_id, bot, kind, spec_generation, payload_json, stage, created_at, updated_at)
      VALUES ('op_legacy', 'legacy-agent', 'create_runtime', 1, '{}', 'waiting_for_runner', 5, 5);
    INSERT INTO chat_executions (execution_id, bot, session_id, runner_id, token, operation_id, workspace_json, harness, stage, created_at)
      VALUES ('chatx_00000000000000000000000000000000', 'sage', 'session-1', 'runner-old', 'legacy-exec-token', 'op_exec',
              '${workspace}', 'cozyagents', 'ready', 6);
  `);
  db.prepare("INSERT INTO runners (id, name, token_hash, is_default, created_at) VALUES (?, ?, ?, 1, 7)")
    .run("runner-old", "Old Mac", hashToken(runnerToken));
  db.close();
  return { path, runnerToken };
}

function snapshot(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      runtimeBots: db.prepare("SELECT * FROM runtime_bots ORDER BY id").all(),
      operations: db.prepare("SELECT * FROM runner_operations ORDER BY operation_id").all(),
      executions: db.prepare("SELECT * FROM chat_executions ORDER BY execution_id").all(),
    };
  } finally {
    db.close();
  }
}

async function pairDevice(url: string, issue: () => string): Promise<Record<string, string>> {
  const paired = await fetch(`${url}/pair`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: issue(), deviceName: "phone" }),
  });
  return { authorization: `Bearer ${((await paired.json()) as { deviceToken: string }).deviceToken}` };
}

/** The hello CozyAgents' runner sends (`src/runner/runner.ts`, the `#send({ kind: "hello", ... })`
 *  call): the process backend with chat execution, and `hermes` only when an executor is set. */
function runnerHello(runnerId: string, harnesses: readonly ("cozyagents" | "hermes")[]) {
  return {
    kind: "hello", version: RUNNER_V1_VERSION, runnerId, backends: ["process"], name: "Old Mac",
    platform: { os: "darwin", arch: "arm64", release: "25.0.0" }, agentVersion: "0.40.1",
    capabilities: { update_runner: 1, chat_execution: 1 }, chatExecutionHarnesses: harnesses,
  };
}

async function connect(wsUrl: string, token: string): Promise<{ ws: WebSocket; frames: unknown[]; closed: Promise<number> }> {
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  const frames: unknown[] = [];
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  closers.push(() => { ws.terminate(); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, frames, closed };
}

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

describe("a database left by a CozyAgents-era gateway", () => {
  it("opens, keeps every legacy row byte for byte, and never attaches, lists or dispatches them", async () => {
    const { path, runnerToken } = legacyDatabase();
    const before = snapshot(path);
    expect(before.runtimeBots).toHaveLength(1);
    expect(before.operations).toHaveLength(1);
    expect(before.executions).toHaveLength(1);

    const gw = await startGateway({
      name: "legacy-db", port: 0, dbPath: path, turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    let gwClosed = false;
    closers.push(async () => { if (!gwClosed) await gw.close(); });
    const auth = await pairDevice(gw.url, () => gw.issueSetupCode());

    // Not listed: a runtime bot row never reaches the roster, and the health still names Hermes only.
    const bots = (await (await fetch(`${gw.url}/bots`, { headers: auth })).json()) as { bots: Array<{ name: string }> };
    expect(bots.bots.map((bot) => bot.name)).not.toContain("legacy-agent");
    expect(((await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo).botRuntimes).toEqual(["hermes"]);

    // Not attached: the legacy bot token and the legacy execution token authenticate nothing.
    for (const token of ["legacy-bot-token", "legacy-exec-token"]) {
      const rejected = await fetch(`${gw.url}/bots`, { headers: { authorization: `Bearer ${token}` } });
      expect(rejected.status).toBe(401);
    }

    // The paired computer row stays listed, offline until it connects.
    const listed = (await (await fetch(`${gw.url}/runners`, { headers: auth })).json()) as { runners: Array<{ id: string; name: string; online?: boolean }> };
    expect(listed.runners.map((runner) => runner.id)).toEqual(["runner-old"]);

    // Not dispatched: the computer connects with a CozyAgents-only hello and is sent only the hello acknowledgement: not
    // the waiting create_runtime operation and not a relaunch of the cozyagents execution.
    const { ws, frames } = await connect(`${gw.url.replace("http", "ws")}/runner/v1`, runnerToken);
    ws.send(JSON.stringify(runnerHello("runner-old", ["cozyagents"])));
    await settle();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const online = (await (await fetch(`${gw.url}/runners`, { headers: auth })).json()) as { runners: Array<{ online?: boolean }> };
    expect(online.runners[0]?.online).toBe(true);
    expect(frames).toEqual([expect.objectContaining({ kind: "hello_ack" })]);
    ws.close();

    gwClosed = true;
    await gw.close();
    // Start and shutdown delete, rewrite and revoke nothing.
    expect(snapshot(path)).toEqual(before);
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare("SELECT id FROM runners").all()).toEqual([{ id: "runner-old" }]);
    raw.close();
  });

  it("revokes a paired computer without a bot count and leaves the legacy rows alone", async () => {
    const { path } = legacyDatabase();
    const before = snapshot(path);
    const gw = await startGateway({
      name: "legacy-revoke", port: 0, dbPath: path, turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    let gwClosed = false;
    closers.push(async () => { if (!gwClosed) await gw.close(); });
    const auth = await pairDevice(gw.url, () => gw.issueSetupCode());
    const revoked = await fetch(`${gw.url}/runners/runner-old`, { method: "DELETE", headers: auth });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ ok: true, botCount: 0, reassignedOperations: 0 });
    expect(((await (await fetch(`${gw.url}/runners`, { headers: auth })).json()) as { runners: unknown[] }).runners).toEqual([]);
    gwClosed = true;
    await gw.close();
    expect(snapshot(path)).toEqual(before);
  });
});

describe("the runner hello a CozyAgents runner sends", () => {
  async function lane() {
    const runnerLane = new RunnerLane({ token: "shared-token", log: () => {}, heartbeatIntervalMs: 60_000 });
    const server: Server = createServer();
    server.on("upgrade", (req, socket, head) => runnerLane.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(async () => { runnerLane.close(); await new Promise((resolve) => server.close(resolve)); });
    return { runnerLane, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it.each([
    [["cozyagents", "hermes"], true],
    [["hermes"], true],
    [["cozyagents"], false],
  ] as const)("accepts a hello listing %j and offers a Hermes chat only when hermes is listed (%s)", async (harnesses, offered) => {
    const { runnerLane, url } = await lane();
    const { ws, closed } = await connect(`${url}/runner/v1`, "shared-token");
    let code: number | undefined;
    void closed.then((value) => { code = value; });
    ws.send(JSON.stringify(runnerHello("old-mac", harnesses)));
    await settle();
    // Accepted: a schema failure would close the socket with 1002.
    expect(code).toBeUndefined();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(runnerLane.connectedRunners()).toEqual(["legacy"]);
    expect(runnerLane.chatCapableRunners()).toEqual(offered ? ["legacy"] : []);
    expect(runnerLane.agentVersion("legacy")).toBe("0.40.1");
  });

  it("is never offered a Hermes chat when the hello names no harness or no chat execution", async () => {
    const { runnerLane, url } = await lane();
    const { ws } = await connect(`${url}/runner/v1`, "shared-token");
    const { chatExecutionHarnesses: _omitted, ...older } = runnerHello("old-mac", ["cozyagents"]);
    ws.send(JSON.stringify(older));
    await settle();
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(runnerLane.chatCapableRunners()).toEqual([]);

    const second = await connect(`${url}/runner/v1`, "shared-token");
    const { capabilities: _caps, ...noChat } = runnerHello("old-mac", ["cozyagents", "hermes"]);
    second.ws.send(JSON.stringify(noChat));
    await settle();
    expect(runnerLane.chatCapableRunners()).toEqual([]);
  });
});

describe("what a Hermes gateway tells a client about runtimes and computers", () => {
  it("answers 503 to a CozyAgents bot create, reports botRuntimes [hermes], and keeps the runners capability", async () => {
    const gw = await startGateway({
      name: "health-snapshot", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    closers.push(() => gw.close());
    const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
    expect(health.botRuntimes).toEqual(["hermes"]);
    // CozyChat gates the Computers screen on this capability at version 1 or later.
    expect(health.capabilities?.["com.cozylabs.runners"]).toBe(1);
    // The whole map, so a removal slice cannot add or drop a capability unnoticed.
    expect(health.capabilities).toEqual({
      approvals: 1,
      "com.cozylabs.cozyapps": 2,
      "com.cozylabs.bots": 89,
      "com.cozylabs.chat-audio": 1,
      "com.cozylabs.chat-configuration": 1,
      "com.cozylabs.chat-context": 1,
      "com.cozylabs.provider-connections": 1,
      "com.cozylabs.harness-settings": 1,
      "com.cozylabs.runners": 1,
      "com.cozylabs.hermes-desktop-sessions": 4,
      "com.cozylabs.mobile-node": 6,
    });
    const auth = await pairDevice(gw.url, () => gw.issueSetupCode());
    const created = await fetch(`${gw.url}/bots`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "sage", runtime: "cozyagents" }),
    });
    expect(created.status).toBe(503);
    expect(await created.json()).toEqual({ error: { code: "backend_unavailable", message: "this gateway cannot create runtime bots" } });
  });

  it("reports no runtimes, and still advertises runners, when no Hermes endpoint is configured", async () => {
    const gw = await startGateway({ name: "no-hermes", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0 });
    closers.push(() => gw.close());
    const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
    expect(health.botRuntimes).toEqual([]);
    expect(health.capabilities?.["com.cozylabs.runners"]).toBe(1);
  });
});

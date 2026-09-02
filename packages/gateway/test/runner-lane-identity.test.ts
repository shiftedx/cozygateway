import { createServer } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { RunnerLane } from "../src/runner/lane.ts";
import { RunnerRoster } from "../src/runner/roster.ts";
import type { RunnerServerFrame } from "../src/runner/protocol.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** Capability 52, the lane half. The single-tenant lane had three single-tenant places at once: one
 *  token, one connection, and a lane that was not built at all without an operator-placed token.
 *  What a person feels when those move is that a second computer can be paired to the account they
 *  already have, and that taking one away closes that machine's socket and nobody else's. */

const NOW = 1_800_000_000_000;
const LEGACY_TOKEN = "legacy-shared-secret";

interface Harness {
  storage: Storage;
  roster: RunnerRoster;
  lane: RunnerLane;
  port: number;
  logs: string[];
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const harness of harnesses.splice(0)) await harness.close();
});

async function harness(opts: { legacyToken?: string } = {}): Promise<Harness> {
  const storage = openStorage(":memory:");
  const roster = new RunnerRoster({ storage, now: () => NOW });
  const logs: string[] = [];
  const lane = new RunnerLane({
    ...(opts.legacyToken === undefined ? {} : { token: opts.legacyToken }),
    roster,
    storage,
    attachTokenFor: (botId) => storage.runtimeBot(botId)?.token,
    now: () => NOW,
    log: (line) => logs.push(line),
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] === "/runner/v1") lane.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const built: Harness = {
    storage,
    roster,
    lane,
    port: typeof address === "object" && address !== null ? address.port : 0,
    logs,
    close: async () => {
      lane.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      storage.close();
    },
  };
  harnesses.push(built);
  return built;
}

interface Runner {
  ws: WebSocket;
  frames: RunnerServerFrame[];
  closed: { code: number | undefined };
}

function connect(h: Harness, token: string): Runner {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/runner/v1`, {
    headers: { authorization: `Bearer ${token}` },
  });
  sockets.push(ws);
  const frames: RunnerServerFrame[] = [];
  const closed: { code: number | undefined } = { code: undefined };
  ws.on("message", (data) => frames.push(JSON.parse(String(data)) as RunnerServerFrame));
  ws.on("close", (code) => {
    closed.code = code;
  });
  return { ws, frames, closed };
}

async function hello(
  runner: Runner,
  frame: Record<string, unknown>,
): Promise<void> {
  await once(runner.ws, "open");
  runner.ws.send(JSON.stringify({ kind: "hello", version: 1, backends: ["process"], ...frame }));
}

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const acked = (runner: Runner) => runner.frames.some((frame) => frame.kind === "hello_ack");

describe("the lane and a per-runner token", () => {
  it("accepts a paired runner's token with no shared token configured at all", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    const runner = connect(h, paired.token);
    await hello(runner, { runnerId: paired.runner.id });
    await until(() => acked(runner));
    expect(h.lane.connectedRunners()).toEqual([paired.runner.id]);
    expect(h.lane.connected()).toBe(true);
  });

  it("records the name, platform and version a hello reported, and leaves nulls without one", async () => {
    const h = await harness();
    const reported = h.roster.pair({ name: "kyle-mbp" });
    const silent = h.roster.pair({ name: "quiet" });

    const first = connect(h, reported.token);
    await hello(first, {
      runnerId: reported.runner.id,
      name: "kyle-mbp",
      platform: { os: "darwin", arch: "arm64", release: "24.5.0" },
      agentVersion: "0.1.0",
      backends: ["process", "docker"],
    });
    await until(() => acked(first));
    const second = connect(h, silent.token);
    await hello(second, { runnerId: silent.runner.id });
    await until(() => acked(second));

    expect(h.roster.get(reported.runner.id)).toMatchObject({
      platform: "darwin/arm64/24.5.0",
      version: "0.1.0",
      backends: ["process", "docker"],
      lastSeenAt: NOW,
    });
    expect(h.roster.get(silent.runner.id)).toMatchObject({ platform: null, version: null, backends: ["process"] });
  });

  it("renames the row when the machine renames itself, and leaves it alone when it says nothing", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "old-name" });
    const first = connect(h, paired.token);
    await hello(first, { runnerId: paired.runner.id, name: "kyle-mbp" });
    await until(() => acked(first));
    // Renaming a computer renames its roster row: a name frozen at pairing time would be stale,
    // not stable.
    expect(h.roster.get(paired.runner.id)?.name).toBe("kyle-mbp");

    first.ws.close();
    await until(() => h.lane.connectedRunners().length === 0);
    const second = connect(h, paired.token);
    // An older runner reports no name at all; what the row already holds stands.
    await hello(second, { runnerId: paired.runner.id });
    await until(() => acked(second));
    expect(h.roster.get(paired.runner.id)?.name).toBe("kyle-mbp");
  });

  it("refuses a revoked token, and closes the socket that token had open", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "gone" });
    const runner = connect(h, paired.token);
    await hello(runner, { runnerId: paired.runner.id });
    await until(() => acked(runner));

    h.roster.remove(paired.runner.id);
    h.lane.disconnectRunner(paired.runner.id);
    await until(() => runner.closed.code !== undefined);
    expect(runner.closed.code).toBe(1008);

    const reconnect = connect(h, paired.token);
    await until(() => reconnect.closed.code !== undefined);
    expect(reconnect.closed.code).toBe(1008);
    expect(h.lane.connectedRunners()).toEqual([]);
  });

  it("closes a hello that claims another runner's identity", async () => {
    const h = await harness();
    const mine = h.roster.pair({ name: "mine" });
    const theirs = h.roster.pair({ name: "theirs" });
    const runner = connect(h, mine.token);
    await hello(runner, { runnerId: theirs.runner.id });
    await until(() => runner.closed.code !== undefined);
    expect(runner.closed.code).toBe(1008);
    expect(h.lane.connectedRunners()).toEqual([]);
  });

  it("refuses an unknown bearer", async () => {
    const h = await harness({ legacyToken: LEGACY_TOKEN });
    const runner = connect(h, "not-a-token");
    await until(() => runner.closed.code !== undefined);
    expect(runner.closed.code).toBe(1008);
  });
});

describe("two runners at once", () => {
  it("gives each its own socket and attributes each hello to its own row", async () => {
    const h = await harness();
    const first = h.roster.pair({ name: "one" });
    const second = h.roster.pair({ name: "two" });
    const runnerOne = connect(h, first.token);
    await hello(runnerOne, { runnerId: first.runner.id, agentVersion: "0.1.0" });
    await until(() => acked(runnerOne));
    const runnerTwo = connect(h, second.token);
    await hello(runnerTwo, { runnerId: second.runner.id, agentVersion: "0.2.0" });
    await until(() => acked(runnerTwo));

    expect([...h.lane.connectedRunners()].sort()).toEqual([first.runner.id, second.runner.id].sort());
    expect(runnerOne.closed.code).toBeUndefined();
    expect(runnerTwo.closed.code).toBeUndefined();
    expect(h.roster.get(first.runner.id)?.version).toBe("0.1.0");
    expect(h.roster.get(second.runner.id)?.version).toBe("0.2.0");
    expect(h.lane.lastContactAt(first.runner.id)).toBe(NOW);
    expect(h.lane.lastContactAt("nobody")).toBeNull();
  });

  it("supersedes only the runner that reconnected, and leaves the other untouched", async () => {
    const h = await harness();
    const first = h.roster.pair({ name: "one" });
    const second = h.roster.pair({ name: "two" });
    const runnerOne = connect(h, first.token);
    await hello(runnerOne, { runnerId: first.runner.id });
    await until(() => acked(runnerOne));
    const runnerTwo = connect(h, second.token);
    await hello(runnerTwo, { runnerId: second.runner.id });
    await until(() => acked(runnerTwo));

    const replacement = connect(h, first.token);
    await hello(replacement, { runnerId: first.runner.id });
    await until(() => acked(replacement));
    await until(() => runnerOne.closed.code !== undefined);
    expect(runnerOne.closed.code).toBe(4000);
    expect(runnerTwo.closed.code).toBeUndefined();
    expect([...h.lane.connectedRunners()].sort()).toEqual([first.runner.id, second.runner.id].sort());
  });
});

describe("the legacy shared token", () => {
  it("still works, still holds one connection, and is still superseded by another legacy hello", async () => {
    const h = await harness({ legacyToken: LEGACY_TOKEN });
    const legacy = connect(h, LEGACY_TOKEN);
    await hello(legacy, { runnerId: "runner-1", backends: ["docker"] });
    await until(() => acked(legacy));
    expect(h.lane.connectedRunners()).toEqual(["legacy"]);

    const replacement = connect(h, LEGACY_TOKEN);
    await hello(replacement, { runnerId: "runner-2", backends: ["docker"] });
    await until(() => acked(replacement));
    await until(() => legacy.closed.code !== undefined);
    expect(legacy.closed.code).toBe(4000);
    expect(h.lane.connectedRunners()).toEqual(["legacy"]);
  });

  it("shares the lane with a paired runner rather than displacing it", async () => {
    const h = await harness({ legacyToken: LEGACY_TOKEN });
    const paired = h.roster.pair({ name: "paired" });
    const modern = connect(h, paired.token);
    await hello(modern, { runnerId: paired.runner.id });
    await until(() => acked(modern));
    const legacy = connect(h, LEGACY_TOKEN);
    await hello(legacy, { runnerId: "runner-1" });
    await until(() => acked(legacy));

    expect([...h.lane.connectedRunners()].sort()).toEqual(["legacy", paired.runner.id].sort());
    expect(modern.closed.code).toBeUndefined();
    // A legacy hello is free to name any runnerId: there is no row to disagree with.
    expect(h.roster.get(paired.runner.id)).toBeDefined();
  });
});

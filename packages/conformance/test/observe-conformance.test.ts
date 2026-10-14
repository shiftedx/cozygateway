/** D6: cross-cutting observability conformance against a running production gateway.
 *
 * The test never builds a second Hono app or a shadow observation ring. `startGateway` owns route
 * registration, attach negotiation, the periodic trim and the live D2/D5 writers; this file only
 * drives that instance and reads its durable store. */
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type RunningGateway } from "cozygateway";
import { OBSERVE_EVENT_DETAIL, OBSERVE_SERIES } from "../../gateway/src/observe/privacy.ts";
import { startFakeHermesServer, type FakeHermesServer } from "../../gateway/test/support/fake-hermes-server.ts";

const DAY = 86_400_000;
const TRIM_INTERVAL_MS = 3_600_000;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let gateway: RunningGateway | undefined;
let hermes: FakeHermesServer | undefined;
let now: number;

function profileList(...names: string[]): unknown {
  return {
    profiles: names.map((name) => ({ name, description: name, has_avatar: false })),
    bot_mode_protocol: true,
  };
}

function concrete(path: string): string {
  return path
    .replace(/:[A-Za-z0-9_]+\{[^}]*\}/g, "x")
    .replace(/:[A-Za-z0-9_]+/g, "x")
    .replace(/\*/g, "x");
}

async function start(options: { observability?: boolean; retentionDays?: number } = {}): Promise<RunningGateway> {
  process.env.D6_ATTACH_TOKEN = "d6-attach-token";
  process.env.D6_CONTROL_TOKEN = "d6-control-token";
  hermes = await startFakeHermesServer({ methods: { "profiles.list": () => profileList("d6-bot") } });
  gateway = await startGateway({
    name: "d6-observe-conformance",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermesEndpoints: [{
      id: "default",
      url: hermes.url,
      tokenEnv: "D6_CONTROL_TOKEN",
      profiles: { "d6-bot": { tokenEnv: "D6_ATTACH_TOKEN", name: "D6" } },
    }],
    observability: { enabled: options.observability ?? true, retentionDays: options.retentionDays ?? 7 },
  });
  return gateway;
}

async function pair(kind: "device" | "observer", token?: string): Promise<string> {
  const codeResponse = token === undefined
    ? undefined
    : await fetch(`${gateway!.url}/observers/pair-code`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const setupCode = token === undefined
    ? gateway!.issueSetupCode()
    : (await codeResponse!.json() as { setupCode: string }).setupCode;
  const response = await fetch(`${gateway!.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode, deviceName: `d6-${kind}`, ...(kind === "observer" ? { kind } : {}) }),
  });
  expect(response.status).toBe(200);
  return (await response.json() as { deviceToken: string }).deviceToken;
}

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  await hermes?.close();
  hermes = undefined;
  delete process.env.D6_ATTACH_TOKEN;
  delete process.env.D6_CONTROL_TOKEN;
  vi.useRealTimers();
});

describe("D6 observation conformance", () => {
  it("everyLiveWriteRouteRefusesAReadScopedToken", async () => {
    const running = await start();
    const write = await pair("device");
    const read = await pair("observer", write);
    const routes = running.routes().filter((route) => WRITE_METHODS.has(route.method.toUpperCase()));
    expect(routes.length).toBeGreaterThan(10);
    const failures: string[] = [];
    for (const route of routes) {
      const url = `${running.url}${concrete(route.path)}`;
      const response = await fetch(url, { method: route.method, headers: { authorization: `Bearer ${read}`, "content-type": "application/json" }, body: "{}" });
      const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
      if (response.status !== 403 || body.error?.code !== "scope_read_only") failures.push(`${route.method} ${route.path}`);
      const writeResponse = await fetch(url, { method: route.method, headers: { authorization: `Bearer ${write}`, "content-type": "application/json" }, body: "{}" });
      const writeBody = await writeResponse.json().catch(() => ({})) as { error?: { code?: string } };
      if (writeBody.error?.code === "scope_read_only") failures.push(`write ${route.method} ${route.path}`);
    }
    expect(failures).toEqual([]);
  });

  it("aRealReadObserverReceivesSanitizedRingSamplesAndNoTranscript", async () => {
    const running = await start();
    const write = await pair("device"), read = await pair("observer", write);
    const socket = new WebSocket(`${running.url.replace("http", "ws")}/ws`);
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", data => frames.push(JSON.parse(String(data))));
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "auth", token: read }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "ready")).toBe(true));
    running.storage.upsertAgent({ id: "private-agent", name: "private-agent", avatar: null, backend: "mock" });
    running.storage.createThread({ id: "private-thread", agentId: "private-agent", title: "private-title", createdAt: now });
    running.storage.appendMessage("private-thread", { role: "user", blocks: [{ type: "paragraph", text: "D6 private transcript sentinel" }] }, now);
    socket.send(JSON.stringify({ type: "observe_subscribe", kinds: ["observe_sample", "observe_event"] }));
    // The subsequent sync acknowledgement is a real protocol ordering barrier for subscribe.
    socket.send(JSON.stringify({ type: "sync", threads: { "private-thread": 0 } }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "synced")).toBe(true));
    running.observations.ring.sample("turn_ms", "d6-bot", 1);
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "observe_sample" && frame.series === "turn_ms")).toBe(true));
    const sample = frames.find(frame => frame.type === "observe_sample" && frame.series === "turn_ms")!;
    expect(Object.keys(sample).sort()).toEqual(["at", "bot", "series", "type", "value"]);
    expect(sample.bot).toBe(running.observations.ring.identify("d6-bot"));
    socket.send(JSON.stringify({ type: "mobile_node_advertise", foreground: true, commands: ["device.status"] }));
    await vi.waitFor(() => expect(frames.some(frame => frame.type === "error" && frame.code === "scope_read_only")).toBe(true));
    expect(frames.some(frame => frame.type === "committed")).toBe(false);
    expect(JSON.stringify(frames)).not.toContain("D6 private transcript sentinel");
    expect(JSON.stringify(frames)).not.toContain("private-title");
    socket.close();
  });

  it("theRetentionTrimRunsThroughTheRealPeriodicSweep", async () => {
    const running = await start({ retentionDays: 1 });
    const store = running.storage.observe;
    const bot = running.observations.ring.identify("d6-bot");
    expect(store.sample("turn_ms", bot, now - 2 * DAY, 1)).toBe(true);
    expect(store.sample("turn_ms", bot, now - 60_000, 2)).toBe(true);
    expect(store.event("turn_terminal", now - 2 * DAY, bot, null, { status: "completed" })).toBe(true);
    expect(store.event("turn_terminal", now - 60_000, bot, null, { status: "completed" })).toBe(true);
    await vi.advanceTimersByTimeAsync(TRIM_INTERVAL_MS);
    const series = store.samples({ series: "turn_ms", from: 0, to: Number.MAX_SAFE_INTEGER });
    const events = store.events({ from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(series.map((row) => row.value)).toEqual([2]);
    expect(events).toHaveLength(1);
  });

  it("noAdversarialStringReachesARingRowUnfiltered", async () => {
    const running = await start();
    const corpus = [
      ...["https://", "http://", "file://", "wss://"].map(scheme => `${scheme}example.test/private?q=secret&token=${["sk", "live", "abcdef0123456789"].join("-")}`),
      "/srv/secret/notes.txt", "../private/notes.txt", "./private/notes.txt", "~/private/notes.txt",
      "C:\\Users\\person\\secret.txt", "..\\private\\secret.txt", "\\\\server\\share\\secret.txt",
      "Bearer eyJhbGciOiJIUzI1NiJ9.abcdef", "Bearer " + "a".repeat(64),
      ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"), ["sk", "live", "abcdef0123456789"].join("-"),
      "Private message paragraph. ".repeat(100) + "\n\nSecond private paragraph.",
      "private\u0000text", "private\u0085text", "private\u200btext", "private\ud800text", "   ",
    ];
    const store = running.storage.observe;
    for (const poison of corpus) {
      running.observations.ring.sample("turn_ms", poison, 1);
      for (const series of OBSERVE_SERIES) running.observations.ring.sample(series, "d6-bot", poison as never);
      for (const [kind, fields] of Object.entries(OBSERVE_EVENT_DETAIL)) {
        for (const field of Object.keys(fields)) running.observations.ring.event(kind as never, "d6-bot", null, { [field]: poison } as never);
      }
      running.observations.ring.event("turn_terminal", poison, poison, { status: "completed" });
      running.observations.ring.event("turn_terminal", poison, poison, { status: "completed", reason: poison } as never);
    }
    const rows = [
      ...OBSERVE_SERIES.flatMap(series => store.samples({ series, from: 0, to: Number.MAX_SAFE_INTEGER }).map(row => JSON.stringify(row))),
      ...store.events({ from: 0, to: Number.MAX_SAFE_INTEGER }).map((row) => JSON.stringify(row)),
    ].join("\n");
    for (const poison of corpus) expect(rows).not.toContain(poison);
    expect(store.refused).toBeGreaterThanOrEqual(corpus.length);
  });
});

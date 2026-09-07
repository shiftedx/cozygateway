/** D6: cross-cutting observability conformance against a running production gateway.
 *
 * The test never builds a second Hono app or a shadow observation ring. `startGateway` owns route
 * registration, attach negotiation, the periodic trim and the live D2/D5 writers; this file only
 * drives that instance and reads its durable store. */
import { once } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { startGateway, type RunningGateway } from "cozygateway";

const DAY = 86_400_000;
const TRIM_INTERVAL_MS = 3_600_000;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const TURN = `obs:${"a".repeat(64)}`;

let gateway: RunningGateway | undefined;
let now: number;

function concrete(path: string): string {
  return path
    .replace(/:[A-Za-z0-9_]+\{[^}]*\}/g, "x")
    .replace(/:[A-Za-z0-9_]+/g, "x")
    .replace(/\*/g, "x");
}

async function start(options: { observability?: boolean; retentionDays?: number } = {}): Promise<RunningGateway> {
  process.env.D6_ATTACH_TOKEN = "d6-attach-token";
  gateway = await startGateway({
    name: "d6-observe-conformance",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    bots: [{ id: "d6-bot", name: "D6", tokenEnv: "D6_ATTACH_TOKEN", runtime: "cozyagents" }],
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

async function attach(capabilities: string[]): Promise<{ socket: WebSocket; received: string[] }> {
  const socket = new WebSocket(`${gateway!.url.replace("http", "ws")}/attach/v1`, {
    headers: { authorization: "Bearer d6-attach-token" },
  });
  const received: string[] = [];
  socket.on("message", (data) => received.push(String(data)));
  await once(socket, "open");
  socket.send(JSON.stringify({
    kind: "hello", version: 2, instanceId: "d6-observe-peer", capabilities,
    resume: { eventSequence: 0, commandSequence: 0 },
  }));
  await vi.waitFor(() => expect(received.some((frame) => JSON.parse(frame).kind === "hello_ack")).toBe(true));
  return { socket, received };
}

function aggregate() {
  const outcomes = { direct: { completed: 0, failed: 0, aborted: 0, unknown: 0 }, gateway: { completed: 0, failed: 0, aborted: 0, unknown: 0 }, routine: { completed: 0, failed: 0, aborted: 0, unknown: 0 }, benchmark: { completed: 0, failed: 0, aborted: 0, unknown: 0 } };
  const failures = { direct: { provider_length: 0, provider: 0, tool: 0, policy: 0, cancelled: 0, transport: 0, internal: 0, unknown: 0 }, gateway: { provider_length: 0, provider: 0, tool: 0, policy: 0, cancelled: 0, transport: 0, internal: 0, unknown: 0 }, routine: { provider_length: 0, provider: 0, tool: 0, policy: 0, cancelled: 0, transport: 0, internal: 0, unknown: 0 }, benchmark: { provider_length: 0, provider: 0, tool: 0, policy: 0, cancelled: 0, transport: 0, internal: 0, unknown: 0 } };
  const family = { calls: 0, succeeded: 0, failed: 0, blocked: 0 };
  return {
    runs: outcomes, failures,
    latency: { samples: 0, wallMs: 0, toolMs: 0, firstTokenSamples: 0, firstTokenMs: 0 },
    tools: { investigation: family, mutation: family, verification: family, unknown: family },
    usage: { samples: 0, availability: "unavailable", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, providerRequests: 0, providerLengthStops: 0 },
    policy: { pendingVerification: 0, blockedDuplicates: 0, blockedIntraBatchDuplicates: 0, blockedStalls: 0, terminalCorrections: 0 },
    delivery: { publishedAttachments: 0, awaitingReceiptTurns: 0, displayedTurns: 0, failedTurns: 0, unmatchedReceipts: 0 },
    context: { compactions: 0, recoveryAttempts: 0, recoverySucceeded: 0, recoveryFailed: 0, toolResults: { rawBytes: 0, modelBytes: 0, exactResults: 0, projectedResults: 0, retrievals: 0, retrievalMisses: 0 } },
    identity: { sources: { service_runtime: 0, unavailable: 0 }, postures: { chat: 0, workspace: 0, room: 0, room51: 0, unattended: 0, consolidation: 0, unavailable: 0 }, builds: {} },
    observer: { retained: 0, retainedBytes: 0, evictions: 0, droppedOversize: 0, failures: 0, droppedSpans: 0, malformedSources: 0 },
  };
}

function snapshot(poison: string) {
  return {
    schema: "cozyagents.observation-snapshot-lane.v1", reason: "turn_terminal", emittedAt: now, windowMs: 60_000,
    snapshot: { schema: "cozyagents.observation-snapshot.v1", dashboard: "cozyagents.observability-dashboard.v1", view: "aggregate", generatedAt: new Date(now).toISOString(), aggregate: aggregate() },
    runtime: { stage: "ready", backend: "docker", isolation: "workspace", bundleVersion: poison },
    cache: { availability: "unavailable", window: "process_lifetime", hits: 0, misses: 0, writes: 0, errors: 0, invalidations: 0 },
    checkpoints: { written: 0 },
    steps: [{ turn: TURN, step: 1, model: poison, promptTokens: 1, completionTokens: 1, cachedTokens: 0 }],
    toolCalls: [{ tool: poison, turn: TURN, step: 1, calls: 1, resultTokens: 1, callTokens: 1, schemaShareTokens: 1, inducedTokens: 3, durationMs: 1, attributed: false, outcomes: { ok: 1 } }],
  };
}

beforeEach(() => {
  now = 1_700_000_000_000;
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  delete process.env.D6_ATTACH_TOKEN;
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

  it("theSnapshotLaneIsByteIdenticalWhenNotNegotiated", async () => {
    const running = await start();
    const peer = await attach(["draft"]);
    const hello = peer.received.map((frame) => JSON.parse(frame)).find((frame) => frame.kind === "hello_ack");
    expect(hello.capabilities).toEqual(["draft"]);
    expect(JSON.stringify(hello)).not.toContain("observation_snapshot");
    expect(running.storage.observe.snapshotSubjects()).toEqual([]);
    expect(running.storage.observe.samples({ series: "prompt_tokens", from: 0, to: Number.MAX_SAFE_INTEGER })).toEqual([]);
    peer.socket.close();
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
      "https://example.test/search?token=sk-live-abcdef0123456789",
      "/srv/secret/notes.txt", "C:\\Users\\person\\secrets\\token.txt",
      "Bearer eyJhbGciOiJIUzI1NiJ9.abcdef", "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "A realistic multi-paragraph message with private content.\n\nIt must never become observability data.",
    ];
    const store = running.storage.observe;
    for (const poison of corpus) {
      running.observations.ring.sample("turn_ms", poison, 1);
      running.observations.ring.event("turn_terminal", poison, poison, { status: "completed", reason: poison } as never);
      expect(running.observations.snapshots.accept("d6-bot", snapshot(poison))).toBe("refused");
    }
    const rows = [
      ...store.samples({ series: "turn_ms", from: 0, to: Number.MAX_SAFE_INTEGER }).map((row) => JSON.stringify(row)),
      ...store.events({ from: 0, to: Number.MAX_SAFE_INTEGER }).map((row) => JSON.stringify(row)),
      ...store.snapshotSubjects().map((subject) => JSON.stringify(store.snapshot(subject))),
    ].join("\n");
    for (const poison of corpus) expect(rows).not.toContain(poison);
    expect(store.refused).toBeGreaterThanOrEqual(corpus.length);
  });
});

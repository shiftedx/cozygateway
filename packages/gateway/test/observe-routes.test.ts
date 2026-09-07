/** Dashboard packet D3 (capability 75): the observer's read routes.
 *
 *  Every panel the concept page draws is answered by one of these routes, every one of them is a
 *  `GET` that a read-scoped token may call and a no-token request may not, and every aggregate on
 *  them carries the number of samples it was computed from. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp, type AppDeps } from "../src/http.ts";
import { ObservationRing } from "../src/observe/ring.ts";
import type { ObserveSnapshotReader } from "../src/observe/routes.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

let storage: Storage;
let clock: number;
let observe: ObservationRing;

function botSummary(name: string, runtime: "cozyagents" | "hermes"): unknown {
  return {
    name, displayName: name, handle: name, description: null, hasAvatar: false, group: null,
    pinned: false, active: true, lastActiveAt: clock - HOUR, chatSessionId: null,
    preview: { text: null, at: null },
    syncState: "ready",
    ...(runtime === "cozyagents" ? { runtime: "cozyagents" } : {}),
  };
}

function makeApp(extra: Partial<AppDeps> = {}) {
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.7.6", contract: "v1" },
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("not under test"); },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => clock,
    observe,
    bots: {
      roster: () => ({
        bots: [botSummary("cleo", "cozyagents"), botSummary("night-owl", "hermes")],
        updatedAt: clock, stale: false, hermesState: "online",
      }),
      health: () => ({ online: true, lastOkAt: clock, lastErrorAt: null, consecutiveFailures: 0 }),
      pendingApprovals: () => [],
    } as unknown as AppDeps["bots"],
    attachHealth: () => ({
      configured: 2, online: 2, degraded: 0, absent: 0,
      lastHeartbeatAt: clock, lastEventAt: clock, lastTerminalAt: clock,
      queueDepth: 1, deadLetters: 0, pluginOutboxDepth: 2, pluginOldestEventAgeMs: 900,
      pluginLastAckProgressAt: clock, pluginCommandInboxDepth: 0,
    }),
    attachDeadLetters: () => [],
    ...extra,
  });
  return app;
}

async function observerToken(app: ReturnType<typeof makeApp>): Promise<string> {
  const code = newSetupCode();
  storage.createSetupCode(code, clock + SETUP_CODE_TTL_MS, "observer");
  const res = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "Dashboard", kind: "observer" }),
  });
  return ((await res.json()) as { deviceToken: string }).deviceToken;
}

/** Every `/observe/api` path the router actually registered, so a route added later is walked by
 *  the scope test without anybody remembering to list it. */
function observeRoutes(app: ReturnType<typeof makeApp>): string[] {
  return [...new Set(
    app.routes
      .filter((route) => route.path.startsWith("/observe/api"))
      .map((route) => `${route.method.toUpperCase()} ${route.path}`),
  )];
}

async function get(
  app: ReturnType<typeof makeApp>,
  path: string,
  token: string | undefined,
): Promise<Response> {
  return await app.request(path, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

beforeEach(() => {
  storage = openStorage(":memory:");
  clock = 1_700_000_000_000;
  observe = new ObservationRing({
    store: storage.observe, options: { enabled: true, retentionDays: 7 }, now: () => clock,
  });
});

afterEach(() => {
  storage.close();
});

describe("every observe api route requires at least read scope", () => {
  it("registers one GET route per panel group and registers no write route at all", () => {
    const routes = observeRoutes(makeApp());
    expect(routes.length).toBeGreaterThanOrEqual(13);
    expect(routes.every((route) => route.startsWith("GET "))).toBe(true);
  });

  it("refuses a request with no token and accepts a read scoped token on every one", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    const failures: string[] = [];
    for (const entry of observeRoutes(app)) {
      const path = entry.slice("GET ".length);
      const anonymous = await get(app, path, undefined);
      if (anonymous.status !== 401) failures.push(`${path} anonymous ${anonymous.status}`);
      const asObserver = await get(app, path, token);
      if (asObserver.status !== 200) failures.push(`${path} observer ${asObserver.status}`);
    }
    expect(failures).toEqual([]);
  });
});

describe("windows and bot filters", () => {
  it("returns only the rows inside the requested window and for the requested bot", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    // Three ages of sample for two bots: inside the hour, inside the day, inside the week.
    for (const [age, value] of [[0, 10], [2 * HOUR, 20], [3 * DAY, 30]] as const) {
      const at = clock;
      clock = at - age;
      observe.sample("ttft_ms", "cleo", value);
      observe.sample("ttft_ms", "night-owl", value + 1);
      clock = at;
    }
    const read = async (window: string, bot?: string) => {
      const query = `?window=${window}${bot === undefined ? "" : `&bot=${bot}`}`;
      const res = await get(app, `/observe/api/series${query}&series=ttft_ms`, token);
      return (await res.json()) as { summary: { samples: number }; points: Array<{ value: number }> };
    };
    expect((await read("1h")).summary.samples).toBe(2);
    expect((await read("24h")).summary.samples).toBe(4);
    expect((await read("7d")).summary.samples).toBe(6);
    expect((await read("7d", "cleo")).points.map((point) => point.value)).toEqual([30, 20, 10]);
    expect((await read("1h", "night-owl")).points.map((point) => point.value)).toEqual([11]);
  });

  it("refuses an unknown window naming the field rather than guessing one", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    const res = await get(app, "/observe/api/overview?window=90d", token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("window");
  });
});

describe("percentiles carry their sample count", () => {
  it("computes p50 and p95 over the window and states how many samples they came from", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    for (let value = 1; value <= 100; value += 1) observe.sample("turn_ms", "cleo", value);
    const res = await get(app, "/observe/api/roundtrip?window=24h&bot=cleo", token);
    const body = (await res.json()) as {
      hops: Array<{ hop: string; p50: number | null; p95: number | null; samples: number }>;
    };
    const turn = body.hops.find((hop) => hop.hop === "turn");
    expect(turn).toBeDefined();
    // Nearest rank over 1..100: p50 is the 50th value, p95 the 95th.
    expect(turn?.p50).toBe(50);
    expect(turn?.p95).toBe(95);
    expect(turn?.samples).toBe(100);
  });

  it("answers an explicit empty shape rather than a 404 for a window with nothing in it", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    const res = await get(app, "/observe/api/roundtrip?window=1h&bot=cleo", token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hops: Array<{ samples: number; p50: number | null }> };
    expect(body.hops.length).toBeGreaterThan(0);
    for (const hop of body.hops) {
      expect(hop.samples).toBe(0);
      expect(hop.p50).toBeNull();
    }
  });

  it("answers an empty shape for a bot the roster has never heard of", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    const res = await get(app, "/observe/api/series?series=ttft_ms&bot=nobody", token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { summary: { samples: number } }).toMatchObject({
      summary: { samples: 0, p50: null, p95: null },
    });
  });
});

describe("fewer than twenty samples shows the count instead of a speed", () => {
  it("withholds the model step percentile under the floor and reports it over the floor", async () => {
    const app = makeApp({ observeSnapshots: presentReader() });
    const token = await observerToken(app);
    for (let step = 0; step < 19; step += 1) observe.sample("model_step_ms", "cleo", 700 + step);
    const under = (await (await get(app, "/observe/api/cozyagents?bot=cleo", token)).json()) as {
      model: { stepLatency: { samples: number; p50: number | null; belowSampleFloor: boolean } };
    };
    expect(under.model.stepLatency.samples).toBe(19);
    expect(under.model.stepLatency.p50).toBeNull();
    expect(under.model.stepLatency.belowSampleFloor).toBe(true);
    observe.sample("model_step_ms", "cleo", 900);
    const over = (await (await get(app, "/observe/api/cozyagents?bot=cleo", token)).json()) as {
      model: { stepLatency: { samples: number; p50: number | null; belowSampleFloor: boolean } };
    };
    expect(over.model.stepLatency.samples).toBe(20);
    expect(over.model.stepLatency.p50).not.toBeNull();
    expect(over.model.stepLatency.belowSampleFloor).toBe(false);
  });
});

describe("identities", () => {
  it("names a subject from the live roster and never returns the hash secret", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    observe.event("turn_terminal", "cleo", "t_1", { status: "completed", reason: "complete" });
    observe.event("turn_terminal", "ghost", "t_2", { status: "failed", reason: "failed" });
    const res = await get(app, "/observe/api/events", token);
    const body = (await res.json()) as {
      events: Array<{ bot: string | null; botName: string | null; kind: string }>;
    };
    const named = body.events.find((event) => event.botName === "cleo");
    expect(named).toBeDefined();
    expect(named?.bot).toBe(observe.identify("cleo"));
    expect(named?.bot).toMatch(/^[0-9a-f]{16}$/);
    const stranger = body.events.find((event) => event.bot === observe.identify("ghost"));
    expect(stranger?.botName).toBe("former bot");
    // The keyed hash may travel as an opaque id; the KEY that made it never may, and a 64 hex
    // string in a response body is what one would look like.
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("the D5 seam", () => {
  it("answers the CozyAgents panels as unavailable with no reader plugged in", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    for (const path of ["/observe/api/cozyagents", "/observe/api/cozyagents/spend", "/observe/api/cozyagents/tools"]) {
      const res = await get(app, path, token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean; reason: string };
      expect(body.available).toBe(false);
      expect(body.reason).toBe("no_snapshot_lane");
    }
  });

  it("serves whatever a plugged in reader returns without reshaping it", async () => {
    const app = makeApp({ observeSnapshots: presentReader() });
    const token = await observerToken(app);
    const spend = (await (await get(app, "/observe/api/cozyagents/spend", token)).json()) as {
      available: boolean; priceSheet: { configured: boolean }; rows: Array<{ bot: string }>;
    };
    expect(spend.available).toBe(true);
    expect(spend.priceSheet.configured).toBe(false);
    expect(spend.rows[0]?.bot).toBe("cleo");
    const tools = (await (await get(app, "/observe/api/cozyagents/tools", token)).json()) as {
      rows: Array<{ tool: string; calls: number }>;
    };
    expect(tools.rows[0]).toMatchObject({ tool: "search_workspace", calls: 268 });
  });
});

describe("the panels the concept page draws", () => {
  it("counts the complete window beyond bounded display feeds", async () => {
    const app = makeApp();
    const token = await observerToken(app);
    for (let index = 0; index < 5_010; index++) {
      observe.event("turn_terminal", "cleo", `turn-${index}`, { status: index < 10 ? "failed" : "completed", reason: "complete" });
    }
    for (let index = 0; index < 20_010; index++) observe.sample("ttft_ms", "cleo", index < 20_000 ? 100 : 200);
    const overview = await (await get(app, "/observe/api/overview", token)).json();
    expect(overview.tiles.turns).toBe(5_010);
    const bots = await (await get(app, "/observe/api/bots", token)).json();
    expect(bots.bots[0]).toMatchObject({ turns: 5_010, failures: 10 });
    const turns = await (await get(app, "/observe/api/turns", token)).json();
    expect(turns.terminals).toHaveLength(5_000);
    expect(turns.firstTokenByHour[0].samples).toBe(20_010);
  });

  it("answers every panel from one route with no extra request shape", async () => {
    const app = makeApp({ observeSnapshots: presentReader() });
    const token = await observerToken(app);
    observe.sample("ttft_ms", "cleo", 330);
    observe.sample("turn_ms", "cleo", 4_100);
    observe.sample("device_rtt_ms", "phone", 46, "tunnel");
    observe.sample("tunnel_rtt_ms", null, 31);
    observe.sample("peer_rtt_ms", "cleo", 9);
    observe.sample("gateway_handle_ms", "cleo", 3);
    observe.sample("felt_latency_ms", "cleo", 4_400, "wifi");
    observe.sample("push_result", "phone", 1, "ok");
    observe.event("turn_terminal", "cleo", "t_1", { status: "completed", reason: "complete" });
    observe.event("tunnel_flap", null, null, { reason: "recovered", outage_ms: 14_000, consecutive: 2 });

    const body = async (path: string) => await (await get(app, path, token)).json() as Record<string, unknown>;

    const overview = await body("/observe/api/overview");
    expect(overview).toHaveProperty("gateway.version", "0.7.6");
    expect(overview).toHaveProperty("gateway.uptimeMs");
    expect(overview).toHaveProperty("attach.queueDepth", 1);
    expect(overview).toHaveProperty("attach.deadLetters", 0);
    expect(overview).toHaveProperty("tunnel.lastFlapAt");
    expect(overview).toHaveProperty("needsAPerson.total");
    expect(overview).toHaveProperty("tiles.firstToken.samples", 1);

    const bots = await body("/observe/api/bots") as { bots: Array<Record<string, unknown>> };
    expect(bots.bots.map((row) => row.name)).toEqual(["cleo", "night-owl"]);
    expect(bots.bots[0]).toMatchObject({ harness: "cozyagents" });
    expect(bots.bots[0]).toHaveProperty("firstToken.samples", 1);
    expect(bots.bots[0]).toHaveProperty("turns");
    expect(bots.bots[0]).toHaveProperty("failures");
    expect(bots.bots[0]).toHaveProperty("openApprovals");

    const turns = await body("/observe/api/turns") as { terminals: unknown[] };
    expect(turns.terminals.length).toBe(1);
    expect(turns).toHaveProperty("firstTokenByHour");

    const roundtrip = await body("/observe/api/roundtrip") as { hops: Array<{ hop: string }> };
    expect(roundtrip.hops.map((hop) => hop.hop)).toEqual([
      "device", "tunnel", "gateway", "peer", "model", "turn",
    ]);
    expect(roundtrip).toHaveProperty("felt.samples", 1);
    expect(roundtrip).toHaveProperty("byNetworkPath");

    const attach = await body("/observe/api/attach");
    expect(attach).toHaveProperty("peers");
    expect(attach).toHaveProperty("deadLetters");

    expect(await body("/observe/api/approvals")).toHaveProperty("grants");
    expect(await body("/observe/api/deliveries")).toHaveProperty("artifacts");
    const devices = await body("/observe/api/devices") as { devices: unknown[]; runners: unknown[] };
    expect(devices.devices.length).toBe(1);
    expect(Array.isArray(devices.runners)).toBe(true);
    expect(await body("/observe/api/events")).toHaveProperty("events");
    expect(await body("/observe/api/cozyagents")).toHaveProperty("internals");
    expect(await body("/observe/api/cozyagents/spend")).toHaveProperty("rows");
    expect(await body("/observe/api/cozyagents/tools")).toHaveProperty("rows");
  });
});

/** A stand in for D5's reader: the shape D3 serves, filled with the concept page's own numbers. */
function presentReader(): ObserveSnapshotReader {
  return {
    attached: () => true,
    internals: () => [{
      bot: "cleo",
      runtimeStage: "ready",
      generationsWanted: 3,
      generationsObserved: 3,
      bundleVersion: "0.2.13",
      runnerName: "a paired computer",
      runnerLastContactAt: 4_000,
      snapshotAgeMs: 12_000,
      toolFamilies: [{ family: "read", calls: 612 }],
      toolServers: [{ server: "calendar", layers: 8, healthy: 8, fingerprint: "4d1c", state: "healthy" }],
      policy: { permitted: 1_171, asked: 27, denied: 3, expired: 2, egressRefused: 1, level: "balanced" },
      context: { inUseTokens: 16_252, windowTokens: 52_428, rollovers: 1, lastRolloverAt: null, cardsAttached: 3, cardsTotal: 29 },
      memory: { recallDocs: 2_314, recallBytes: 19_083_264, lastConsolidationAt: null, evicted: 6, tombstoned: 0 },
      checkpoints: { count: 142, restores: 1, lastRestoreResult: "byte_match" },
    }],
    throughput: () => ({
      priceSheetConfigured: false,
      rows: [{
        bot: "cleo", model: "qwen3.8-27b",
        prefill: { samples: 42, p50: 6_443, p95: 7_100, belowSampleFloor: false },
        decode: { samples: 42, p50: 48, p95: 52, belowSampleFloor: false },
        tokens: { prompt: 1_912_440, completion: 188_102, cached: 0 },
        costMicros: null,
        lifetime: { prompt: 9_000_000, completion: 800_000, cached: 0, costMicros: null, turns: 318 },
      }],
    }),
    toolCosts: () => ({
      priceSheetConfigured: false,
      rows: [{
        tool: "search_workspace", family: "search", calls: 268, errors: 0,
        medianResultTokens: 2_900, inducedTokens: 780_000, costMicros: null,
        duration: { samples: 268, p50: 41, p95: 96, belowSampleFloor: false },
        flags: ["heavy"], attributed: false,
      }],
    }),
  };
}

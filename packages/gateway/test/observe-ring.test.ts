import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";
import {
  ObservationRing,
  TunnelSelfProbe,
  OBSERVE_SERIES,
  OBSERVE_EVENT_KINDS,
  isIdLike,
  serializeDetail,
  seriesName,
} from "../src/observe/index.ts";
import { deviceOriginVia, publicHostOf } from "../src/observe/origin.ts";
import { observability } from "../src/config.ts";

const DAY = 86_400_000;

let storage: Storage;
let clock: number;

function ring(enabled = true, retentionDays = 7): ObservationRing {
  return new ObservationRing({
    store: storage.observe,
    options: { enabled, retentionDays },
    now: () => clock,
  });
}

beforeEach(() => {
  storage = openStorage(":memory:");
  clock = 1_700_000_000_000;
});

afterEach(() => {
  storage.close();
});

function allSeriesRows(): Array<{ series: string; bot: string | null; at: number; value: number }> {
  const out: Array<{ series: string; bot: string | null; at: number; value: number }> = [];
  for (const base of OBSERVE_SERIES) {
    for (const suffix of ["", "|tunnel", "|lan", "|wifi", "|cellular", "|vpn_on", "|vpn_off", "|ok", "|not_found", "|http_error", "|network_error"]) {
      out.push(...storage.observe.samples({ series: `${base}${suffix}`, from: 0, to: Number.MAX_SAFE_INTEGER }));
    }
  }
  return out;
}

function eventRows() {
  return storage.observe.events({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5_000 });
}

describe("the observation ring's row shape", () => {
  it("writes every named series as one unlabelled numeric row", () => {
    const observe = ring();
    // Table driven over the writers named in design sections 3, 10 and 12. Each one is exercised
    // through the public writer a real hook calls, not through the raw store.
    observe.deviceRtt("device-1", 42, "tunnel");
    observe.heartbeatGap("device-1", 5_100);
    observe.tunnelRtt(31);
    observe.gatewayHandle("luna", 3);
    observe.peerHeartbeatSent("luna");
    observe.peerHeartbeatAcked("luna");
    observe.turnAdmitted("luna", "turn-1");
    observe.turnDispatched("luna", "turn-1");
    observe.turnDelta("luna", "turn-1");
    observe.turnDelta("luna", "turn-1");
    observe.turnTerminal("luna", "turn-1", { status: "completed" })();
    observe.attachDepths({ online: 2, queueDepth: 0, deadLetters: 0, outboxDepth: 1 });
    observe.pushResult("device-1", "ok");
    observe.feltLatency("luna", 900, "vpn_on");
    observe.foldSnapshotIntoSeries("luna", {
      modelStepMs: [120, 140], modelSteps: 2, toolMs: [8],
      promptTokens: 1_000, completionTokens: 200, cachedTokens: 800,
    });

    const written = allSeriesRows();
    const names = new Set(written.map((row) => row.series.split("|")[0]));
    for (const series of OBSERVE_SERIES) expect(names, `missing ${series}`).toContain(series);
    for (const row of written) {
      expect(typeof row.value).toBe("number");
      expect(Number.isFinite(row.value)).toBe(true);
      expect(row.at).toBe(clock);
      if (row.bot !== null) expect(isIdLike(row.bot)).toBe(true);
    }
    expect(storage.observe.refused).toBe(0);
  });

  it("counts every delta frame of a turn and times only the first as ttft", () => {
    const observe = ring();
    observe.turnAdmitted("luna", "turn-2");
    for (let index = 0; index < 5; index += 1) observe.turnDelta("luna", "turn-2");
    observe.turnTerminal("luna", "turn-2", { status: "completed", reason: "cancelled" })();

    expect(storage.observe.summarize({ series: "ttft_ms", from: 0, to: clock + 1 }).count).toBe(1);
    const frames = storage.observe.samples({ series: "delta_frames", from: 0, to: clock + 1 });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.value).toBe(5);
    // Admission to dispatch and terminal to broadcast are both gateway handling, so a turn with a
    // dispatch and a terminal contributes two legs, not one.
    expect(storage.observe.summarize({ series: "gateway_handle_ms", from: 0, to: clock + 1 }).count).toBe(1);
  });

  it("tags a device round trip by the origin it arrived on", () => {
    const observe = ring();
    observe.deviceRtt("device-tunnel", 90, "tunnel");
    observe.deviceRtt("device-lan", 4, "lan");
    expect(storage.observe.samples({ series: "device_rtt_ms|tunnel", from: 0, to: clock + 1 })).toHaveLength(1);
    expect(storage.observe.samples({ series: "device_rtt_ms|lan", from: 0, to: clock + 1 })).toHaveLength(1);
    // Bare `device_rtt_ms` is never written, so a reader who forgets the tag gets nothing rather
    // than a silently mixed distribution.
    expect(storage.observe.samples({ series: "device_rtt_ms", from: 0, to: clock + 1 })).toHaveLength(0);
    expect(storage.observe.summarize({ series: "device_rtt_ms", from: 0, to: clock + 1, includeTags: true }).count).toBe(2);
  });
});

describe("observability disabled", () => {
  it("writes nothing at all when the flag is off", () => {
    const observe = ring(false);
    observe.deviceRtt("device-1", 42, "tunnel");
    observe.heartbeatGap("device-1", 1);
    observe.tunnelRtt(31);
    observe.tunnelFlap("bad_gateway", 502);
    observe.gatewayHandle("luna", 3);
    observe.peerHeartbeatSent("luna");
    observe.peerHeartbeatAcked("luna");
    observe.turnAdmitted("luna", "turn-1");
    observe.turnDispatched("luna", "turn-1");
    observe.turnDelta("luna", "turn-1");
    observe.turnTerminal("luna", "turn-1", { status: "completed" })();
    observe.attachDepths({ online: 2, queueDepth: 1, deadLetters: 1, outboxDepth: 1 });
    observe.deadLetter("luna", "event-1");
    observe.pushResult("device-1", "http_error");
    observe.feltLatency("luna", 900, "wifi");
    observe.foldSnapshotIntoSeries("luna", { modelSteps: 3 });
    observe.accumulateLifetime({ bot: "luna", model: "qwen", prompt: 1, completion: 1, cached: 0, costMicros: 0, turns: 1, at: clock });

    expect(allSeriesRows()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
    expect(storage.observe.lifetime()).toHaveLength(0);
    expect(storage.observe.refused).toBe(0);
  });

  it("reads an omitted config section as disabled with a seven day ring", () => {
    expect(observability({ name: "g", port: 1, dbPath: "x", turnTimeoutSeconds: 0 })).toEqual({
      enabled: false, retentionDays: 7,
    });
    expect(observability({
      name: "g", port: 1, dbPath: "x", turnTimeoutSeconds: 0,
      observability: { enabled: true, retentionDays: 3 },
    })).toEqual({ enabled: true, retentionDays: 3 });
  });
});

describe("the ring's retention", () => {
  it("trims at retentionDays and keeps everything inside the window", () => {
    const observe = ring(true, 7);
    storage.observe.sample("turn_ms", "luna", clock - 8 * DAY, 100);
    storage.observe.sample("turn_ms", "luna", clock - 6 * DAY, 200);
    storage.observe.event("turn_terminal", clock - 8 * DAY, "luna", "old-turn", { status: "completed" });
    storage.observe.event("turn_terminal", clock - 1 * DAY, "luna", "new-turn", { status: "completed" });

    const trimmed = observe.trim(clock);
    expect(trimmed).toEqual({ series: 1, events: 1 });
    const survivors = storage.observe.samples({ series: "turn_ms", from: 0, to: clock + 1 });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.value).toBe(200);
    expect(eventRows().map((row) => row.ref)).toEqual(["new-turn"]);
  });

  it("still trims when the flag was turned off after rows were written", () => {
    storage.observe.sample("turn_ms", "luna", clock - 30 * DAY, 100);
    expect(ring(false, 7).trim(clock)).toEqual({ series: 1, events: 0 });
  });

  it("never trims the lifetime table the ring sits beside", () => {
    const observe = ring();
    observe.accumulateLifetime({ bot: "luna", model: "qwen3", prompt: 10, completion: 5, cached: 2, costMicros: 7, turns: 1, at: clock - 400 * DAY });
    observe.accumulateLifetime({ bot: "luna", model: "qwen3", prompt: 1, completion: 1, cached: 0, costMicros: 1, turns: 1, at: clock });
    observe.trim(clock);
    expect(storage.observe.lifetime("luna")).toEqual([
      { bot: "luna", model: "qwen3", prompt: 11, completion: 6, cached: 2, costMicros: 8, turns: 2, updatedAt: clock },
    ]);
  });
});

describe("the privacy rule at the writer", () => {
  const forbidden = [
    "https://gateway.example.com/ready",
    "http://192.168.1.5:8787/bots/luna/chat",
    "/var/lib/cozygateway/Application Support/cozygateway.db",
    "D:\\data\\gateway.db",
    "../../etc/passwd",
    "sk-ant-api03-abcdefghijklmnop",
    "ghp_0123456789abcdefghij",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0",
    "Bearer abc123",
    "hey can you summarise the doc I sent",
    "wss://tunnel.example.com/ws",
    "?query=secret&token=abc",
    "a".repeat(49),
    "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    "",
    "  ",
    "name@example.com",
    "file:///etc/hosts",
  ];

  it("refuses every url, path, token shape, over-long string and sentence in bot, ref and detail", () => {
    for (const value of forbidden) {
      expect(isIdLike(value), `isIdLike accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.sample("turn_ms", value, clock, 1), `bot accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("turn_terminal", clock, null, value), `ref accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("turn_terminal", clock, null, null, { reason: value }), `detail accepted ${JSON.stringify(value)}`).toBe(false);
      expect(serializeDetail({ [value]: 1 }), `detail key accepted ${JSON.stringify(value)}`).toBeUndefined();
    }
    expect(allSeriesRows()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
    expect(storage.observe.refused).toBe(forbidden.length * 3);
  });

  it("refuses a series name or event kind nothing declared, and a value that is not a number", () => {
    expect(storage.observe.sample("secret_prompt_text", "luna", clock, 1)).toBe(false);
    expect(storage.observe.sample("turn_ms|totally_free_text", "luna", clock, 1)).toBe(false);
    expect(storage.observe.sample("turn_ms", "luna", clock, Number.NaN)).toBe(false);
    expect(storage.observe.sample("turn_ms", "luna", clock, Number.POSITIVE_INFINITY)).toBe(false);
    expect(storage.observe.event("transcript", clock, "luna", null)).toBe(false);
    expect(allSeriesRows()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
  });

  it("refuses a detail object that is too large or too wide, and drops it whole rather than in part", () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 20; index += 1) wide[`k${index}`] = index;
    expect(storage.observe.event("turn_terminal", clock, "luna", null, wide)).toBe(false);
    const long: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) long[`key${index}`] = "a".repeat(48);
    expect(storage.observe.event("turn_terminal", clock, "luna", null, long)).toBe(false);
    expect(eventRows()).toHaveLength(0);
  });

  it("accepts the shapes the design does allow: ids, reason codes, hashes, counts and durations", () => {
    expect(storage.observe.sample("turn_ms", "luna", clock, 1_234.5)).toBe(true);
    expect(storage.observe.sample(seriesName("device_rtt_ms", "tunnel"), "0f5c1a3e-7b21-4a55-9d2e-6c8b1f0a4d33", clock, 42)).toBe(true);
    expect(storage.observe.event("turn_terminal", clock, "hermes:luna", "turn-1", {
      status: "failed", reason: "unknown_turn", steps: 3, interrupted: true, cause: null,
    })).toBe(true);
    expect(storage.observe.refused).toBe(0);
  });
});

describe("p50 and p95 helpers", () => {
  it("returns the sample count beside every aggregate and undefined when there is nothing", () => {
    const observe = ring();
    const empty = observe.summarize({ series: "turn_ms", from: 0, to: clock + 1 });
    expect(empty).toEqual({ count: 0, p50: undefined, p95: undefined, min: undefined, max: undefined });

    for (let value = 1; value <= 100; value += 1) storage.observe.sample("turn_ms", "luna", clock, value);
    const full = observe.summarize({ series: "turn_ms", bot: "luna", from: 0, to: clock + 1 });
    expect(full.count).toBe(100);
    expect(full.p50).toBe(50);
    expect(full.p95).toBe(95);
    expect(full.min).toBe(1);
    expect(full.max).toBe(100);
  });

  it("reports each network path separately so a VPN cost is a difference of two measured medians", () => {
    const observe = ring();
    for (const value of [100, 120, 140]) observe.feltLatency("luna", value, "vpn_on");
    for (const value of [40, 50, 60]) observe.feltLatency("luna", value, "vpn_off");
    const on = observe.summarize({ series: "felt_latency_ms", tag: "vpn_on", from: 0, to: clock + 1 });
    const off = observe.summarize({ series: "felt_latency_ms", tag: "vpn_off", from: 0, to: clock + 1 });
    expect(on.count).toBe(3);
    expect(off.count).toBe(3);
    expect(on.p50).toBe(120);
    expect(off.p50).toBe(50);
  });

  it("bounds a window read to the window it was asked for", () => {
    storage.observe.sample("turn_ms", "luna", clock - 2 * DAY, 1);
    storage.observe.sample("turn_ms", "luna", clock - 1, 2);
    const observe = ring();
    expect(observe.summarize({ series: "turn_ms", from: clock - DAY, to: clock }).count).toBe(1);
  });
});

describe("the tunnel self probe", () => {
  function probe(responder: (url: string) => Promise<Response>, observe: ObservationRing): TunnelSelfProbe {
    return new TunnelSelfProbe({
      ring: observe,
      publicUrl: "https://gateway.example.com",
      loopbackUrl: "http://127.0.0.1:8787",
      fetch: (async (input: string | URL | Request) => responder(String(input))) as typeof fetch,
      timeoutMs: 50,
    });
  }

  it("records the public minus loopback difference as a tunnel round trip", async () => {
    const observe = ring();
    await probe(async (url) => {
      if (url.startsWith("https://")) await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response("{}", { status: 200 });
    }, observe).probe();

    const samples = storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0]?.value).toBeGreaterThan(10);
    expect(samples[0]?.bot).toBeNull();
    expect(eventRows()).toHaveLength(0);
  });

  it("writes a tunnel_flap with no url in the detail on a 502, and no round trip sample", async () => {
    const observe = ring();
    await probe(async (url) => new Response("", { status: url.startsWith("https://") ? 502 : 200 }), observe).probe();

    expect(storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 })).toHaveLength(0);
    const events = eventRows();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("tunnel_flap");
    expect(events[0]?.bot).toBeNull();
    expect(events[0]?.ref).toBeNull();
    expect(JSON.parse(events[0]?.detailJson ?? "{}")).toEqual({ reason: "bad_gateway", status: 502 });
    expect(events[0]?.detailJson).not.toContain("gateway.example.com");
    expect(events[0]?.detailJson).not.toContain("http");
  });

  it("writes a tunnel_flap on a timeout", async () => {
    const observe = ring();
    await probe(async (url) => {
      if (url.startsWith("https://")) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return new Response("{}", { status: 200 });
    }, observe).probe();
    expect(eventRows().map((row) => JSON.parse(row.detailJson ?? "{}").reason)).toEqual(["timeout"]);
  });

  it("treats a 503 from the gateway's own readiness as a healthy tunnel, not a flap", async () => {
    const observe = ring();
    await probe(async () => new Response("{}", { status: 503 }), observe).probe();
    expect(eventRows()).toHaveLength(0);
    expect(storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 })).toHaveLength(1);
  });

  it("writes nothing when observability is off", async () => {
    const observe = ring(false);
    await probe(async (url) => new Response("", { status: url.startsWith("https://") ? 502 : 200 }), observe).probe();
    expect(eventRows()).toHaveLength(0);
    expect(allSeriesRows()).toHaveLength(0);
  });
});

describe("the request origin tag", () => {
  function request(headers: Record<string, string>) {
    return { headers } as unknown as Parameters<typeof deviceOriginVia>[0];
  }

  it("reads a proxy hop header as a tunnel and a bare LAN request as lan", () => {
    expect(deviceOriginVia(request({ "x-forwarded-for": "203.0.113.7" }))).toBe("tunnel");
    expect(deviceOriginVia(request({ "cf-ray": "8a0000000000-DFW" }))).toBe("tunnel");
    expect(deviceOriginVia(request({ host: "192.168.1.20:8787" }))).toBe("lan");
    expect(deviceOriginVia(undefined)).toBe("lan");
  });

  it("reads the advertised public host as a tunnel even with no proxy header", () => {
    const host = publicHostOf("https://gateway.example.com");
    expect(host).toBe("gateway.example.com");
    expect(deviceOriginVia(request({ host: "gateway.example.com" }), host)).toBe("tunnel");
    expect(deviceOriginVia(request({ host: "127.0.0.1:8787" }), host)).toBe("lan");
  });
});

describe("the fold-in seam D5 calls", () => {
  it("writes only the numeric fields of a snapshot and never infers a hop it did not receive", () => {
    const observe = ring();
    observe.foldSnapshotIntoSeries("luna", { modelStepMs: [100, 200], modelSteps: 2 });
    expect(storage.observe.summarize({ series: "model_step_ms", bot: "luna", from: 0, to: clock + 1 }).count).toBe(2);
    // A Hermes bot sends no snapshot, so it has no model rows at all rather than a subtracted one.
    expect(storage.observe.summarize({ series: "model_step_ms", bot: "hermes-bot", from: 0, to: clock + 1 }).count).toBe(0);
    expect(storage.observe.summarize({ series: "tool_ms", bot: "luna", from: 0, to: clock + 1 }).count).toBe(0);
  });
});

describe("the declared vocabulary", () => {
  it("keeps every series and event kind the design names", () => {
    for (const series of [
      "device_rtt_ms", "tunnel_rtt_ms", "gateway_handle_ms", "peer_rtt_ms", "ttft_ms", "turn_ms",
      "delta_frames", "model_step_ms", "model_steps", "tool_ms", "attach_online", "queue_depth",
      "dead_letters", "outbox_depth", "heartbeat_gap_ms", "push_result", "felt_latency_ms",
    ]) expect(OBSERVE_SERIES as readonly string[]).toContain(series);
    for (const kind of [
      "turn_terminal", "approval_raised", "approval_resolved", "repair_proposed", "runtime_stage",
      "runner_contact_lost", "runner_contact_regained", "device_paired", "device_revoked",
      "dead_letter", "tunnel_flap", "maintenance_operation",
    ]) expect(OBSERVE_EVENT_KINDS as readonly string[]).toContain(kind);
  });
});

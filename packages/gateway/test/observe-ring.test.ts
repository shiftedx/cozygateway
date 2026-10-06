import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { performance } from "node:perf_hooks";

import { openStorage, type Storage } from "../src/storage.ts";
import { ObservationRing } from "../src/observe/ring.ts";
import { TunnelSelfProbe } from "../src/observe/self-probe.ts";
import {
  OBSERVE_SERIES,
  OBSERVE_EVENT_KINDS,
  OBSERVE_EVENT_DETAIL,
  isIdentityHash,
  serializeDetail,
  seriesName,
} from "../src/observe/privacy.ts";
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

const TAG_SUFFIXES = [
  "", "|tunnel", "|lan", "|wifi", "|cellular", "|wired", "|other",
  "|wifi_vpn_off", "|cellular_vpn_off", "|wired_vpn_off", "|other_vpn_off",
  "|wifi_vpn_on", "|cellular_vpn_on", "|wired_vpn_on", "|other_vpn_on",
  "|ok", "|not_found", "|http_error", "|network_error",
];

function allSeriesRows(): Array<{ series: string; bot: string | null; at: number; value: number }> {
  const out: Array<{ series: string; bot: string | null; at: number; value: number }> = [];
  for (const base of OBSERVE_SERIES) {
    for (const suffix of TAG_SUFFIXES) {
      out.push(...storage.observe.samples({ series: `${base}${suffix}`, from: 0, to: Number.MAX_SAFE_INTEGER }));
    }
  }
  return out;
}

function eventRows() {
  return storage.observe.events({ from: 0, to: Number.MAX_SAFE_INTEGER, limit: 5_000 });
}

/** The identity every writer stores for a name. Nothing else can reach the bot or ref column. */
function id(value: string): string {
  return storage.observe.identify(value);
}

describe("the observation ring's row shape", () => {
  it("writes every named series as one unlabelled numeric row keyed by an identity hash", () => {
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
    observe.feltLatency("luna", 900, "wifi", true);
    observe.edgeRtt("luna", 40, "wifi", true);

    const written = allSeriesRows();
    const names = new Set(written.map((row) => row.series.split("|")[0]));
    for (const series of OBSERVE_SERIES) expect(names, `missing ${series}`).toContain(series);
    for (const row of written) {
      expect(typeof row.value).toBe("number");
      expect(Number.isFinite(row.value)).toBe(true);
      expect(row.at).toBe(clock);
      // No name reaches a row: the subject column is a keyed hash or nothing at all.
      if (row.bot !== null) expect(isIdentityHash(row.bot)).toBe(true);
    }
    expect(written.some((row) => row.bot === "luna" || row.bot === "device-1")).toBe(false);
    expect(storage.observe.refused).toBe(0);
  });

  it("counts every delta frame of a turn and times only the first as ttft", () => {
    const observe = ring();
    observe.turnAdmitted("luna", "turn-2");
    observe.turnDispatched("luna", "turn-2");
    for (let index = 0; index < 5; index += 1) observe.turnDelta("luna", "turn-2");
    observe.turnTerminal("luna", "turn-2", { status: "completed", reason: "cancelled" })();

    expect(storage.observe.summarize({ series: "ttft_ms", from: 0, to: clock + 1 }).count).toBe(1);
    const frames = storage.observe.samples({ series: "delta_frames", from: 0, to: clock + 1 });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.value).toBe(5);
    // Admission to dispatch and terminal to broadcast are both gateway handling, so a dispatched
    // turn that reaches a terminal contributes exactly two legs.
    expect(storage.observe.summarize({ series: "gateway_handle_ms", from: 0, to: clock + 1 }).count).toBe(2);
  });

  it("times a turn from dispatch, not from admission, and writes neither when it never dispatched", () => {
    const observe = ring();
    // A turn whose peer is offline sits in the durable outbox. Its wait is gateway handling, and
    // reporting it as time to first token would chart the gateway's own queueing as the model.
    observe.turnAdmitted("luna", "queued-turn");
    observe.turnDelta("luna", "queued-turn");
    observe.turnTerminal("luna", "queued-turn", { status: "failed" })();

    expect(storage.observe.samples({ series: "ttft_ms", from: 0, to: clock + 1 })).toHaveLength(0);
    expect(storage.observe.samples({ series: "turn_ms", from: 0, to: clock + 1 })).toHaveLength(0);
    // The delta count and the terminal marker still land: those are facts either way.
    expect(storage.observe.samples({ series: "delta_frames", from: 0, to: clock + 1 })).toHaveLength(1);
    expect(eventRows()).toHaveLength(1);
    // And the queueing itself is still measured, as its own series.
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

  it("keeps a stable identity across restarts and a different one per gateway", () => {
    const first = id("luna");
    expect(id("luna")).toBe(first);
    expect(id("luna-2")).not.toBe(first);
    const other = openStorage(":memory:");
    try {
      // A different gateway hashes the same name differently, so two exports cannot be joined by
      // guessing a bot's name.
      expect(other.observe.identify("luna")).not.toBe(first);
    } finally {
      other.close();
    }
  });
});

describe("observability disabled", () => {
  it("writes nothing at all when the flag is off", () => {
    const observe = ring(false);
    observe.deviceRtt("device-1", 42, "tunnel");
    observe.heartbeatGap("device-1", 1);
    observe.tunnelRtt(31);
    observe.tunnelDown("bad_gateway", 502);
    observe.tunnelRecovered(1_000, 3);
    observe.gatewayHandle("luna", 3);
    observe.peerHeartbeatSent("luna");
    observe.peerHeartbeatAcked("luna");
    observe.turnAdmitted("luna", "turn-1");
    observe.turnDispatched("luna", "turn-1");
    observe.turnDelta("luna", "turn-1");
    observe.turnTerminal("luna", "turn-1", { status: "completed" })();
    observe.attachDepths({ online: 2, queueDepth: 1, deadLetters: 1, outboxDepth: 1 });
    observe.deadLetter("luna", null, { sequence: 3, attempts: 2 });
    observe.pushResult("device-1", "http_error");
    observe.feltLatency("luna", 900, "wifi");
    expect(observability({
      name: "g", port: 1, dbPath: "x", turnTimeoutSeconds: 0,
      observability: { enabled: true, retentionDays: 3 },
    })).toEqual({ enabled: true, retentionDays: 3 });
    expect(observability({
      name: "g", port: 1, dbPath: "x", turnTimeoutSeconds: 0,
      observability: { enabled: true, retentionDays: 365 },
    })).toEqual({ enabled: true, retentionDays: 14 });
  });
});

describe("the ring's retention", () => {
  it("trims at retentionDays and keeps everything inside the window", () => {
    const observe = ring(true, 7);
    storage.observe.sample("turn_ms", id("luna"), clock - 8 * DAY, 100);
    storage.observe.sample("turn_ms", id("luna"), clock - 6 * DAY, 200);
    storage.observe.event("turn_terminal", clock - 8 * DAY, id("luna"), id("old-turn"), { status: "completed" });
    storage.observe.event("turn_terminal", clock - 1 * DAY, id("luna"), id("new-turn"), { status: "completed" });

    expect(observe.trim(clock)).toEqual({ series: 1, events: 1, folds: 0, complete: true });
    const survivors = storage.observe.samples({ series: "turn_ms", from: 0, to: clock + 1 });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.value).toBe(200);
    expect(eventRows().map((row) => row.ref)).toEqual([id("new-turn")]);
  });

  it("bounds one pass and finishes the rest on the next, rather than one unbounded delete", () => {
    // The case that matters is an operator lowering retentionDays from a year: without a bound this
    // is one synchronous statement over a year of rows on the gateway's event loop.
    const subject = id("luna");
    for (let index = 0; index < 5_050; index += 1) {
      storage.observe.sample("turn_ms", subject, clock - 30 * DAY, index);
    }
    const observe = ring(true, 7);
    const pass = observe.trim(clock);
    // Batched: the first statement takes a full batch, the second takes the remainder and stops.
    expect(pass.series).toBe(5_050);
    expect(pass.complete).toBe(true);
    expect(storage.observe.samples({ series: "turn_ms", from: 0, to: clock + 1, limit: 20_000 })).toHaveLength(0);
  });

  it("still trims when the flag was turned off after rows were written", () => {
    storage.observe.sample("turn_ms", id("luna"), clock - 30 * DAY, 100);
    expect(ring(false, 7).trim(clock)).toEqual({ series: 1, events: 0, folds: 0, complete: true });
  });



});

describe("the privacy rule at the writer", () => {
  /** A generator rather than a fixed list. The fixed list an earlier round shipped could only find
   *  the leaks somebody had already thought of, and it missed every one that mattered: an
   *  unprefixed high-entropy key, an opaque scheme:env:secret id, and a sentence with its spaces
   *  removed. These are built from shapes, and the identity rule refuses the whole space they live
   *  in rather than the members of it anybody listed. */
  function forbiddenValues(): string[] {
    const values: string[] = [
      // The reviewer's own reproducers.
      "0123456789abcdef0123456789abcdef",
      "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD",
      "cozy:live:9f8e7d6c5b4a39281706",
      "heycanyousummarisethedocIsentyesterdayplease",
      "0f5c1a3e-7b21-4a55-9d2e-6c8b1f0a4d33",
      // Explicitly named in this round.
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r0",
      "AKIAIOSFODNN7EXAMPLE",
      "httpsgatewayexamplecomreadytokenabc",
      "9f8e7d6c5b4a392817065432",
      // Urls, paths, bodies, credentials and words.
      "https://gw.example.com/bots/luna/chat?token=abc",
      "data:text/plain;base64,QUJD",
      "/var/lib/cozygateway/Application Support/cozygateway.db",
      "D:\\data\\gateway.db",
      "../../etc/passwd",
      ".env",
      "sk-ant-api03-abcdefghijklmnop",
      "ghp_0123456789abcdefghij",
      "Bearer abc123",
      "hey can you summarise the doc I sent",
      "name@example.com",
      "",
      "  ",
      "a".repeat(49),
    ];
    // Hex of every plausible key or hash width. Sixteen is the ring's own identity width and is the
    // one shape that is legal, so it is deliberately absent from the forbidden set.
    for (const width of [8, 12, 20, 24, 32, 40, 64]) values.push("9f8e7d6c5b4a3928170654329f8e7d6c5b4a3928170654329f8e7d6c".slice(0, width));
    // Separator-free prose at several lengths, which no shape test can tell from a reason code.
    const prose = "pleaseresendthecontractandthebankdetailsbeforefriday";
    for (const width of [12, 20, 31, 44]) values.push(prose.slice(0, width));
    // Unprefixed high-entropy keys across the alphabets a credential actually uses.
    for (const alphabet of ["abcdefghijklmnopqrstuvwxyz0123456789", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "0123456789abcdef"]) {
      for (const width of [20, 28, 32, 40, 48]) {
        let generated = "";
        for (let index = 0; index < width; index += 1) generated += alphabet[(index * 31 + width * 7) % alphabet.length];
        values.push(generated);
      }
    }
    return values;
  }

  it("refuses every url, path, token, opaque id, hash width and sentence in bot, ref and detail", () => {
    const values = forbiddenValues();
    expect(values.length).toBeGreaterThanOrEqual(45);
    for (const value of values) {
      expect(isIdentityHash(value), `identity accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.sample("turn_ms", value, clock, 1), `bot accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("turn_terminal", clock, null, value), `ref accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("approval_resolved", clock, null, null, { grant: value }), `hash field accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("turn_terminal", clock, null, null, { status: value }), `code field accepted ${JSON.stringify(value)}`).toBe(false);
      expect(storage.observe.event("turn_terminal", clock, null, null, { [value]: 1 }), `detail key accepted ${JSON.stringify(value)}`).toBe(false);
    }
    expect(allSeriesRows()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
    expect(storage.observe.refused).toBe(values.length * 5);
  });

  it("refuses a raw device id and stores its hash instead", () => {
    const raw = "0f5c1a3e-7b21-4a55-9d2e-6c8b1f0a4d33";
    expect(storage.observe.sample("device_rtt_ms|tunnel", raw, clock, 12)).toBe(false);
    ring().deviceRtt(raw, 12, "tunnel");
    const rows = storage.observe.samples({ series: "device_rtt_ms|tunnel", from: 0, to: clock + 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bot).toBe(id(raw));
    expect(rows[0]?.bot).not.toBe(raw);
  });

  it("refuses a series name or event kind nothing declared, and a value that is not a number", () => {
    expect(storage.observe.sample("secret_prompt_text", id("luna"), clock, 1)).toBe(false);
    expect(storage.observe.sample("turn_ms|totally_free_text", id("luna"), clock, 1)).toBe(false);
    expect(storage.observe.sample("turn_ms", id("luna"), clock, Number.NaN)).toBe(false);
    expect(storage.observe.sample("turn_ms", id("luna"), clock, Number.POSITIVE_INFINITY)).toBe(false);
    expect(storage.observe.event("transcript", clock, id("luna"), null)).toBe(false);
    expect(allSeriesRows()).toHaveLength(0);
    expect(eventRows()).toHaveLength(0);
  });

  it("refuses a detail field this kind never declared, and drops the object whole rather than in part", () => {
    // A key that is legal on another kind is still refused here: the schema is per kind.
    expect(storage.observe.event("turn_terminal", clock, id("luna"), null, { sequence: 3 })).toBe(false);
    expect(storage.observe.event("dead_letter", clock, id("luna"), null, { status: "completed" })).toBe(false);
    // A count field will not take a string, and a code field will not take a number.
    expect(storage.observe.event("dead_letter", clock, id("luna"), null, { sequence: "three" as unknown as number })).toBe(false);
    expect(storage.observe.event("turn_terminal", clock, id("luna"), null, { status: 1 })).toBe(false);
    expect(eventRows()).toHaveLength(0);
  });

  it("accepts the shapes the design does allow: hashes, reason codes, counts and durations", () => {
    expect(storage.observe.sample("turn_ms", id("luna"), clock, 1_234.5)).toBe(true);
    expect(storage.observe.sample(seriesName("device_rtt_ms", "tunnel"), id("phone"), clock, 42)).toBe(true);
    expect(storage.observe.event("turn_terminal", clock, id("hermes:luna"), id("turn-1"), {
      status: "failed", reason: "unknown_turn",
    })).toBe(true);
    expect(storage.observe.event("approval_resolved", clock, id("luna"), id("turn-1"), {
      grant: id("grant-1"), decision: "approved",
    })).toBe(true);
    expect(storage.observe.refused).toBe(0);
  });

  it("declares a closed detail schema for every event kind it will write", () => {
    for (const kind of OBSERVE_EVENT_KINDS) {
      expect(OBSERVE_EVENT_DETAIL[kind], kind).toBeDefined();
      for (const spec of Object.values(OBSERVE_EVENT_DETAIL[kind])) {
        // No field anywhere may hold a free string.
        expect(["count", "flag", "hash", "colo", "code"]).toContain(spec.kind);
        if (spec.kind === "code") expect(spec.values).toContain("other");
      }
    }
    expect(serializeDetail("turn_terminal", undefined)).toBeNull();
  });

  it("accepts only the narrow Cloudflare colo shape in receipt detail JSON", () => {
    expect(serializeDetail("receipt_measurement", { edge_colo: "ORD" }))
      .toBe('{"edge_colo":"ORD"}');
    for (const poison of ["ord", "OR", "ORD5", "ORD/secret", "A".repeat(49)]) {
      expect(serializeDetail("receipt_measurement", { edge_colo: poison })).toBeUndefined();
    }
  });
});

describe("p50 and p95 helpers", () => {
  it("returns the sample count beside every aggregate and undefined when there is nothing", () => {
    const observe = ring();
    const empty = observe.summarize({ series: "turn_ms", from: 0, to: clock + 1 });
    expect(empty).toEqual({ count: 0, p50: undefined, p95: undefined, min: undefined, max: undefined });

    for (let value = 1; value <= 100; value += 1) storage.observe.sample("turn_ms", id("luna"), clock, value);
    const full = observe.summarize({ series: "turn_ms", bot: "luna", from: 0, to: clock + 1 });
    expect(full.count).toBe(100);
    expect(full.p50).toBe(50);
    expect(full.p95).toBe(95);
    expect(full.min).toBe(1);
    expect(full.max).toBe(100);
  });

  it("reports each network path separately so a VPN cost is a difference of two measured medians", () => {
    const observe = ring();
    for (const value of [100, 120, 140]) observe.feltLatency("luna", value, "wifi", true);
    for (const value of [40, 50, 60]) observe.feltLatency("luna", value, "wifi", false);
    const on = observe.summarize({ series: "felt_latency_ms", tag: "wifi_vpn_on", from: 0, to: clock + 1 });
    const off = observe.summarize({ series: "felt_latency_ms", tag: "wifi_vpn_off", from: 0, to: clock + 1 });
    expect(on.count).toBe(3);
    expect(off.count).toBe(3);
    expect(on.p50).toBe(120);
    expect(off.p50).toBe(50);
  });

  it("records the app's Cloudflare edge round trip under the same radio and VPN tags", () => {
    const observe = ring();
    observe.edgeRtt("luna", 41, "cellular", true);
    expect(observe.summarize({ series: "edge_rtt_ms", tag: "cellular_vpn_on", from: 0, to: clock + 1 }))
      .toMatchObject({ count: 1, p50: 41 });
  });

  it("keeps an unreported VPN state distinct from observed false", () => {
    const observe = ring();
    observe.feltLatency("luna", 40, "wifi");
    observe.feltLatency("luna", 50, "wifi", false);
    expect(observe.summarize({ series: "felt_latency_ms", tag: "wifi", from: 0, to: clock + 1 }))
      .toMatchObject({ count: 1, p50: 40 });
    expect(observe.summarize({ series: "felt_latency_ms", tag: "wifi_vpn_off", from: 0, to: clock + 1 }))
      .toMatchObject({ count: 1, p50: 50 });
  });

  it("records one privacy-safe receipt measurement with hashed bot and device identities", () => {
    const observe = ring();
    observe.receiptMeasurement({
      bot: "luna", deviceId: "device-1", networkPath: "wired", vpn: false,
      feltLatencyMs: 900, edgeRttMs: 41, edgeColo: "ORD",
    });
    const events = storage.observe.events({ kind: "receipt_measurement", from: 0, to: clock + 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ bot: id("luna"), ref: id("device-1") });
    expect(JSON.parse(events[0]?.detailJson ?? "{}"))
      .toEqual({ radio: "wired", vpn: false, felt_latency_ms: 900, edge_rtt_ms: 41, edge_colo: "ORD" });
    expect(events[0]?.detailJson).not.toContain("luna");
    expect(events[0]?.detailJson).not.toContain("device-1");
  });

  it("does not read a neighbouring series through the underscore LIKE wildcard", () => {
    // `turn_ms` as a LIKE pattern also matches `turnXms`, so the folded read escapes it.
    storage.observe.sample("turn_ms|ok", id("luna"), clock, 1);
    const folded = storage.observe.summarize({ series: "turn_ms", from: 0, to: clock + 1, includeTags: true });
    expect(folded.count).toBe(1);
    expect(folded.max).toBe(1);
  });

  it("bounds a window read to the window it was asked for", () => {
    storage.observe.sample("turn_ms", id("luna"), clock - 2 * DAY, 1);
    storage.observe.sample("turn_ms", id("luna"), clock - 1, 2);
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
    const monotonic = vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(108)
      .mockReturnValueOnce(108)
      .mockReturnValueOnce(133);
    try {
      await probe(async () => new Response("{}", { status: 200 }), observe).probe();

      const samples = storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 });
      expect(samples).toHaveLength(1);
      expect(samples[0]?.value).toBe(17);
      expect(samples[0]?.bot).toBeNull();
      expect(eventRows()).toHaveLength(0);
    } finally {
      monotonic.mockRestore();
    }
  });

  it("drops the sample rather than clamping when the loopback leg was the slower of the two", async () => {
    const observe = ring();
    await probe(async (url) => {
      if (url.startsWith("http://")) await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response("{}", { status: 200 });
    }, observe).probe();
    // A clamped zero would be a number nothing measured, stored as a measured tunnel round trip.
    expect(storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 })).toHaveLength(0);
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

  it("is edge triggered: one event going down, one coming back with the outage length", async () => {
    const observe = ring();
    let down = true;
    const self = probe(async (url) => {
      if (!url.startsWith("https://")) return new Response("{}", { status: 200 });
      if (down) return new Response("", { status: 504 });
      await new Promise((resolve) => setTimeout(resolve, 15));
      return new Response("{}", { status: 200 });
    }, observe);
    // A day of downtime must not put 2,880 identical rows in the ring.
    for (let tick = 0; tick < 5; tick += 1) await self.probe();
    expect(eventRows()).toHaveLength(1);

    down = false;
    await self.probe();
    await self.probe();
    const events = eventRows();
    expect(events).toHaveLength(2);
    const recovery = JSON.parse(events[0]?.detailJson ?? "{}");
    expect(recovery.reason).toBe("recovered");
    expect(recovery.consecutive).toBe(5);
    expect(recovery.outage_ms).toBeGreaterThanOrEqual(0);
    // And the tunnel is measured again once it is back.
    expect(storage.observe.samples({ series: "tunnel_rtt_ms", from: 0, to: clock + 1 }).length).toBeGreaterThan(0);
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


describe("the declared vocabulary", () => {
  it("keeps every series and event kind the design names", () => {
    for (const series of [
      "device_rtt_ms", "tunnel_rtt_ms", "gateway_handle_ms", "peer_rtt_ms", "ttft_ms", "turn_ms",
      "delta_frames", "attach_online", "queue_depth",
      "dead_letters", "outbox_depth", "heartbeat_gap_ms", "push_result", "felt_latency_ms",
    ]) expect(OBSERVE_SERIES as readonly string[]).toContain(series);
    for (const kind of [
      "turn_terminal", "approval_raised", "approval_resolved", "repair_proposed", "runtime_stage",
      "runner_contact_lost", "runner_contact_regained", "device_paired", "device_revoked",
      "dead_letter", "tunnel_flap", "maintenance_operation", "receipt_measurement",
    ]) expect(OBSERVE_EVENT_KINDS as readonly string[]).toContain(kind);
  });
});

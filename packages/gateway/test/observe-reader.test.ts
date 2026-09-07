import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStorage, type Storage } from "../src/storage.ts";
import { ObservationRing } from "../src/observe/ring.ts";
import { ObservationSnapshotLane } from "../src/observe/lane.ts";
import { createObserveSnapshotReader, groupObserveReceiptMeasurements } from "../src/observe/reader.ts";
import type { AppDeps } from "../src/http.ts";
import { snapshotPayload } from "./support/observe-snapshot-fixture.ts";
import { testHermes } from "./support/test-config.ts";

let storage: Storage;
const now = 1_700_000_000_000;
const query = { from: now - 1, to: now + 1 };
let ring: ObservationRing;
let lane: ObservationSnapshotLane;
let reader: ReturnType<typeof createObserveSnapshotReader>;
beforeEach(() => {
  storage = openStorage(":memory:");
  ring = new ObservationRing({ store: storage.observe, options: { enabled: true, retentionDays: 7 }, now: () => now });
  lane = new ObservationSnapshotLane({ ring, now: () => now });
  reader = createObserveSnapshotReader({
    observe: ring, now: () => now, presenceOf: () => "online", observePeerAttached: () => true,
    config: { name: "test", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }] },
    bots: { roster: () => ({ bots: [{ name: "test-bot", runtime: "cozyagents" }] }) },
  } as unknown as AppDeps & { observe: ObservationRing });
});
afterEach(() => storage.close());

describe("validated snapshot dashboard reader", () => {
  it("distinguishes no observation from zero and respects gateway attachment", () => {
    expect(reader.attached()).toBe(false);
    expect(lane.accept("test-bot", snapshotPayload())).toBe("stored");
    expect(reader.attached()).toBe(true);
    const entry = reader.internals(query)[0]!;
    expect(entry.context.windowTokens).toBeNull();
    expect(entry.policy.egressRefused).toBeNull();
    expect(entry.checkpoints.restores).toBeNull();
    expect(entry.checkpoints.count).toBe(2);
    expect(entry.steps).toHaveLength(1);
  });
  it("does not pool prefix speed samples or duplicate model lifetime totals", () => {
    const steps = Array.from({ length: 30 }, (_, step) => ({
      turn: `obs:${"b".repeat(64)}`, step, model: "unpriced-test-model",
      promptTokens: 100, completionTokens: 10, cachedTokens: 0,
      prefillTokensPerSecond: step < 15 ? 100 : 1000,
      prefix: step < 15 ? "cached_prefix" : "cold",
    }));
    // Use the closed protocol's uncached mode spelling.
    for (const step of steps) if (step.prefix === "cold") step.prefix = "no_prefix_cache";
    expect(lane.accept("test-bot", snapshotPayload({ steps, toolCalls: [] }))).toBe("stored");
    const result = reader.throughput(query);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.lifetime.prompt).toBe(3000);
    expect(result.rows[0]!.costMicros).toBeNull();
    expect(result.rows[0]!.prefill.p50).toBeNull();
    expect(result.rows[0]!.speedsByPrefix).toHaveLength(2);
    expect(result.rows[0]!.speedsByPrefix!.every(row => row.prefill.samples === 15 && row.prefill.p50 === null)).toBe(true);
    expect(reader.throughput({ from: now + 1, to: now + 2 }).rows[0]!.tokens.prompt).toBe(0);
    expect(reader.throughput({ from: now + 1, to: now + 2 }).rows[0]!.lifetime.prompt).toBe(3000);
    expect(reader.throughput({ ...query, bot: "other" }).rows).toEqual([]);
  });
  it("does not manufacture medians for aggregated calls and flags errors above five percent", () => {
    expect(lane.accept("test-bot", snapshotPayload({ toolCalls: [{
      tool: "searchWorkspaceItems", turn: `obs:${"a".repeat(64)}`, step: 1,
      family: "investigation", calls: 20, resultTokens: 1000, inducedTokens: 1200,
      durationMs: 100, outcomes: { error: 2, ok: 18 },
    }] }))).toBe("stored");
    const result = reader.toolCosts(query);
    expect(result.retryDetectionAvailable).toBe(false);
    expect(result.rows[0]!.medianResultTokens).toBeNull();
    expect(result.rows[0]!.duration.p50).toBeNull();
    expect(result.rows[0]!.flags).toContain("errors");
  });
});

it("keeps VPN comparisons within one device and radio and requires thirty measured samples each", () => {
  const rows = (device: string, vpn: boolean | undefined, count: number, value: number) => Array.from({ length: count }, () => ({
    bot: "hashed-bot", device, detail: { radio: "wifi", ...(vpn === undefined ? {} : { vpn }), felt_latency_ms: value },
  }));
  const result = groupObserveReceiptMeasurements([
    ...rows("device-a", true, 30, 150), ...rows("device-a", false, 30, 100), ...rows("device-a", undefined, 100, 999),
    ...rows("device-b", true, 29, 999), ...rows("device-b", false, 30, 100),
  ]);
  expect(result[0]!.felt.vpnCostMs).toBe(50);
  expect(result[0]!.felt.vpnOn.samples).toBe(30);
  expect(result[1]!.felt.vpnCostMs).toBeNull();
  expect(result[0]!.edge.vpnCostMs).toBeNull();
});

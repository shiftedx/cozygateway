import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openStorage, type Storage } from "../src/storage.ts";
import {
  ObservationRing,
  ObservationSnapshotLane,
  OBSERVATION_SNAPSHOT_LANE_SCHEMA,
  OBSERVATION_SNAPSHOT_MAX_BYTES,
  OBSERVE_DEFAULT_PRICES,
  observeCostMicros,
  observeModelPrice,
  validateObservationSnapshotPayload,
} from "../src/observe/index.ts";
import { observability, observabilityPrices } from "../src/config.ts";

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

function lane(options?: { enabled?: boolean; prices?: Record<string, { inputPerMillion?: number; cachedInputPerMillion?: number; outputPerMillion?: number }> }): ObservationSnapshotLane {
  return new ObservationSnapshotLane({
    ring: ring(options?.enabled ?? true),
    ...(options?.prices === undefined ? {} : { prices: options.prices }),
    now: () => clock,
  });
}

const TURN = `obs:${"a".repeat(64)}`;
const OTHER_TURN = `obs:${"b".repeat(64)}`;

/** The aggregate the harness embeds, at its smallest legal shape. */
function aggregate() {
  const outcomes = () => ({ completed: 1, failed: 0, aborted: 0, unknown: 0 });
  const failures = () => ({
    provider_length: 0, provider: 0, tool: 0, policy: 0, cancelled: 0,
    transport: 0, internal: 0, unknown: 0,
  });
  const family = () => ({ calls: 0, succeeded: 0, failed: 0, blocked: 0 });
  return {
    runs: { direct: outcomes(), gateway: outcomes(), routine: outcomes(), benchmark: outcomes() },
    failures: { direct: failures(), gateway: failures(), routine: failures(), benchmark: failures() },
    latency: { samples: 1, wallMs: 1_200, toolMs: 200, firstTokenSamples: 1, firstTokenMs: 300 },
    tools: { investigation: family(), mutation: family(), verification: family(), unknown: family() },
    usage: {
      samples: 1, availability: "reported" as const, inputTokens: 100, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 120,
      providerRequests: 1, providerLengthStops: 0,
    },
    policy: { pendingVerification: 0, blockedDuplicates: 0, blockedIntraBatchDuplicates: 0, blockedStalls: 0, terminalCorrections: 0 },
    delivery: { publishedAttachments: 0, awaitingReceiptTurns: 0, displayedTurns: 1, failedTurns: 0, unmatchedReceipts: 0 },
    context: { compactions: 0, recoveryAttempts: 0, recoverySucceeded: 0, recoveryFailed: 0, toolResults: { rawBytes: 0, modelBytes: 0, exactResults: 0, projectedResults: 0, retrievals: 0, retrievalMisses: 0 } },
    identity: {
      sources: { service_runtime: 1, unavailable: 0 },
      postures: { chat: 1, workspace: 0, room: 0, room51: 0, unattended: 0, consolidation: 0, unavailable: 0 },
      builds: { "0.2.13": 1 },
    },
    observer: { retained: 1, retainedBytes: 10, evictions: 0, droppedOversize: 0, failures: 0, droppedSpans: 0, malformedSources: 0 },
  } as unknown as Record<string, unknown> & { identity: { builds: Record<string, number> } };
}

/** A whole valid payload, with the parts a test cares about overridable. */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: OBSERVATION_SNAPSHOT_LANE_SCHEMA,
    reason: "turn_terminal",
    emittedAt: clock,
    windowMs: 60_000,
    snapshot: {
      schema: "cozyagents.observation-snapshot.v1",
      dashboard: "cozyagents.observability-dashboard.v1",
      view: "aggregate",
      generatedAt: new Date(clock).toISOString(),
      aggregate: aggregate(),
    },
    runtime: {
      stage: "ready", backend: "docker", isolation: "workspace",
      lastContactAtMs: clock - 1_000, bundleVersion: "0.2.13",
    },
    cache: { availability: "reported", window: "process_lifetime", hits: 3, misses: 1, writes: 2, errors: 0, invalidations: 0 },
    checkpoints: { written: 2 },
    steps: [
      {
        turn: TURN, step: 1, model: "qwen/qwen3-27b",
        promptTokens: 1_000, completionTokens: 200, cachedTokens: 400,
        timeToFirstTokenMs: 500, generationMs: 2_000,
        prefillTokensPerSecond: 2_000, decodeTokensPerSecond: 100, prefix: "cached_prefix",
      },
    ],
    toolCalls: [
      {
        tool: "searchWorkspaceItems", turn: TURN, step: 1, family: "investigation",
        calls: 1, resultTokens: 300, callTokens: 40, schemaShareTokens: 60,
        inducedTokens: 400, durationMs: 120, attributed: false, outcomes: { ok: 1 },
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  storage = openStorage(":memory:");
  clock = 1_700_000_000_000;
});

afterEach(() => {
  storage.close();
});

describe("the observation_snapshot payload validator", () => {
  it("acceptsAWholeSnapshotFromTheHarness", () => {
    const value = validateObservationSnapshotPayload(payload());
    expect(value).toBeDefined();
    expect(value?.steps?.[0]?.turn).toBe(TURN);
    expect(value?.toolCalls?.[0]?.tool).toBe("searchWorkspaceItems");
  });

  it("refusesAPayloadCarryingAnUnknownKey", () => {
    expect(validateObservationSnapshotPayload(payload({ transcript: "hello there" }))).toBeUndefined();
  });

  it("refusesAValueOutsideAClosedSet", () => {
    expect(validateObservationSnapshotPayload(payload({ reason: "because_i_said_so" }))).toBeUndefined();
    expect(validateObservationSnapshotPayload(payload({
      runtime: { stage: "/Users/someone/notes.md" },
    }))).toBeUndefined();
  });

  it("refusesAStringCarryingTextAUrlAPathOrAToken", () => {
    for (const poison of [
      "https://example.test/search?key=sk-live-abc123",
      "sk-live-abcdef0123456789",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "/Users/someone/Documents/notes.md",
      "the model said it could not find the file",
      "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
    ]) {
      const withPoison = payload({
        toolCalls: [{
          tool: poison, turn: TURN, step: 1, calls: 1,
          resultTokens: 1, callTokens: 1, schemaShareTokens: 1, inducedTokens: 3,
          durationMs: 1, attributed: false, outcomes: { ok: 1 },
        }],
      });
      const value = validateObservationSnapshotPayload(withPoison);
      expect(JSON.stringify(value ?? {})).not.toContain(poison);
    }
  });

  it("refusesAControlCharacterOrALoneSurrogate", () => {
    expect(validateObservationSnapshotPayload(payload({
      checkpoints: { written: "2" },
    }))).toBeUndefined();
    expect(validateObservationSnapshotPayload(payload({
      recall: {
        source: "index", before: 0, after: 0, indexed: 0, evicted: 0, tombstoned: 0,
        secrets: 0, orphaned: 0, dropped: 0, bytes: 0, rules: ["ok​name"],
      },
    }))).toBeUndefined();
  });

  it("refusesACollectionPastItsBound", () => {
    const many = Array.from({ length: 65 }, (_unused, index) => ({
      turn: TURN, step: index + 1, model: "qwen/qwen3-27b",
    }));
    expect(validateObservationSnapshotPayload(payload({ steps: many }))).toBeUndefined();
  });

  it("toleratesAToolRowWhoseStepRowTheCapDropped", () => {
    const value = validateObservationSnapshotPayload(payload({ steps: [] }));
    expect(value?.toolCalls).toHaveLength(1);
  });
});

describe("the gateway store", () => {
  it("theGatewayStoresOnlyTheLatestSnapshotPerBot", () => {
    const observe = lane();
    expect(observe.accept("luna", payload({ checkpoints: { written: 1 } }))).toBe("stored");
    clock += 30_000;
    expect(observe.accept("luna", payload({ checkpoints: { written: 9 } }))).toBe("stored");
    const stored = observe.latest("luna");
    expect(stored?.payload.checkpoints?.written).toBe(9);
    expect(stored?.receivedAt).toBe(clock);
    expect(storage.observe.snapshotSubjects()).toHaveLength(1);
  });

  it("refusesAFramePastTheSixtyFourKibibyteCap", () => {
    const observe = lane();
    expect(observe.accept("luna", payload(), OBSERVATION_SNAPSHOT_MAX_BYTES + 1)).toBe("too_large");
    expect(observe.hasSnapshot("luna")).toBe(false);
    expect(observe.refused).toBe(1);
  });

  it("dropsAFailingSnapshotWholeAndCountsIt", () => {
    const observe = lane();
    expect(observe.accept("luna", payload({ transcript: "hello" }))).toBe("refused");
    expect(observe.hasSnapshot("luna")).toBe(false);
    expect(observe.refused).toBe(1);
  });

  it("makesSnapshotPresenceQueryableForTheTabToHideItself", () => {
    const observe = lane();
    expect(observe.hasSnapshot("luna")).toBe(false);
    observe.accept("luna", payload());
    expect(observe.hasSnapshot("luna")).toBe(true);
  });
});

describe("the fold into the series ring", () => {
  function samplesOf(series: string): number[] {
    return storage.observe
      .samples({ series, from: 0, to: Number.MAX_SAFE_INTEGER })
      .map((row) => row.value);
  }

  it("snapshotNumericFieldsFoldIntoTheSeriesRing", () => {
    lane().accept("luna", payload());
    expect(samplesOf("prompt_tokens")).toEqual([1_000]);
    expect(samplesOf("completion_tokens")).toEqual([200]);
    expect(samplesOf("cached_tokens")).toEqual([400]);
    expect(samplesOf("prefill_tokens_per_second")).toEqual([2_000]);
    expect(samplesOf("decode_tokens_per_second")).toEqual([100]);
    expect(samplesOf("tool_ms")).toEqual([120]);
    expect(samplesOf("induced_tokens")).toEqual([400]);
  });

  it("foldsTheSameTurnAndStepOnceAcrossAnIdleTickAndItsTerminal", () => {
    const observe = lane();
    observe.accept("luna", payload({ reason: "idle_interval" }));
    clock += 1_000;
    observe.accept("luna", payload({ reason: "turn_terminal" }));
    expect(samplesOf("prompt_tokens")).toEqual([1_000]);
    expect(samplesOf("tool_ms")).toEqual([120]);
  });

  it("neverFoldsTheProcessLifetimeCacheCountersIntoAWindowedSeries", () => {
    const observe = lane();
    observe.accept("luna", payload());
    clock += 30_000;
    observe.accept("luna", payload({ reason: "idle_interval", steps: [], toolCalls: [] }));
    // Cache is a LEVEL on the stored snapshot, never summed as a windowed rate: two snapshots
    // reporting three hits each are three hits, not six, so no series carries them at all.
    const rows = storage.observe.samples({ series: "cached_tokens", from: 0, to: Number.MAX_SAFE_INTEGER });
    expect(rows.map((row) => row.value)).toEqual([400]);
    expect(observe.latest("luna")?.payload.cache).toMatchObject({ availability: "reported", hits: 3 });
  });
});

describe("the lifetime tables", () => {
  it("lifetimeTableAccumulatesAcrossSnapshotsAndIsNeverTrimmed", () => {
    const shared = ring();
    const observe = new ObservationSnapshotLane({ ring: shared, now: () => clock });
    observe.accept("luna", payload());
    clock += 60_000;
    observe.accept("luna", payload({
      steps: [{ turn: OTHER_TURN, step: 1, model: "qwen/qwen3-27b", promptTokens: 500, completionTokens: 50, cachedTokens: 0 }],
      toolCalls: [],
    }));
    const before = storage.observe.lifetime();
    expect(before).toHaveLength(1);
    expect(before[0]?.prompt).toBe(1_500);
    expect(before[0]?.completion).toBe(250);
    expect(before[0]?.turns).toBe(2);

    clock += 30 * DAY;
    shared.trim();
    expect(storage.observe.samples({ series: "prompt_tokens", from: 0, to: Number.MAX_SAFE_INTEGER })).toHaveLength(0);
    expect(storage.observe.lifetime()).toHaveLength(1);
    expect(storage.observe.lifetime()[0]?.prompt).toBe(1_500);
  });

  it("keepsPerToolLifetimeCountersBesideThePerBotOnes", () => {
    const observe = lane({ prices: { "qwen/qwen3-27b": { inputPerMillion: 1, outputPerMillion: 2 } } });
    observe.accept("luna", payload());
    clock += 60_000;
    observe.accept("luna", payload({
      steps: [{ turn: OTHER_TURN, step: 1, model: "qwen/qwen3-27b", promptTokens: 10, completionTokens: 2, cachedTokens: 0 }],
      toolCalls: [{
        tool: "searchWorkspaceItems", turn: OTHER_TURN, step: 1, family: "investigation",
        calls: 2, resultTokens: 100, callTokens: 10, schemaShareTokens: 10,
        inducedTokens: 120, durationMs: 200, attributed: true, outcomes: { error: 2 },
      }],
    }));
    const rows = storage.observe.toolLifetime();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool).toBe("searchWorkspaceItems");
    expect(rows[0]?.calls).toBe(3);
    expect(rows[0]?.tokens).toBe(520);
    expect(rows[0]?.failures).toBe(2);
    expect(rows[0]?.costMicros).toBeGreaterThan(0);
  });

  it("takesADurationPercentileOnlyFromRowsThatMeasuredOneCall", () => {
    const observe = lane();
    observe.accept("luna", payload());
    clock += 60_000;
    observe.accept("luna", payload({
      steps: [],
      toolCalls: [{
        tool: "searchWorkspaceItems", turn: OTHER_TURN, step: 1,
        calls: 4, resultTokens: 1, callTokens: 1, schemaShareTokens: 1,
        inducedTokens: 3, durationMs: 4_000, attributed: true, outcomes: { ok: 4 },
      }],
    }));
    const summary = storage.observe.toolDurations({
      bot: storage.observe.identify("luna"), tool: "searchWorkspaceItems",
      from: 0, to: Number.MAX_SAFE_INTEGER,
    });
    expect(summary.count).toBe(1);
    expect(summary.p50).toBe(120);
  });
});

describe("the price sheet", () => {
  it("noPriceSheetEntryReportsTokensOnlyNotZeroDollars", () => {
    const observe = lane({ prices: {} });
    observe.accept("luna", payload({
      steps: [{ turn: TURN, step: 1, model: "some-unlisted-model", promptTokens: 1_000, completionTokens: 100, cachedTokens: 0 }],
      toolCalls: [],
    }));
    const row = storage.observe.lifetime()[0];
    expect(row?.costMicros).toBe(0);
    expect(row?.unpriced).toBeGreaterThan(0);
    expect(row?.priced).toBe(0);
  });

  it("distinguishesAPricedZeroFromNoSheetAtAll", () => {
    const observe = lane({ prices: { "local-27b": { inputPerMillion: 0, outputPerMillion: 0 } } });
    observe.accept("luna", payload({
      steps: [{ turn: TURN, step: 1, model: "local-27b", promptTokens: 1_000, completionTokens: 100, cachedTokens: 0 }],
      toolCalls: [],
    }));
    const row = storage.observe.lifetime()[0];
    expect(row?.costMicros).toBe(0);
    expect(row?.priced).toBe(1);
    expect(row?.unpriced).toBe(0);
  });

  it("pricesTheModelsTheRoadmapNamesFromTheBuiltInSheet", () => {
    expect(Object.keys(OBSERVE_DEFAULT_PRICES).length).toBeGreaterThan(0);
    const price = observeModelPrice(undefined, "claude-opus-4-5-20260101");
    expect(price).toBeDefined();
    expect(observeCostMicros(price, { prompt: 1_000_000, completion: 0, cached: 0 })).toBeGreaterThan(0);
  });

  it("readsTheSheetThroughTheGatewayConfigSurface", () => {
    const config = {
      name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
      observability: { enabled: true, retentionDays: 7, prices: { "qwen/qwen3-27b": { inputPerMillion: 0.2, outputPerMillion: 0.6 } } },
    } as never;
    expect(observability(config).enabled).toBe(true);
    expect(observabilityPrices(config)["qwen/qwen3-27b"]?.inputPerMillion).toBe(0.2);
  });
});

describe("a gateway with observability off", () => {
  it("storesNothingAndFoldsNothing", () => {
    const observe = lane({ enabled: false });
    expect(observe.accept("luna", payload())).toBe("disabled");
    expect(observe.hasSnapshot("luna")).toBe(false);
    expect(storage.observe.lifetime()).toHaveLength(0);
  });
});

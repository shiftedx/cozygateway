import { OBSERVATION_SNAPSHOT_LANE_SCHEMA } from "../../src/observe/snapshot.ts";
const TURN = `obs:${"a".repeat(64)}`;
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
export function snapshotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: OBSERVATION_SNAPSHOT_LANE_SCHEMA,
    reason: "turn_terminal",
    emittedAt: 1_700_000_000_000,
    windowMs: 60_000,
    snapshot: {
      schema: "cozyagents.observation-snapshot.v1",
      dashboard: "cozyagents.observability-dashboard.v1",
      view: "aggregate",
      generatedAt: new Date(1_700_000_000_000).toISOString(),
      aggregate: aggregate(),
    },
    runtime: {
      stage: "ready", backend: "docker", isolation: "workspace",
      lastContactAtMs: 1_700_000_000_000 - 1_000, bundleVersion: "0.2.13",
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

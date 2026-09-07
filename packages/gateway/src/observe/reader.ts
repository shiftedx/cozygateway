import type { AppDeps } from "../http.ts";
import type { BotRuntimeProjection } from "cozygateway-contract";
import { observabilityPrices } from "../config.ts";
import { costMicros, priceOf } from "./prices.ts";
import type { ObservationSnapshotStepRow, ObservationSnapshotToolRow } from "./snapshot.ts";
import { SPEED_SAMPLE_FLOOR, type ObserveAggregate, type ObserveAgentInternals, type ObserveSnapshotReader, type ObserveThroughput, type ObserveToolCosts } from "./routes.ts";

type Query = { bot?: string; from: number; to: number };
const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" ? value : null;
const string = (value: unknown): string | null => typeof value === "string" ? value : null;
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

export function observationAggregate(values: readonly number[], speed = false): ObserveAggregate {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const belowSampleFloor = speed && sorted.length < SPEED_SAMPLE_FLOOR;
  const percentile = (fraction: number) => sorted.length === 0 || belowSampleFloor ? null : sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), belowSampleFloor };
}

/** Reads validated D5 state. Unreported values remain null, and speed samples are never pooled
 * across bots, models or cache-prefix modes. Lifetime counters include retained history even when
 * its detailed step records have aged out of the ring. */
export function createObserveSnapshotReader(deps: AppDeps & { observe: NonNullable<AppDeps["observe"]> }): ObserveSnapshotReader {
  const ring = deps.observe;
  const store = ring.store;
  const prices = observabilityPrices(deps.config);
  const roster = () => deps.bots?.roster().bots ?? [];
  const subjects = (query: Query) => ({ ...query, ...(query.bot === undefined ? {} : { bot: ring.identify(query.bot) }) });
  const botName = (hash: string) => roster().find(row => ring.identify(row.name) === hash)?.name ?? "former bot";
  const records = <T>(query: Query, kind: "step" | "tool") => store.snapshotRecords({ ...subjects(query), kind })
    .map(row => ({ bot: row.bot, at: row.at, value: row.record as T }));
  const runtime = (bot: string): BotRuntimeProjection | undefined => {
    try { return deps.bots !== undefined && "botRuntime" in deps.bots ? deps.bots.botRuntime?.(bot) : undefined; }
    catch { return undefined; } // Config-declared or removed runtimes legitimately have no operation projection.
  };
  return {
    attached: () => ring.enabled && roster().some(row => row.runtime === "cozyagents"
      && (deps.observePeerAttached?.(row.name) ?? deps.presenceOf(row.name) === "online")
      && store.snapshot(ring.identify(row.name)) !== undefined),
    internals: (query) => roster().filter(row => row.runtime === "cozyagents" && (query.bot === undefined || row.name === query.bot)).flatMap(row => {
      const latest = store.snapshot(ring.identify(row.name));
      if (latest === undefined) return [];
      const { payload, receivedAt } = latest;
      const aggregate = object(payload.snapshot.aggregate);
      const context = object(aggregate.context);
      const tools = object(aggregate.tools);
      const guardrails = payload.guardrails;
      const decisions = object(guardrails?.decisions);
      const actions = object(guardrails?.actions);
      const wanted = runtime(row.name);
      const entry: ObserveAgentInternals = {
        bot: row.name, runtimeStage: wanted?.stage ?? string(payload.runtime?.stage) ?? "unknown",
        generationsWanted: wanted?.specGeneration ?? null, generationsObserved: wanted?.observedGeneration ?? null,
        bundleVersion: string(payload.runtime?.bundleVersion), runnerName: wanted?.runnerName ?? row.runnerName ?? null,
        runnerLastContactAt: wanted?.lastRunnerContactAt ?? null, snapshotAgeMs: Math.max(0, deps.now() - receivedAt),
        toolFamilies: Object.entries(tools).map(([family, tally]) => ({ family, calls: number(object(tally).calls) ?? 0 })),
        toolServers: (payload.mcp ?? []).map(server => ({ server: string(server.server) ?? "unknown",
          layers: Object.keys(object(server.layers)).length,
          healthy: Object.values(object(server.layers)).filter(layer => object(layer).value === "yes").length,
          fingerprint: string(object(server.fingerprint).current), state: server.repair === undefined ? string(server.summary) ?? "unknown" : "repair_pending" })),
        policy: { permitted: number(decisions.permitted), asked: number(actions.ask), denied: number(decisions.denied),
          expired: number(decisions.expired), egressRefused: null, level: null },
        context: { inUseTokens: null, windowTokens: null, rollovers: number(context.compactions), lastRolloverAt: null,
          cardsAttached: null, cardsTotal: null },
        memory: { recallDocs: number(payload.recall?.indexed) ?? number(payload.recall?.after), recallBytes: number(payload.recall?.bytes),
          lastConsolidationAt: null, evicted: number(payload.recall?.evicted), tombstoned: number(payload.recall?.tombstoned) },
        checkpoints: { count: payload.checkpoints?.written ?? null, restores: null, lastRestoreResult: null },
        prompt: payload.prompt ?? null, cache: payload.cache, recall: payload.recall ?? null,
        guardrails: payload.guardrails ?? null, steps: payload.steps ?? [], toolCalls: payload.toolCalls ?? [],
      };
      return [entry];
    }),
    throughput: (query): ObserveThroughput => {
      const steps = records<ObservationSnapshotStepRow>(query, "step");
      const lifetime = store.lifetime(query.bot === undefined ? undefined : ring.identify(query.bot));
      const groups = new Map<string, { bot: string; model: string; steps: ObservationSnapshotStepRow[] }>();
      for (const row of steps) {
        const model = row.value.model ?? "unreported";
        const key = JSON.stringify([row.bot, model]);
        const group = groups.get(key) ?? { bot: row.bot, model, steps: [] };
        group.steps.push(row.value); groups.set(key, group);
      }
      // Preserve lifetime-only rows without manufacturing current-window observations.
      for (const total of lifetime) {
        if ([...groups.values()].some(group => group.bot === total.bot && ring.identify(group.model) === total.model)) continue;
        const model = store.snapshot(total.bot)?.payload.steps?.find(step => step.model !== undefined && ring.identify(step.model) === total.model)?.model ?? `former model ${total.model}`;
        groups.set(JSON.stringify([total.bot, model]), { bot: total.bot, model, steps: [] });
      }
      const rows = [...groups.values()].map(group => {
        const total = lifetime.find(row => row.bot === group.bot && (row.model === ring.identify(group.model) || group.model === `former model ${row.model}`));
        const costs = group.steps.map(step => step.model === undefined ? undefined : costMicros(priceOf(prices, step.model), {
          prompt: step.promptTokens ?? 0, completion: step.completionTokens ?? 0, cached: step.cachedTokens ?? 0,
        }));
        const turnCosts = new Map<string, Array<number | undefined>>();
        group.steps.forEach((step, index) => {
          if (step.turn === undefined) return;
          const values = turnCosts.get(step.turn) ?? []; values.push(costs[index]); turnCosts.set(step.turn, values);
        });
        const costPerTurn = observationAggregate([...turnCosts.values()].flatMap(values =>
          values.some(value => value === undefined) ? [] : [sum(values as number[])]));
        const prefixes = [...new Set(group.steps.map(step => step.prefix ?? "unreported"))];
        const speedsByPrefix = prefixes.map(prefix => {
          const steps = group.steps.filter(step => (step.prefix ?? "unreported") === prefix);
          return { prefix,
            prefill: observationAggregate(steps.flatMap(step => step.prefillTokensPerSecond === undefined ? [] : [step.prefillTokensPerSecond]), true),
            decode: observationAggregate(steps.flatMap(step => step.decodeTokensPerSecond === undefined ? [] : [step.decodeTokensPerSecond]), true) };
        });
        return { bot: botName(group.bot), model: group.model, prefix: prefixes.length === 1 ? prefixes[0]! : "mixed",
          speedsByPrefix, costPerTurn,
          prefill: speedsByPrefix.length === 1 ? speedsByPrefix[0]!.prefill : observationAggregate([], true),
          decode: speedsByPrefix.length === 1 ? speedsByPrefix[0]!.decode : observationAggregate([], true),
          tokens: { prompt: sum(group.steps.map(step => step.promptTokens ?? 0)), completion: sum(group.steps.map(step => step.completionTokens ?? 0)), cached: sum(group.steps.map(step => step.cachedTokens ?? 0)) },
          costMicros: costs.length === 0 || costs.some(cost => cost === undefined) ? null : sum(costs as number[]),
          lifetime: { prompt: total?.prompt ?? 0, completion: total?.completion ?? 0, cached: total?.cached ?? 0,
            costMicros: total === undefined || total.unpriced > 0 || total.priced === 0 ? null : total.costMicros, turns: total?.turns ?? 0 },
        };
      });
      return { priceSheetConfigured: rows.some(row => row.costMicros !== null || row.lifetime.costMicros !== null), rows };
    },
    toolCosts: (query): ObserveToolCosts => {
      const calls = records<ObservationSnapshotToolRow>(query, "tool");
      const steps = records<ObservationSnapshotStepRow>(query, "step");
      const stepModels = new Map(steps.map(row => [JSON.stringify([row.bot, row.value.turn, row.value.step]), row.value.model]));
      const grouped = new Map<string, typeof calls>();
      for (const row of calls) {
        const group = grouped.get(row.value.tool) ?? []; group.push(row); grouped.set(row.value.tool, group);
      }
      const rows = [...grouped].map(([tool, records]) => {
        const calls = sum(records.map(row => row.value.calls));
        const resultTokens = records.map(row => row.value.resultTokens);
        const inducedTokens = records.map(row => row.value.inducedTokens);
        const costs = records.map(row => {
          const model = stepModels.get(JSON.stringify([row.bot, row.value.turn, row.value.step]));
          if (model === undefined || row.value.resultTokens === undefined || row.value.callTokens === undefined || row.value.schemaShareTokens === undefined) return undefined;
          return costMicros(priceOf(prices, model), { prompt: row.value.resultTokens + row.value.schemaShareTokens, completion: row.value.callTokens, cached: 0 });
        });
        const exact = records.filter(row => row.value.calls === 1);
        const medianResultTokens = exact.length === records.length && resultTokens.every(value => value !== undefined)
          ? observationAggregate(resultTokens as number[]).p50 : null;
        const duration = observationAggregate(exact.flatMap(row => row.value.durationMs === undefined ? [] : [row.value.durationMs]));
        const totalInduced = inducedTokens.every(value => value !== undefined) ? sum(inducedTokens as number[]) : null;
        const errors = sum(records.map(row => row.value.outcomes?.error ?? 0));
        const families = new Set(records.map(row => row.value.family ?? "unknown"));
        const flags: string[] = [];
        if (calls > 0 && errors / calls > .05) flags.push("errors");
        if (records.some(row => row.value.estimated === true)) flags.push("estimated");
        const drivingTurns = new Map<string, { bot: string; turn: string; calls: number; inducedTokens: number | null }>();
        for (const row of records) {
          if (row.value.turn === undefined) continue;
          const key = JSON.stringify([row.bot, row.value.turn]);
          const item = drivingTurns.get(key) ?? { bot: botName(row.bot), turn: row.value.turn, calls: 0, inducedTokens: 0 };
          item.calls += row.value.calls;
          item.inducedTokens = item.inducedTokens === null || row.value.inducedTokens === undefined ? null : item.inducedTokens + row.value.inducedTokens;
          drivingTurns.set(key, item);
        }
        return { tool, resultSize: observationAggregate(exact.flatMap(row => row.value.resultTokens === undefined ? [] : [row.value.resultTokens])),
          drivingTurns: [...drivingTurns.values()].sort((a, b) => (b.inducedTokens ?? -1) - (a.inducedTokens ?? -1)), family: families.size === 1 ? [...families][0]! : "mixed", calls, errors, medianResultTokens,
          inducedTokens: totalInduced, costMicros: costs.some(value => value === undefined) ? null : sum(costs as number[]),
          duration, flags, attributed: records.some(row => row.value.attributed === true) };
      });
      // The family threshold is a call distribution, not an equally weighted list of tools.
      // Aggregated rows cannot reconstruct that distribution; withhold the flag in that case.
      const heavyDetectionAvailable = calls.length > 0 && calls.every(row => row.value.calls === 1 && row.value.inducedTokens !== undefined);
      if (heavyDetectionAvailable) for (const row of rows) {
        if (row.inducedTokens === null || row.calls === 0 || row.family === "mixed" || row.family === "unknown") continue;
        const peers = calls.filter(peer => peer.value.family === row.family)
          .map(peer => peer.value.inducedTokens!).sort((a, b) => a - b);
        const threshold = peers[Math.max(0, Math.ceil(peers.length * .9) - 1)];
        if (threshold !== undefined && row.inducedTokens / row.calls > threshold) row.flags.push("heavy");
      }
      rows.sort((a, b) => (b.inducedTokens ?? -1) - (a.inducedTokens ?? -1));
      return { priceSheetConfigured: rows.some(row => row.costMicros !== null), retryDetectionAvailable: false, heavyDetectionAvailable, rows };
    },
  };
}

/** VPN deltas compare only measured on/off receipts from one device and radio. Unknown VPN
 * state contributes to the device distribution, never either side of the comparison. */
export function observeReceiptDistributions(ring: NonNullable<AppDeps["observe"]>, query: Query) {
  const measurements = ring.store.receiptMeasurements(query);
  return groupObserveReceiptMeasurements(measurements);
}

export function groupObserveReceiptMeasurements(measurements: Array<{ bot: string; device: string; detail: Record<string, unknown> }>) {
  const groups = new Map<string, typeof measurements>();
  for (const row of measurements) {
    const radio = typeof row.detail.radio === "string" ? row.detail.radio : "unknown";
    const key = JSON.stringify([row.device, radio]);
    const rows = groups.get(key) ?? []; rows.push(row); groups.set(key, rows);
  }
  return [...groups].map(([key, rows]) => {
    const [device, radio] = JSON.parse(key) as [string, string];
    const distribution = (metric: "felt_latency_ms" | "edge_rtt_ms", vpn?: boolean) => observationAggregate(rows.flatMap(row =>
      (vpn === undefined || row.detail.vpn === vpn) && typeof row.detail[metric] === "number" ? [row.detail[metric] as number] : []));
    const metric = (name: "felt_latency_ms" | "edge_rtt_ms") => {
      const vpnOn = distribution(name, true), vpnOff = distribution(name, false);
      const comparable = radio !== "unknown" && vpnOn.samples >= 30 && vpnOff.samples >= 30;
      return { ...distribution(name), vpnOn, vpnOff, vpnCostMs: comparable ? vpnOn.p50! - vpnOff.p50! : null,
        belowComparisonFloor: !comparable };
    };
    return { device, radio, felt: metric("felt_latency_ms"), edge: metric("edge_rtt_ms"),
      edgeColos: [...new Set(rows.flatMap(row => typeof row.detail.edge_colo === "string" ? [row.detail.edge_colo] : []))] };
  });
}

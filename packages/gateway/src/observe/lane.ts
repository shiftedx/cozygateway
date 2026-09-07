import type { ObservationRing } from "./ring.ts";
import { costMicros, priceOf, type ObservePriceSheet } from "./prices.ts";
import {
  OBSERVATION_SNAPSHOT_MAX_BYTES, validateObservationSnapshotPayload,
  type ObservationSnapshotPayload,
} from "./snapshot.ts";

/** Latest-state storage and the one bridge from the peer's closed payload to numeric accounting.
 * The shipped CozyAgents producer publishes StepWindow rows only after harness.run settles, with
 * the finally path repeating the same recorder output. Fold-once depends on those immutable rows;
 * estimated means a settled turn had no following step, not that this record will be updated. */
export class ObservationSnapshotLane {
  readonly #ring: ObservationRing;
  readonly #prices: ObservePriceSheet | undefined;
  readonly #now: () => number;
  #refused = 0;

  constructor(deps: { ring: ObservationRing; prices?: ObservePriceSheet; now?: () => number }) {
    this.#ring = deps.ring;
    this.#prices = deps.prices;
    this.#now = deps.now ?? Date.now;
  }

  get refused(): number { return this.#refused; }

  latest(bot: string): { payload: ObservationSnapshotPayload; receivedAt: number } | undefined {
    return this.#ring.store.snapshot(this.#ring.store.identify(bot));
  }

  hasSnapshot(bot?: string): boolean {
    return bot === undefined ? this.#ring.store.snapshotSubjects().length > 0 : this.latest(bot) !== undefined;
  }

  accept(bot: string, value: unknown, bytes?: number): "stored" | "refused" | "too_large" | "disabled" {
    if (!this.#ring.enabled) return "disabled";
    let encodedBytes: number;
    try { encodedBytes = Buffer.byteLength(JSON.stringify({ kind: "observation_snapshot", payload: value })); }
    catch { this.#refused++; return "refused"; }
    if (Math.max(bytes ?? 0, encodedBytes) > OBSERVATION_SNAPSHOT_MAX_BYTES) {
      this.#refused++; return "too_large";
    }
    const payload = validateObservationSnapshotPayload(value);
    if (payload === undefined) { this.#refused++; return "refused"; }
    const at = this.#now();
    const store = this.#ring.store;
    const subject = store.identify(bot);
    const previous = this.latest(bot)?.payload;
    // The latest tail protects recurring idle snapshots even after a seven-day ledger sweep.
    const previousSteps = new Set(previous?.steps?.map(row => `${row.turn}:${row.step}`));
    const previousTools = new Set(previous?.toolCalls?.map(row => `${row.turn}:${row.step}:${row.tool}`));
    try { return store.transaction(() => {
      const steps = (payload.steps ?? []).filter(row => row.turn !== undefined
        && !previousSteps.has(`${row.turn}:${row.step}`)
        && store.claimSnapshotRecord(`step:${bot}:${row.turn}:${row.step}`, at))
        .map(row => ({ ...row, turnId: row.turn!,
          ...(row.timeToFirstTokenMs !== undefined && row.generationMs !== undefined
            ? { modelStepMs: row.timeToFirstTokenMs + row.generationMs } : {}),
        }));
      const toolCalls = (payload.toolCalls ?? []).filter(row => row.turn !== undefined && row.step !== undefined
        && !previousTools.has(`${row.turn}:${row.step}:${row.tool}`)
        && store.claimSnapshotRecord(`tool:${bot}:${row.turn}:${row.step}:${row.tool}`, at))
        .map(row => ({ ...row, turnId: row.turn!, step: row.step!,
          ...(row.durationMs === undefined ? {} : { toolMs: row.durationMs }),
        }));
      const turnSteps = new Map<string, number>();
      if (payload.reason === "turn_terminal") for (const row of payload.steps ?? []) {
        if (row.turn !== undefined) turnSteps.set(row.turn, Math.max(turnSteps.get(row.turn) ?? 0, row.step));
      }
      const turns = [...turnSteps].filter(([turn]) => store.claimSnapshotRecord(`anatomy:${bot}:${turn}`, at))
        .map(([turnId, modelSteps]) => ({ turnId, modelSteps }));
      const folded = this.#ring.foldSnapshotIntoSeries(bot, { steps, toolCalls, turns }, true);
      for (const step of steps.filter(row => folded.acceptedSteps.includes(row))) {
        const { turnId: _turnId, modelStepMs: _modelStepMs, ...record } = step;
        store.putSnapshotRecord(subject, "step", record, at);
        if (step.model === undefined) continue;
        const tokens = { prompt: step.promptTokens ?? 0, completion: step.completionTokens ?? 0, cached: step.cachedTokens ?? 0 };
        const cost = costMicros(priceOf(this.#prices, step.model), tokens);
        this.#ring.accumulateLifetime({ snapshotId: `lifetime:${bot}:${step.turn}:${step.step}`, bot,
          model: step.model, ...tokens, costMicros: cost ?? 0, priced: cost === undefined ? 0 : 1,
          unpriced: cost === undefined ? 1 : 0,
          turns: store.claimSnapshotRecord(`turn:${bot}:${step.turn}:${step.model}`, at) ? 1 : 0, at,
        });
      }
      for (const call of toolCalls.filter(row => folded.acceptedToolCalls.includes(row))) {
        const { turnId: _turnId, toolMs: _toolMs, ...record } = call;
        store.putSnapshotRecord(subject, "tool", record, at);
        const step = payload.steps?.find(row => row.turn === call.turn && row.step === call.step);
        const price = step?.model === undefined ? undefined : priceOf(this.#prices, step.model);
        // Result and schema tokens induce input; the serialized call induces output. Orphans remain unpriced.
        const cost = call.inducedTokens === undefined ? undefined : costMicros(price, {
          prompt: (call.resultTokens ?? 0) + (call.schemaShareTokens ?? 0),
          completion: call.callTokens ?? 0, cached: 0,
        });
        store.accumulateToolLifetime({ bot: subject, tool: call.tool, calls: call.calls,
          tokens: call.inducedTokens ?? 0, failures: call.outcomes?.error ?? 0, costMicros: cost ?? 0,
          priced: cost === undefined ? 0 : call.calls, unpriced: cost === undefined ? call.calls : 0, at,
        });
        if (call.calls === 1 && call.durationMs !== undefined) store.sampleToolDuration(subject, call.tool, at, call.durationMs);
      }
      if (!store.putSnapshot(subject, payload, at)) throw new Error("snapshot storage refused");
      return "stored";
    }); } catch {
      // Observability cannot take an authenticated peer offline on a storage failure.
      this.#refused++;
      return "refused";
    }
  }
}

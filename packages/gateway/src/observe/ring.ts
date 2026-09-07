import { performance } from "node:perf_hooks";

import type { ObserveStore, ObserveSummary } from "./store.ts";
import { seriesName, type ObserveDetail, type ObserveEventKind, type ObserveSeries, type ObserveSeriesTag } from "./privacy.ts";

/** One monotonic clock, in milliseconds, shared by every duration in the ring.
 *
 *  Section 11: "every figure is a measured round trip on one clock (monotonic, millisecond
 *  resolution, no clock sync between machines)". `Date.now()` is not that clock: an NTP step or a
 *  daylight change would turn a 40 ms round trip into a negative number or an hour, and the ring
 *  would record it as a real measurement. Wall time is still what the `at` column stores, because a
 *  chart has to be placed on a calendar, but no DURATION is ever a difference of two wall clocks. */
export function monotonicNow(): number {
  return performance.now();
}

/** Config shape for the ring, mirroring `observability` in the gateway config. */
export interface ObservabilityOptions {
  enabled: boolean;
  retentionDays: number;
}

export const OBSERVABILITY_DEFAULT_RETENTION_DAYS = 7;

/** How many in-flight turns, devices or peers the ring will hold timing state for. A bound rather
 *  than an unbounded map, because this state is keyed by ids a peer supplies: a peer that opens
 *  turns and never terminalizes them must cost the gateway a fixed amount of memory, not a growing
 *  one. Oldest entries are dropped first, and dropping one loses a metric and nothing else. */
const MAX_TRACKED = 4_096;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_TRACKED && !map.has(key)) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
  map.set(key, value);
}

interface TurnTiming {
  /** Monotonic reading at admission. */
  admittedAt: number;
  dispatchedAt?: number;
  firstDeltaAt?: number;
  deltaFrames: number;
}

/** The observation ring: everything the gateway measures once and would otherwise throw away.
 *
 *  Off by default and inert when off. `enabled: false` is not a filter applied at read time; every
 *  writer returns before it touches SQLite, so a gateway with observability off does exactly the
 *  work it did before this module existed, including keeping no in-memory timing state.
 *
 *  Nothing in here is derived. A hop the gateway cannot measure is absent from the ring rather
 *  than computed by subtraction and stored beside the measured ones: section 11 requires derived
 *  figures to be drawn hatched and labelled, which the dashboard can only do if the store never
 *  blurred the two. */
export class ObservationRing {
  readonly #store: ObserveStore;
  readonly #now: () => number;
  readonly #enabled: boolean;
  readonly #retentionDays: number;
  readonly #turns = new Map<string, TurnTiming>();
  readonly #peerHeartbeats = new Map<string, number>();

  constructor(deps: {
    store: ObserveStore;
    options: ObservabilityOptions;
    /** Wall clock for the `at` column only. Durations never come from here. */
    now?: () => number;
  }) {
    this.#store = deps.store;
    this.#now = deps.now ?? Date.now;
    this.#enabled = deps.options.enabled;
    this.#retentionDays = Math.max(1, deps.options.retentionDays);
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get retentionDays(): number {
    return this.#retentionDays;
  }

  /** Read access for D3's routes. Present even when the ring is disabled so a reader gets an empty
   *  window rather than a crash; D4 is what answers 404 for a disabled gateway. */
  get store(): ObserveStore {
    return this.#store;
  }

  // primitives

  sample(series: ObserveSeries, bot: string | null, value: number, tag?: ObserveSeriesTag): void {
    if (!this.#enabled) return;
    this.#store.sample(seriesName(series, tag), bot, this.#now(), value);
  }

  event(kind: ObserveEventKind, bot: string | null, ref: string | null, detail?: ObserveDetail): void {
    if (!this.#enabled) return;
    this.#store.event(kind, this.#now(), bot, ref, detail);
  }

  // hop writers

  /** Section 10, device to gateway: the ping-to-pong time on the gateway's own monotonic clock,
   *  tagged with how the socket reached this process. */
  deviceRtt(deviceId: string, milliseconds: number, via: "tunnel" | "lan"): void {
    this.sample("device_rtt_ms", deviceId, milliseconds, via);
  }

  /** A device answered so late that a ping was already outstanding, or never answered at all. The
   *  gap is a measured silence, not a round trip, which is why it is its own series. */
  heartbeatGap(deviceId: string, milliseconds: number): void {
    this.sample("heartbeat_gap_ms", deviceId, milliseconds);
  }

  /** Section 10, the tunnel leg alone: the public round trip minus the loopback round trip, both
   *  timed by this process on the same clock in the same second. This IS a subtraction, and it is
   *  the one section 11 explicitly sanctions and names ("difference is the gateway-side tunnel leg
   *  plus the edge"), because both terms are measurements this gateway took itself. */
  tunnelRtt(milliseconds: number): void {
    this.sample("tunnel_rtt_ms", null, milliseconds);
  }

  tunnelFlap(reason: "timeout" | "bad_gateway" | "unreachable" | "http_error", status?: number): void {
    this.event("tunnel_flap", null, null, {
      reason,
      ...(status === undefined ? {} : { status }),
    });
  }

  /** Section 10, gateway handling. Two legs per turn: admission to dispatch, and the peer's
   *  terminal to the app broadcast. Both are gateway-internal time and both land in this series,
   *  so its sample count is per leg rather than per turn. */
  gatewayHandle(bot: string, milliseconds: number): void {
    this.sample("gateway_handle_ms", bot, milliseconds);
  }

  /** Section 10, gateway to peer: the attach heartbeat request to its ack. */
  peerHeartbeatSent(agentId: string): void {
    if (!this.#enabled) return;
    remember(this.#peerHeartbeats, agentId, monotonicNow());
  }

  peerHeartbeatAcked(agentId: string): void {
    if (!this.#enabled) return;
    const sentAt = this.#peerHeartbeats.get(agentId);
    if (sentAt === undefined) return;
    this.#peerHeartbeats.delete(agentId);
    this.sample("peer_rtt_ms", agentId, monotonicNow() - sentAt);
  }

  peerForgotten(agentId: string): void {
    this.#peerHeartbeats.delete(agentId);
  }

  // turn timing

  #turnKey(bot: string, turnId: string): string {
    return `${bot} ${turnId}`;
  }

  /** The turn was admitted: a durable turn row exists and the gateway now owes the peer a command. */
  turnAdmitted(bot: string, turnId: string): void {
    if (!this.#enabled) return;
    remember(this.#turns, this.#turnKey(bot, turnId), { admittedAt: monotonicNow(), deltaFrames: 0 });
  }

  /** The turn command reached the peer's lane. Writes the admission-to-dispatch leg. */
  turnDispatched(bot: string, turnId: string): void {
    if (!this.#enabled) return;
    const timing = this.#turns.get(this.#turnKey(bot, turnId));
    if (timing === undefined || timing.dispatchedAt !== undefined) return;
    timing.dispatchedAt = monotonicNow();
    this.gatewayHandle(bot, timing.dispatchedAt - timing.admittedAt);
  }

  /** One `bot_chat_delta` for this turn. The first one is time to first token as the gateway can
   *  observe it; every one of them counts toward `delta_frames`. */
  turnDelta(bot: string, turnId: string): void {
    if (!this.#enabled) return;
    const timing = this.#turns.get(this.#turnKey(bot, turnId));
    if (timing === undefined) return;
    timing.deltaFrames += 1;
    if (timing.firstDeltaAt !== undefined) return;
    timing.firstDeltaAt = monotonicNow();
    this.sample("ttft_ms", bot, timing.firstDeltaAt - timing.admittedAt);
  }

  /** The turn reached a terminal. Writes `turn_ms`, `delta_frames` and the terminal event, and
   *  returns a function that closes the terminal-to-broadcast leg once the frame is out. */
  turnTerminal(
    bot: string,
    turnId: string,
    terminal: { status: string; reason?: string },
  ): () => void {
    if (!this.#enabled) return () => {};
    const key = this.#turnKey(bot, turnId);
    const timing = this.#turns.get(key);
    const terminalAt = monotonicNow();
    if (timing !== undefined) {
      this.#turns.delete(key);
      this.sample("turn_ms", bot, terminalAt - timing.admittedAt);
      this.sample("delta_frames", bot, timing.deltaFrames);
    }
    this.event("turn_terminal", bot, turnId, {
      status: terminal.status,
      ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
    });
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.gatewayHandle(bot, monotonicNow() - terminalAt);
    };
  }

  turnForgotten(bot: string, turnId: string): void {
    this.#turns.delete(this.#turnKey(bot, turnId));
  }

  // gateway wide

  /** Sampled on the observation sweep rather than only on demand, so the dashboard can draw a line
   *  through a night nobody was watching. */
  attachDepths(depths: {
    online: number;
    queueDepth: number;
    deadLetters: number;
    outboxDepth: number;
  }): void {
    this.sample("attach_online", null, depths.online);
    this.sample("queue_depth", null, depths.queueDepth);
    this.sample("dead_letters", null, depths.deadLetters);
    this.sample("outbox_depth", null, depths.outboxDepth);
  }

  /** A durable event lost to the projection dead letter queue. */
  deadLetter(bot: string, ref: string | null, detail?: ObserveDetail): void {
    this.event("dead_letter", bot, ref, detail);
  }

  /** Push relay outcome, written beside the existing `relay_result` trace rather than replacing
   *  it: the trace is a debugging line an operator tails, this is a countable series. The value is
   *  1 for a delivered push and 0 for anything else, so a success rate is a mean over the base
   *  series and the reason is the tag. */
  pushResult(deviceId: string, result: "ok" | "not_found" | "http_error" | "network_error"): void {
    this.sample("push_result", deviceId, result === "ok" ? 1 : 0, result);
    if (result !== "ok") this.event("push_result", null, deviceId, { result });
  }

  /** Section 11, perceived by the person: the app's own send-tapped to first-delta-rendered
   *  measurement, reported on the delivery receipt. Measured on the PHONE's clock, which is why it
   *  is a separate series from every gateway-side hop and is never added to one. */
  feltLatency(
    bot: string,
    milliseconds: number,
    networkPath?: "wifi" | "cellular" | "vpn_on" | "vpn_off",
  ): void {
    this.sample("felt_latency_ms", bot, milliseconds, networkPath);
  }

  /** Section 12's lifetime counters, outside the ring and never trimmed. */
  accumulateLifetime(input: Parameters<ObserveStore["accumulateLifetime"]>[0]): void {
    if (!this.#enabled) return;
    this.#store.accumulateLifetime(input);
  }

  /** THE SEAM D5 CALLS. D5's gateway-side store-latest-snapshot code invokes this once per
   *  `observation_snapshot` it accepts; D2 owns the series-write side and nothing else. Only the
   *  numeric fields cross, and each is written under the CozyAgents-measured series name, so a
   *  Hermes bot that never sends a snapshot simply has no rows here rather than an inferred one. */
  foldSnapshotIntoSeries(
    bot: string,
    snapshot: {
      modelStepMs?: readonly number[];
      modelSteps?: number;
      toolMs?: readonly number[];
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
    },
  ): void {
    if (!this.#enabled) return;
    for (const value of snapshot.modelStepMs ?? []) this.sample("model_step_ms", bot, value);
    for (const value of snapshot.toolMs ?? []) this.sample("tool_ms", bot, value);
    if (snapshot.modelSteps !== undefined) this.sample("model_steps", bot, snapshot.modelSteps);
    if (snapshot.promptTokens !== undefined) this.sample("prompt_tokens", bot, snapshot.promptTokens);
    if (snapshot.completionTokens !== undefined) this.sample("completion_tokens", bot, snapshot.completionTokens);
    if (snapshot.cachedTokens !== undefined) this.sample("cached_tokens", bot, snapshot.cachedTokens);
  }

  // retention

  /** The nightly trim. Runs even when the ring is disabled: an operator who turns observability off
   *  should watch the rows it already wrote age out, not keep them forever. */
  trim(nowMs: number = this.#now()): { series: number; events: number } {
    return this.#store.trim(nowMs - this.#retentionDays * 86_400_000);
  }

  // read helpers

  /** p50, p95 and the sample count for one series over one window, for D3 to call. */
  summarize(query: {
    series: ObserveSeries;
    tag?: ObserveSeriesTag;
    bot?: string | null;
    from: number;
    to: number;
    /** Fold every tag of this base series into one distribution. */
    allTags?: boolean;
  }): ObserveSummary {
    return this.#store.summarize({
      series: query.allTags === true ? query.series : seriesName(query.series, query.tag),
      ...(query.bot === undefined ? {} : { bot: query.bot }),
      from: query.from,
      to: query.to,
      ...(query.allTags === true ? { includeTags: true } : {}),
    });
  }
}

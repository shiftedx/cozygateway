import { performance } from "node:perf_hooks";

import type { ObserveStore, ObserveSummary } from "./store.ts";
import {
  codeOf,
  seriesName,
  type ObserveDetail,
  type ObserveEventKind,
  type ObserveSeries,
  type ObserveSeriesTag,
} from "./privacy.ts";

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

/** How many folded snapshot steps the ring remembers for the replay guard. A turn is a few dozen
 *  steps, so this covers hundreds of concurrent turns; forgetting the oldest entry can only ever
 *  re-admit a very old duplicate, which is a far smaller error than admitting every duplicate. */
const MAX_FOLDED = 16_384;

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_TRACKED && !map.has(key)) {
    const oldest = map.keys().next();
    if (oldest.done !== true) map.delete(oldest.value);
  }
  map.set(key, value);
}

/** Claims a key in a bounded seen-set. False means it was already there. */
function claim(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  if (seen.size >= MAX_FOLDED) {
    const oldest = seen.values().next();
    if (oldest.done !== true) seen.delete(oldest.value);
  }
  seen.add(key);
  return true;
}

interface TurnTiming {
  /** Monotonic reading at admission: the durable turn row exists. */
  admittedAt: number;
  /** Monotonic reading at dispatch: the command is on the peer's lane. The zero of `ttft_ms` and
   *  `turn_ms`, because everything before it is the gateway's own queueing. */
  dispatchedAt?: number;
  firstDeltaAt?: number;
  deltaFrames: number;
}

/** One step of a CozyAgents snapshot, as D5's harness reports it. Every record carries the turn it
 *  belongs to and its index within that turn, which is what makes a repeated fold detectable. */
export interface ObserveSnapshotStep {
  turnId: string;
  step: number;
  modelStepMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
}

export interface ObserveSnapshotToolCall {
  turnId: string;
  step: number;
  /** Distinguishes two tool calls made in the same step. */
  index?: number;
  toolMs: number;
}

export interface ObserveSnapshot {
  steps?: readonly ObserveSnapshotStep[];
  toolCalls?: readonly ObserveSnapshotToolCall[];
  /** How many model steps a FINISHED turn took. Folded once per turn. */
  turns?: readonly { turnId: string; modelSteps: number }[];
}

/** The observation ring: everything the gateway measures once and would otherwise throw away.
 *
 *  Off by default and inert when off. `enabled: false` is not a filter applied at read time; every
 *  writer returns before it touches SQLite, so a gateway with observability off does exactly the
 *  work it did before this module existed, including keeping no in-memory timing state.
 *
 *  Nothing in here is derived. A hop the gateway cannot measure is absent from the ring rather than
 *  computed by subtraction and stored beside the measured ones: section 11 requires derived figures
 *  to be drawn hatched and labelled, which the dashboard can only do if the store never blurred the
 *  two.
 *
 *  No identifier reaches a row. Every bot, device, agent and turn id is put through the store's
 *  keyed `identify` first, so the ring is keyed by stable hashes and holds no name at all. */
export class ObservationRing {
  readonly #store: ObserveStore;
  readonly #now: () => number;
  readonly #enabled: boolean;
  readonly #retentionDays: number;
  readonly #turns = new Map<string, TurnTiming>();
  readonly #peerHeartbeats = new Map<string, number>();
  readonly #folded = new Set<string>();

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

  /** The value the ring stores for an identifier. D3 calls this on a name it already knows (a bot
   *  from the roster, a device from the pairing table) to find that subject's rows. */
  identify(value: string): string {
    return this.#store.identify(value);
  }

  // primitives

  sample(series: ObserveSeries, subject: string | null, value: number, tag?: ObserveSeriesTag): void {
    if (!this.#enabled) return;
    this.#store.sample(
      seriesName(series, tag),
      subject === null ? null : this.#store.identify(subject),
      this.#now(),
      value,
    );
  }

  event(kind: ObserveEventKind, subject: string | null, ref: string | null, detail?: ObserveDetail): void {
    if (!this.#enabled) return;
    this.#store.event(
      kind,
      this.#now(),
      subject === null ? null : this.#store.identify(subject),
      ref === null ? null : this.#store.identify(ref),
      detail,
    );
  }

  // hop writers

  /** Section 10, device to gateway: the ping-to-pong time on the gateway's own monotonic clock,
   *  tagged with how the socket reached this process. */
  deviceRtt(deviceId: string, milliseconds: number, via: "tunnel" | "lan"): void {
    this.sample("device_rtt_ms", deviceId, milliseconds, via);
  }

  /** A device answered so late that a ping was already outstanding, or never answered at all. The gap
   *  is a measured silence, not a round trip, which is why it is its own series. */
  heartbeatGap(deviceId: string, milliseconds: number): void {
    this.sample("heartbeat_gap_ms", deviceId, milliseconds);
  }

  /** Section 10, the tunnel leg alone: the public round trip minus the loopback round trip, both
   *  timed by this process on the same clock in the same second. This IS a subtraction, and it is the
   *  one section 11 explicitly sanctions and names ("difference is the gateway-side tunnel leg plus
   *  the edge"), because both terms are measurements this gateway took itself. */
  tunnelRtt(milliseconds: number): void {
    this.sample("tunnel_rtt_ms", null, milliseconds);
  }

  /** The tunnel stopped answering. EDGE TRIGGERED: the probe calls this on the transition into an
   *  outage, never once per failing probe, because a state that has not changed is not a state
   *  change and a day of downtime would otherwise bury the transition under 2,880 identical rows. */
  tunnelDown(reason: "timeout" | "bad_gateway" | "unreachable" | "http_error", status?: number): void {
    this.event("tunnel_flap", null, null, {
      reason: codeOf("tunnel_flap", "reason", reason) ?? "other",
      ...(status === undefined ? {} : { status }),
    });
  }

  /** The tunnel answered again. Carries how long it was down, which is the figure an operator
   *  actually wants and the one nothing else in the gateway records. */
  tunnelRecovered(outageMs: number, consecutiveFailures: number): void {
    this.event("tunnel_flap", null, null, {
      reason: "recovered",
      outage_ms: Math.round(outageMs),
      consecutive: consecutiveFailures,
    });
  }

  /** Section 10, gateway handling. Two legs per turn: admission to dispatch, and the peer's terminal
   *  to the app broadcast. Both are gateway-internal time and both land in this series, so its sample
   *  count is per leg rather than per turn. */
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

  /** The peer's socket went away. Drops any outstanding heartbeat stamp, so an ack arriving on the
   *  NEXT connection cannot be differenced against the previous one's send: that would record an
   *  entire disconnect as a round trip, which is a one-way silence reported as a measurement. */
  peerForgotten(agentId: string): void {
    this.#peerHeartbeats.delete(agentId);
  }

  // turn timing

  #turnKey(bot: string, turnId: string): string {
    return `${bot} ${turnId}`;
  }

  /** The turn was admitted: a durable turn row exists and the gateway now owes the peer a command. */
  turnAdmitted(bot: string, turnId: string): void {
    if (!this.#enabled) return;
    remember(this.#turns, this.#turnKey(bot, turnId), { admittedAt: monotonicNow(), deltaFrames: 0 });
  }

  /** The turn command reached the peer's lane. Writes the admission-to-dispatch leg, and starts the
   *  clock for `ttft_ms` and `turn_ms`.
   *
   *  Dispatch rather than admission is the zero for those two ON PURPOSE. A turn for a peer that is
   *  not attached sits in the durable outbox until it comes back, bounded only by the operator's turn
   *  timeout, and timing from admission would report minutes of queueing as time to first token: the
   *  p95 of a gateway with an intermittent peer would be a chart of its own waiting. The queueing is
   *  not lost, it is `gateway_handle_ms`, which is a separate measured series rather than something a
   *  reader has to derive by subtracting two. */
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
    // No dispatch reading means nothing honest to measure from, so no sample. An invented zero
    // would be a derived figure wearing a measurement's clothes.
    if (timing.dispatchedAt === undefined) return;
    this.sample("ttft_ms", bot, timing.firstDeltaAt - timing.dispatchedAt);
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
      if (timing.dispatchedAt !== undefined) this.sample("turn_ms", bot, terminalAt - timing.dispatchedAt);
      this.sample("delta_frames", bot, timing.deltaFrames);
    }
    const reason = codeOf("turn_terminal", "reason", terminal.reason);
    this.event("turn_terminal", bot, turnId, {
      status: codeOf("turn_terminal", "status", terminal.status) ?? "other",
      ...(reason === undefined ? {} : { reason }),
    });
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.gatewayHandle(bot, monotonicNow() - terminalAt);
    };
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

  /** Push relay outcome, written beside the existing `relay_result` trace rather than replacing it:
   *  the trace is a debugging line an operator tails, this is a countable series. The value is 1 for
   *  a delivered push and 0 for anything else, so a success rate is a mean over the base series and
   *  the reason is the tag. */
  pushResult(deviceId: string, result: "ok" | "not_found" | "http_error" | "network_error"): void {
    this.sample("push_result", deviceId, result === "ok" ? 1 : 0, result);
    if (result !== "ok") this.event("push_result", null, deviceId, { result });
  }

  /** Section 11, perceived by the person: the app's own send-tapped to first-delta-rendered
   *  measurement, reported on the delivery receipt. Measured on the PHONE's clock, which is why it is
   *  a separate series from every gateway-side hop and is never added to one. */
  feltLatency(
    bot: string,
    milliseconds: number,
    networkPath?: "wifi" | "cellular" | "vpn_on" | "vpn_off",
  ): void {
    this.sample("felt_latency_ms", bot, milliseconds, networkPath);
  }

  /** Section 12's lifetime counters, outside the ring and never trimmed.
   *
   *  Two guards, because these counters are additive and nothing downstream can correct an inflated
   *  one, and because neither guard alone holds for all time:
   *
   *  1. `snapshotId` is claimed durably in the store's ledger, so a snapshot folded twice, including
   *     across a restart, adds once.
   *  2. A snapshot whose own timestamp is older than the retention window is REFUSED OUTRIGHT. The
   *     ledger is trimmed on the ring's window (it is the one table here that would otherwise grow
   *     forever, one row per snapshot), and trimming a claim would reopen the replay it was
   *     preventing. This closes that: past the window there is no claim to check and nothing to
   *     check it for, because the snapshot is refused on its age instead. A snapshot that old
   *     describes a turn that ended a week ago and is not something any producer still holds.
   *
   *  Returns false for a refusal of either kind, so a caller can tell a replay from an addition. */
  accumulateLifetime(input: {
    snapshotId: string;
    bot: string;
    model: string;
    prompt: number;
    completion: number;
    cached: number;
    costMicros: number;
    turns: number;
    at: number;
  }): boolean {
    if (!this.#enabled) return false;
    if (this.#now() - input.at > this.#retentionDays * 86_400_000) return false;
    return this.#store.accumulateLifetime({
      ...input,
      snapshotId: this.#store.identify(input.snapshotId),
      bot: this.#store.identify(input.bot),
      model: this.#store.identify(input.model),
    });
  }

  /** THE SEAM D5 CALLS. D5's gateway-side store-latest-snapshot code invokes this once per
   *  `observation_snapshot` it accepts; D2 owns the series-write side and nothing else.
   *
   *  IDEMPOTENT PER BOT, TURN AND STEP. D5's harness repeats a step index between an idle tick and a
   *  terminal, and a cumulative snapshot replays the whole turn on every tick, so folding blind would
   *  double count by a factor that grows with the number of ticks. Every record carries the turn it
   *  belongs to and its index within that turn, and a record already folded is skipped. The return
   *  says how many of each it did, so a caller can see a replay rather than guess at one.
   *
   *  Only numeric fields cross, each under a CozyAgents-measured series name, so a Hermes bot that
   *  never sends a snapshot simply has no rows here rather than an inferred one. */
  foldSnapshotIntoSeries(bot: string, snapshot: ObserveSnapshot): { folded: number; skipped: number } {
    if (!this.#enabled) return { folded: 0, skipped: 0 };
    let folded = 0;
    let skipped = 0;
    for (const step of snapshot.steps ?? []) {
      if (!claim(this.#folded, `${bot} ${step.turnId} s${step.step}`)) {
        skipped += 1;
        continue;
      }
      folded += 1;
      if (step.modelStepMs !== undefined) this.sample("model_step_ms", bot, step.modelStepMs);
      if (step.promptTokens !== undefined) this.sample("prompt_tokens", bot, step.promptTokens);
      if (step.completionTokens !== undefined) this.sample("completion_tokens", bot, step.completionTokens);
      if (step.cachedTokens !== undefined) this.sample("cached_tokens", bot, step.cachedTokens);
    }
    for (const call of snapshot.toolCalls ?? []) {
      if (!claim(this.#folded, `${bot} ${call.turnId} t${call.step}.${call.index ?? 0}`)) {
        skipped += 1;
        continue;
      }
      folded += 1;
      this.sample("tool_ms", bot, call.toolMs);
    }
    for (const turn of snapshot.turns ?? []) {
      if (!claim(this.#folded, `${bot} ${turn.turnId} n`)) {
        skipped += 1;
        continue;
      }
      folded += 1;
      this.sample("model_steps", bot, turn.modelSteps);
    }
    return { folded, skipped };
  }

  // retention

  /** The nightly trim. Runs even when the ring is disabled: an operator who turns observability off
   *  should watch the rows it already wrote age out, not keep them forever. */
  trim(nowMs: number = this.#now()): { series: number; events: number; folds: number; complete: boolean } {
    return this.#store.trim(nowMs - this.#retentionDays * 86_400_000);
  }

  // read helpers

  /** p50, p95 and the sample count for one series over one window, for D3 to call. `bot` is a NAME,
   *  hashed here the same way the writer hashed it. */
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
      ...(query.bot === undefined || query.bot === null ? {} : { bot: this.#store.identify(query.bot) }),
      from: query.from,
      to: query.to,
      ...(query.allTags === true ? { includeTags: true } : {}),
    });
  }
}

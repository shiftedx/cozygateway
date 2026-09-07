/** Dashboard packet D3 (capability 75): the observer's read routes, `/observe/api/*`.
 *
 *  Three rules the finished module holds:
 *
 *  1. EVERY ROUTE IS A `GET`. The dashboard is strictly read only, so there is no request shape
 *     here that changes gateway state, and capability 72's one middleware refuses a write for a
 *     read token before any handler runs.
 *  2. NO NAME IS INVENTED AND NO HASH IS REVERSED. The ring is keyed by the store's HMAC identity
 *     hashes and never returns a raw id, so these routes hash the LIVE ROSTER (bots, devices,
 *     runners) and join on the result. A subject that is no longer on the roster reads as
 *     `former bot` or `former device`. The hash itself may travel as an opaque id; the key never
 *     leaves the store.
 *  3. EVERY AGGREGATE CARRIES ITS SAMPLE COUNT (design section 11), and the model-speed figures of
 *     section 12 report the COUNT INSTEAD OF A PERCENTILE below `SPEED_SAMPLE_FLOOR`. */

/** Section 12: "a model with fewer than 20 steps in the window shows the count instead of a
 *  speed". Applied to the model-speed shaped figures only; a hop's round trip still reports its
 *  percentile beside its count, because section 11 asks for the count there rather than silence. */
export const SPEED_SAMPLE_FLOOR = 20;

/** p50, p95 and the number of samples they came from. `p50` and `p95` are null when there is
 *  nothing to compute them from, and when a speed-shaped figure is under the floor: a reader is
 *  never handed a number it would have to know a rule to distrust. */
export interface ObserveAggregate {
  samples: number;
  p50: number | null;
  p95: number | null;
  belowSampleFloor: boolean;
}

// ------------------------------------------------------------------ the D5 seam

/** THE D5 SEAM.
 *
 *  D5 owns the `observation_snapshot` lane, the latest-snapshot store, the per-bot and per-tool
 *  lifetime tables, the operator's price sheet and the cost-per-tool-call attribution. D3 owns the
 *  route surface those panels are served on, and nothing else: these routes call this reader and
 *  serve what it returns, so D5 plugs in by supplying one and changes no route.
 *
 *  With no reader the CozyAgents panels answer `{ available: false, reason: "no_snapshot_lane" }`
 *  rather than 404, so the dashboard renders an empty state instead of treating a gateway with no
 *  CozyAgents peer as an error. */
export interface ObserveSnapshotReader {
  /** Whether a CozyAgents peer is attached and publishing. Gates the CozyAgents tab. */
  attached(): boolean;
  internals(query: { bot?: string; from: number; to: number }): readonly ObserveAgentInternals[];
  throughput(query: { bot?: string; from: number; to: number }): ObserveThroughput;
  toolCosts(query: { bot?: string; from: number; to: number }): ObserveToolCosts;
}

export interface ObserveAgentInternals {
  bot: string;
  runtimeStage: string;
  generationsWanted: number | null;
  generationsObserved: number | null;
  bundleVersion: string | null;
  runnerName: string | null;
  runnerLastContactAt: number | null;
  snapshotAgeMs: number | null;
  toolFamilies: readonly { family: string; calls: number }[];
  toolServers: readonly {
    server: string; layers: number; healthy: number; fingerprint: string | null; state: string;
  }[];
  policy: {
    permitted: number | null; asked: number | null; denied: number | null; expired: number | null; egressRefused: number | null;
    level: string | null;
  };
  context: {
    inUseTokens: number | null; windowTokens: number | null; rollovers: number | null; lastRolloverAt: number | null;
    cardsAttached: number | null; cardsTotal: number | null;
  };
  memory: {
    recallDocs: number | null; recallBytes: number | null; lastConsolidationAt: number | null;
    evicted: number | null; tombstoned: number | null;
  };
  prompt?: Record<string, unknown> | null;
  cache?: Record<string, unknown>;
  recall?: Record<string, unknown> | null;
  guardrails?: Record<string, unknown> | null;
  steps?: readonly import("./snapshot.ts").ObservationSnapshotStepRow[];
  toolCalls?: readonly import("./snapshot.ts").ObservationSnapshotToolRow[];
  checkpoints: { count: number | null; restores: number | null; lastRestoreResult: string | null };
}

/** Section 12. `costMicros` is null until the operator enters a price sheet, which is what makes
 *  the panel say "tokens only" rather than print a zero somebody could mistake for free. */
export interface ObserveThroughput {
  priceSheetConfigured: boolean;
  rows: readonly {
    bot: string;
    model: string;
    prefix?: string;
    speedsByPrefix?: readonly { prefix: string; prefill: ObserveAggregate; decode: ObserveAggregate }[];
    prefill: ObserveAggregate;
    decode: ObserveAggregate;
    tokens: { prompt: number; completion: number; cached: number };
    costMicros: number | null;
    costPerTurn?: ObserveAggregate;
    lifetime: {
      prompt: number; completion: number; cached: number; costMicros: number | null; turns: number;
    };
  }[];
}

/** Section 13. `attributed` says the tokens of a step were split across the calls it made, which is
 *  an attribution rule rather than a measurement and is labelled as one. */
export interface ObserveToolCosts {
  retryDetectionAvailable?: boolean;
  heavyDetectionAvailable?: boolean;
  priceSheetConfigured: boolean;
  rows: readonly {
    tool: string;
    family: string;
    calls: number;
    errors: number;
    medianResultTokens: number | null;
    resultSize?: ObserveAggregate;
    drivingTurns?: readonly { bot: string; turn: string; calls: number; inducedTokens: number | null }[];
    inducedTokens: number | null;
    costMicros: number | null;
    duration: ObserveAggregate;
    flags: readonly string[];
    attributed: boolean;
  }[];
}

/** The reader a gateway with no CozyAgents peer has. Every panel it feeds answers empty, and no
 *  route has to know whether D5 landed. */
export const ABSENT_SNAPSHOT_READER: ObserveSnapshotReader = {
  attached: () => false,
  internals: () => [],
  throughput: () => ({ priceSheetConfigured: false, rows: [] }),
  toolCosts: () => ({ priceSheetConfigured: false, rows: [] }),
};

import { createObserveSnapshotReader, observeReceiptDistributions } from "./reader.ts";
import { Hono } from "hono";
import type { AppDeps } from "../http.ts";
import { isAllowedEventKind, isAllowedSeries, OBSERVE_SERIES_TAGS } from "./privacy.ts";
import type { ObserveSummary } from "./store.ts";

function aggregate(summary: ObserveSummary, speed = false): ObserveAggregate {
  const belowSampleFloor = speed && summary.count < SPEED_SAMPLE_FLOOR;
  return { samples: summary.count, p50: belowSampleFloor ? null : summary.p50 ?? null,
    p95: belowSampleFloor ? null : summary.p95 ?? null, belowSampleFloor };
}

/** Auth is installed by the parent router before this group. Every projection below is explicit:
 * adding a field to a chat, artifact, or runner record never silently exposes it to the dashboard. */
export function observeRoutes(deps: AppDeps & { observe: NonNullable<AppDeps["observe"]> }): Hono {
  const app = new Hono();
  const ring = deps.observe;
  const reader = deps.observeSnapshots ?? createObserveSnapshotReader(deps);
  const startedAt = deps.now();
  const windows = { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 };
  const paths = ["overview", "bots", "turns", "roundtrip", "attach", "approvals", "deliveries",
    "devices", "events", "series", "cozyagents", "cozyagents/spend", "cozyagents/tools"] as const;
  for (const path of paths) app.get(`/observe/api/${path}`, (c) => {
    const window = c.req.query("window") ?? "24h";
    if (!Object.hasOwn(windows, window)) return c.json({ error: { code: "invalid_request", message: "invalid window" } }, 400);
    const now = deps.now();
    const from = now - windows[window as keyof typeof windows];
    const to = now + 1; // Store windows are half-open; include measurements made on this millisecond.
    const bot = c.req.query("bot");
    const query = { from, to, ...(bot === undefined ? {} : { bot: ring.identify(bot) }) };
    const readerQuery = { from, to, ...(bot === undefined ? {} : { bot }) };
    const roster = deps.bots?.roster().bots ?? [];
    const selected = roster.filter((row) => bot === undefined || row.name === bot);
    const names = new Map(roster.map((row) => [ring.identify(row.name), row.name]));
    const summary = (series: string, speed = false, subject: string | null | undefined = query.bot) => aggregate(ring.store.summarize({
      series, from, to, ...(subject === undefined ? {} : { bot: subject }), includeTags: true,
    }), speed);
    const points = (series: string, subject = query.bot) => ring.store.samples({
      series, from, to, ...(subject === undefined ? {} : { bot: subject }), limit: 20_000, includeTags: true,
    });
    const events = (kind?: string, subject: string | null | undefined = query.bot) => ring.store.events({ ...query, bot: subject, ...(kind === undefined ? {} : { kind }), limit: 5_000 })
      .map(({ detailJson, ...row }) => ({ ...row, botName: row.bot === null ? null : names.get(row.bot) ?? "former bot",
        detail: detailJson === null ? null : JSON.parse(detailJson) as Record<string, string | number | boolean> }));
    const pending = deps.bots !== undefined && "pendingApprovals" in deps.bots
      ? deps.bots.pendingApprovals().filter((row) => bot === undefined || row.bot === bot) : [];
    const attach = deps.attachHealth?.() ?? null;
    const terminals = () => events("turn_terminal");
    switch (path) {
      case "series": {
        const base = c.req.query("series") ?? "ttft_ms";
        const tag = c.req.query("tag");
        const series = tag === undefined ? base : `${base}|${tag}`;
        if (!isAllowedSeries(series)) return c.json({ error: { code: "invalid_request", message: "invalid series or tag" } }, 400);
        const samples = points(series);
        const total = ring.store.summarize({ series, ...query, includeTags: true }).count;
        return c.json({ summary: summary(series), points: samples, pointLimit: 20_000,
          view: "bounded_history", totalPoints: total, truncated: total > samples.length });
      }
      case "events": {
        const kind = c.req.query("kind");
        if (kind !== undefined && !isAllowedEventKind(kind)) return c.json({ error: { code: "invalid_request", message: "invalid kind" } }, 400);
        const rows = events(kind);
        const total = ring.store.countEvents({ ...query, ...(kind === undefined ? {} : { kind }) });
        return c.json({ events: rows, limit: 5_000, view: "bounded_history", totalEvents: total, truncated: total > rows.length });
      }
      case "overview": {
        const flaps = events("tunnel_flap", null);
        const repairs = reader.attached() ? reader.internals(readerQuery).reduce((n, row) => n + row.toolServers.filter((server) => server.state === "repair_pending").length, 0) : 0;
        return c.json({ gateway: { name: deps.gatewayInfo.name, version: deps.gatewayInfo.version,
          uptimeMs: Math.max(0, now - startedAt), bridge: deps.hermesBridgeAbsent ? "absent" : deps.bots?.health().online ? "online" : "offline" },
          attach, tunnel: { lastFlapAt: flaps[0]?.at ?? null, state: flaps[0]?.detail?.reason === "recovered" ? "online" : flaps.length ? "offline" : "unknown" },
          needsAPerson: { total: pending.length + repairs, approvals: pending.length, repairs },
          tiles: { firstToken: summary("ttft_ms"), roundTrip: summary("device_rtt_ms", false, null), turns: ring.store.countEvents({ ...query, kind: "turn_terminal" }),
            spend: reader.attached() ? reader.throughput(readerQuery) : null } });
      }
      case "bots": return c.json({ bots: selected.map((row) => {
        const hash = ring.identify(row.name);
        const turns = ring.store.events({ from, to, bot: hash, kind: "turn_terminal", limit: 5_000 });
        return { id: hash, name: row.name, harness: row.runtime === "cozyagents" ? "cozyagents" : "hermes",
          online: deps.presenceOf(row.name) === "online", lastTurnAt: turns[0]?.at ?? null,
          firstToken: summary("ttft_ms", false, hash), sparkline: points("ttft_ms", hash), turns: ring.store.countEvents({ from, to, bot: hash, kind: "turn_terminal" }),
          failures: ring.store.countEvents({ from, to, bot: hash, kind: "turn_terminal", status: "failed" }),
          openApprovals: pending.filter((approval) => approval.bot === row.name).length };
      }) });
      case "turns": {
        const firstTokenByHour = [];
        for (let at = Math.floor(from / 3_600_000) * 3_600_000; at < to; at += 3_600_000) {
          const result = ring.store.summarize({ series: "ttft_ms", from: Math.max(at, from),
            to: Math.min(at + 3_600_000, to), ...(query.bot === undefined ? {} : { bot: query.bot }), includeTags: true });
          if (result.count > 0) firstTokenByHour.push({ at, ...aggregate(result) });
        }
        const total = ring.store.countEvents({ ...query, kind: "turn_terminal" });
        return c.json({ terminals: terminals(), terminalLimit: 5_000, totalTerminals: total,
          view: "bounded_history", truncated: total > 5_000, firstTokenByHour });
      }
      case "roundtrip": return c.json({ byDevice: observeReceiptDistributions(ring, query), vpnComparisonSampleFloor: 30, hops: [
        ["device", "device_rtt_ms"], ["tunnel", "tunnel_rtt_ms"], ["gateway", "gateway_handle_ms"],
        ["peer", "peer_rtt_ms"], ["model", "model_step_ms"], ["turn", "turn_ms"],
      ].map(([hop, series]) => ({ hop, scope: hop === "device" || hop === "tunnel" ? "gateway" : "selected_bots",
        ...(hop === "peer" && bot !== undefined && deps.observeAttachPeers !== undefined
          ? aggregate(ring.store.summarize({ series: series!, from, to, includeTags: true,
            bots: deps.observeAttachPeers().filter(row => row.bot === bot).map(row => ring.identify(row.peerId)) }))
          : summary(series!, false, hop === "device" || hop === "tunnel" ? null : query.bot)) })), felt: summary("felt_latency_ms"),
        byNetworkPath: OBSERVE_SERIES_TAGS.filter((tag) => !["tunnel", "lan", "ok", "not_found", "http_error", "network_error"].includes(tag))
          .map((networkPath) => ({ networkPath, ...summary(`felt_latency_ms|${networkPath}`) })) });
      case "attach": return c.json({ summary: attach,
        peers: (deps.observeAttachPeers?.() ?? selected.map(row => ({ bot: row.name, peerId: row.name,
          online: deps.presenceOf(row.name) === "online" ? 1 : 0 })))
          .filter(row => bot === undefined || row.bot === bot)
          .map(({ peerId, ...row }) => ({ ...row, id: ring.identify(peerId), roundTrip: summary("peer_rtt_ms", false, ring.identify(peerId)) })),
        deadLetters: (deps.attachDeadLetters?.() ?? []).map(row => ({ ...row, agentId: deps.observeBotForPeer?.(row.agentId) ?? row.agentId })).filter((row) => bot === undefined || row.agentId === bot)
          .map((row) => ({ bot: ring.identify(row.agentId), sequence: row.sequence, attempts: row.attempts, at: row.deadLetteredAt })) });
      case "approvals": return c.json({ pending: pending.map((row) => ({ bot: row.bot, id: ring.identify(row.toolCallId), createdAt: row.createdAt })),
        grants: selected.flatMap((row) => deps.storage.approvalGrants(row.name, now).map((grant) => ({ bot: row.name,
          id: ring.identify(grant.grantId), scope: grant.scope, category: grant.category, createdAt: grant.createdAt, expiresAt: grant.expiresAt }))),
        events: [...events("approval_raised"), ...events("approval_resolved")].sort((a, b) => b.at - a.at), view: "bounded_history", eventLimitPerKind: 5_000 });
      case "deliveries": return c.json({ artifacts: deps.storage.artifacts.list(bot === undefined ? {} : { bot })
        .filter((row) => row.createdAt >= from && row.createdAt < to).map((row) => ({ id: ring.identify(row.artifactId), bot: row.bot,
          state: row.state, sizeBytes: row.sizeBytes, createdAt: row.createdAt, committedAt: row.committedAt ?? null })),
        push: summary("push_result", false, null), events: events("push_result", null), pushScope: "gateway" });
      case "devices": return c.json({ devices: deps.storage.listDevices().map((row) => ({ id: ring.identify(row.id), name: row.name,
        kind: row.kind, scope: row.scope, createdAt: row.createdAt, lastSeenAt: row.lastSeenAt })),
        runners: (deps.runners?.list() ?? []).map((row) => ({ id: ring.identify(row.id), name: row.displayName ?? row.name,
          online: deps.runnerPresence?.online(row.id) ?? false, lastContactAt: deps.runnerPresence?.lastContactAt(row.id) ?? row.lastSeenAt })) });
      case "cozyagents": return c.json(reader.attached() ? { available: true, internals: reader.internals(readerQuery),
        model: { stepLatency: summary("model_step_ms", true) } } : { available: false, reason: "no_snapshot_lane" });
      case "cozyagents/spend": {
        if (!reader.attached()) return c.json({ available: false, reason: "no_snapshot_lane" });
        const result = reader.throughput(readerQuery);
        return c.json({ available: true, priceSheet: { configured: result.priceSheetConfigured }, rows: result.rows });
      }
      case "cozyagents/tools": {
        if (!reader.attached()) return c.json({ available: false, reason: "no_snapshot_lane" });
        const result = reader.toolCosts(readerQuery);
        return c.json({ available: true, priceSheet: { configured: result.priceSheetConfigured }, retryDetectionAvailable: result.retryDetectionAvailable ?? false, heavyDetectionAvailable: result.heavyDetectionAvailable ?? false, rows: result.rows });
      }
    }
  });
  return app;
}

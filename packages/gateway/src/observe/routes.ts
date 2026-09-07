/** Dashboard packet D3 (capability 75): the observer's read routes, `/observe/api/*`.
 *
 *  STATUS: the wire types and the D5 seam are declared; the route group itself is not implemented
 *  yet (see `packages/gateway/test/observe-routes.test.ts`, which is the failing specification).
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
  generationsWanted: number;
  generationsObserved: number;
  bundleVersion: string | null;
  runnerName: string | null;
  runnerLastContactAt: number | null;
  snapshotAgeMs: number | null;
  toolFamilies: readonly { family: string; calls: number }[];
  toolServers: readonly {
    server: string; layers: number; healthy: number; fingerprint: string; state: string;
  }[];
  policy: {
    permitted: number; asked: number; denied: number; expired: number; egressRefused: number;
    level: string;
  };
  context: {
    inUseTokens: number; windowTokens: number; rollovers: number; lastRolloverAt: number | null;
    cardsAttached: number; cardsTotal: number;
  };
  memory: {
    recallDocs: number; recallBytes: number; lastConsolidationAt: number | null;
    evicted: number; tombstoned: number;
  };
  checkpoints: { count: number; restores: number; lastRestoreResult: string | null };
}

/** Section 12. `costMicros` is null until the operator enters a price sheet, which is what makes
 *  the panel say "tokens only" rather than print a zero somebody could mistake for free. */
export interface ObserveThroughput {
  priceSheetConfigured: boolean;
  rows: readonly {
    bot: string;
    model: string;
    prefill: ObserveAggregate;
    decode: ObserveAggregate;
    tokens: { prompt: number; completion: number; cached: number };
    costMicros: number | null;
    lifetime: {
      prompt: number; completion: number; cached: number; costMicros: number | null; turns: number;
    };
  }[];
}

/** Section 13. `attributed` says the tokens of a step were split across the calls it made, which is
 *  an attribution rule rather than a measurement and is labelled as one. */
export interface ObserveToolCosts {
  priceSheetConfigured: boolean;
  rows: readonly {
    tool: string;
    family: string;
    calls: number;
    errors: number;
    medianResultTokens: number | null;
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

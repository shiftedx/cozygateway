/** The observation ring (packet D2 of the observability dashboard).
 *
 *  Everything the gateway already measures once per turn, per heartbeat and per sweep, kept for
 *  seven days in two capped SQLite tables so the dashboard has something to chart. Off by default:
 *  `observability.enabled` in the gateway config turns it on, and with it off every writer returns
 *  before it touches the database.
 *
 *  Three rules run through the whole module and are worth stating once here:
 *
 *  1. One clock. Every duration is a difference of two `monotonicNow()` readings taken by this
 *     process. Wall time places a row on a calendar and is never subtracted from another.
 *  2. Measured, not derived. A hop the gateway cannot time is absent rather than inferred and
 *     stored beside the ones it did time. The single sanctioned subtraction is the tunnel leg,
 *     where both terms are this process's own measurements seconds apart.
 *  3. Counts travel with aggregates. `summarize` always returns the sample count beside p50 and
 *     p95, because a p95 over four samples is not a p95. */
export { ObserveStore, type ObserveSummary, type ObserveSeriesRow, type ObserveEventRow } from "./store.ts";
export {
  ObservationRing,
  monotonicNow,
  OBSERVABILITY_DEFAULT_RETENTION_DAYS,
  type ObservabilityOptions,
  type ObserveSnapshot,
  type ObserveSnapshotStep,
  type ObserveSnapshotToolCall,
} from "./ring.ts";
export { TunnelSelfProbe, TUNNEL_PROBE_INTERVAL_MS, TUNNEL_PROBE_TIMEOUT_MS } from "./self-probe.ts";
export {
  OBSERVE_SERIES,
  OBSERVE_EVENT_KINDS,
  OBSERVE_SERIES_TAGS,
  OBSERVE_IDENTITY_LENGTH,
  OBSERVE_MAX_DETAIL_BYTES,
  OBSERVE_EVENT_DETAIL,
  OBSERVE_OTHER_CODE,
  GATEWAY_MEASURED_SERIES,
  identityHash,
  isIdentityHash,
  isAllowedSeries,
  isAllowedEventKind,
  isStorableValue,
  serializeDetail,
  seriesName,
  parseSeriesName,
  codeOf,
  type ObserveDetail,
  type ObserveSeries,
  type ObserveSeriesTag,
  type ObserveEventKind,
} from "./privacy.ts";
export {
  OBSERVATION_SNAPSHOT_LANE_SCHEMA,
  OBSERVATION_SNAPSHOT_AGGREGATE_SCHEMA,
  OBSERVATION_SNAPSHOT_DASHBOARD_SCHEMA,
  OBSERVATION_SNAPSHOT_CAPABILITY,
  OBSERVATION_SNAPSHOT_FRAME_KIND,
  OBSERVATION_SNAPSHOT_MAX_BYTES,
  OBSERVATION_SNAPSHOT_BOUNDS,
  validateObservationSnapshotPayload,
  type ObservationSnapshotPayload,
  type ObservationSnapshotStepRow,
  type ObservationSnapshotToolRow,
} from "./snapshot.ts";
export {
  OBSERVE_DEFAULT_PRICES,
  priceOf as observeModelPrice,
  costMicros as observeCostMicros,
  type ObserveModelPrice,
  type ObservePriceSheet,
} from "./prices.ts";

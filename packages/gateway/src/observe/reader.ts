import type { AppDeps } from "../http.ts";
import { SPEED_SAMPLE_FLOOR, type ObserveAggregate } from "./routes.ts";

type Query = { bot?: string; from: number; to: number };

export function observationAggregate(values: readonly number[], speed = false): ObserveAggregate {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const belowSampleFloor = speed && sorted.length < SPEED_SAMPLE_FLOOR;
  const percentile = (fraction: number) => sorted.length === 0 || belowSampleFloor ? null : sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return { samples: sorted.length, p50: percentile(.5), p95: percentile(.95), belowSampleFloor };
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

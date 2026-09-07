/** The privacy rule for the observation ring, enforced at the writer.
 *
 *  Section 3 of the observability design: "no message text, no transcript, no url, path, query or
 *  body, no token. Tool names, reason codes, hashes, counts and durations only." This module is the
 *  single place that decides what may enter a row, and `store.ts` refuses anything it rejects, so
 *  no call site can opt out of the rule by forgetting it.
 *
 *  IT IS AN ALLOWLIST, WITH NO FREE STRING ANYWHERE. Every column is one of exactly four things:
 *
 *  - a name from a closed enum declared in this file (`series`, `kind`, a series tag),
 *  - a 16 hex character keyed identity hash (`bot`, `ref`), never the id itself,
 *  - a number, or
 *  - inside `detail_json`, a number, a boolean, a hash, or a code from THAT FIELD'S OWN closed set,
 *    under a per-kind schema that refuses an unknown key outright.
 *
 *  An earlier draft policed strings by shape and by a list of known credential prefixes. That is a
 *  blacklist however it is described: it admitted an unrecognised 32 character key, an opaque
 *  `scheme:env:secret` id, and a sentence with its spaces removed, because none of them looked like
 *  anything anybody had thought of. There is no shape test that separates a person's words from a
 *  reason code, so this file stops trying: a caller that wants an identifier in a row hands it to
 *  `identityHash` and stores the hash, and a caller that wants a word declares it in an enum here.
 */

import { createHmac } from "node:crypto";

/** Every series this gateway may write. A name absent here is refused rather than stored, so a typo
 *  shows up as a missing chart instead of an unqueryable row nobody notices. */
export const OBSERVE_SERIES = [
  // Section 10, the round trip per hop. Each of these is a MEASURED round trip on one clock.
  "device_rtt_ms",
  "tunnel_rtt_ms",
  "gateway_handle_ms",
  "peer_rtt_ms",
  "ttft_ms",
  "turn_ms",
  "delta_frames",
  "heartbeat_gap_ms",
  // Gateway wide, sampled on the observation sweep.
  "attach_online",
  "queue_depth",
  "dead_letters",
  "outbox_depth",
  "push_result",
  // Section 11, reported by the app on the delivery receipt it already sends.
  "felt_latency_ms",
  "edge_rtt_ms",
  // Section 3 and 12, folded in from the CozyAgents snapshot lane by D5. The gateway never measures
  // these itself and never infers them.
  "model_step_ms",
  "model_steps",
  "tool_ms",
  "prefill_tokens_per_second",
  "decode_tokens_per_second",
  "induced_tokens",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
] as const;
export type ObserveSeries = (typeof OBSERVE_SERIES)[number];

/** Series the gateway measures itself. Anything outside this set arrives from a peer's own clock or
 *  from a snapshot, which is why the dashboard draws it differently. */
export const GATEWAY_MEASURED_SERIES = new Set<string>([
  "device_rtt_ms", "tunnel_rtt_ms", "gateway_handle_ms", "peer_rtt_ms",
  "ttft_ms", "turn_ms", "delta_frames", "heartbeat_gap_ms",
  "attach_online", "queue_depth", "dead_letters", "outbox_depth", "push_result",
]);

/** Every event kind this gateway may write, from section 3's list plus section 10's tunnel flap. */
export const OBSERVE_EVENT_KINDS = [
  "turn_terminal",
  "approval_raised",
  "approval_resolved",
  "repair_proposed",
  "runtime_stage",
  "runner_contact_lost",
  "runner_contact_regained",
  "device_paired",
  "device_revoked",
  "dead_letter",
  "tunnel_flap",
  "maintenance_operation",
  "push_result",
] as const;
export type ObserveEventKind = (typeof OBSERVE_EVENT_KINDS)[number];

/** The only qualifiers a series name may carry after the bar. A tag is a closed enum, never a free
 *  string, because the series column is the one place a caller could otherwise smuggle text past
 *  the identity rule by pretending it is a name. */
export const OBSERVE_SERIES_TAGS = [
  // Section 10, the origin of a device websocket as the gateway saw it.
  "tunnel", "lan",
  // Section 11, the network path the app reports for itself.
  "wifi", "cellular", "wired", "other",
  "wifi_vpn", "cellular_vpn", "wired_vpn", "other_vpn",
  // Push relay outcomes, mirroring the existing relay_result trace vocabulary.
  "ok", "not_found", "http_error", "network_error",
] as const;
export type ObserveSeriesTag = (typeof OBSERVE_SERIES_TAGS)[number];

const SERIES = new Set<string>(OBSERVE_SERIES);
const EVENT_KINDS = new Set<string>(OBSERVE_EVENT_KINDS);
const TAGS = new Set<string>(OBSERVE_SERIES_TAGS);

/** `observe_series` carries four columns and no fifth for a label, so a qualified sample encodes its
 *  tag in the name: `device_rtt_ms|tunnel`. D3 reads one tag with an equality match and both with a
 *  prefix match, and either is an indexed scan on `(series, bot, at)`. */
export function seriesName(base: ObserveSeries, tag?: ObserveSeriesTag): string {
  return tag === undefined ? base : `${base}|${tag}`;
}

export function parseSeriesName(name: string): { base: string; tag: string | undefined } {
  const bar = name.indexOf("|");
  return bar === -1
    ? { base: name, tag: undefined }
    : { base: name.slice(0, bar), tag: name.slice(bar + 1) };
}

export function isAllowedSeries(name: string): boolean {
  const { base, tag } = parseSeriesName(name);
  if (!SERIES.has(base)) return false;
  return tag === undefined || TAGS.has(tag);
}

export function isAllowedEventKind(kind: string): boolean {
  return EVENT_KINDS.has(kind);
}

// ---------------------------------------------------------------- identity

/** The width of an identity hash in the ring. Sixteen hex characters is what `trace.ts` already
 *  uses for the same job, so an operator reading a trace line and a chart is looking at the same
 *  value for the same bot. */
export const OBSERVE_IDENTITY_LENGTH = 16;

const IDENTITY_SHAPE = /^[0-9a-f]{16}$/;

/** True only for a value produced by `identityHash`. This is the WHOLE alphabet the `bot` and `ref`
 *  columns accept, which is what makes the rule an allowlist: there is no string a caller can
 *  invent that lands in either column, only a hash of one. */
export function isIdentityHash(value: string): boolean {
  return IDENTITY_SHAPE.test(value);
}

/** A stable, keyed hash of an identifier.
 *
 *  Keyed rather than a bare digest because bot names and device names are low entropy: a plain
 *  SHA-256 of "luna" is the same everywhere and reverses with a word list. The key is per gateway
 *  and lives in its database (see `ObserveStore`), so the same bot hashes to the same value across
 *  restarts and to a different value on somebody else's gateway.
 *
 *  Stable is the whole requirement section 11 has of an identity here: the VPN comparison needs to
 *  group two distributions by the same device, not to name it. Rendering a name beside a chart is
 *  D3's job, and D3 has the roster: it hashes the names it already knows and joins on the result. */
export function identityHash(key: string, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex").slice(0, OBSERVE_IDENTITY_LENGTH);
}

// ---------------------------------------------------------------- detail schemas

/** What one field of one event kind may hold.
 *
 *  `count` a finite number, `flag` a boolean, `hash` an identity hash, or a closed set of codes.
 *  There is no "string" here on purpose: a field that could hold an arbitrary word is a field a
 *  message could be written into. */
export type DetailFieldSpec =
  | { kind: "count" }
  | { kind: "flag" }
  | { kind: "hash" }
  | { kind: "code"; values: readonly string[] };

const count = { kind: "count" } as const;
const hash = { kind: "hash" } as const;
const code = (...values: readonly string[]): DetailFieldSpec => ({ kind: "code", values });

/** The code every closed set carries so an unfamiliar value from a peer becomes a countable
 *  "something else" rather than a refused event or a stored free string. */
export const OBSERVE_OTHER_CODE = "other";

function withOther(...values: readonly string[]): DetailFieldSpec {
  return code(...values, OBSERVE_OTHER_CODE);
}

/** One closed schema per event kind. An unknown key is refused, not dropped: a caller writing a
 *  field nobody declared has misunderstood what this table is for, and finding that out is worth
 *  more than the row. */
export const OBSERVE_EVENT_DETAIL: Record<ObserveEventKind, Record<string, DetailFieldSpec>> = {
  turn_terminal: {
    status: withOther("completed", "failed", "interrupted", "timed_out"),
    reason: withOther("complete", "failed", "interrupted", "timed_out", "cancelled", "verification_unavailable", "detached", "undeclared", "unknown_turn"),
  },
  approval_raised: { grant: hash },
  approval_resolved: { grant: hash, decision: withOther("approved", "denied", "expired") },
  repair_proposed: { attempts: count },
  runtime_stage: { stage: withOther(
    "waiting_for_runner", "waiting_for_capacity", "pulling_image", "creating", "starting",
    "ready", "draining", "stopping", "stopped", "recovering", "upgrading", "deleting",
    "deleted", "needs_attention",
  ) },
  runner_contact_lost: { gap_ms: count },
  runner_contact_regained: { gap_ms: count },
  device_paired: {},
  device_revoked: {},
  dead_letter: { sequence: count, attempts: count },
  tunnel_flap: {
    reason: withOther("timeout", "bad_gateway", "unreachable", "http_error", "recovered"),
    status: count,
    consecutive: count,
    outage_ms: count,
  },
  maintenance_operation: { outcome: withOther("ok", "failed", "skipped") },
  push_result: { result: withOther("ok", "not_found", "http_error", "network_error") },
};

/** Bounded so one malformed detail object cannot turn the ring into a text store. The per-kind
 *  schemas already bound it much more tightly; this is the backstop. */
export const OBSERVE_MAX_DETAIL_BYTES = 512;

export type ObserveDetail = Record<string, number | boolean | string>;

/** A finite, in range number. `NaN` and `Infinity` would poison every percentile computed over the
 *  series they landed in, and a stored `NaN` is unreadable rather than merely wrong. */
export function isStorableValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15;
}

/** Serializes a detail object against its kind's schema, or returns undefined when any part of it
 *  fails.
 *
 *  Undefined rather than a thrown error and rather than a scrubbed copy: a partially redacted row
 *  invites a reader to trust the fields that survived, and the ring is worth less than the promise
 *  that nothing in it is a person's words. */
export function serializeDetail(kind: string, detail: ObserveDetail | undefined): string | null | undefined {
  if (detail === undefined) return null;
  const schema = OBSERVE_EVENT_DETAIL[kind as ObserveEventKind];
  if (schema === undefined) return undefined;
  for (const [key, value] of Object.entries(detail)) {
    const spec = schema[key];
    if (spec === undefined) return undefined;
    switch (spec.kind) {
      case "count":
        if (!isStorableValue(value)) return undefined;
        break;
      case "flag":
        if (typeof value !== "boolean") return undefined;
        break;
      case "hash":
        if (typeof value !== "string" || !isIdentityHash(value)) return undefined;
        break;
      case "code":
        if (typeof value !== "string" || !spec.values.includes(value)) return undefined;
        break;
    }
  }
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, "utf8") > OBSERVE_MAX_DETAIL_BYTES) return undefined;
  return json;
}

/** Maps a value a peer supplied onto one of a field's declared codes, or onto `other`.
 *
 *  Callers use this so a new terminal cause from a plugin becomes a countable `other` rather than a
 *  refused event; the store still enforces the set, so a caller that skips this is refused. */
export function codeOf(kind: ObserveEventKind, field: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const spec = OBSERVE_EVENT_DETAIL[kind]?.[field];
  if (spec === undefined || spec.kind !== "code") return undefined;
  return spec.values.includes(value) ? value : OBSERVE_OTHER_CODE;
}

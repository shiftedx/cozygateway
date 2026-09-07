/** The privacy rule for the observation ring, enforced at the writer.
 *
 *  Section 3 of the observability design: "no message text, no transcript, no url, path, query or
 *  body, no token. Tool names, reason codes, hashes, counts and durations only." This module is
 *  the single place that decides what "id shaped" means, and `store.ts` refuses any row a value
 *  here rejects, so no call site can opt out of the rule by forgetting it.
 *
 *  The rule is deliberately a whitelist of shapes rather than a blacklist of secrets: a blacklist
 *  only catches the leaks somebody already thought of. */

/** Every series this gateway may write. A name absent here is refused rather than stored, so a
 *  typo shows up as a missing chart instead of an unqueryable row nobody notices. */
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
  // Section 3 and 12, folded in from the CozyAgents snapshot lane by D5. The gateway never
  // measures these itself and never infers them.
  "model_step_ms",
  "model_steps",
  "tool_ms",
  "prompt_tokens",
  "completion_tokens",
  "cached_tokens",
] as const;
export type ObserveSeries = (typeof OBSERVE_SERIES)[number];

/** Series the gateway measures itself. Anything outside this set arrives from a peer's own clock
 *  or from a snapshot, which is why the dashboard draws it differently. */
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

/** The only qualifiers a series name may carry after the `|`. A tag is a closed enum, never a free
 *  string, because the series column is the one place a caller could otherwise smuggle text past
 *  the id shape rule by pretending it is a name. */
export const OBSERVE_SERIES_TAGS = [
  // Section 10, the origin of a device websocket as the gateway saw it.
  "tunnel", "lan",
  // Section 11, the network path the app reports for itself.
  "wifi", "cellular", "vpn_on", "vpn_off",
  // Push relay outcomes, mirroring the existing relay_result trace vocabulary.
  "ok", "not_found", "http_error", "network_error",
] as const;
export type ObserveSeriesTag = (typeof OBSERVE_SERIES_TAGS)[number];

const SERIES = new Set<string>(OBSERVE_SERIES);
const EVENT_KINDS = new Set<string>(OBSERVE_EVENT_KINDS);
const TAGS = new Set<string>(OBSERVE_SERIES_TAGS);

/** `observe_series` carries four columns and no fifth for a label, so a qualified sample encodes
 *  its tag in the name: `device_rtt_ms|tunnel`. D3 reads one tag with an equality match and both
 *  with a prefix match, and either is an indexed scan on `(series, bot, at)`. */
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

/** The longest identifier the ring will store. A UUID is 36 and a bot id is capped at 48 by
 *  config, so 48 admits every id this gateway mints and excludes a 64 character token hash, a
 *  bearer token and every sentence a person could type. */
export const OBSERVE_MAX_ID_LENGTH = 48;

/** Bounded so one malformed detail object cannot turn the ring into a text store. */
export const OBSERVE_MAX_DETAIL_BYTES = 512;
export const OBSERVE_MAX_DETAIL_KEYS = 12;

const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const URI_SCHEME = /^(?:https?|wss?|ftp|file|data|mailto|blob|ssh|smb):/i;
/** Prefixes that announce a credential. Length alone already excludes most of them; this is the
 *  belt to that pair of braces. */
const TOKEN_SHAPE = /^(?:sk-|pk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abposr]-|eyJ|Bearer|Basic|AKIA|ASIA|glpat-|hf_|nvapi-|cg_)/i;

/** True when a string is safe to store in `bot`, `ref`, or a `detail_json` value.
 *
 *  An id has no spaces, no slashes, no query separators and no scheme, which is exactly what
 *  disqualifies a URL, a filesystem path, a query string, a request body and a sentence of a
 *  person's message. The character class is the rule; the explicit checks below only name the
 *  cases a reader would otherwise have to derive from it. */
export function isIdLike(value: string): boolean {
  if (value.length === 0 || value.length > OBSERVE_MAX_ID_LENGTH) return false;
  if (!ID_SHAPE.test(value)) return false;
  if (value.includes("://") || URI_SCHEME.test(value)) return false;
  if (value.includes("..")) return false;
  if (TOKEN_SHAPE.test(value)) return false;
  return true;
}

/** A finite, in range number. `NaN` and `Infinity` would poison every percentile computed over the
 *  series they landed in, and a stored `NaN` is unreadable rather than merely wrong. */
export function isStorableValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) < 1e15;
}

export type ObserveDetail = Record<string, number | boolean | string | null>;

/** Serializes a detail object, or returns undefined when any part of it fails the rule.
 *
 *  Undefined rather than a thrown error and rather than a scrubbed copy: a partially redacted row
 *  invites a reader to trust the fields that survived, and the ring is worth less than the promise
 *  that nothing in it is a person's words. */
export function serializeDetail(detail: ObserveDetail | undefined): string | null | undefined {
  if (detail === undefined) return null;
  const keys = Object.keys(detail);
  if (keys.length > OBSERVE_MAX_DETAIL_KEYS) return undefined;
  for (const key of keys) {
    if (!isIdLike(key)) return undefined;
    const value = detail[key];
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!isStorableValue(value)) return undefined;
      continue;
    }
    if (typeof value === "string") {
      if (!isIdLike(value)) return undefined;
      continue;
    }
    return undefined;
  }
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json, "utf8") > OBSERVE_MAX_DETAIL_BYTES) return undefined;
  return json;
}

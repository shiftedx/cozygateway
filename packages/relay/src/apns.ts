import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";

import { PUSH_CATEGORIES } from "./categories.ts";
import type { PushDeliveryOptions, Transport } from "./transports.ts";

/** The content-free alert used when no category applies (today's message push, unchanged). */
const DEFAULT_ALERT = { title: "CozyChat", body: "New message" } as const;

/** APNs provider config. The .p8 key is PEM (PKCS8) contents; env plumbing reads it from a file. */
export interface ApnsConfig {
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app bundle id, e.g. com.cozylabs.cozychat. */
  topic: string;
  environment: "development" | "production";
}

export interface ApnsTransportOptions {
  /** Override the APNs origin (test seam; default derives from `environment`). */
  baseUrl?: string;
  now?: () => number;
  /** Per-push deadline in ms (default {@link APNS_DELIVERY_TIMEOUT_MS}). */
  deliveryTimeoutMs?: number;
  /** Open the HTTP/2 session (test seam; defaults to node:http2 connect). */
  connect?: (url: string) => ClientHttp2Session;
}

/** Per-push deadline. A connected-but-silent APNs session would otherwise leave deliver() pending
 *  forever and wedge whatever awaits it. APNs answers in well under a second in normal operation,
 *  so ten seconds is generous headroom and still an operator-sane bound: a push that has not been
 *  acknowledged in ten seconds is not going to be. */
export const APNS_DELIVERY_TIMEOUT_MS = 10_000;

const APNS_HOSTS: Record<ApnsConfig["environment"], string> = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** APNs rejects a provider token older than 60 minutes; refresh comfortably before that. */
const JWT_REFRESH_MS = 50 * 60 * 1000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Build an ES256 provider JWT: header { alg: "ES256", kid }, claims { iss: teamId, iat }. The EC
 *  P-256 signature MUST be raw R||S (JOSE / ieee-p1363), not the DER form node emits by default. */
export function buildProviderJwt(config: ApnsConfig, iatSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: iatSeconds }));
  const signingInput = `${header}.${claims}`;
  const key = createPrivateKey(config.keyP8);
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** A first-class APNs delivery transport. Token-based auth (ES256 provider JWT, cached and
 *  refreshed). The relay never decrypts: the opaque ciphertext rides under the top-level custom
 *  key "c" (the iOS Notification Service Extension reads exactly payload["c"]). Uses node:http2
 *  (stdlib) because APNs requires HTTP/2 and the relay stays dependency-free.
 *
 *  SESSION LIFECYCLE (deliberate choice): one fresh HTTP/2 session per push, always explicitly
 *  closed on every exit path (success, non-2xx, stream error, session error, timeout). The issue
 *  floated a small session cache for connection reuse; we did not take it. A cached session is
 *  shared mutable state whose failure modes are exactly the class of bug this change exists to
 *  close: a half-open session that looks alive, accepts a stream, and never answers. Correctly
 *  cached sessions need GOAWAY handling, error eviction, idle expiry, and in-flight-request
 *  draining, and the win they buy is one TLS handshake on a relay whose push volume is nowhere
 *  near the rate where that matters. Revisit only with a measured handshake cost that justifies
 *  the state; until then a push either completes or tears its own connection down with it. */
export function apnsTransport(config: ApnsConfig, options: ApnsTransportOptions = {}): Transport {
  const baseUrl = options.baseUrl ?? APNS_HOSTS[config.environment];
  const now = options.now ?? Date.now;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? APNS_DELIVERY_TIMEOUT_MS;
  const connect = options.connect ?? http2Connect;
  let cached: { token: string; mintedAt: number } | undefined;

  const providerJwt = (): string => {
    const t = now();
    if (cached === undefined || t - cached.mintedAt >= JWT_REFRESH_MS) {
      cached = { token: buildProviderJwt(config, Math.floor(t / 1000)), mintedAt: t };
    }
    return cached.token;
  };

  return {
    deliver(token: string, ciphertext: string, push?: PushDeliveryOptions): Promise<void> {
      // The category shapes the ENVELOPE only: which actionable category the app renders its
      // Approve/Deny buttons for, and the fallback alert shown if the Notification Service
      // Extension cannot run. The relay never reads the ciphertext, so the alert it builds is
      // a fixed, content-free string per category; the NSE decrypts and rewrites it on device.
      const spec = push?.category === undefined ? undefined : PUSH_CATEGORIES[push.category];
      const alert = spec?.alert ?? DEFAULT_ALERT;
      const body = push?.liveActivity === undefined ? JSON.stringify({
        aps: {
          alert: { title: alert.title, body: alert.body },
          "mutable-content": 1,
          ...(spec === undefined ? {} : { category: spec.id }),
        },
        c: ciphertext,
      }) : JSON.stringify({
        aps: {
          timestamp: push.liveActivity.timestamp,
          event: push.liveActivity.event,
          "content-state": push.liveActivity.contentState,
          ...(push.liveActivity.staleDate === undefined ? {} : { "stale-date": push.liveActivity.staleDate }),
          ...(push.liveActivity.dismissalDate === undefined
            ? {}
            : { "dismissal-date": push.liveActivity.dismissalDate }),
        },
      });
      return new Promise<void>((resolve, reject) => {
        let session: ClientHttp2Session;
        try {
          session = connect(baseUrl);
        } catch (err) {
          reject(toError(err));
          return;
        }
        // Every exit path funnels through settle(): the session is closed exactly once, and the
        // first signal wins so a late error cannot re-settle an already-decided delivery.
        let settled = false;
        const settle = (err?: Error): void => {
          if (settled) return;
          settled = true;
          try {
            session.close();
          } catch {
            // Already torn down by node; the delivery outcome below still stands.
          }
          if (err === undefined) resolve();
          else reject(err);
        };
        session.on("error", (err) => settle(toError(err)));
        const req = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${providerJwt()}`,
          "apns-topic": push?.liveActivity === undefined
            ? config.topic
            : `${config.topic}.push-type.liveactivity`,
          "apns-push-type": push?.liveActivity === undefined ? (spec?.pushType ?? "alert") : "liveactivity",
          "apns-priority": String(push?.liveActivity?.priority ?? 10),
          "content-type": "application/json",
          // Coalescing: a later push with the same collapse id REPLACES the delivered one on
          // device. Approvals pass the toolCallId; bot messages pass a bot/chat digest so a burst
          // from one canonical conversation coalesces.
          ...(push?.collapseId === undefined ? {} : { "apns-collapse-id": push.collapseId }),
        });
        let status = 0;
        let responseBody = "";
        req.setEncoding("utf8");
        req.setTimeout(deliveryTimeoutMs, () => {
          req.destroy();
          settle(new Error(`apns delivery timed out after ${deliveryTimeoutMs}ms`));
        });
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => {
          responseBody += chunk;
        });
        req.on("end", () => {
          if (status >= 200 && status < 300) settle();
          else settle(new Error(`apns delivery failed: HTTP ${status} ${responseBody}`.trim()));
        });
        req.on("error", (err) => settle(toError(err)));
        req.write(body);
        req.end();
      });
    },
  };
}

/** Read APNs config from the environment, or undefined when unconfigured (relay runs webhook-only).
 *  All five vars are required together; a partial set is a startup error. `readFile` is injected so
 *  the .p8 file read stays testable. */
export function apnsConfigFromEnv(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ApnsConfig | undefined {
  const p8Path = env["APNS_KEY_P8_PATH"];
  const keyId = env["APNS_KEY_ID"];
  const teamId = env["APNS_TEAM_ID"];
  const topic = env["APNS_TOPIC"];
  const environment = env["APNS_ENVIRONMENT"];
  if (!p8Path && !keyId && !teamId && !topic && !environment) return undefined;
  if (!p8Path || !keyId || !teamId || !topic || !environment) {
    throw new Error(
      "APNs config incomplete: set APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC, and APNS_ENVIRONMENT together (or none)",
    );
  }
  if (environment !== "development" && environment !== "production") {
    throw new Error(`invalid APNS_ENVIRONMENT "${environment}" (expected development or production)`);
  }
  const keyP8 = readFile(p8Path);
  // Startup probe (secure-by-default operator posture). Without it a present-but-malformed .p8
  // validates lazily at the first JWT mint: the relay starts green and then rejects every single
  // push with a log line nobody is watching. This fires ONLY when a key is present, so an absent
  // key (APNs off) still starts green exactly as before.
  try {
    createPrivateKey(keyP8);
  } catch (err) {
    throw new Error(
      `APNS_KEY_P8_PATH ${p8Path} is not a usable PKCS8 private key: ${toError(err).message}`,
    );
  }
  return { keyP8, keyId, teamId, topic, environment };
}

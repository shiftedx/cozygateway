import { connect as http2Connect, type ClientHttp2Session } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";

import type { Transport } from "./transports.ts";

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
}

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

/** A first-class APNs delivery transport. Token-based auth (ES256 provider JWT, cached and
 *  refreshed). The relay never decrypts: the opaque ciphertext rides under the top-level custom
 *  key "c" (the iOS Notification Service Extension reads exactly payload["c"]). Uses node:http2
 *  (stdlib) because APNs requires HTTP/2 and the relay stays dependency-free. */
export function apnsTransport(config: ApnsConfig, options: ApnsTransportOptions = {}): Transport {
  const baseUrl = options.baseUrl ?? APNS_HOSTS[config.environment];
  const now = options.now ?? Date.now;
  let cached: { token: string; mintedAt: number } | undefined;

  const providerJwt = (): string => {
    const t = now();
    if (cached === undefined || t - cached.mintedAt >= JWT_REFRESH_MS) {
      cached = { token: buildProviderJwt(config, Math.floor(t / 1000)), mintedAt: t };
    }
    return cached.token;
  };

  return {
    deliver(token: string, ciphertext: string): Promise<void> {
      const body = JSON.stringify({
        aps: { alert: { title: "CozyChat", body: "New message" }, "mutable-content": 1 },
        c: ciphertext,
      });
      return new Promise<void>((resolve, reject) => {
        let session: ClientHttp2Session;
        try {
          session = http2Connect(baseUrl);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        session.on("error", (err) => reject(err));
        const req = session.request({
          ":method": "POST",
          ":path": `/3/device/${token}`,
          authorization: `bearer ${providerJwt()}`,
          "apns-topic": config.topic,
          "apns-push-type": "alert",
          "content-type": "application/json",
        });
        let status = 0;
        let responseBody = "";
        req.setEncoding("utf8");
        req.on("response", (headers) => {
          status = Number(headers[":status"]) || 0;
        });
        req.on("data", (chunk) => {
          responseBody += chunk;
        });
        req.on("end", () => {
          session.close();
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`apns delivery failed: HTTP ${status} ${responseBody}`.trim()));
        });
        req.on("error", (err) => {
          session.close();
          reject(err);
        });
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
  return { keyP8: readFile(p8Path), keyId, teamId, topic, environment };
}

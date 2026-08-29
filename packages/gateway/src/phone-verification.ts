import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { SETUP_CODE_TTL_MS } from "./auth.ts";
import {
  PHONE_VERIFICATION_HEADERS,
  PHONE_VERIFICATION_PAGE,
} from "./phone-verification-page.ts";
import type { OnboardingMode, Storage } from "./storage.ts";
import {
  PRE_UPGRADE_AUTH_TIMEOUT_MS,
  preUpgradeAuthRemainingMs,
  type UpgradeHandler,
} from "./upgrade-dispatcher.ts";

export const PHONE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PHONE_CONFIRM_MAX_BYTES = 256;
export const PHONE_PROBE_MAX_BYTES = 256;
export const PHONE_MAX_SOCKETS = 4;
export const PHONE_AUTH_TIMEOUT_MS = PRE_UPGRADE_AUTH_TIMEOUT_MS;
export const PHONE_SOCKET_LIFETIME_MS = 60_000;
export const PHONE_CONFIRM_ATTEMPTS_PER_MINUTE = 5;
export const PHONE_GLOBAL_CONFIRMS_PER_MINUTE = 60;
const PROCESS_CONFIRM_ATTEMPTS: number[] = [];

export interface PhoneVerificationContext {
  canonicalOrigin: string;
  durableFingerprint: string;
  verificationEpoch: string;
  bootGeneration: string;
}

export interface PhoneVerificationChallenge {
  challengeId: string;
  sessionId: string;
  verificationUrl: string;
  phrase: string;
  expiresAt: number;
}

interface ChallengeRecord extends Omit<PhoneVerificationChallenge, "verificationUrl"> {
  capabilityHash: string;
  state: "active" | "ws_probed" | "phone_confirmed" | "cancelled";
  monotonicExpiresAt: number;
  confirmAttempts: number[];
}

export function normalizeCanonicalOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin === "null" || (url.protocol !== "http:" && url.protocol !== "https:"))
    throw new Error("phone verification requires an HTTP origin");
  return url.origin;
}

export interface PhoneVerificationDeps {
  storage: Storage;
  now?: () => number;
  monotonicNow?: () => number;
  randomBytes?: (size: number) => Buffer;
  authTimeoutMs?: number;
  socketLifetimeMs?: number;
}

const PHRASE_LEFT = ["amber", "brisk", "cobalt", "gentle", "silver", "sunny", "velvet", "winter"];
const PHRASE_RIGHT = ["badger", "comet", "harbor", "kite", "maple", "otter", "robin", "willow"];

function headerValues(rawHeaders: readonly string[] | undefined, name: string): string[] | undefined {
  if (rawHeaders === undefined) return undefined;
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === name) values.push(rawHeaders[index + 1] ?? "");
  }
  return values;
}

function secureResponse(body: BodyInit | null, status: number, extra: HeadersInit = {}): Response {
  return new Response(body, { status, headers: { ...PHONE_VERIFICATION_HEADERS, ...extra } });
}

function notFound(): Response {
  return secureResponse("Not Found", 404, { "content-type": "text/plain; charset=UTF-8" });
}

function rejectUpgrade(socket: Duplex): void {
  socket.write([
    "HTTP/1.1 404 Not Found",
    "Connection: close",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Length: 9",
    `Cache-Control: ${PHONE_VERIFICATION_HEADERS["cache-control"]}`,
    `Referrer-Policy: ${PHONE_VERIFICATION_HEADERS["referrer-policy"]}`,
    `X-Content-Type-Options: ${PHONE_VERIFICATION_HEADERS["x-content-type-options"]}`,
    `Content-Security-Policy: ${PHONE_VERIFICATION_HEADERS["content-security-policy"]}`,
    "",
    "Not Found",
  ].join("\r\n"));
  socket.destroy();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class PhoneVerification {
  readonly #storage: Storage;
  readonly #now: () => number;
  readonly #monotonicNow: () => number;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #authTimeoutMs: number;
  readonly #socketLifetimeMs: number;
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: PHONE_PROBE_MAX_BYTES, perMessageDeflate: false });
  readonly #records = new Map<string, ChallengeRecord>();
  readonly #pendingUpgrades = new WeakMap<IncomingMessage, {
    record: ChallengeRecord;
    authDeadline: number;
    release(): void;
  }>();
  #context: PhoneVerificationContext | undefined;
  #activeSockets = 0;
  #closed = false;

  constructor(deps: PhoneVerificationDeps) {
    this.#storage = deps.storage;
    this.#now = deps.now ?? Date.now;
    this.#monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.#randomBytes = deps.randomBytes ?? randomBytes;
    this.#authTimeoutMs = deps.authTimeoutMs ?? PHONE_AUTH_TIMEOUT_MS;
    this.#socketLifetimeMs = deps.socketLifetimeMs ?? PHONE_SOCKET_LIFETIME_MS;
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (ws, request) => {
      const pending = this.#pendingUpgrades.get(request);
      this.#pendingUpgrades.delete(request);
      if (pending === undefined) { ws.terminate(); return; }
      this.#runProbe(ws, pending.record, pending.authDeadline, pending.release);
    });
  }

  activate(context: PhoneVerificationContext): void {
    if (this.#context !== undefined) throw new Error("phone verification was already activated");
    this.#context = { ...context, canonicalOrigin: normalizeCanonicalOrigin(context.canonicalOrigin) };
  }

  begin(
    mode: OnboardingMode = "advanced",
    operatorContext?: { canonicalOrigin: string; durableFingerprint: string },
  ): PhoneVerificationChallenge {
    if (this.#closed || this.#context === undefined) throw new Error("phone verification is unavailable");
    const now = this.#now();
    const existing = [...this.#records.values()].find((record) =>
      record.state !== "phone_confirmed" && record.state !== "cancelled");
    if (existing !== undefined && this.#isUsable(existing))
      throw new Error("a phone verification session is already active");
    if (operatorContext !== undefined) {
      const canonicalOrigin = normalizeCanonicalOrigin(operatorContext.canonicalOrigin);
      if (operatorContext.durableFingerprint.length < 1 || operatorContext.durableFingerprint.length > 128)
        throw new Error("invalid operator verification posture");
      const verificationEpoch = randomUUID();
      this.#storage.beginOperatorVerificationContext({
        bootGeneration: this.#context.bootGeneration,
        verificationEpoch,
        canonicalOrigin,
        durableFingerprint: operatorContext.durableFingerprint,
        startedAt: now,
      });
      this.#context = {
        ...this.#context,
        verificationEpoch,
        canonicalOrigin,
        durableFingerprint: operatorContext.durableFingerprint,
      };
    }
    const sessionId = randomUUID();
    const sessionInput = {
      sessionId, mode, ...this.#context, createdAt: now,
    };

    const capability = this.#randomBytes(32).toString("base64url");
    if (!PHONE_CAPABILITY_PATTERN.test(capability)) throw new Error("failed to create phone capability");
    const challengeId = randomUUID();
    const phrase = `${PHRASE_LEFT[this.#randomBytes(1)[0]! % PHRASE_LEFT.length]} ${PHRASE_RIGHT[this.#randomBytes(1)[0]! % PHRASE_RIGHT.length]}`;
    const expiresAt = now + SETUP_CODE_TTL_MS;
    const challengeInput = {
      challengeId, sessionId, capabilityHash: sha256(capability), phrase,
      ...this.#context, createdAt: now, expiresAt,
    };
    if (existing === undefined) {
      const session = this.#storage.beginSetupSession(sessionInput);
      if (session.outcome !== "created") throw new Error("a phone verification session is already active");
      const result = this.#storage.createVerificationChallenge(challengeInput);
      if (result.outcome !== "created") throw new Error("failed to create phone verification challenge");
    } else {
      const result = this.#storage.replaceLocallyExpiredVerification({
        expiredSessionId: existing.sessionId,
        expiredChallengeId: existing.challengeId,
        expiredCapabilityHash: existing.capabilityHash,
        now, session: sessionInput, challenge: challengeInput,
      });
      if (result.outcome !== "created") throw new Error("failed to replace expired phone verification challenge");
      this.#records.delete(existing.capabilityHash);
    }
    const record: ChallengeRecord = {
      challengeId, sessionId, capabilityHash: sha256(capability), phrase, expiresAt,
      state: "active", monotonicExpiresAt: this.#monotonicNow() + SETUP_CODE_TTL_MS,
      confirmAttempts: [],
    };
    this.#records.set(record.capabilityHash, record);
    return this.#publicChallenge(record, capability);
  }

  /** Local operator projection. It deliberately omits the capability URL and returns the phrase
   * only after the phone confirmation transition is authoritative. */
  status(challengeId: string):
    | { state: "pending"; expiresAt: number }
    | { state: "confirmed"; phrase: string; expiresAt: number }
    | { state: "expired" | "cancelled" | "gateway_restarted" | "not_found" } {
    return this.#storage.onboardingVerificationStatus(challengeId, this.#now());
  }

  /** Idempotent local cancellation. SQLite is transitioned first; only then is the in-memory
   * capability made unusable. A completed/finalized winner cannot be cancelled here. */
  cancel(challengeId: string): boolean {
    const record = [...this.#records.values()].find((candidate) => candidate.challengeId === challengeId);
    if (!this.#storage.cancelVerificationChallenge(challengeId, this.#now())) return false;
    if (record !== undefined) record.state = "cancelled";
    return true;
  }

  #publicChallenge(record: ChallengeRecord, capability: string): PhoneVerificationChallenge {
    return { challengeId: record.challengeId, sessionId: record.sessionId, verificationUrl: `${this.#context!.canonicalOrigin}/cozy/onboarding/${capability}`, phrase: record.phrase, expiresAt: record.expiresAt };
  }

  #isUsable(record: ChallengeRecord): boolean {
    return this.#now() <= record.expiresAt && this.#monotonicNow() <= record.monotonicExpiresAt;
  }

  #record(capability: string, expected?: ChallengeRecord["state"]): ChallengeRecord | undefined {
    if (!PHONE_CAPABILITY_PATTERN.test(capability)) return undefined;
    const record = this.#records.get(sha256(capability));
    if (record === undefined || record.state === "cancelled" || !this.#isUsable(record)
      || (expected !== undefined && record.state !== expected)) return undefined;
    return record;
  }

  #authority(headers: Headers, rawHeaders?: readonly string[]): boolean {
    if (this.#context === undefined) return false;
    const expected = new URL(this.#context.canonicalOrigin).host;
    const raw = headerValues(rawHeaders, "host");
    if (raw !== undefined && (raw.length !== 1 || raw[0] !== expected)) return false;
    const host = headers.get("host");
    return host === expected && !host.includes(",");
  }

  #origin(headers: Headers, rawHeaders?: readonly string[]): boolean {
    if (this.#context === undefined) return false;
    const raw = headerValues(rawHeaders, "origin");
    if (raw !== undefined && (raw.length !== 1 || raw[0] !== this.#context.canonicalOrigin)) return false;
    const origin = headers.get("origin");
    return origin === this.#context.canonicalOrigin && !origin.includes(",");
  }

  async handleHttp(request: Request, rawHeaders?: readonly string[]): Promise<Response> {
    const match = new URL(request.url).pathname.match(/^\/cozy\/onboarding\/([^/]+)(\/confirm)?$/);
    if (match === null || !this.#authority(request.headers, rawHeaders)) return notFound();
    const capability = match[1]!;
    const confirm = match[2] !== undefined;
    if (confirm) {
      if (request.method !== "POST" || !this.#origin(request.headers, rawHeaders)) return notFound();
      return this.#confirm(capability, request);
    }
    const record = this.#record(capability, "active");
    if (record === undefined) return notFound();
    if (request.method === "OPTIONS") return secureResponse(null, 204, { allow: "GET, HEAD, OPTIONS" });
    if (request.method === "HEAD") return secureResponse(null, 200, { "content-type": "text/html; charset=UTF-8" });
    if (request.method !== "GET") return notFound();
    return secureResponse(PHONE_VERIFICATION_PAGE, 200, { "content-type": "text/html; charset=UTF-8" });
  }

  async #readBody(request: Request): Promise<string | undefined> {
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > PHONE_CONFIRM_MAX_BYTES)) return undefined;
    if (request.body === null) return "";
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    let timedOut = false;
    const authTimer = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, this.#authTimeoutMs);
    authTimer.unref?.();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > PHONE_CONFIRM_MAX_BYTES) { await reader.cancel(); return undefined; }
        chunks.push(value);
      }
    } catch {
      return undefined;
    } finally {
      clearTimeout(authTimer);
    }
    if (timedOut) return undefined;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  }

  #allowConfirm(record: ChallengeRecord): boolean {
    const floor = this.#now() - 60_000;
    while ((record.confirmAttempts[0] ?? Infinity) < floor) record.confirmAttempts.shift();
    while ((PROCESS_CONFIRM_ATTEMPTS[0] ?? Infinity) < floor) PROCESS_CONFIRM_ATTEMPTS.shift();
    if (record.confirmAttempts.length >= PHONE_CONFIRM_ATTEMPTS_PER_MINUTE || PROCESS_CONFIRM_ATTEMPTS.length >= PHONE_GLOBAL_CONFIRMS_PER_MINUTE) return false;
    const now = this.#now();
    record.confirmAttempts.push(now);
    PROCESS_CONFIRM_ATTEMPTS.push(now);
    return true;
  }

  async #confirm(capability: string, request: Request): Promise<Response> {
    const record = this.#record(capability, "ws_probed");
    if (record === undefined || !this.#allowConfirm(record)) return notFound();
    const body = await this.#readBody(request);
    if (body === undefined) return notFound();
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return notFound(); }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || (parsed as { type?: unknown }).type !== "confirm") return notFound();
    let result;
    try {
      result = this.#storage.recordPhoneConfirmation({ capabilityHash: record.capabilityHash, ...this.#context!, now: this.#now() });
    } catch {
      return notFound();
    }
    if (result.outcome !== "advanced") return notFound();
    record.state = "phone_confirmed";
    return secureResponse(JSON.stringify({ phrase: record.phrase }), 200, { "content-type": "application/json; charset=UTF-8" });
  }

  resolveUpgrade(pathname: string): UpgradeHandler | undefined {
    if (!pathname.startsWith("/cozy/onboarding/")) return undefined;
    return (request, socket, head) => this.handleUpgrade(request, socket, head);
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const match = (request.url ?? "").split("?")[0]!.match(/^\/cozy\/onboarding\/([^/]+)\/probe$/);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value !== undefined) headers.set(name, value.join(", "));
    }
    const record = match === null ? undefined : this.#record(match[1]!, "active");
    if (record === undefined || !this.#authority(headers, request.rawHeaders) || !this.#origin(headers, request.rawHeaders) || this.#activeSockets >= PHONE_MAX_SOCKETS) {
      rejectUpgrade(socket); return;
    }
    this.#activeSockets += 1;
    const now = this.#monotonicNow();
    const inheritedRemainingMs = preUpgradeAuthRemainingMs(request);
    const authDeadline = now + Math.min(inheritedRemainingMs ?? this.#authTimeoutMs, this.#authTimeoutMs);
    let released = false;
    const release = () => { if (!released) { released = true; this.#activeSockets -= 1; } };
    try {
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#pendingUpgrades.set(request, { record, authDeadline, release });
        this.#wss.emit("connection", ws, request);
      });
    } catch {
      release(); rejectUpgrade(socket);
    }
  }

  #runProbe(ws: WebSocket, record: ChallengeRecord, authDeadline: number, release: () => void): void {
    let seen = false;
    const authTimer = setTimeout(() => ws.terminate(), Math.max(0, authDeadline - this.#monotonicNow()));
    const lifetimeTimer = setTimeout(() => ws.terminate(), this.#socketLifetimeMs);
    const challenge = '{"type":"cozy_onboarding_probe"}';
    ws.on("error", () => {});
    ws.once("close", () => { clearTimeout(authTimer); clearTimeout(lifetimeTimer); release(); });
    ws.on("message", (data, isBinary) => {
      const frame = String(data);
      if (seen || isBinary || Buffer.byteLength(frame) > PHONE_PROBE_MAX_BYTES || frame !== challenge || record.state !== "active" || !this.#isUsable(record)) { ws.terminate(); return; }
      seen = true;
      ws.send(frame, (error) => {
        if (error) { ws.terminate(); return; }
        let result;
        try {
          result = this.#storage.recordVerificationProbe({ capabilityHash: record.capabilityHash, ...this.#context!, now: this.#now() });
        } catch { ws.terminate(); return; }
        if (result.outcome !== "advanced") { ws.terminate(); return; }
        record.state = "ws_probed";
        clearTimeout(authTimer);
      });
    });
  }

  close(): void {
    this.#closed = true;
    this.#records.clear();
    for (const socket of this.#wss.clients) socket.terminate();
    this.#wss.close();
  }
}

export function gatewayPostureFingerprint(input: { host: string; port: number; canonicalOrigin: string }): string {
  return sha256(JSON.stringify(input));
}

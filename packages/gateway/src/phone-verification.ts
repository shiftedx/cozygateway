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
import type { UpgradeHandler } from "./upgrade-dispatcher.ts";

export const PHONE_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const PHONE_CONFIRM_MAX_BYTES = 256;
export const PHONE_PROBE_MAX_BYTES = 256;
export const PHONE_MAX_SOCKETS = 4;
export const PHONE_AUTH_TIMEOUT_MS = 5_000;
export const PHONE_SOCKET_LIFETIME_MS = 60_000;
export const PHONE_CONFIRM_ATTEMPTS_PER_MINUTE = 5;
export const PHONE_GLOBAL_CONFIRMS_PER_MINUTE = 60;

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

interface ChallengeRecord extends PhoneVerificationChallenge {
  capabilityHash: string;
  state: "active" | "ws_probed" | "phone_confirmed";
  monotonicExpiresAt: number;
  confirmAttempts: number[];
}

export interface PhoneVerificationDeps {
  storage: Storage;
  now?: () => number;
  monotonicNow?: () => number;
  randomBytes?: (size: number) => Buffer;
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
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: PHONE_PROBE_MAX_BYTES, perMessageDeflate: false });
  readonly #records = new Map<string, ChallengeRecord>();
  readonly #globalConfirmAttempts: number[] = [];
  readonly #pendingUpgrades = new WeakMap<IncomingMessage, { record: ChallengeRecord; release(): void }>();
  #context: PhoneVerificationContext | undefined;
  #activeSockets = 0;
  #closed = false;

  constructor(deps: PhoneVerificationDeps) {
    this.#storage = deps.storage;
    this.#now = deps.now ?? Date.now;
    this.#monotonicNow = deps.monotonicNow ?? (() => performance.now());
    this.#randomBytes = deps.randomBytes ?? randomBytes;
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (ws, request) => {
      const pending = this.#pendingUpgrades.get(request);
      this.#pendingUpgrades.delete(request);
      if (pending === undefined) { ws.terminate(); return; }
      this.#runProbe(ws, pending.record, pending.release);
    });
  }

  activate(context: PhoneVerificationContext): void {
    if (this.#context !== undefined) throw new Error("phone verification was already activated");
    const origin = new URL(context.canonicalOrigin).origin;
    if (origin !== context.canonicalOrigin) throw new Error("phone verification requires a canonical origin");
    this.#context = { ...context };
  }

  begin(mode: OnboardingMode = "advanced"): PhoneVerificationChallenge {
    if (this.#closed || this.#context === undefined) throw new Error("phone verification is unavailable");
    const existing = [...this.#records.values()].find((record) => this.#isUsable(record) && record.state !== "phone_confirmed");
    if (existing !== undefined) return this.#publicChallenge(existing);

    const now = this.#now();
    const sessionId = randomUUID();
    const session = this.#storage.beginSetupSession({
      sessionId, mode, ...this.#context, createdAt: now,
    });
    if (session.outcome !== "created") throw new Error("a phone verification session is already active");

    const capability = this.#randomBytes(32).toString("base64url");
    if (!PHONE_CAPABILITY_PATTERN.test(capability)) throw new Error("failed to create phone capability");
    const challengeId = randomUUID();
    const phrase = `${PHRASE_LEFT[this.#randomBytes(1)[0]! % PHRASE_LEFT.length]} ${PHRASE_RIGHT[this.#randomBytes(1)[0]! % PHRASE_RIGHT.length]}`;
    const expiresAt = now + SETUP_CODE_TTL_MS;
    const result = this.#storage.createVerificationChallenge({
      challengeId, sessionId, capabilityHash: sha256(capability), phrase,
      ...this.#context, createdAt: now, expiresAt,
    });
    if (result.outcome !== "created") throw new Error("failed to create phone verification challenge");
    const record: ChallengeRecord = {
      challengeId, sessionId, capabilityHash: sha256(capability), phrase, expiresAt,
      verificationUrl: `${this.#context.canonicalOrigin}/cozy/onboarding/${capability}`,
      state: "active", monotonicExpiresAt: this.#monotonicNow() + SETUP_CODE_TTL_MS,
      confirmAttempts: [],
    };
    this.#records.set(capability, record);
    return this.#publicChallenge(record);
  }

  #publicChallenge(record: ChallengeRecord): PhoneVerificationChallenge {
    return { challengeId: record.challengeId, sessionId: record.sessionId, verificationUrl: record.verificationUrl, phrase: record.phrase, expiresAt: record.expiresAt };
  }

  #isUsable(record: ChallengeRecord): boolean {
    return this.#now() <= record.expiresAt && this.#monotonicNow() <= record.monotonicExpiresAt;
  }

  #record(capability: string, expected?: ChallengeRecord["state"]): ChallengeRecord | undefined {
    if (!PHONE_CAPABILITY_PATTERN.test(capability)) return undefined;
    const record = this.#records.get(capability);
    if (record === undefined || !this.#isUsable(record) || (expected !== undefined && record.state !== expected)) return undefined;
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
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return undefined; }
  }

  #allowConfirm(record: ChallengeRecord): boolean {
    const floor = this.#now() - 60_000;
    while ((record.confirmAttempts[0] ?? Infinity) < floor) record.confirmAttempts.shift();
    while ((this.#globalConfirmAttempts[0] ?? Infinity) < floor) this.#globalConfirmAttempts.shift();
    if (record.confirmAttempts.length >= PHONE_CONFIRM_ATTEMPTS_PER_MINUTE || this.#globalConfirmAttempts.length >= PHONE_GLOBAL_CONFIRMS_PER_MINUTE) return false;
    const now = this.#now();
    record.confirmAttempts.push(now);
    this.#globalConfirmAttempts.push(now);
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
    let released = false;
    const release = () => { if (!released) { released = true; this.#activeSockets -= 1; } };
    try {
      this.#wss.handleUpgrade(request, socket, head, (ws) => {
        this.#pendingUpgrades.set(request, { record, release });
        this.#wss.emit("connection", ws, request);
      });
    } catch {
      release(); rejectUpgrade(socket);
    }
  }

  #runProbe(ws: WebSocket, record: ChallengeRecord, release: () => void): void {
    let seen = false;
    const authTimer = setTimeout(() => ws.terminate(), PHONE_AUTH_TIMEOUT_MS);
    const lifetimeTimer = setTimeout(() => ws.terminate(), PHONE_SOCKET_LIFETIME_MS);
    const challenge = '{"type":"cozy_onboarding_probe"}';
    ws.on("error", () => {});
    ws.once("close", () => { clearTimeout(authTimer); clearTimeout(lifetimeTimer); release(); });
    ws.on("message", (data, isBinary) => {
      if (seen || isBinary || Buffer.byteLength(String(data)) > PHONE_PROBE_MAX_BYTES || String(data) !== challenge || record.state !== "active" || !this.#isUsable(record)) { ws.terminate(); return; }
      seen = true;
      try { ws.send(challenge); } catch { ws.terminate(); return; }
      // Queue the echo first, then commit ws_probed in the same turn. Waiting for ws's flush
      // callback races a fast browser that receives the echo and immediately POSTs confirmation.
      let result;
      try {
        result = this.#storage.recordVerificationProbe({ capabilityHash: record.capabilityHash, ...this.#context!, now: this.#now() });
      } catch {
        ws.terminate(); return;
      }
      if (result.outcome === "advanced") record.state = "ws_probed";
      else ws.terminate();
      clearTimeout(authTimer);
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

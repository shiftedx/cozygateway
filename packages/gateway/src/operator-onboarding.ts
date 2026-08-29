import { timingSafeEqual } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync } from "node:fs";

import type { OnboardingMode } from "./storage.ts";

const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE_ID = /^[A-Za-z0-9-]{1,128}$/;
const MAX_BODY_BYTES = 512;
const MAX_RESPONSE_BYTES = 4_096;

export type OperatorPhoneStatus =
  | { state: "pending"; expiresAt: number }
  | { state: "confirmed"; phrase: string; expiresAt: number }
  | { state: "expired" | "cancelled" | "not_found" };

export interface OperatorPhoneVerification {
  begin(mode: OnboardingMode, context: { canonicalOrigin: string; durableFingerprint: string }): {
    challengeId: string;
    sessionId: string;
    verificationUrl: string;
    expiresAt: number;
  };
  status(challengeId: string): OperatorPhoneStatus;
  cancel(challengeId: string): boolean;
}

export interface OperatorOnboardingControlOptions {
  token: string;
  phoneVerification: OperatorPhoneVerification;
}

function notFound(): Response {
  return new Response('{"error":"not_found"}', {
    status: 404,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function loopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "0:0:0:0:0:0:0:1"
    || remoteAddress?.startsWith("::ffff:127.") === true;
}

async function boundedJson(request: Request): Promise<unknown | undefined> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return undefined;
  const reader = request.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function loadOperatorControlToken(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size < 43 || info.size > 45) throw new Error("invalid operator control token file");
    const bytes = Buffer.alloc(info.size);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== bytes.length) throw new Error("invalid operator control token file");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const token = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!CONTROL_TOKEN.test(token)) throw new Error("invalid operator control token file");
    return token;
  } catch (error) {
    if (error instanceof Error && /operator control token/.test(error.message)) throw error;
    throw new Error("invalid operator control token file");
  } finally {
    closeSync(descriptor);
  }
}

export class OperatorOnboardingControl {
  readonly #token: Buffer;
  readonly #phoneVerification: OperatorPhoneVerification;

  constructor(options: OperatorOnboardingControlOptions) {
    if (!CONTROL_TOKEN.test(options.token)) throw new Error("invalid operator control token");
    this.#token = Buffer.from(options.token, "ascii");
    this.#phoneVerification = options.phoneVerification;
  }

  async handle(request: Request, remoteAddress: string | undefined): Promise<Response> {
    const authorization = request.headers.get("authorization") ?? "";
    const candidate = authorization.startsWith("Bearer ")
      ? Buffer.from(authorization.slice(7), "ascii")
      : Buffer.alloc(0);
    const authenticated = candidate.length === this.#token.length
      && timingSafeEqual(candidate, this.#token);
    if (!loopback(remoteAddress) || !authenticated || request.method !== "POST") return notFound();
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
      return notFound();
    const body = await boundedJson(request);
    if (!record(body) || typeof body.action !== "string") return notFound();

    if (
      body.action === "begin"
      && exactKeys(body, ["action", "mode", "canonicalOrigin", "durableFingerprint"])
      && (body.mode === "tailscale" || body.mode === "lan" || body.mode === "advanced")
      && typeof body.canonicalOrigin === "string"
      && typeof body.durableFingerprint === "string"
      && /^[\x21-\x7e]{1,128}$/.test(body.durableFingerprint)
    ) {
      try {
        const parsedOrigin = new URL(body.canonicalOrigin);
        if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") return notFound();
        const canonicalOrigin = parsedOrigin.origin;
        if (canonicalOrigin !== body.canonicalOrigin) return notFound();
        const challenge = this.#phoneVerification.begin(body.mode, {
          canonicalOrigin,
          durableFingerprint: body.durableFingerprint,
        });
        return json({
          state: "pending",
          challengeId: challenge.challengeId,
          sessionId: challenge.sessionId,
          verificationUrl: challenge.verificationUrl,
          expiresAt: challenge.expiresAt,
        });
      } catch {
        return json({ state: "busy" }, 409);
      }
    }
    if (
      (body.action === "status" || body.action === "cancel")
      && exactKeys(body, ["action", "challengeId"])
      && typeof body.challengeId === "string"
      && CHALLENGE_ID.test(body.challengeId)
    ) {
      if (body.action === "status") {
        const status = this.#phoneVerification.status(body.challengeId);
        return status.state === "not_found" ? notFound() : json(status);
      }
      return this.#phoneVerification.cancel(body.challengeId)
        ? json({ state: "cancelled" })
        : notFound();
    }
    return notFound();
  }
}

export type OperatorBeginResult = {
  state: "pending";
  challengeId: string;
  sessionId: string;
  verificationUrl: string;
  expiresAt: number;
};

export interface OperatorOnboardingClientOptions {
  localOrigin: string;
  token: string;
  fetch?: typeof fetch;
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function phrase(value: unknown): value is string {
  return typeof value === "string" && /^[a-z]{1,16} [a-z]{1,16}$/.test(value);
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("local onboarding control failed");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES))
    throw new Error("local onboarding control failed");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("local onboarding control failed");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("local onboarding control failed");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("local onboarding control failed");
  }
}

export class OperatorOnboardingClient {
  readonly #endpoint: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: OperatorOnboardingClientOptions) {
    if (!CONTROL_TOKEN.test(options.token)) throw new Error("invalid operator control token");
    const origin = new URL(options.localOrigin);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:")
      || !new Set(["127.0.0.1", "::1", "localhost"]).has(origin.hostname)
      || origin.username !== "" || origin.password !== "" || origin.pathname !== "/"
      || origin.search !== "" || origin.hash !== "")
      throw new Error("local onboarding control requires a loopback origin");
    this.#endpoint = `${origin.origin}/cozy/operator/onboarding`;
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  begin(
    mode: OnboardingMode,
    context: { canonicalOrigin: string; durableFingerprint: string },
    signal?: AbortSignal,
  ): Promise<OperatorBeginResult> {
    return this.#call({ action: "begin", mode, ...context }, signal).then((value) => {
      if (!record(value) || !exactKeys(value, ["state", "challengeId", "sessionId", "verificationUrl", "expiresAt"])
        || value.state !== "pending" || typeof value.challengeId !== "string" || !CHALLENGE_ID.test(value.challengeId)
        || typeof value.sessionId !== "string" || !CHALLENGE_ID.test(value.sessionId)
        || typeof value.verificationUrl !== "string" || !timestamp(value.expiresAt))
        throw new Error("local onboarding control failed");
      const verification = new URL(value.verificationUrl);
      if ((verification.protocol !== "http:" && verification.protocol !== "https:")
        || !/^\/cozy\/onboarding\/[A-Za-z0-9_-]{43}$/.test(verification.pathname)
        || verification.username !== "" || verification.password !== "" || verification.search !== "" || verification.hash !== "")
        throw new Error("local onboarding control failed");
      return value as unknown as OperatorBeginResult;
    });
  }

  status(challengeId: string, signal?: AbortSignal): Promise<OperatorPhoneStatus> {
    return this.#challengeCall("status", challengeId, signal).then((value) => {
      if (!record(value) || typeof value.state !== "string") throw new Error("local onboarding control failed");
      if (value.state === "pending" && exactKeys(value, ["state", "expiresAt"]) && timestamp(value.expiresAt))
        return value as unknown as OperatorPhoneStatus;
      if (value.state === "confirmed" && exactKeys(value, ["state", "phrase", "expiresAt"])
        && phrase(value.phrase) && timestamp(value.expiresAt)) return value as unknown as OperatorPhoneStatus;
      if ((value.state === "expired" || value.state === "cancelled") && exactKeys(value, ["state"]))
        return value as unknown as OperatorPhoneStatus;
      throw new Error("local onboarding control failed");
    });
  }

  cancel(challengeId: string, signal?: AbortSignal): Promise<{ state: "cancelled" }> {
    return this.#challengeCall("cancel", challengeId, signal).then((value) => {
      if (!record(value) || !exactKeys(value, ["state"]) || value.state !== "cancelled")
        throw new Error("local onboarding control failed");
      return { state: "cancelled" };
    });
  }

  #challengeCall(action: "status" | "cancel", challengeId: string, signal?: AbortSignal): Promise<unknown> {
    if (!CHALLENGE_ID.test(challengeId)) return Promise.reject(new Error("local onboarding control failed"));
    return this.#call({ action, challengeId }, signal);
  }

  async #call(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      return await boundedResponseJson(response);
    } catch {
      throw new Error("local onboarding control failed");
    }
  }
}

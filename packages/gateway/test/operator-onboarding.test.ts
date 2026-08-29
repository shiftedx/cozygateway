import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  OperatorOnboardingControl,
  loadOperatorControlToken,
} from "../src/operator-onboarding.ts";

const TOKEN = "A".repeat(43);

function request(body: unknown, token = TOKEN): Request {
  return new Request("http://127.0.0.1/cozy/operator/onboarding", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function verifier() {
  return {
    begin: vi.fn(() => ({
      challengeId: "challenge-1",
      sessionId: "session-1",
      verificationUrl: `https://cozy.example/cozy/onboarding/${"B".repeat(43)}`,
      expiresAt: 600_000,
    })),
    status: vi.fn<() =>
      | { state: "pending"; expiresAt: number }
      | { state: "confirmed"; phrase: string; expiresAt: number }
    >(() => ({ state: "pending", expiresAt: 600_000 })),
    cancel: vi.fn(() => true),
  };
}

describe("local operator onboarding control", () => {
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "accepts authenticated requests only from loopback address %s",
    async (remoteAddress) => {
      const phone = verifier();
      const control = new OperatorOnboardingControl({ token: TOKEN, phoneVerification: phone });

      const response = await control.handle(request({
        action: "begin", mode: "tailscale",
        canonicalOrigin: "https://cozy.example", durableFingerprint: "posture-a",
      }), remoteAddress);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        state: "pending",
        challengeId: "challenge-1",
        sessionId: "session-1",
        verificationUrl: `https://cozy.example/cozy/onboarding/${"B".repeat(43)}`,
        expiresAt: 600_000,
      });
      expect(phone.begin).toHaveBeenCalledWith("tailscale", {
        canonicalOrigin: "https://cozy.example", durableFingerprint: "posture-a",
      });
    },
  );

  it("uses one uniform response for absent/bad credentials, non-loopback callers, and malformed input", async () => {
    const phone = verifier();
    const control = new OperatorOnboardingControl({ token: TOKEN, phoneVerification: phone });
    const begin = { action: "begin", mode: "lan", canonicalOrigin: "http://192.168.1.20:8787", durableFingerprint: "posture-a" };
    const missing = request(begin);
    missing.headers.delete("authorization");
    const cases = [
      control.handle(missing, "127.0.0.1"),
      control.handle(request(begin, "C".repeat(43)), "127.0.0.1"),
      control.handle(request(begin), "192.168.1.20"),
      control.handle(request({ ...begin, extra: true }), "127.0.0.1"),
      control.handle(request({ ...begin, canonicalOrigin: "ftp://cozy.example" }), "127.0.0.1"),
      control.handle(request({ ...begin, durableFingerprint: "posture a" }), "127.0.0.1"),
      control.handle(request("{"), "127.0.0.1"),
    ];

    const results = await Promise.all(cases);
    expect(await Promise.all(results.map(async (response) => ({
      status: response.status,
      body: await response.text(),
    })))).toEqual(Array.from({ length: cases.length }, () => ({
      status: 404,
      body: '{"error":"not_found"}',
    })));
    expect(phone.begin).not.toHaveBeenCalled();
  });

  it("rejects an oversized body before parsing or invoking phone verification", async () => {
    const phone = verifier();
    const control = new OperatorOnboardingControl({ token: TOKEN, phoneVerification: phone });
    const response = await control.handle(request("x".repeat(513)), "127.0.0.1");

    expect(response.status).toBe(404);
    expect(phone.begin).not.toHaveBeenCalled();
  });

  it("bounds an authenticated operator body read and cancels the incomplete stream", async () => {
    vi.useFakeTimers();
    const phone = verifier();
    const control = new OperatorOnboardingControl({
      token: TOKEN,
      phoneVerification: phone,
      bodyReadTimeoutMs: 5_000,
    });
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      cancel,
    });
    const slow = new Request("http://127.0.0.1/cozy/operator/onboarding", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = control.handle(slow, "127.0.0.1");
    try {
      await vi.advanceTimersByTimeAsync(5_000);
      let settled = false;
      void pending.then(() => { settled = true; });
      await Promise.resolve();

      expect(settled).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      await expect(pending).resolves.toMatchObject({ status: 404 });
      expect(phone.begin).not.toHaveBeenCalled();
    } finally {
      if (cancel.mock.calls.length === 0) streamController?.close();
      await pending;
      vi.useRealTimers();
    }
  });

  it("cancels an authenticated operator body read when its request aborts", async () => {
    const phone = verifier();
    const control = new OperatorOnboardingControl({ token: TOKEN, phoneVerification: phone });
    const cancel = vi.fn();
    const abort = new AbortController();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const slow = new Request("http://127.0.0.1/cozy/operator/onboarding", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body,
      duplex: "half",
      signal: abort.signal,
    } as RequestInit & { duplex: "half" });

    const pending = control.handle(slow, "127.0.0.1");
    abort.abort();

    await expect(pending).resolves.toMatchObject({ status: 404 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(phone.begin).not.toHaveBeenCalled();
  });

  it("returns only bounded pending/confirmed state and supports exact cancel", async () => {
    const phone = verifier();
    phone.status
      .mockReturnValueOnce({ state: "pending", expiresAt: 600_000 })
      .mockReturnValueOnce({ state: "confirmed", phrase: "quiet harbor", expiresAt: 600_000 });
    const control = new OperatorOnboardingControl({ token: TOKEN, phoneVerification: phone });

    const pending = await control.handle(request({ action: "status", challengeId: "challenge-1" }), "127.0.0.1");
    const confirmed = await control.handle(request({ action: "status", challengeId: "challenge-1" }), "127.0.0.1");
    const cancelled = await control.handle(request({ action: "cancel", challengeId: "challenge-1" }), "127.0.0.1");

    expect(await pending.json()).toEqual({ state: "pending", expiresAt: 600_000 });
    expect(await confirmed.json()).toEqual({ state: "confirmed", phrase: "quiet harbor", expiresAt: 600_000 });
    expect(await cancelled.json()).toEqual({ state: "cancelled" });
    expect(phone.cancel).toHaveBeenCalledWith("challenge-1");
  });

  it("loads exactly one private 256-bit base64url token without accepting extra bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-control-token-"));
    const path = join(directory, "operator-control.token");
    writeFileSync(path, `${TOKEN}\n`, { mode: 0o600 });
    expect(loadOperatorControlToken(path)).toBe(TOKEN);

    writeFileSync(path, `${TOKEN}\nextra`, { mode: 0o600 });
    expect(() => loadOperatorControlToken(path)).toThrow(/control token/i);
  });
});

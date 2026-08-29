import { describe, expect, it, vi } from "vitest";

import {
  OperatorOnboardingBusyError,
  OperatorOnboardingClient,
  OperatorOnboardingUnavailableError,
} from "../src/operator-onboarding.ts";

const TOKEN = "F".repeat(43);

describe("operator onboarding client", () => {
  it("uses the loopback listener, exact bearer token, and bounded action bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        state: "pending",
        challengeId: "challenge-1",
        sessionId: "session-1",
        verificationUrl: `https://cozy.example/cozy/onboarding/${"G".repeat(43)}`,
        expiresAt: 600_000,
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new OperatorOnboardingClient({
      localOrigin: "http://127.0.0.1:8787",
      token: TOKEN,
      fetch: fetcher as typeof fetch,
    });

    await expect(client.begin("tailscale", {
      canonicalOrigin: "https://cozy.example", durableFingerprint: "posture-a",
    })).resolves.toMatchObject({
      state: "pending", challengeId: "challenge-1", sessionId: "session-1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/cozy/operator/onboarding");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.body).toBe('{"action":"begin","mode":"tailscale","canonicalOrigin":"https://cozy.example","durableFingerprint":"posture-a"}');
  });

  it("validates exact response schemas and never reflects token or capability details in errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      state: "pending",
      challengeId: "challenge-1",
      sessionId: "session-1",
      verificationUrl: `https://cozy.example/cozy/onboarding/${"G".repeat(43)}`,
      expiresAt: 600_000,
      extra: TOKEN,
    }), { status: 200 }));
    const client = new OperatorOnboardingClient({
      localOrigin: "http://127.0.0.1:8787", token: TOKEN, fetch: fetcher as typeof fetch,
    });
    const error = await client.begin("lan", {
      canonicalOrigin: "http://192.168.1.20:8787", durableFingerprint: "posture-a",
    }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: local onboarding control failed");
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain("/cozy/onboarding/");
  });

  it("bounds responses and exposes only typed status/cancel operations", async () => {
    const responses = [
      new Response(JSON.stringify({ state: "confirmed", phrase: "silver maple", expiresAt: 600_000 })),
      new Response(JSON.stringify({ state: "cancelled" })),
      new Response("x".repeat(4_097)),
    ];
    const fetcher = vi.fn(async () => responses.shift()!);
    const client = new OperatorOnboardingClient({
      localOrigin: "http://127.0.0.1:8787", token: TOKEN, fetch: fetcher as typeof fetch,
    });

    await expect(client.status("challenge-1")).resolves.toEqual({
      state: "confirmed", phrase: "silver maple", expiresAt: 600_000,
    });
    await expect(client.cancel("challenge-1")).resolves.toEqual({ state: "cancelled" });
    await expect(client.status("challenge-1")).rejects.toThrow("local onboarding control failed");
  });

  it("always composes a fixed deadline with caller cancellation and types endpoint absence as transient", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        signals.push(init?.signal as AbortSignal);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      });
      const caller = new AbortController();
      const client = new OperatorOnboardingClient({
        localOrigin: "http://127.0.0.1:8787", token: TOKEN,
        fetch: fetcher as typeof fetch, requestTimeoutMs: 25,
      });
      const timed = client.status("challenge-1");
      const timedExpectation = expect(timed).rejects.toBeInstanceOf(OperatorOnboardingUnavailableError);
      await vi.advanceTimersByTimeAsync(25);
      await timedExpectation;
      expect(signals[0]?.aborted).toBe(true);

      const cancelled = client.status("challenge-1", caller.signal);
      const cancelledExpectation = expect(cancelled).rejects.toBeInstanceOf(OperatorOnboardingUnavailableError);
      caller.abort();
      await cancelledExpectation;
      expect(signals[1]?.aborted).toBe(true);

      const absent = new OperatorOnboardingClient({
        localOrigin: "http://127.0.0.1:8787", token: TOKEN,
        fetch: vi.fn(async () => new Response('{"error":"not_found"}', { status: 404 })) as typeof fetch,
      });
      await expect(absent.status("challenge-1")).rejects.toBeInstanceOf(OperatorOnboardingUnavailableError);
      const busy = new OperatorOnboardingClient({
        localOrigin: "http://127.0.0.1:8787", token: TOKEN,
        fetch: vi.fn(async () => new Response('{"state":"busy"}', { status: 409 })) as typeof fetch,
      });
      await expect(busy.begin("lan", {
        canonicalOrigin: "http://192.168.1.20:8787", durableFingerprint: "posture-a",
      })).rejects.toBeInstanceOf(OperatorOnboardingBusyError);
    } finally {
      vi.useRealTimers();
    }
  });
});

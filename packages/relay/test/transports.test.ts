import { describe, expect, it, vi } from "vitest";

import { webhookTransport } from "../src/transports.ts";

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe("webhook transport", () => {
  it("POSTs {ciphertext} to the token URL", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await webhookTransport(fetchImpl).deliver("https://x.example/hook", "CIPHER");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://x.example/hook");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ ciphertext: "CIPHER" });
  });

  it("throws on a non-2xx response", async () => {
    await expect(webhookTransport(fetchReturning(500)).deliver("https://x.example/hook", "C")).rejects.toThrow(
      "HTTP 500",
    );
  });

  it("throws when fetch rejects", async () => {
    const failing = (async () => {
      throw new Error("connect refused");
    }) as typeof fetch;
    await expect(webhookTransport(failing).deliver("https://x.example/hook", "C")).rejects.toThrow("connect refused");
  });
});

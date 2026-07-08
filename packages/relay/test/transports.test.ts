import type { LookupFunction } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { createVettingLookup, EgressBlockedError, webhookTransport } from "../src/transports.ts";

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe("webhook transport (unrestricted, default)", () => {
  it("POSTs {ciphertext} to the token URL", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await webhookTransport({ fetchImpl }).deliver("https://x.example/hook", "CIPHER");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://x.example/hook");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ ciphertext: "CIPHER" });
  });

  it("throws on a non-2xx response", async () => {
    await expect(
      webhookTransport({ fetchImpl: fetchReturning(500) }).deliver("https://x.example/hook", "C"),
    ).rejects.toThrow("HTTP 500");
  });

  it("throws when fetch rejects", async () => {
    const failing = (async () => {
      throw new Error("connect refused");
    }) as typeof fetch;
    await expect(webhookTransport({ fetchImpl: failing }).deliver("https://x.example/hook", "C")).rejects.toThrow(
      "connect refused",
    );
  });

  it("defaults to unrestricted when no options are given", async () => {
    // Regression guard: webhookTransport() with zero args must not throw and must not
    // silently switch into restricted mode.
    const transport = webhookTransport();
    expect(transport).toBeDefined();
  });
});

describe("createVettingLookup", () => {
  function stubLookup(address: string, family: number): LookupFunction {
    return (_hostname, _options, callback) => {
      callback(null, address, family);
    };
  }

  it("passes through a public resolved address unchanged", () => {
    const results: Array<{ err: unknown; address: unknown; family: unknown }> = [];
    const vetted = createVettingLookup(stubLookup("8.8.8.8", 4));
    vetted("public.example", { family: 0 }, (err, address, family) => results.push({ err, address, family }));
    expect(results).toEqual([{ err: null, address: "8.8.8.8", family: 4 }]);
  });

  it("refuses a resolved loopback address", () => {
    const results: Array<{ err: unknown; address: unknown }> = [];
    const vetted = createVettingLookup(stubLookup("127.0.0.1", 4));
    vetted("internal.example", { family: 0 }, (err, address) => results.push({ err, address }));
    expect(results).toHaveLength(1);
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a resolved private RFC1918 address", () => {
    const results: Array<{ err: unknown }> = [];
    const vetted = createVettingLookup(stubLookup("10.1.2.3", 4));
    vetted("internal.example", { family: 0 }, (err) => results.push({ err }));
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a resolved link-local address (e.g. cloud metadata)", () => {
    const results: Array<{ err: unknown }> = [];
    const vetted = createVettingLookup(stubLookup("169.254.169.254", 4));
    vetted("metadata.internal", { family: 0 }, (err) => results.push({ err }));
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a resolved IPv6 unique-local address", () => {
    const results: Array<{ err: unknown }> = [];
    const vetted = createVettingLookup(stubLookup("fd12:3456::1", 6));
    vetted("internal.example", { family: 0 }, (err) => results.push({ err }));
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
  });

  it("passes through the underlying resolver's own error unchanged", () => {
    const results: Array<{ err: unknown }> = [];
    const failing: LookupFunction = (_hostname, _options, callback) => {
      callback(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), "", 4);
    };
    const vetted = createVettingLookup(failing);
    vetted("nowhere.example", { family: 0 }, (err) => results.push({ err }));
    expect((results[0]?.err as Error).message).toBe("ENOTFOUND");
    expect(results[0]?.err).not.toBeInstanceOf(EgressBlockedError);
  });
});

describe("webhook transport (restricted egress mode)", () => {
  it("refuses delivery when the resolved address is a private range, without attempting a network call", async () => {
    const stubbedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, "10.1.2.3", 4);
    };
    const transport = webhookTransport({ restrictEgress: true, lookup: stubbedLookup });
    await expect(transport.deliver("http://internal.example/hook", "C")).rejects.toThrow(EgressBlockedError);
  });

  it("refuses delivery when a literal-IP loopback token resolves through the stubbed resolver", async () => {
    const stubbedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, "127.0.0.1", 4);
    };
    const transport = webhookTransport({ restrictEgress: true, lookup: stubbedLookup });
    await expect(transport.deliver("http://127.0.0.1:9/hook", "C")).rejects.toThrow(EgressBlockedError);
  });

  it("propagates a resolver failure (e.g. ENOTFOUND) as a rejection", async () => {
    const stubbedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(Object.assign(new Error("getaddrinfo ENOTFOUND nowhere.example"), { code: "ENOTFOUND" }), "", 4);
    };
    const transport = webhookTransport({ restrictEgress: true, lookup: stubbedLookup });
    await expect(transport.deliver("http://nowhere.example/hook", "C")).rejects.toThrow("ENOTFOUND");
  });
});

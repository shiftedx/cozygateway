import type { LookupAddress } from "node:dns";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
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

  // Regression coverage for the CRITICAL finding: `http.request`/`https.request` invoke
  // a custom `lookup` with `{ hints: 1024, all: true }` by default (autoSelectFamily is
  // on by default on modern Node), and `dns.lookup(host, { all: true })` always answers
  // with an array of `{address, family}` objects, never a single address. Every stub
  // above ignores `options` and answers with the single-address shape, so none of them
  // would have caught a regression here; these tests drive the array shape explicitly.
  function stubLookupAll(addresses: LookupAddress[]): LookupFunction {
    return (_hostname, _options, callback) => {
      callback(null, addresses);
    };
  }

  it("passes through an `all: true` array of public addresses unchanged (the shape http.request sends by default)", () => {
    const results: Array<{ err: unknown; address: unknown }> = [];
    const addresses: LookupAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "2001:4860:4860::8888", family: 6 },
    ];
    const vetted = createVettingLookup(stubLookupAll(addresses));
    vetted("public.example", { family: 0, all: true }, (err, address) => results.push({ err, address }));
    expect(results).toEqual([{ err: null, address: addresses }]);
  });

  it("refuses the whole delivery when any member of an `all: true` array is blocked, without filtering it out", () => {
    const results: Array<{ err: unknown }> = [];
    // One public member alongside one blocked member: the conservative reading is to
    // refuse the whole delivery rather than silently drop the blocked member and
    // proceed with only the public one.
    const addresses: LookupAddress[] = [
      { address: "2001:4860:4860::8888", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ];
    const vetted = createVettingLookup(stubLookupAll(addresses));
    vetted("mixed.example", { family: 0, all: true }, (err) => results.push({ err }));
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
    expect((results[0]?.err as Error).message).toContain("127.0.0.1");
  });

  it("refuses a `localhost`-shaped `all: true` result ([::1, 127.0.0.1]), both members blocked", () => {
    const results: Array<{ err: unknown }> = [];
    const addresses: LookupAddress[] = [
      { address: "::1", family: 6 },
      { address: "127.0.0.1", family: 4 },
    ];
    const vetted = createVettingLookup(stubLookupAll(addresses));
    vetted("localhost", { family: 0, all: true }, (err) => results.push({ err }));
    expect(results[0]?.err).toBeInstanceOf(EgressBlockedError);
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

  it("refuses delivery, through the full deliverRestricted path, when an `all: true` resolved array contains a blocked member (e.g. [203.0.113.5, 127.0.0.1])", async () => {
    // 203.0.113.5 is TEST-NET-3 (RFC 5737), a real public documentation address that is
    // not in our restricted ranges; 127.0.0.1 is loopback. This drives the exact shape
    // `http.request` sends by default end to end (not just createVettingLookup in
    // isolation), using the real production `vetAddress` default (no test seam needed:
    // 127.0.0.1 is genuinely blocked in production).
    const stubbedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, [
        { address: "203.0.113.5", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
    };
    const transport = webhookTransport({ restrictEgress: true, lookup: stubbedLookup });
    await expect(transport.deliver("http://mixed.example/hook", "C")).rejects.toThrow(EgressBlockedError);
  });

  it("delivers successfully end-to-end against a real local server when the resolver answers with the `all: true` array shape", async () => {
    // This is the gap that hid the CRITICAL finding: every prior restricted-mode test
    // stubbed a resolver that ignored `options` and answered with a single address, so
    // none of them ever drove the array shape `http.request` actually sends by default
    // (autoSelectFamily on, `{hints, all: true}`) through a real connection. This test
    // spins up a real local HTTP server and proves restricted-mode delivery actually
    // succeeds against it when the resolver returns that array shape.
    //
    // The server can only bind to loopback here, and production's default `vetAddress`
    // correctly refuses loopback (already covered above and in the single-address
    // tests). To prove the *success* path end-to-end without weakening that production
    // default, this test uses the narrow `vetAddress` test seam (see transports.ts) so
    // the public/blocked decision for this resolved address is controlled by the test,
    // not by patching the real restricted ranges.
    let receivedBody = "";
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        receivedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200).end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr !== "object") throw new Error("no server address");

    try {
      const stubbedLookup: LookupFunction = (_hostname, _options, callback) => {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      };
      const transport = webhookTransport({
        restrictEgress: true,
        lookup: stubbedLookup,
        vetAddress: () => false, // test seam only: treat every address as public
      });
      await transport.deliver(`http://test-host.internal:${addr.port}/hook`, "PAYLOAD");
      expect(JSON.parse(receivedBody)).toEqual({ ciphertext: "PAYLOAD" });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});

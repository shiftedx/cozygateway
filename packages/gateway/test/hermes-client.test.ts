import { afterEach, describe, expect, it } from "vitest";

import {
  createHermesClient,
  computeReconnectDelay,
  HermesRpcError,
  HermesUnavailable,
  type HermesClient,
} from "../src/hermes-bridge/client.ts";
import { startFakeHermesServer, NO_REPLY, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const TOKEN = "SECRET-HERMES-TOKEN-4d3c2b1a";

const servers: FakeHermesServer[] = [];
const clients: HermesClient[] = [];

async function fakeServer(behavior?: Parameters<typeof startFakeHermesServer>[0]): Promise<FakeHermesServer> {
  const server = await startFakeHermesServer(behavior);
  servers.push(server);
  return server;
}

function client(url: string, overrides?: Partial<Parameters<typeof createHermesClient>[0]>): HermesClient {
  const c = createHermesClient({
    url,
    token: TOKEN,
    reconnect: { minMs: 15, maxMs: 80 },
    ...overrides,
  });
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("computeReconnectDelay", () => {
  it("doubles per attempt and caps at maxMs", () => {
    const policy = { minMs: 100, maxMs: 800 };
    const noJitter = () => 0.5;
    expect(computeReconnectDelay(1, policy, noJitter)).toBe(100);
    expect(computeReconnectDelay(3, policy, noJitter)).toBe(400);
    expect(computeReconnectDelay(9, policy, noJitter)).toBe(800);
  });
});

describe("handshake and auth", () => {
  it("reaches online on gateway.ready and dials with the credential on the URL", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");
    expect(server.queries()[0]).toBe(`token=${TOKEN}`);
  });

  it("uses the ticket parameter when configured for a public bind", async () => {
    const server = await fakeServer();
    const c = client(server.url, { authParam: "ticket" });
    c.start();
    await until(() => c.state() === "online");
    expect(server.queries()[0]).toBe(`ticket=${TOKEN}`);
  });

  it("force-closes and retries a connection that never sends gateway.ready", async () => {
    const server = await fakeServer({ neverSendReady: true });
    const c = client(server.url, { handshakeTimeoutMs: 60 });
    c.start();
    await until(() => server.totalConnections() >= 2, 4_000);
    expect(c.state()).not.toBe("online");
  });

  it("stops retrying after an auth refusal (close 4401)", async () => {
    const server = await fakeServer({ refuseNextConnections: 99, refuseWithCode: 4401 });
    const lines: string[] = [];
    const c = client(server.url, { logSink: (line) => lines.push(line) });
    c.start();
    await until(() => c.state() === "absent" && server.totalConnections() >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(server.totalConnections()).toBe(1);
    expect(lines.join("")).toContain("close code 4401");
    expect(lines.join("")).not.toContain(TOKEN);
  });
});

describe("request correlation", () => {
  it("correlates strictly by id when responses arrive out of request order", async () => {
    let releaseSlow: (() => void) | undefined;
    const server = await fakeServer({
      methods: {
        // "slow" defers its reply; the test releases it only after "fast" has already answered,
        // so the two responses land in the reverse of the request order.
        slow: (_params, ctx) => {
          releaseSlow = () => ctx.reply({ which: "slow" });
          return NO_REPLY;
        },
        fast: () => ({ which: "fast" }),
      },
    });
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const slow = c.request("slow", {});
    await until(() => releaseSlow !== undefined);
    expect(await c.request("fast", {})).toEqual({ which: "fast" });

    releaseSlow?.();
    expect(await slow).toEqual({ which: "slow" });
  });

  it("resolves a whole burst answered back to front, each caller with its own result", async () => {
    const deferred: Array<{ n: unknown; ctx: { reply(result: unknown): void } }> = [];
    const server = await fakeServer({
      methods: {
        echo: (params, ctx) => {
          deferred.push({ n: params["n"], ctx });
          return NO_REPLY;
        },
      },
    });
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const calls = [c.request("echo", { n: 1 }), c.request("echo", { n: 2 }), c.request("echo", { n: 3 })];
    await until(() => deferred.length === 3);
    for (const entry of [...deferred].reverse()) entry.ctx.reply({ n: entry.n });

    expect(await Promise.all(calls)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("preserves the gateway's unknown-method error text verbatim", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    await expect(c.request("bots.list", {})).rejects.toBeInstanceOf(HermesRpcError);
    const err = await c.request("bots.list", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermesRpcError);
    expect((err as HermesRpcError).message).toBe("unknown method: bots.list");
    expect((err as HermesRpcError).message).toMatch(/unknown method/i);
    expect((err as HermesRpcError).code).toBe(4001);
  });

  it("rejects with HermesUnavailable when offline", async () => {
    const server = await fakeServer({ neverSendReady: true });
    const c = client(server.url, { handshakeTimeoutMs: 5_000 });
    c.start();
    await expect(c.request("profiles.list", {})).rejects.toBeInstanceOf(HermesUnavailable);
  });

  it("fails in-flight requests when the socket drops under them", async () => {
    const server = await fakeServer({ methods: { hang: () => NO_REPLY }, dropOnMethod: [] });
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");
    const pending = c.request("hang", {});
    await until(() => server.callsOf("hang").length === 1);
    server.dropAll();
    await expect(pending).rejects.toBeInstanceOf(HermesUnavailable);
  });
});

describe("reconnect", () => {
  it("reconnects after a server-initiated drop and reaches online again", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");
    expect(server.totalConnections()).toBe(1);

    server.dropAll();
    await until(() => c.state() !== "online");
    await until(() => c.state() === "online", 4_000);
    expect(server.totalConnections()).toBeGreaterThanOrEqual(2);
  });
});

describe("event stream", () => {
  it("delivers change broadcasts, and tolerates a gateway that never sends them", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    const seen: string[] = [];
    c.onEvent((event) => seen.push(event.type));
    c.start();
    await until(() => c.state() === "online");
    expect(seen).toContain("gateway.ready");

    server.sendEvent("sessions.changed", { reason: "prompt" });
    server.sendEvent("cron.changed", {});
    await until(() => seen.includes("sessions.changed") && seen.includes("cron.changed"));

    // A silent gateway is still a working gateway: requests keep flowing with no events at all.
    const silent = await fakeServer({ methods: { ping: () => ({ ok: true }) } });
    const c2 = client(silent.url);
    c2.start();
    await until(() => c2.state() === "online");
    expect(await c2.request("ping", {})).toEqual({ ok: true });
  });
});

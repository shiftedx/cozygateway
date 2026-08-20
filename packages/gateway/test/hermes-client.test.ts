import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHermesClient,
  computeReconnectDelay,
  MAX_TICKET_RETRIES,
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
    auth: { mode: "token", token: TOKEN },
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
    const c = client(server.url, { auth: { mode: "token", token: TOKEN, param: "ticket" } });
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

describe("liveness", () => {
  // Issue #63: a monitor that only reads `state()`/the capability id cannot tell "online" from
  // "stuck reconnecting for hours", because neither of those ever changes shape while a bridge is
  // down. `liveness()` is the snapshot that answers it -- a boolean-shaped `online`, when it last
  // changed, and how many consecutive reconnects have failed since.
  it("reports online with a zeroed reconnectAttempt once the handshake completes", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    const before = c.liveness();
    expect(before.state).toBe("absent");
    expect(before.reconnectAttempt).toBe(0);
    c.start();
    await until(() => c.state() === "online");
    const after = c.liveness();
    expect(after.state).toBe("online");
    expect(after.reconnectAttempt).toBe(0);
    expect(after.since).toBeGreaterThanOrEqual(before.since);
  });

  it("keeps state connecting and counts up reconnectAttempt while the link cannot come up", async () => {
    const server = await fakeServer({ neverSendReady: true });
    const c = client(server.url, { handshakeTimeoutMs: 30 });
    c.start();
    await until(() => server.totalConnections() >= 3, 4_000);
    const liveness = c.liveness();
    expect(liveness.state).toBe("connecting");
    expect(liveness.reconnectAttempt).toBeGreaterThanOrEqual(2);
  });

  it("stamps `since` at the moment state last changed, not on every read", async () => {
    const server = await fakeServer({ neverSendReady: true });
    const c = client(server.url, { handshakeTimeoutMs: 30 });
    c.start();
    await until(() => c.liveness().reconnectAttempt >= 1);
    const first = c.liveness();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = c.liveness();
    // Still `connecting` on both reads (the same state), so `since` must not have moved just
    // because time passed between the two calls.
    if (second.state === first.state) {
      expect(second.since).toBe(first.since);
    }
  });
});

describe("gated password auth", () => {
  const USERNAME = "cozybridge";
  const PASSWORD = "SECRET-DASH-PASSWORD-9f8e7d6c";

  async function gatedServer(
    overrides?: Parameters<typeof startFakeHermesServer>[0],
  ): Promise<FakeHermesServer> {
    return fakeServer({ gated: { username: USERNAME, password: PASSWORD }, ...overrides });
  }

  function gatedClient(
    server: FakeHermesServer,
    overrides?: Partial<Parameters<typeof createHermesClient>[0]>,
  ): HermesClient {
    return client(server.url, {
      auth: { mode: "password", baseUrl: server.baseUrl, username: USERNAME, password: PASSWORD },
      ...overrides,
    });
  }

  it("logs in, mints a ticket, and dials with it", async () => {
    const server = await gatedServer();
    const lines: string[] = [];
    const c = gatedClient(server, { logSink: (line) => lines.push(line) });
    c.start();
    await until(() => c.state() === "online");

    expect(server.loginCount()).toBe(1);
    expect(server.ticketMintCount()).toBe(1);
    expect(server.queries()[0]).toBe(`ticket=${server.mintedTickets()[0]}`);
    // Nothing secret reaches the log sink: not the password, not the session, not the ticket.
    expect(lines.join("")).not.toContain(PASSWORD);
    expect(lines.join("")).not.toContain(server.mintedTickets()[0]);
  });

  it("mints a FRESH ticket for every reconnect without logging in again", async () => {
    const server = await gatedServer();
    const c = gatedClient(server);
    c.start();
    await until(() => c.state() === "online");

    server.dropAll();
    await until(() => server.totalConnections() >= 2 && c.state() === "online");

    const [first, second] = server.queries();
    expect(first).not.toBe(second);
    expect(server.ticketMintCount()).toBe(2);
    expect(server.mintedTickets()).toHaveLength(2);
    // The session cookie survives the reconnect; only the ticket is re-minted.
    expect(server.loginCount()).toBe(1);
  });

  it("rejects a replayed ticket, because tickets are single-use", async () => {
    const server = await gatedServer();
    const c = gatedClient(server);
    c.start();
    await until(() => c.state() === "online");

    const consumed = server.mintedTickets()[0];
    const replay = new WebSocket(`${server.url}?ticket=${consumed}`);
    const code = await new Promise<number>((resolve) => replay.on("close", (value) => resolve(value)));
    expect(code).toBe(4401);
  });

  it("logs in again when the session has expired under a reconnect", async () => {
    const server = await gatedServer();
    const c = gatedClient(server);
    c.start();
    await until(() => c.state() === "online");

    server.expireSessions();
    server.dropAll();
    await until(() => c.state() === "online" && server.totalConnections() >= 2);

    // One 401 on the ws-ticket mint, one re-login, then a second (successful) mint.
    expect(server.loginCount()).toBe(2);
    expect(server.ticketMintCount()).toBe(3);
  });

  it("retries a bounded number of times when the ticket is refused, then fails closed", async () => {
    // A 0ms TTL means every ticket is born expired, so the upgrade is always closed 4401.
    const server = await gatedServer({ ticketTtlMs: 0 });
    const lines: string[] = [];
    const c = gatedClient(server, { logSink: (line) => lines.push(line) });
    c.start();
    await until(() => c.state() === "absent" && server.totalConnections() >= 1, 5_000);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The first dial plus MAX_TICKET_RETRIES re-mints, and then it stops.
    expect(server.totalConnections()).toBe(1 + MAX_TICKET_RETRIES);
    expect(lines.join("")).toContain("re-minting");
    expect(lines.join("")).toContain("close code 4401");
  });

  it("never dials and never retries when the password is wrong", async () => {
    const server = await gatedServer();
    const lines: string[] = [];
    const c = gatedClient(server, {
      auth: { mode: "password", baseUrl: server.baseUrl, username: USERNAME, password: "not-the-password" },
      logSink: (line) => lines.push(line),
    });
    c.start();
    await until(() => c.state() === "absent" && server.loginCount() >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.loginCount()).toBe(1);
    expect(server.totalConnections()).toBe(0);
    expect(lines.join("")).toContain("HTTP 401");
    expect(lines.join("")).not.toContain("not-the-password");
  });

  it("logs in against a configured non-basic provider", async () => {
    const server = await gatedServer({ gated: { username: USERNAME, password: PASSWORD, provider: "ldap" } });
    const c = gatedClient(server, {
      auth: {
        mode: "password",
        baseUrl: server.baseUrl,
        username: USERNAME,
        password: PASSWORD,
        provider: "ldap",
      },
    });
    c.start();
    await until(() => c.state() === "online");
    expect(server.loginCount()).toBe(1);
  });

  it("names the provider when the dashboard does not register it (HTTP 404)", async () => {
    const server = await gatedServer({ gated: { username: USERNAME, password: PASSWORD, provider: "ldap" } });
    const lines: string[] = [];
    // Default provider "basic" against a dashboard that only registers "ldap": upstream answers a
    // generic 404, so the message has to say which provider was tried.
    const c = gatedClient(server, { logSink: (line) => lines.push(line) });
    c.start();
    await until(() => c.state() === "absent" && server.loginCount() >= 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(server.loginCount()).toBe(1);
    expect(server.totalConnections()).toBe(0);
    expect(lines.join("")).toContain('no password auth provider named "basic"');
    expect(lines.join("")).toContain("HTTP 404");
    expect(lines.join("")).not.toContain(PASSWORD);
  });

  it("retries with backoff when the dashboard is unreachable", async () => {
    const server = await gatedServer();
    const lines: string[] = [];
    // Port 1 on loopback refuses instantly, so every login attempt fails at the transport layer.
    const c = client(server.url, {
      auth: { mode: "password", baseUrl: "http://127.0.0.1:1", username: USERNAME, password: PASSWORD },
      logSink: (line) => lines.push(line),
    });
    c.start();
    await until(() => lines.join("").includes("could not obtain a hermes credential"), 4_000);
    expect(c.state()).not.toBe("online");
    expect(server.totalConnections()).toBe(0);
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

  it("does not let a throwing handler kill the link or block later handlers (cozygateway#65)", async () => {
    const server = await fakeServer({ methods: { ping: () => ({ ok: true }) } });
    const lines: string[] = [];
    const c = client(server.url, { logSink: (line) => lines.push(line) });

    const seenByLater: string[] = [];
    c.onEvent(function boom() {
      throw new Error("tool-activity persist blew up");
    });
    c.onEvent((event) => seenByLater.push(event.type));

    c.start();
    await until(() => c.state() === "online");
    // "gateway.ready" already ran both handlers once during the handshake; the throwing handler
    // must not have taken the link down under it.
    expect(seenByLater).toContain("gateway.ready");

    server.sendEvent("sessions.changed", { reason: "prompt" });
    await until(() => seenByLater.includes("sessions.changed"));

    // The socket is still the same working link: RPC settlement (the other consumer of this exact
    // message listener) is unaffected by the handler that threw.
    expect(await c.request("ping", {})).toEqual({ ok: true });
    expect(c.state()).toBe("online");

    expect(lines.join("")).toContain("boom");
    expect(lines.join("")).toContain("gateway.ready");
  });
});

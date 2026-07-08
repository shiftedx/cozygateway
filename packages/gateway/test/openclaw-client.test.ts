import { afterEach, describe, expect, it } from "vitest";

import { createOpenClawClient, computeReconnectDelay, type OpenClawClient } from "../src/adapters/openclaw/client.ts";
import { generateDeviceIdentity } from "../src/adapters/openclaw/device-auth.ts";
import type { ServerFrame } from "../src/adapters/openclaw/protocol.ts";
import { startFakeOpenClawServer, type FakeOpenClawServer } from "./support/fake-openclaw-server.ts";

const TOKEN = "SECRET-TOKEN-9f8e7d6c5b4a";

const servers: FakeOpenClawServer[] = [];
const clients: OpenClawClient[] = [];

async function fakeServer(behavior?: Parameters<typeof startFakeOpenClawServer>[0]): Promise<FakeOpenClawServer> {
  const server = await startFakeOpenClawServer(behavior);
  servers.push(server);
  return server;
}

function client(url: string, overrides?: Partial<Parameters<typeof createOpenClawClient>[0]>): OpenClawClient {
  const c = createOpenClawClient({
    url,
    token: TOKEN,
    identity: generateDeviceIdentity(),
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

function trackStates(c: OpenClawClient): string[] {
  const states: string[] = [];
  c.onStateChange((s) => states.push(s));
  return states;
}

describe("computeReconnectDelay", () => {
  it("grows exponentially with attempt and caps at maxMs, with no randomness injected", () => {
    const policy = { minMs: 100, maxMs: 800 };
    const noJitter = () => 0.5; // (0.5*2-1) = 0 jitter
    expect(computeReconnectDelay(1, policy, noJitter)).toBe(100);
    expect(computeReconnectDelay(2, policy, noJitter)).toBe(200);
    expect(computeReconnectDelay(3, policy, noJitter)).toBe(400);
    expect(computeReconnectDelay(4, policy, noJitter)).toBe(800);
    expect(computeReconnectDelay(5, policy, noJitter)).toBe(800); // capped
    expect(computeReconnectDelay(10, policy, noJitter)).toBe(800); // still capped
  });

  it("never returns below minMs or above maxMs even at jitter extremes", () => {
    const policy = { minMs: 50, maxMs: 200 };
    expect(computeReconnectDelay(1, policy, () => 0)).toBeGreaterThanOrEqual(policy.minMs);
    expect(computeReconnectDelay(1, policy, () => 1)).toBeGreaterThanOrEqual(policy.minMs);
    expect(computeReconnectDelay(6, policy, () => 0)).toBeLessThanOrEqual(policy.maxMs);
    expect(computeReconnectDelay(6, policy, () => 1)).toBeLessThanOrEqual(policy.maxMs);
  });
});

describe("scenario (a): connect -> challenge -> signed-connect -> hello-ok reaches online", () => {
  it("start() drives the handshake to online, and request() round-trips a method call", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    const states = trackStates(c);

    expect(c.state()).toBe("absent");
    c.start();
    await until(() => c.state() === "online");
    expect(states).toContain("connecting");
    expect(states[states.length - 1]).toBe("online");
    expect(server.totalConnections()).toBe(1);

    const result = await c.request("chat.send", { sessionKey: "s1", text: "hi" });
    expect(result).toEqual({});
  });
});

describe("scenario (b): protocol mismatch fails closed without a retry storm", () => {
  it("leaves the client absent and does not open a second connection", async () => {
    const server = await fakeServer({ protocolVersion: 3 });
    const c = client(server.url);
    c.start();

    await until(() => c.state() === "absent");
    expect(server.totalConnections()).toBe(1);

    // Give ample time (many multiples of minMs) for a retry-storm to reveal itself, if present.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(c.state()).toBe("absent");
    expect(server.totalConnections()).toBe(1);
  });
});

describe("scenario (c): server-initiated drop reconnects with growing, capped backoff", () => {
  it("reconnects online -> connecting -> online, with each retry delay non-decreasing and capped at maxMs", async () => {
    const server = await fakeServer();
    const reconnect = { minMs: 30, maxMs: 150 };
    const c = client(server.url, { reconnect });
    c.start();
    await until(() => c.state() === "online");
    expect(server.totalConnections()).toBe(1);

    // Force 3 consecutive reconnect FAILURES (server terminates the socket immediately, before
    // any handshake frame) so the backoff counter climbs across several attempts before the 4th
    // attempt is finally allowed to complete the handshake and reach online again.
    server.setBehavior({ failNextConnections: 3 });

    // A single loop drives both the wait and the connectTimes recording, so there is no race
    // between an independent poller and the wait condition (a separate setInterval racing a
    // separate until() can observe the wait condition become true one tick before the poller
    // has recorded the final connectTimes entry, undercounting it).
    const connectTimes: number[] = [Date.now()];
    const dropAt = Date.now();
    server.dropAll();

    const deadline = Date.now() + 5_000;
    for (;;) {
      const total = server.totalConnections();
      while (connectTimes.length < total) connectTimes.push(Date.now());
      if (connectTimes.length >= 5 && c.state() === "online") break;
      if (Date.now() > deadline) throw new Error("timed out waiting for the 5th connection to reach online");
      await new Promise((resolve) => setTimeout(resolve, 4));
    }

    expect(connectTimes.length).toBeGreaterThanOrEqual(5);
    const delay1 = connectTimes[1]! - dropAt;
    const delay2 = connectTimes[2]! - connectTimes[1]!;
    const delay3 = connectTimes[3]! - connectTimes[2]!;
    const delay4 = connectTimes[4]! - connectTimes[3]!;

    // Non-decreasing trend across attempts (allow ties from scheduling noise, not decreases).
    expect(delay2).toBeGreaterThanOrEqual(delay1 - 10);
    expect(delay3).toBeGreaterThanOrEqual(delay2 - 10);
    // A clear overall growth signal comparing attempts far enough apart to survive scheduling
    // jitter (bases 30ms -> 120ms, a 4x spread).
    expect(delay3).toBeGreaterThan(delay1 * 1.5);
    // The cap: no observed delay exceeds maxMs by more than scheduling/poll slack.
    for (const d of [delay1, delay2, delay3, delay4]) {
      expect(d).toBeLessThanOrEqual(reconnect.maxMs + 60);
    }
  });
});

describe("scenario (d): request() rejects when the socket drops before a response", () => {
  it("rejects the in-flight request on a mid-turn drop", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    server.setBehavior({ dropOnMethod: ["chat.send"] });
    await expect(c.request("chat.send", { sessionKey: "s1", text: "hi" })).rejects.toThrow();

    // The client recovers: the drop is just a disconnect, and it reconnects on its own.
    server.setBehavior({ dropOnMethod: [] });
    await until(() => c.state() === "online");
  });

  it("rejects a request attempted while not online, without sending anything", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    // Never started: state is "absent".
    await expect(c.request("chat.send", { text: "hi" })).rejects.toThrow(/absent/);
  });
});

describe("scenario (e): tick silence beyond tickIntervalMs*2 closes with 4000 and reconnects", () => {
  it("closes the wire with the tick-timeout code and reconnects", async () => {
    const server = await fakeServer({ tickIntervalMs: 20, silent: true });
    const c = client(server.url);
    const states = trackStates(c);
    c.start();

    await until(() => c.state() === "online");
    // Silence for longer than tickIntervalMs*2 (40ms): the watchdog must fire.
    await until(() => server.closeCodes().includes(4000), 2_000);

    // And the client recovers on its own: connecting again, then online again.
    await until(() => states.filter((s) => s === "online").length >= 2, 2_000);
    expect(states).toContain("connecting");
  });
});

describe("scenario (f): the token never appears in any log line or thrown error message", () => {
  it("stays out of logs across a normal connect, a protocol mismatch, and a mid-turn drop", async () => {
    const logLines: string[] = [];
    const errorMessages: string[] = [];
    const logSink = (line: string): void => {
      logLines.push(line);
    };

    // Normal connect + a round-tripped request.
    const okServer = await fakeServer();
    const okClient = client(okServer.url, { logSink });
    okClient.start();
    await until(() => okClient.state() === "online");
    await okClient.request("chat.send", { sessionKey: "s1", text: "hi" });

    // A version mismatch: fails closed, logs a reason.
    const mismatchServer = await fakeServer({ protocolVersion: 999 });
    const mismatchClient = client(mismatchServer.url, { logSink });
    mismatchClient.start();
    await until(() => mismatchClient.state() === "absent");

    // A mid-turn drop: the request rejects with an Error whose message we also capture.
    okServer.setBehavior({ dropOnMethod: ["chat.send"] });
    try {
      await okClient.request("chat.send", { sessionKey: "s1", text: "hi again" });
    } catch (err) {
      errorMessages.push((err as Error).message);
    }
    // A rejection while not online, also captured.
    const neverStarted = client(okServer.url, { logSink });
    try {
      await neverStarted.request("chat.send", { text: "x" });
    } catch (err) {
      errorMessages.push((err as Error).message);
    }

    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) expect(line).not.toContain(TOKEN);
    expect(errorMessages.length).toBeGreaterThan(0);
    for (const message of errorMessages) expect(message).not.toContain(TOKEN);
  });
});

describe("close()", () => {
  it("is idempotent, cancels any pending reconnect, and fails outstanding requests", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    server.setBehavior({ dropOnMethod: ["chat.send"] });
    const pendingBeforeClose = c.request("chat.send", { text: "hi" }).catch((err: Error) => err);

    await c.close();
    await c.close(); // idempotent: no throw, no hang

    const settled = await pendingBeforeClose;
    expect(settled).toBeInstanceOf(Error);
    expect(c.state()).toBe("absent");

    // No reconnect happens after close, even after waiting past the backoff window.
    const totalAtClose = server.totalConnections();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.totalConnections()).toBe(totalAtClose);
  });
});

describe("onEvent", () => {
  it("forwards tick events once online", async () => {
    const server = await fakeServer({ tickIntervalMs: 20 });
    const c = client(server.url);
    const events: ServerFrame[] = [];
    c.onEvent((frame) => events.push(frame));
    c.start();
    await until(() => c.state() === "online");
    await until(() => events.some((e) => e.kind === "tick"), 2_000);
  });
});

/** Builds a `chat.delta` wire event with the exact payload shape the client's ASSUMPTION-tagged
 *  `sessionKeyOf`/`isReplyEnd` helpers read: `sessionKey` identifies the session, `message`
 *  defaults to "" (meaning "no cumulative snapshot on this event", per `accumulateDelta`'s
 *  contract), and `done: true` is the reply-end marker. */
function deltaFrame(input: {
  sessionKey: string;
  deltaText: string;
  message?: string;
  replace?: boolean;
  done?: boolean;
}): Record<string, unknown> {
  return {
    type: "event",
    event: "chat.delta",
    payload: {
      sessionKey: input.sessionKey,
      deltaText: input.deltaText,
      message: input.message ?? "",
      ...(input.replace !== undefined ? { replace: input.replace } : {}),
      ...(input.done !== undefined ? { done: input.done } : {}),
    },
  };
}

describe("subscribeSession: per-session delta filtering", () => {
  it("delivers deltas only to their own subscribed session, and drops an unsubscribed session's event", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const aDeltas: string[] = [];
    const bDeltas: string[] = [];
    c.subscribeSession("session-a", { onDelta: (s) => aDeltas.push(s), onDone: () => {}, onError: () => {} });
    const unsubscribeB = c.subscribeSession("session-b", {
      onDelta: (s) => bDeltas.push(s),
      onDone: () => {},
      onError: () => {},
    });

    server.sendEvent(deltaFrame({ sessionKey: "session-a", deltaText: "Hello" }));
    server.sendEvent(deltaFrame({ sessionKey: "session-c", deltaText: "never subscribed" }));
    server.sendEvent(deltaFrame({ sessionKey: "session-b", deltaText: "World" }));

    await until(() => aDeltas.length >= 1 && bDeltas.length >= 1);
    // Give the (dropped) foreign-session event ample time to have arrived, if it were wrongly
    // delivered, before asserting it never was.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(aDeltas).toEqual(["Hello"]);
    expect(bDeltas).toEqual(["World"]);

    // Unsubscribing stops further delivery to that session's handlers.
    unsubscribeB();
    server.sendEvent(deltaFrame({ sessionKey: "session-b", deltaText: " again" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bDeltas).toEqual(["World"]);
  });
});

describe("subscribeSession: accumulateDelta replace/append semantics", () => {
  it("replace:true replaces the accumulated snapshot; replace absent/false appends", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: string[] = [];
    c.subscribeSession("s1", { onDelta: (s) => snapshots.push(s), onDone: () => {}, onError: () => {} });

    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Hello" })); // absent -> append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: " World", replace: false })); // false -> append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Replaced", replace: true })); // true -> replace

    await until(() => snapshots.length >= 3);
    expect(snapshots).toEqual(["Hello", "Hello World", "Replaced"]);
  });
});

describe("subscribeSession: cumulative message wins over local accumulation", () => {
  it("uses the server's cumulative message snapshot when present, agreeing with it exactly", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: string[] = [];
    c.subscribeSession("s1", { onDelta: (s) => snapshots.push(s), onDone: () => {}, onError: () => {} });

    server.sendEvent(
      deltaFrame({ sessionKey: "s1", deltaText: "ignored-local-delta", message: "authoritative snapshot" }),
    );

    await until(() => snapshots.length >= 1);
    expect(snapshots[0]).toBe("authoritative snapshot");
  });
});

describe("subscribeSession: reply-end fires onDone exactly once", () => {
  it("fires onDone once on the terminal marker and ignores deltas received after it", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: string[] = [];
    let doneCount = 0;
    c.subscribeSession("s1", {
      onDelta: (s) => snapshots.push(s),
      onDone: () => {
        doneCount += 1;
      },
      onError: () => {},
    });

    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Hi", done: true }));
    // A second terminal event and a plain trailing delta must both be ignored: onDone must not
    // fire again, and onDelta must not observe either.
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Hi", done: true }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: " more after end" }));

    await until(() => snapshots.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(snapshots).toEqual(["Hi"]);
    expect(doneCount).toBe(1);
  });
});

describe("subscribeSession: onError on disconnect before reply-end", () => {
  it("fires onError, without token content, when the connection drops mid-reply", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const errors: string[] = [];
    c.subscribeSession("s1", { onDelta: () => {}, onDone: () => {}, onError: (message) => errors.push(message) });

    server.dropAll();
    await until(() => errors.length >= 1);
    expect(errors[0]).not.toContain(TOKEN);
  });
});

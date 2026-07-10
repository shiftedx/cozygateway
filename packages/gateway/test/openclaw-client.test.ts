import { afterEach, describe, expect, it } from "vitest";

import {
  createOpenClawClient,
  computeReconnectDelay,
  type OpenClawClient,
  type SessionToolCall,
} from "../src/adapters/openclaw/client.ts";
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

describe("scenario (g): handshake deadline bounds connecting -> online", () => {
  // Real timers, like every other reconnect/backoff scenario in this file: the assertions below
  // use generous margins (a fresh connection observed well within 3s of a 60ms deadline) rather
  // than pinning exact timing, so ordinary scheduling jitter cannot flake them.

  it("a gateway that never sends hello-ok times out the handshake and forces a reconnect", async () => {
    const server = await fakeServer({ neverSendChallenge: true });
    const c = client(server.url, { handshakeTimeoutMs: 60 });
    const states = trackStates(c);
    c.start();

    await until(() => server.totalConnections() >= 1);
    expect(c.state()).toBe("connecting");

    // The handshake deadline must force a close and a fresh connection attempt: proof the client
    // did not sit in "connecting" forever with no watchdog.
    await until(() => server.totalConnections() >= 2, 3_000);
    expect(states).toContain("connecting");
    // hello-ok never arrives from this server, so "online" must never appear either.
    expect(states).not.toContain("online");
    expect(c.state()).toBe("connecting");
  });

  it("a bad_signature connect rejection without a socket close still trips the handshake deadline", async () => {
    const logLines: string[] = [];
    const server = await fakeServer({ forceBadSignature: true });
    const c = client(server.url, { handshakeTimeoutMs: 60, logSink: (line) => logLines.push(line) });
    c.start();

    // The rejection must be observable: a content-free diagnostic log line naming the error code,
    // never the token or the server's own `.reason` text.
    await until(() => logLines.some((l) => l.includes("bad_signature")), 3_000);
    for (const line of logLines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("device signature did not verify");
    }

    // Nothing on the server side ever closes this socket: only the client's OWN handshake
    // deadline can be what eventually forces the close and reconnect.
    await until(() => server.totalConnections() >= 2, 3_000);
    expect(c.state()).not.toBe("online");
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

/** Builds a `chat` wire event in the shape PINNED by the Task 8 live study: `sessionKey` identifies
 *  the session, `state` is `delta` while streaming or `final` (the reply-end marker) when `done` is
 *  set, `deltaText` is the incremental chunk, and `message` (when present) is the cumulative
 *  assistant STRUCT (an object) that `accumulateDelta` deliberately ignores for text. */
function deltaFrame(input: {
  sessionKey: string;
  deltaText?: string;
  messageObject?: unknown;
  replace?: boolean;
  done?: boolean;
  state?: "delta" | "final" | "error" | "aborted";
  runId?: string;
}): Record<string, unknown> {
  return {
    type: "event",
    event: "chat",
    payload: {
      sessionKey: input.sessionKey,
      state: input.state ?? (input.done ? "final" : "delta"),
      ...(input.deltaText !== undefined ? { deltaText: input.deltaText } : {}),
      ...(input.replace !== undefined ? { replace: input.replace } : {}),
      ...(input.messageObject !== undefined ? { message: input.messageObject } : {}),
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
    },
  };
}

/** The cumulative assistant-message struct the real wire carries on a `chat` event, with the
 *  given per-message cumulative text at `content[0].text` (see `messageTextOf` in client.ts). */
function assistantMessage(text: string): unknown {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() };
}

describe("subscribeSession: per-session delta filtering", () => {
  it("delivers deltas only to their own subscribed session, and drops an unsubscribed session's event", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const aDeltas: string[] = [];
    const bDeltas: string[] = [];
    c.subscribeSession("session-a", {
      onDelta: (s) => aDeltas.push(s),
      onDone: () => {},
      onError: () => {},
      onToolCalls: () => {},
    });
    const unsubscribeB = c.subscribeSession("session-b", {
      onDelta: (s) => bDeltas.push(s),
      onDone: () => {},
      onError: () => {},
      onToolCalls: () => {},
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
    c.subscribeSession("s1", {
      onDelta: (s) => snapshots.push(s),
      onDone: () => {},
      onError: () => {},
      onToolCalls: () => {},
    });

    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Hello" })); // absent -> append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: " World", replace: false })); // false -> append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Replaced", replace: true })); // true -> replace

    await until(() => snapshots.length >= 3);
    expect(snapshots).toEqual(["Hello", "Hello World", "Replaced"]);
  });
});

describe("subscribeSession: the cumulative message snapshot is authoritative for text (issue #15)", () => {
  it("follows message.content[0].text, not deltaText, when a well-formed message is present", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: string[] = [];
    c.subscribeSession("s1", {
      onDelta: (s) => snapshots.push(s),
      onDone: () => {},
      onError: () => {},
      onToolCalls: () => {},
    });

    // Since issue #15 the per-message cumulative `message` snapshot is authoritative (fix point 1).
    // To prove the accumulator follows it (not merely that the two happen to agree), deltaText here
    // is deliberately garbled while message.content[0].text carries the true cumulative text: the
    // running snapshot must track the message, never the deltaText.
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "XXX", messageObject: assistantMessage("Hel") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "YYY", messageObject: assistantMessage("Hello") }));

    await until(() => snapshots.length >= 2);
    expect(snapshots).toEqual(["Hel", "Hello"]);
  });
});

describe("subscribeSession: message-partitioned accumulation (issue #15 regression fixtures)", () => {
  /** A complete, well-formed answer used across the interleaving fixtures. */
  const X = "The magic number in `magic-number.txt` is **7431**.";

  /** Subscribes and returns collectors: every onDelta snapshot, plus the snapshot captured at the
   *  moment onDone fires (the value the adapter commits, since onDone reads the last onDelta). */
  function collect(c: OpenClawClient, sessionKey: string): { deltas: string[]; committed: () => string | undefined } {
    const deltas: string[] = [];
    let committed: string | undefined;
    c.subscribeSession(sessionKey, {
      onDelta: (s) => deltas.push(s),
      onDone: () => {
        committed = deltas.at(-1);
      },
      onError: () => {},
      onToolCalls: () => {},
    });
    return { deltas, committed: () => committed };
  }

  it("(a) converges the A1,B1,A2,B2 interleaving incident to the clean text, not the doubled string", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const { committed } = collect(c, "s1");
    const runId = "run-shared";
    // Two independent 2-chunk reconstructions of the SAME final text X, split at different offsets
    // (3 and 37), whose deltas arrive INTERLEAVED as A1,B1,A2,B2 -- the exact shape that folded into
    // the 102-char doubled string in the study's section 2b. Each frame carries its own stream's
    // cumulative message.content[0].text, and all share one runId + sessionKey.
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, deltaText: X.slice(0, 3), messageObject: assistantMessage(X.slice(0, 3)) })); // A1
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, deltaText: X.slice(0, 37), messageObject: assistantMessage(X.slice(0, 37)) })); // B1
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, deltaText: X.slice(3), messageObject: assistantMessage(X) })); // A2
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, deltaText: X.slice(37), messageObject: assistantMessage(X) })); // B2
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage(X), done: true }));

    await until(() => committed() !== undefined);
    expect(committed()).toBe(X);
    expect(committed()).toHaveLength(51);
    // The specific pre-fix corruption must not recur.
    expect(committed()).not.toBe(
      "TheThe magic number in `magic-number.txt magic number in `magic-number.txt` is **7431**.` is **7431**.",
    );
  });

  it("(b) two different runIds on one sessionKey: last run wins, no concatenation", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const { committed } = collect(c, "s1");
    // Run 1 streams a full message, with no terminal marker; run 2 (a genuine duplicate/replayed
    // run on the same sessionKey) then starts under a DIFFERENT runId and must discard run 1 whole.
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId: "r1", messageObject: assistantMessage("First") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId: "r1", messageObject: assistantMessage("First answer") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId: "r2", messageObject: assistantMessage("Second") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId: "r2", messageObject: assistantMessage("Second answer") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId: "r2", messageObject: assistantMessage("Second answer"), done: true }));

    await until(() => committed() !== undefined);
    expect(committed()).toBe("Second answer");
    expect(committed()).not.toContain("First");
  });

  it("(c) message absent on all frames: byte-identical to the delta append/replace fallback", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const { deltas, committed } = collect(c, "s1");
    // No `message`, no `runId`: the fallback path must behave exactly as the old flat accumulator.
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Hello" })); // append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: " World", replace: false })); // append
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Replaced", replace: true, done: true })); // replace + end

    await until(() => committed() !== undefined);
    expect(deltas).toEqual(["Hello", "Hello World", "Replaced"]);
    expect(committed()).toBe("Replaced");
  });

  it("(d) legitimate two-message turn: both messages committed, joined by a blank line, in order", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const { committed } = collect(c, "s1");
    const runId = "run-multi"; // one constant runId across the whole turn (boundary is message-driven, not runId-driven).
    // Message 1 grows to completion...
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage("Let me") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage("Let me check that") }));
    // ...then message 2's snapshot regresses AND is not a prefix of message 1: a real boundary.
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage("The answer") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage("The answer is 42") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", runId, messageObject: assistantMessage("The answer is 42"), done: true }));

    await until(() => committed() !== undefined);
    expect(committed()).toBe("Let me check that\n\nThe answer is 42");
  });

  it("(e) out-of-order older frame (wire text a strict prefix of held): ignored, no regression", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const { deltas, committed } = collect(c, "s1");
    server.sendEvent(deltaFrame({ sessionKey: "s1", messageObject: assistantMessage("Hello world") }));
    // A strict prefix of what we hold: an out-of-order older frame of the SAME message. It must be
    // ignored -- neither regress the snapshot nor open a new segment.
    server.sendEvent(deltaFrame({ sessionKey: "s1", messageObject: assistantMessage("Hello") }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", messageObject: assistantMessage("Hello world"), done: true }));

    await until(() => committed() !== undefined);
    expect(committed()).toBe("Hello world");
    // The snapshot never dipped to "Hello": every delivered draft stayed at the full held text.
    expect(deltas).toEqual(["Hello world", "Hello world", "Hello world"]);
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
      onToolCalls: () => {},
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

  it("routes a terminal error/aborted state to onError, never onDone (no partial commit as success)", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    let doneCount = 0;
    const errors: string[] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {
        doneCount += 1;
      },
      onError: (message) => errors.push(message),
      onToolCalls: () => {},
    });

    // Partial text streamed, then the turn ERRORS (or is aborted) mid-reply.
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "partial answer" }));
    server.sendEvent(deltaFrame({ sessionKey: "s1", state: "error" }));

    await until(() => errors.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(doneCount).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("error");
    // The error message names only the state, never streamed content.
    expect(errors[0]).not.toContain("partial answer");
  });

  it("does not wipe the accumulated reply on a terminal frame with replace:true and no deltaText", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: string[] = [];
    let finalSnapshot: string | undefined;
    c.subscribeSession("s1", {
      onDelta: (s) => snapshots.push(s),
      onDone: () => {
        finalSnapshot = snapshots.at(-1);
      },
      onError: () => {},
      onToolCalls: () => {},
    });

    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "Complete answer" }));
    // A terminal final with replace:true but NO deltaText must not reset the snapshot to empty.
    server.sendEvent(deltaFrame({ sessionKey: "s1", state: "final", replace: true }));

    await until(() => finalSnapshot !== undefined);
    expect(finalSnapshot).toBe("Complete answer");
  });
});

describe("subscribeSession: onError on disconnect before reply-end", () => {
  it("fires onError, without token content, when the connection drops mid-reply", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const errors: string[] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {},
      onError: (message) => errors.push(message),
      onToolCalls: () => {},
    });

    server.dropAll();
    await until(() => errors.length >= 1);
    expect(errors[0]).not.toContain(TOKEN);
  });
});

/** Agent tool item frame in the live-pinned wire shape (see protocol tests / the design spec). */
function toolFrame(input: {
  sessionKey: string;
  toolCallId: string;
  name?: string;
  phase: "start" | "end";
  failed?: boolean;
}): Record<string, unknown> {
  return {
    type: "event",
    event: "agent",
    payload: {
      sessionKey: input.sessionKey,
      stream: "item",
      data: {
        itemId: `tool:${input.toolCallId}`,
        kind: "tool",
        phase: input.phase,
        toolCallId: input.toolCallId,
        name: input.name ?? "read",
        status: input.phase === "start" ? "running" : input.failed ? "failed" : "completed",
        ...(input.failed ? { error: "ENOENT: secret-path" } : {}),
      },
    },
  };
}

describe("subscribeSession: tool call snapshots", () => {
  it("folds start/end pairs into running -> ok chips, and failed ends into error chips", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t1", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t1", phase: "end" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t2", name: "exec", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "t2", phase: "end", failed: true }));

    await until(() => snapshots.length >= 4);
    expect(snapshots[0]).toEqual([{ id: "t1", name: "read", status: "running" }]);
    expect(snapshots[1]).toEqual([{ id: "t1", name: "read", status: "ok" }]);
    expect(snapshots[2]).toEqual([
      { id: "t1", name: "read", status: "ok" },
      { id: "t2", name: "exec", status: "running" },
    ]);
    expect(snapshots[3]).toEqual([
      { id: "t1", name: "read", status: "ok" },
      { id: "t2", name: "exec", status: "error" },
    ]);
  });

  it("keeps insertion order stable and each snapshot a fresh array", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "a", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "b", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "a", phase: "end" }));

    await until(() => snapshots.length >= 3);
    // "a" keeps its first-seen position after its end frame overwrites its status.
    expect(snapshots[2]!.map((call) => call.id)).toEqual(["a", "b"]);
    // Fresh array per callback: mutating an earlier snapshot cannot corrupt a later one.
    expect(snapshots[0]).not.toBe(snapshots[1]);
    expect(snapshots[0]).toEqual([{ id: "a", name: "read", status: "running" }]);
  });

  it("drops tool frames for unsubscribed sessions silently, with no content in any log line", async () => {
    const logged: string[] = [];
    const server = await fakeServer();
    const c = client(server.url, { logSink: (line) => logged.push(line) });
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    c.subscribeSession("mine", {
      onDelta: () => {},
      onDone: () => {},
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent(toolFrame({ sessionKey: "theirs", toolCallId: "foreign-tool", phase: "start" }));
    server.sendEvent(toolFrame({ sessionKey: "mine", toolCallId: "t1", phase: "start" }));

    await until(() => snapshots.length >= 1);
    expect(snapshots[0]).toEqual([{ id: "t1", name: "read", status: "running" }]);
    // The foreign frame's content must appear nowhere in the log (silent drop; the chat drop
    // line already flags foreign traffic, and agent frames are several-per-turn noise).
    const allLogs = logged.join("\n");
    expect(allLogs).not.toContain("foreign-tool");
    expect(allLogs).not.toContain("theirs");
  });

  it("ignores tool frames after the reply ended and non-tool agent streams entirely", async () => {
    const server = await fakeServer();
    const c = client(server.url);
    c.start();
    await until(() => c.state() === "online");

    const snapshots: SessionToolCall[][] = [];
    let done = false;
    c.subscribeSession("s1", {
      onDelta: () => {},
      onDone: () => {
        done = true;
      },
      onError: () => {},
      onToolCalls: (calls) => snapshots.push(calls),
    });

    server.sendEvent({
      type: "event",
      event: "agent",
      payload: { sessionKey: "s1", stream: "lifecycle", data: { phase: "start" } },
    });
    server.sendEvent(deltaFrame({ sessionKey: "s1", deltaText: "hi", done: true }));
    await until(() => done);
    server.sendEvent(toolFrame({ sessionKey: "s1", toolCallId: "late", phase: "start" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(snapshots).toEqual([]);
  });
});

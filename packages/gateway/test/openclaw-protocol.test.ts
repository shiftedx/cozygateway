import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  TICK_TIMEOUT_CLOSE_CODE,
  ConnectChallengeEventSchema,
  HelloOkResponseSchema,
  ResponseFrameSchema,
  ChatEventSchema,
  TickEventSchema,
  AgentEventSchema,
  parseServerFrame,
  buildConnectRequest,
  toolItemOf,
} from "../src/adapters/openclaw/protocol.ts";
import { check } from "cozygateway-contract";

describe("OpenClaw protocol constants", () => {
  it("pins protocol version 4 and the tick-timeout close code", () => {
    expect(PROTOCOL_VERSION).toBe(4);
    expect(TICK_TIMEOUT_CLOSE_CODE).toBe(4000);
  });
});

describe("parseServerFrame", () => {
  it("parses a hello-ok response and exposes the tick interval", () => {
    const frame = parseServerFrame({
      type: "res",
      id: "1",
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        server: { version: "x", connId: "c" },
        features: { methods: [], events: [] },
        auth: { role: "operator", scopes: ["operator.read"] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 15000 },
      },
    });
    expect(frame?.kind).toBe("hello-ok");
    if (frame?.kind === "hello-ok") expect(frame.payload.policy.tickIntervalMs).toBe(15000);
  });

  it("parses a connect.challenge event", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n1", ts: 1720000000000 },
    });
    expect(frame?.kind).toBe("challenge");
    if (frame?.kind === "challenge") {
      expect(frame.payload.nonce).toBe("n1");
      expect(frame.payload.ts).toBe(1720000000000);
    }
  });

  it("parses a chat delta event carrying sessionKey, state, deltaText, and replace", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "chat",
      payload: {
        sessionKey: "s1",
        state: "delta",
        deltaText: "ello",
        replace: false,
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
      },
    });
    expect(frame?.kind).toBe("chat");
    if (frame?.kind === "chat") {
      expect(frame.payload.sessionKey).toBe("s1");
      expect(frame.payload.state).toBe("delta");
      expect(frame.payload.deltaText).toBe("ello");
      expect(frame.payload.replace).toBe(false);
    }
  });

  it("parses a terminal (final) chat event as the reply-end marker", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "chat",
      payload: { sessionKey: "s1", state: "final", stopReason: "stop" },
    });
    expect(frame?.kind).toBe("chat");
    if (frame?.kind === "chat") {
      expect(frame.payload.state).toBe("final");
      expect(frame.payload.deltaText).toBeUndefined();
    }
  });

  it("rejects a chat event with an unknown state", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "chat",
      payload: { sessionKey: "s1", state: "bogus" },
    });
    expect(frame).toBeUndefined();
  });

  it("parses a tick event", () => {
    const frame = parseServerFrame({ type: "event", event: "tick" });
    expect(frame?.kind).toBe("tick");
  });

  it("parses a generic ok response (not hello-ok)", () => {
    const frame = parseServerFrame({
      type: "res",
      id: "2",
      ok: true,
      payload: { sessionKey: "s1" },
    });
    expect(frame?.kind).toBe("response");
    if (frame?.kind === "response" && frame.ok) {
      expect((frame.payload as Record<string, unknown>).sessionKey).toBe("s1");
    }
  });

  it("parses an error response", () => {
    const frame = parseServerFrame({
      type: "res",
      id: "3",
      ok: false,
      error: { details: { code: "bad_request", reason: "malformed session key" } },
    });
    expect(frame?.kind).toBe("response");
    if (frame?.kind === "response" && !frame.ok) {
      expect(frame.error.details.code).toBe("bad_request");
    }
  });

  it("tolerates unknown extra fields on every frame kind (open objects)", () => {
    const helloOk = parseServerFrame({
      type: "res",
      id: "1",
      ok: true,
      payload: {
        type: "hello-ok",
        protocol: 4,
        server: { version: "x", connId: "c", futureField: "z" },
        features: { methods: [], events: [] },
        auth: { role: "operator", scopes: [] },
        policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1000 },
        fromTheFuture: true,
      },
      unknownEnvelopeField: 42,
    });
    expect(helloOk?.kind).toBe("hello-ok");

    const challenge = parseServerFrame({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "n1", ts: 1, extra: "x" },
      seq: 1,
      stateVersion: 1,
    });
    expect(challenge?.kind).toBe("challenge");

    const delta = parseServerFrame({
      type: "event",
      event: "chat",
      payload: { sessionKey: "s1", state: "delta", deltaText: "a", replace: true, extra: "y" },
    });
    expect(delta?.kind).toBe("chat");
  });

  it("returns undefined for a frame with an unknown type", () => {
    expect(parseServerFrame({ type: "unknown", foo: "bar" })).toBeUndefined();
  });

  it("returns undefined for a malformed frame missing required discriminants", () => {
    expect(parseServerFrame({ type: "event" })).toBeUndefined();
    expect(parseServerFrame({ type: "res" })).toBeUndefined();
    expect(parseServerFrame(null)).toBeUndefined();
    expect(parseServerFrame("not an object")).toBeUndefined();
  });
});

describe("schema guards directly", () => {
  it("check() accepts a well-formed HelloOkResponse and rejects a malformed one", () => {
    expect(
      check(HelloOkResponseSchema, {
        type: "res",
        id: "1",
        ok: true,
        payload: {
          type: "hello-ok",
          protocol: 4,
          server: { version: "x", connId: "c" },
          features: { methods: [], events: [] },
          auth: { role: "operator", scopes: [] },
          policy: { maxPayload: 1, maxBufferedBytes: 1, tickIntervalMs: 1000 },
        },
      }),
    ).toBe(true);
    expect(check(HelloOkResponseSchema, { type: "res", id: "1", ok: true, payload: { type: "not-hello-ok" } })).toBe(
      false,
    );
  });

  it("check() rejects an unknown top-level type on the raw envelopes", () => {
    expect(check(ConnectChallengeEventSchema, { type: "req", event: "connect.challenge", payload: {} })).toBe(false);
    expect(check(ResponseFrameSchema, { type: "event", id: "1", ok: true })).toBe(false);
  });

  it("check() accepts both the ok and error variants of ResponseFrame", () => {
    expect(check(ResponseFrameSchema, { type: "res", id: "1", ok: true, payload: {} })).toBe(true);
    expect(
      check(ResponseFrameSchema, {
        type: "res",
        id: "1",
        ok: false,
        error: { details: { code: "x", reason: "y" } },
      }),
    ).toBe(true);
    expect(check(ResponseFrameSchema, { type: "res", id: "1", ok: false })).toBe(false);
  });

  it("check() accepts ChatEvent and TickEvent shapes", () => {
    expect(
      check(ChatEventSchema, {
        type: "event",
        event: "chat",
        payload: { sessionKey: "s1", state: "delta", deltaText: "a" },
      }),
    ).toBe(true);
    // A non-"chat" event name is not a ChatEvent.
    expect(
      check(ChatEventSchema, { type: "event", event: "agent", payload: { sessionKey: "s1", state: "delta" } }),
    ).toBe(false);
    expect(check(TickEventSchema, { type: "event", event: "tick" })).toBe(true);
    expect(check(TickEventSchema, { type: "event", event: "not-tick" })).toBe(false);
  });
});

describe("outbound request builders", () => {
  it("buildConnectRequest places the token at params.auth.token, pins protocol 4, and role operator", () => {
    const req = buildConnectRequest({
      id: "req-1",
      token: "secret-token",
      nonce: "n1",
      device: {
        id: "device-1",
        publicKey: "pub-key",
        signature: "sig",
        signedAt: 1720000000000,
      },
    });
    expect(req.type).toBe("req");
    expect(req.id).toBe("req-1");
    expect(req.method).toBe("connect");
    expect(req.params.auth.token).toBe("secret-token");
    expect(req.params.minProtocol).toBe(4);
    expect(req.params.maxProtocol).toBe(4);
    expect(req.params.role).toBe("operator");
    expect(req.params.device?.nonce).toBe("n1");
    expect(req.params.device?.id).toBe("device-1");
    // The client block presents a valid client identity whose fields the signature covers; mode is
    // a real client mode ("backend"), distinct from the connection role ("operator").
    expect(req.params.client.id).toBe("gateway-client");
    expect(req.params.client.mode).toBe("backend");
    expect(req.params.client.platform).toBe("server");
    expect(req.params.client.deviceFamily).toBe("server");
  });

  it("buildConnectRequest omits device when not supplied (token-only connect attempt)", () => {
    const req = buildConnectRequest({ id: "req-2", token: "t" });
    expect(req.params.device).toBeUndefined();
    expect(req.params.auth.token).toBe("t");
  });
});

/** Live-captured tool item frames (openclaw@2026.6.11, 2026-07-09; see
 *  docs/specs/2026-07-09-openclaw-tool-chips-design.md). */
function agentToolFrame(data: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId: "cabc10f1-b12f-486b-8a3d-dc8d70480b86",
      sessionKey: "agent:main:dashboard:b8400f2f",
      stream: "item",
      data,
      seq: 3,
      ts: 1783629483751,
      isHeartbeat: false,
    },
    seq: 4,
  };
}

const TOOL_START = {
  itemId: "tool:790639779",
  phase: "start",
  kind: "tool",
  title: "read from magic-number.txt",
  status: "running",
  name: "read",
  meta: "from magic-number.txt",
  toolCallId: "790639779",
  startedAt: 1783629483750,
};

const TOOL_END_OK = { ...TOOL_START, phase: "end", status: "completed", endedAt: 1783629483774 };

const TOOL_END_FAILED = {
  ...TOOL_START,
  phase: "end",
  status: "failed",
  error: "ENOENT: no such file or directory, access '/workspace/totally-missing-xyz.txt'",
  endedAt: 1783629574578,
};

describe("parseServerFrame: agent events", () => {
  it("parses a live-captured agent item frame as kind agent", () => {
    const frame = parseServerFrame(agentToolFrame(TOOL_START));
    expect(frame?.kind).toBe("agent");
    if (frame?.kind === "agent") {
      expect(frame.payload.sessionKey).toBe("agent:main:dashboard:b8400f2f");
      expect(frame.payload.stream).toBe("item");
    }
  });

  it("parses an agent lifecycle frame (no data requirements beyond the envelope)", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "agent",
      payload: { sessionKey: "s1", stream: "lifecycle", data: { phase: "start" } },
    });
    expect(frame?.kind).toBe("agent");
  });

  it("rejects an agent frame with no sessionKey (falls through to unrecognized)", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "agent",
      payload: { stream: "item", data: TOOL_START },
    });
    expect(frame).toBeUndefined();
  });
});

describe("toolItemOf", () => {
  function agentEvent(payload: Record<string, unknown>) {
    const frame = parseServerFrame({ type: "event", event: "agent", payload });
    if (frame?.kind !== "agent") throw new Error("fixture did not parse as agent");
    return frame;
  }

  it("narrows a live-captured start frame: running phase, not failed", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_START }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "start", failed: false });
  });

  it("narrows a completed end frame as not failed", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_END_OK }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "end", failed: false });
  });

  it("narrows a failed end frame as failed (status failed)", () => {
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: TOOL_END_FAILED }));
    expect(item?.failed).toBe(true);
  });

  it("treats an error field as failure even without status failed", () => {
    const data = { ...TOOL_END_OK, status: "completed", error: "boom" };
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data }));
    expect(item?.failed).toBe(true);
  });

  it("maps an unknown end status without an error field to not-failed", () => {
    const data = { ...TOOL_END_OK, status: "some-future-status" };
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data }));
    expect(item).toEqual({ toolCallId: "790639779", name: "read", phase: "end", failed: false });
  });

  it("falls back to itemId when toolCallId is missing, and yields undefined when both are missing", () => {
    const noToolCallId: Record<string, unknown> = { ...TOOL_START };
    delete noToolCallId["toolCallId"];
    const viaItemId = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noToolCallId }));
    expect(viaItemId?.toolCallId).toBe("tool:790639779");

    const noIds: Record<string, unknown> = { ...noToolCallId };
    delete noIds["itemId"];
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noIds }))).toBeUndefined();
  });

  it("falls back to a generic name when name is missing", () => {
    const noName: Record<string, unknown> = { ...TOOL_START };
    delete noName["name"];
    const item = toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: noName }));
    expect(item?.name).toBe("tool");
  });

  it("yields undefined for non-item streams, non-tool kinds, unknown phases, and missing data", () => {
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "assistant", data: { ...TOOL_START } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: { ...TOOL_START, kind: "message" } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item", data: { ...TOOL_START, phase: "middle" } }))).toBeUndefined();
    expect(toolItemOf(agentEvent({ sessionKey: "s1", stream: "item" }))).toBeUndefined();
  });
});

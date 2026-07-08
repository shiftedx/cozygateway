import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  TICK_TIMEOUT_CLOSE_CODE,
  ConnectChallengeEventSchema,
  HelloOkResponseSchema,
  ResponseFrameSchema,
  ChatDeltaEventSchema,
  TickEventSchema,
  parseServerFrame,
  buildConnectRequest,
  buildChatSendRequest,
  buildSessionsCreateRequest,
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

  it("parses a chat delta event carrying deltaText, cumulative message, and replace", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "chat.delta",
      payload: { deltaText: "ello", message: "Hello", replace: false },
    });
    expect(frame?.kind).toBe("delta");
    if (frame?.kind === "delta") {
      expect(frame.payload.deltaText).toBe("ello");
      expect(frame.payload.message).toBe("Hello");
      expect(frame.payload.replace).toBe(false);
    }
  });

  it("tolerates a chat delta event without the optional replace field", () => {
    const frame = parseServerFrame({
      type: "event",
      event: "chat.delta",
      payload: { deltaText: "hi", message: "hi" },
    });
    expect(frame?.kind).toBe("delta");
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
      event: "chat.delta",
      payload: { deltaText: "a", message: "a", replace: true, extra: "y" },
    });
    expect(delta?.kind).toBe("delta");
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

  it("check() accepts ChatDeltaEvent and TickEvent shapes", () => {
    expect(
      check(ChatDeltaEventSchema, {
        type: "event",
        event: "chat.delta",
        payload: { deltaText: "a", message: "a" },
      }),
    ).toBe(true);
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
  });

  it("buildConnectRequest omits device when not supplied (token-only connect attempt)", () => {
    const req = buildConnectRequest({ id: "req-2", token: "t" });
    expect(req.params.device).toBeUndefined();
    expect(req.params.auth.token).toBe("t");
  });

  it("buildChatSendRequest places sessionKey and text under params", () => {
    const req = buildChatSendRequest({ id: "req-3", sessionKey: "sess-1", text: "hello" });
    expect(req).toEqual({
      type: "req",
      id: "req-3",
      method: "chat.send",
      params: { sessionKey: "sess-1", text: "hello" },
    });
  });

  it("buildSessionsCreateRequest returns a typed request with a caller-supplied id", () => {
    const req = buildSessionsCreateRequest({ id: "req-4" });
    expect(req).toEqual({ type: "req", id: "req-4", method: "sessions.create", params: {} });
  });
});

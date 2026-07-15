import { describe, expect, it } from "vitest";

import type { Agent, GatewayInfo, Message, Thread } from "../src/resources.ts";
import { AgentSchema, ERROR_CODES, GatewayInfoSchema, MessageSchema, ThreadSchema } from "../src/resources.ts";
import { check } from "../src/validate.ts";

describe("resource schemas", () => {
  it("accepts a full agent", () => {
    const agent: Agent = {
      id: "a1",
      name: "Sage",
      avatar: "owl",
      backend: "mock",
      presence: "online",
    };
    expect(check(AgentSchema, agent)).toBe(true);
  });

  it("accepts a thread with a null lastMessageAt", () => {
    const thread: Thread = {
      id: "t1",
      agentId: "a1",
      title: "New thread",
      createdAt: 1_720_000_000_000,
      lastMessageAt: null,
    };
    expect(check(ThreadSchema, thread)).toBe(true);
  });

  it("accepts committed messages including a turn.failed marker", () => {
    const message: Message = {
      threadId: "t1",
      seq: 3,
      role: "system",
      blocks: [{ type: "paragraph", text: "The agent turn failed." }],
      turnId: "turn-9",
      marker: "turn.failed",
      createdAt: 1_720_000_000_000,
    };
    expect(check(MessageSchema, message)).toBe(true);
  });

  it("rejects seq 0 (seq starts at 1)", () => {
    expect(
      check(MessageSchema, {
        threadId: "t1",
        seq: 0,
        role: "user",
        blocks: [],
        createdAt: 1,
      }),
    ).toBe(false);
  });

  it("rejects an unknown presence and an unknown role", () => {
    expect(check(AgentSchema, { id: "a", name: "n", backend: "mock", presence: "away" })).toBe(false);
    expect(
      check(MessageSchema, { threadId: "t", seq: 1, role: "bot", blocks: [], createdAt: 1 }),
    ).toBe(false);
  });

  it("freezes the error code list", () => {
    expect(ERROR_CODES).toContain("unauthorized");
    expect(ERROR_CODES).toContain("not_found");
    expect(ERROR_CODES).toContain("invalid_request");
  });

  // Issue #16: GatewayInfo.capabilities is an additive v1.x field. A receiver must tolerate it
  // present, absent (pre-#16 gateways), and populated with ids it has never heard of.
  describe("GatewayInfo.capabilities", () => {
    it("accepts a populated capabilities map, including a com.cozylabs.* vendor id", () => {
      const info: GatewayInfo = {
        name: "g",
        version: "1.0.0",
        contract: "v1",
        capabilities: { "com.cozylabs.test": 1 },
      };
      expect(check(GatewayInfoSchema, info)).toBe(true);
    });

    it("accepts a GatewayInfo with no capabilities field at all (a gateway that predates it)", () => {
      const legacy = { name: "g", version: "0.9.0", contract: "v1" };
      expect(check(GatewayInfoSchema, legacy)).toBe(true);
    });

    it("accepts an empty capabilities map", () => {
      const info: GatewayInfo = { name: "g", version: "1.0.0", contract: "v1", capabilities: {} };
      expect(check(GatewayInfoSchema, info)).toBe(true);
    });

    it("tolerates a capability id a client has never heard of, mixed with a known one", () => {
      const info: GatewayInfo = {
        name: "g",
        version: "1.0.0",
        contract: "v1",
        capabilities: { "com.cozylabs.test": 1, "com.cozylabs.some-future-thing": 42 },
      };
      expect(check(GatewayInfoSchema, info)).toBe(true);
    });

    it("rejects a non-integer capability version", () => {
      expect(
        check(GatewayInfoSchema, {
          name: "g",
          version: "1.0.0",
          contract: "v1",
          capabilities: { "com.cozylabs.test": "one" },
        }),
      ).toBe(false);
    });
  });
});

describe("contract v1.x additive message fields", () => {
  const base = {
    threadId: "t1",
    seq: 1,
    role: "user" as const,
    blocks: [{ type: "paragraph", text: "hi" }],
    createdAt: 0,
  };

  it("accepts a user message with no delivery (delivery absent means turn)", () => {
    expect(check(MessageSchema, base)).toBe(true);
  });

  it("accepts delivery 'turn' and 'steer' and rejects any other value", () => {
    expect(check(MessageSchema, { ...base, delivery: "turn" })).toBe(true);
    expect(check(MessageSchema, { ...base, delivery: "steer" })).toBe(true);
    expect(check(MessageSchema, { ...base, delivery: "queue" })).toBe(false);
  });

  it("accepts both turn.failed and turn.interrupted markers on a system message", () => {
    const sys = { ...base, role: "system" as const, turnId: "x" };
    expect(check(MessageSchema, { ...sys, marker: "turn.failed" })).toBe(true);
    expect(check(MessageSchema, { ...sys, marker: "turn.interrupted" })).toBe(true);
    expect(check(MessageSchema, { ...sys, marker: "turn.aborted" })).toBe(false);
  });

  it("lists interrupt_unsupported as a known error code", () => {
    expect(ERROR_CODES).toContain("interrupt_unsupported");
  });
});

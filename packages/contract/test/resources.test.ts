import { describe, expect, it } from "vitest";

import type { Agent, Message, Thread } from "../src/resources.ts";
import { AgentSchema, ERROR_CODES, MessageSchema, ThreadSchema } from "../src/resources.ts";
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
});

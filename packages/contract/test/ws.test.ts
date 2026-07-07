import { describe, expect, it } from "vitest";

import type { ClientFrame, ServerFrame } from "../src/ws.ts";
import { ClientFrameSchema, ServerFrameSchema } from "../src/ws.ts";
import { check } from "../src/validate.ts";

describe("client frames", () => {
  it("accepts auth and sync", () => {
    const auth: ClientFrame = { type: "auth", token: "tok" };
    const sync: ClientFrame = { type: "sync", threads: { t1: 0, t2: 17 } };
    expect(check(ClientFrameSchema, auth)).toBe(true);
    expect(check(ClientFrameSchema, sync)).toBe(true);
  });

  it("rejects a negative sinceSeq and an unknown type", () => {
    expect(check(ClientFrameSchema, { type: "sync", threads: { t1: -1 } })).toBe(false);
    expect(check(ClientFrameSchema, { type: "send", text: "hi" })).toBe(false);
  });
});

describe("server frames", () => {
  it("accepts the full lifecycle frames", () => {
    const frames: ServerFrame[] = [
      { type: "ready", deviceId: "d1", gateway: { name: "g", version: "0.1.0", contract: "v1" } },
      {
        type: "committed",
        threadId: "t1",
        seq: 4,
        message: {
          threadId: "t1",
          seq: 4,
          role: "agent",
          blocks: [{ type: "paragraph", text: "done" }],
          turnId: "turn-1",
          createdAt: 1,
        },
      },
      {
        type: "draft",
        threadId: "t1",
        turnId: "turn-1",
        blocks: [{ type: "paragraph", text: "thinking" }],
        toolCalls: [{ id: "c1", name: "search", status: "running" }],
      },
      { type: "done", threadId: "t1", turnId: "turn-1" },
      { type: "presence", agentId: "a1", state: "absent" },
      { type: "error", code: "backend_unavailable", message: "agent offline", threadId: "t1" },
      { type: "synced" },
    ];
    for (const frame of frames) {
      expect(check(ServerFrameSchema, frame)).toBe(true);
    }
  });
});

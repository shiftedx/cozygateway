import { describe, expect, it } from "vitest";

import type { PairRequest, SendMessageRequest } from "../src/rest.ts";
import {
  CreateThreadRequestSchema,
  PairRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
} from "../src/rest.ts";
import { check } from "../src/validate.ts";

describe("REST schemas", () => {
  it("accepts a pair request without a pubkey", () => {
    const req: PairRequest = { setupCode: "ABCD-1234", deviceName: "Kyle's phone" };
    expect(check(PairRequestSchema, req)).toBe(true);
  });

  it("rejects an empty device name", () => {
    expect(check(PairRequestSchema, { setupCode: "x", deviceName: "" })).toBe(false);
  });

  it("requires agentId to create a thread; title is optional", () => {
    expect(check(CreateThreadRequestSchema, { agentId: "a1" })).toBe(true);
    expect(check(CreateThreadRequestSchema, { title: "no agent" })).toBe(false);
  });

  it("rejects an empty rename", () => {
    expect(check(RenameThreadRequestSchema, { title: "" })).toBe(false);
  });

  it("requires at least one block to send", () => {
    const ok: SendMessageRequest = { blocks: [{ type: "paragraph", text: "hi" }] };
    expect(check(SendMessageRequestSchema, ok)).toBe(true);
    expect(check(SendMessageRequestSchema, { blocks: [] })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { check } from "cozygateway-contract";

import {
  AttachInboundFrameSchema,
  AttachTurnFrameSchema,
} from "../src/adapters/attach/protocol.ts";
import { blocksToText } from "../src/adapters/attach/blocks-to-text.ts";

describe("attach protocol schemas", () => {
  it("accepts a draft update with blocks and tool calls", () => {
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: {
          kind: "draft",
          turnId: "turn-1",
          blocks: [{ type: "paragraph", text: "hi" }],
          toolCalls: [{ id: "search#1", name: "search", status: "running" }],
        },
      }),
    ).toBe(true);
  });

  it("accepts a draft update without toolCalls (optional when empty)", () => {
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "draft", turnId: "turn-1", blocks: [] },
      }),
    ).toBe(true);
  });

  it("accepts done and failed updates", () => {
    expect(
      check(AttachInboundFrameSchema, { threadId: "t1", update: { kind: "done", turnId: "turn-1" } }),
    ).toBe(true);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "failed", turnId: "turn-1", message: "model unreachable" },
      }),
    ).toBe(true);
  });

  it("rejects unknown kinds, missing ids, and malformed members", () => {
    expect(check(AttachInboundFrameSchema, { threadId: "t1", update: { kind: "working" } })).toBe(false);
    expect(check(AttachInboundFrameSchema, { update: { kind: "done", turnId: "x" } })).toBe(false);
    expect(check(AttachInboundFrameSchema, { threadId: "", update: { kind: "done", turnId: "x" } })).toBe(false);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: { kind: "draft", turnId: "x", blocks: [{ type: "nonsense" }] },
      }),
    ).toBe(false);
    expect(
      check(AttachInboundFrameSchema, {
        threadId: "t1",
        update: {
          kind: "draft",
          turnId: "x",
          blocks: [],
          toolCalls: [{ id: "a", name: "b", status: "started" }],
        },
      }),
    ).toBe(false);
  });

  it("validates the outbound turn frame shape", () => {
    expect(
      check(AttachTurnFrameSchema, { kind: "turn", threadId: "t1", turnId: "turn-1", text: "hello" }),
    ).toBe(true);
    expect(check(AttachTurnFrameSchema, { kind: "turn", threadId: "t1", turnId: "turn-1" })).toBe(false);
  });

  describe("open-object tolerance (unknown extra fields ignored)", () => {
    it("tolerates unknown fields on a draft update frame", () => {
      expect(
        check(AttachInboundFrameSchema, {
          threadId: "t1",
          fromTheFuture: true,
          update: {
            kind: "draft",
            turnId: "turn-1",
            blocks: [{ type: "paragraph", text: "hi", futureField: "x" }],
            toolCalls: [{ id: "search#1", name: "search", status: "running", extra: "chip-color" }],
            unknownFrameField: 42,
          },
        }),
      ).toBe(true);
    });

    it("tolerates unknown fields on a done update frame", () => {
      expect(
        check(AttachInboundFrameSchema, {
          threadId: "t1",
          update: { kind: "done", turnId: "turn-1", extraneous: "ignored" },
        }),
      ).toBe(true);
    });

    it("tolerates unknown fields on a failed update frame", () => {
      expect(
        check(AttachInboundFrameSchema, {
          threadId: "t1",
          update: {
            kind: "failed",
            turnId: "turn-1",
            message: "model unreachable",
            errorCode: "TIMEOUT",
          },
        }),
      ).toBe(true);
    });

    it("tolerates unknown fields on the outbound turn frame", () => {
      expect(
        check(AttachTurnFrameSchema, {
          kind: "turn",
          threadId: "t1",
          turnId: "turn-1",
          text: "hello",
          futureMetadata: { retryOf: "turn-0" },
        }),
      ).toBe(true);
    });
  });
});

describe("blocksToText", () => {
  it("renders every block type and joins with blank lines", () => {
    const text = blocksToText([
      { type: "heading", level: 2, text: "Title" },
      { type: "paragraph", text: "Hello there." },
      { type: "code", code: "print(1)", language: "python" },
      { type: "code", code: "raw" },
      {
        type: "list",
        ordered: true,
        items: [{ text: "first" }, { text: "task", checked: true }],
      },
      { type: "list", items: [{ text: "loose", checked: false }] },
      { type: "table", header: ["a", "b"], rows: [["1", "2"]] },
      { type: "math", latex: "x^2" },
      { type: "attachment", fileId: "f1", name: "notes.txt", mimeType: "text/plain", size: 10 },
    ]);
    expect(text).toBe(
      [
        "## Title",
        "Hello there.",
        "```python\nprint(1)\n```",
        "```\nraw\n```",
        "1. first\n2. [x] task",
        "- [ ] loose",
        "| a | b |\n| --- | --- |\n| 1 | 2 |",
        "$$\nx^2\n$$",
        "[attachment: notes.txt]",
      ].join("\n\n"),
    );
  });

  it("renders an empty block list as an empty string", () => {
    expect(blocksToText([])).toBe("");
  });
});

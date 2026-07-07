import { describe, expect, it } from "vitest";

import type { RichBlock } from "../src/rich-blocks.ts";
import { RichBlockSchema } from "../src/rich-blocks.ts";
import { check } from "../src/validate.ts";

const valid: RichBlock[] = [
  { type: "paragraph", text: "hello" },
  { type: "code", code: "let x = 1", language: "ts" },
  { type: "code", code: "no lang" },
  { type: "heading", level: 2, text: "Title" },
  { type: "list", items: [{ text: "a" }, { text: "b", checked: true }], ordered: true },
  { type: "table", header: ["k", "v"], rows: [["a", "1"]] },
  { type: "math", latex: "e^{i\\pi}" },
  { type: "attachment", fileId: "f1", name: "notes.pdf", mimeType: "application/pdf", size: 1024 },
];

describe("RichBlockSchema", () => {
  it.each(valid.map((b) => [b.type, b] as const))("accepts %s", (_type, block) => {
    expect(check(RichBlockSchema, block)).toBe(true);
  });

  it("rejects unknown block types (closed union)", () => {
    expect(check(RichBlockSchema, { type: "cardMention", taskId: "t", title: "x" })).toBe(false);
    expect(check(RichBlockSchema, { type: "html", html: "<b>" })).toBe(false);
  });

  it("rejects malformed fields", () => {
    expect(check(RichBlockSchema, { type: "heading", level: 4, text: "x" })).toBe(false);
    expect(check(RichBlockSchema, { type: "list", items: [{ text: 1 }] })).toBe(false);
    expect(check(RichBlockSchema, { type: "table", header: ["a"], rows: [[1]] })).toBe(false);
    expect(check(RichBlockSchema, { type: "attachment", fileId: "f", name: "n", mimeType: "m", size: "big" })).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import vectors from "./fixtures/markdown-blocks-vectors.json" with { type: "json" };
import { normalizeMarkdownToBlocks } from "../src/markdown-blocks.ts";
import type { RichBlock } from "cozygateway-contract";

describe("normalizeMarkdownToBlocks parity", () => {
  for (const [name, v] of Object.entries(vectors as Record<string, { text: string; blocks: RichBlock[] }>)) {
    it(`matches the reference normalizer: ${name}`, () => {
      expect(normalizeMarkdownToBlocks(v.text)).toEqual(v.blocks);
    });
  }
});

describe("normalizeMarkdownToBlocks direct unit cases", () => {
  it("emits a fenced code block", () => {
    const blocks: RichBlock[] = normalizeMarkdownToBlocks("```python\nprint(1)\n```\n");
    expect(blocks).toEqual([{ type: "code", code: "print(1)", language: "python" }]);
  });

  it("still emits a code block for an unclosed trailing fence", () => {
    const blocks: RichBlock[] = normalizeMarkdownToBlocks("```python\nprint(1)\n");
    expect(blocks).toEqual([{ type: "code", code: "print(1)\n", language: "python" }]);
  });

  it("parses a checked task list item", () => {
    const blocks: RichBlock[] = normalizeMarkdownToBlocks("- [x] done");
    expect(blocks).toEqual([{ type: "list", items: [{ text: "done", checked: true }], ordered: false }]);
  });

  it("emits a code block with no language key for a bare fence", () => {
    const blocks: RichBlock[] = normalizeMarkdownToBlocks("```\ncode\n```\n");
    expect(blocks).toEqual([{ type: "code", code: "code" }]);
    expect("language" in blocks[0]!).toBe(false);
  });
});

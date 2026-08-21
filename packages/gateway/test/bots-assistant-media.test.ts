import { describe, expect, it } from "vitest";

import {
  ASSISTANT_MEDIA_MAX_BYTES,
  assistantMediaDirectives,
  decodeAssistantMediaDataUrl,
  stripAssistantMediaDirectives,
} from "../src/hermes-bridge/assistant-media.ts";
import { sniffImageType } from "../src/hermes-bridge/photos.ts";

describe("assistant MEDIA directives", () => {
  it("accepts standalone plain and quoted forms, including paths with spaces", () => {
    const text = [
      "MEDIA:/tmp/one.png",
      "`MEDIA:/tmp/two.webp`",
      "\"MEDIA:/tmp/three.gif\"",
      "MEDIA:'/tmp/four with spaces.jpg'",
      "prefix MEDIA:/tmp/not-standalone.png",
    ].join("\n");
    expect(assistantMediaDirectives(text).map((entry) => entry.path)).toEqual([
      "/tmp/one.png",
      "/tmp/two.webp",
      "/tmp/three.gif",
      "/tmp/four with spaces.jpg",
    ]);
  });

  it("ignores directives inside backtick and tilde code fences", () => {
    const text = [
      "```text",
      "MEDIA:/tmp/example.png",
      "```",
      "~~~",
      "MEDIA:/tmp/other.png",
      "~~~~",
      "MEDIA:/tmp/live.png",
    ].join("\n");
    expect(assistantMediaDirectives(text).map((entry) => entry.path)).toEqual(["/tmp/live.png"]);
  });

  it("strips successful lines only", () => {
    const text = "ready\nMEDIA:/tmp/ok.png\nMEDIA:/tmp/missing.png";
    const directives = assistantMediaDirectives(text);
    expect(stripAssistantMediaDirectives(text, new Set([directives[0]!.key]))).toBe(
      "ready\nMEDIA:/tmp/missing.png",
    );
  });
});

describe("assistant media data URLs", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  it("decodes an allowed raster whose bytes match its MIME", () => {
    const decoded = decodeAssistantMediaDataUrl(
      `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
      sniffImageType,
    );
    expect(decoded).toMatchObject({ mime: "image/png", ext: "png", bytes: png });
  });

  it("rejects wrong types and payloads over eight megabytes before decoding", () => {
    expect(() => decodeAssistantMediaDataUrl("data:image/svg+xml;base64,PHN2Zz4=", sniffImageType)).toThrow();
    const oversized = "A".repeat(Math.ceil(ASSISTANT_MEDIA_MAX_BYTES / 3) * 4 + 1);
    expect(() => decodeAssistantMediaDataUrl(`data:image/png;base64,${oversized}`, sniffImageType)).toThrow(
      /size cap/,
    );
  });
});

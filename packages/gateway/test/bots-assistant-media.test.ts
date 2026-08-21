import { describe, expect, it } from "vitest";

import {
  ASSISTANT_AUDIO_MAX_BYTES,
  ASSISTANT_MEDIA_MAX_BYTES,
  ASSISTANT_VIDEO_MAX_BYTES,
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
    expect(decoded).toMatchObject({ mime: "image/png", ext: "png", kind: "image", bytes: png });
  });

  it("accepts declared audio and video containers and assigns their media kind", () => {
    const mp4 = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const mov = Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0]);
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const decode = (mime: string, bytes: Uint8Array) =>
      decodeAssistantMediaDataUrl(`data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, sniffImageType);

    expect(decode("video/mp4", mp4)).toMatchObject({ kind: "video", ext: "mp4" });
    expect(decode("video/quicktime", mov)).toMatchObject({ kind: "video", ext: "mov" });
    expect(decode("audio/mp4", mp4)).toMatchObject({ kind: "audio", ext: "m4a" });
    expect(decode("audio/mpeg", mp3)).toMatchObject({ kind: "audio", ext: "mp3" });
    expect(decode("audio/wav", wav)).toMatchObject({ kind: "audio", ext: "wav" });
    expect(() => decode("video/quicktime", mp4)).toThrow(/declared allowed type/);
  });

  it("rejects wrong types and payloads over eight megabytes before decoding", () => {
    expect(() => decodeAssistantMediaDataUrl("data:image/svg+xml;base64,PHN2Zz4=", sniffImageType)).toThrow();
    const oversized = "A".repeat(Math.ceil(ASSISTANT_MEDIA_MAX_BYTES / 3) * 4 + 1);
    expect(() => decodeAssistantMediaDataUrl(`data:image/png;base64,${oversized}`, sniffImageType)).toThrow(
      /size cap/,
    );
  });

  it("keeps images at eight MB while audio and video use forty MB caps", () => {
    expect(ASSISTANT_MEDIA_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ASSISTANT_AUDIO_MAX_BYTES).toBe(40 * 1024 * 1024);
    expect(ASSISTANT_VIDEO_MAX_BYTES).toBe(40 * 1024 * 1024);
  });
});

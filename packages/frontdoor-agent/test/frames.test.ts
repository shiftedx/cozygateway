import { describe, expect, it } from "vitest";

import { decodeFrame, MAX_DECODED_DATA_BYTES, MAX_MESSAGE_BYTES } from "../src/frames.ts";

describe("agent frames", () => {
  it("rejects non-canonical and oversized payloads", () => {
    expect(decodeFrame(JSON.stringify({ t: "data", sid: 1, b64: "aA" }))).toBeUndefined();
    expect(decodeFrame(JSON.stringify({
      t: "data", sid: 1, b64: Buffer.alloc(MAX_DECODED_DATA_BYTES + 1).toString("base64"),
    }))).toBeUndefined();
    expect(decodeFrame("x".repeat(MAX_MESSAGE_BYTES + 1))).toBeUndefined();
  });
});

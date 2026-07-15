import { describe, expect, it } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import { isStopPhrase, normalizeStopCandidate, stopCandidateFromBlocks } from "../src/stop-phrase.ts";

describe("normalizeStopCandidate", () => {
  it("trims, casefolds, and strips terminal .!? runs", () => {
    expect(normalizeStopCandidate("  Stop.  ")).toBe("stop");
    expect(normalizeStopCandidate("STOP IT!!!")).toBe("stop it");
    expect(normalizeStopCandidate("Cancel?")).toBe("cancel");
    expect(normalizeStopCandidate("abort")).toBe("abort");
  });
});

describe("isStopPhrase (whole-message match only)", () => {
  it("matches exactly the four phrases after normalization", () => {
    for (const yes of ["stop", "Stop.", "stop it", "STOP IT!", "cancel", "Cancel!!", "abort", "Abort."]) {
      expect(isStopPhrase(yes)).toBe(true);
    }
  });

  it("does not match a message that merely contains a stop word", () => {
    for (const no of [
      "stop adding comments to every file",
      "please stop",
      "don't abort yet",
      "cancellation policy",
      "stop it now and also do X",
      "",
      "   ",
    ]) {
      expect(isStopPhrase(no)).toBe(false);
    }
  });
});

describe("stopCandidateFromBlocks", () => {
  it("returns the text of a single paragraph block", () => {
    expect(stopCandidateFromBlocks([{ type: "paragraph", text: "stop" }])).toBe("stop");
  });

  it("returns undefined for multi-block or non-paragraph messages", () => {
    const multi: RichBlock[] = [
      { type: "paragraph", text: "stop" },
      { type: "paragraph", text: "more" },
    ];
    expect(stopCandidateFromBlocks(multi)).toBeUndefined();
    expect(stopCandidateFromBlocks([{ type: "code", code: "stop" }])).toBeUndefined();
    expect(stopCandidateFromBlocks([])).toBeUndefined();
  });
});

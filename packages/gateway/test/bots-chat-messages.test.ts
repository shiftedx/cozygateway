import { describe, expect, it } from "vitest";

import { ChatIdentityLedger, syntheticChatId } from "../src/hermes-bridge/chat-identity.ts";
import {
  CONTEXT_COMPACTION_MARKER,
  extractMessageText,
  normalizeTimestamp,
  parseChatSnapshot,
} from "../src/hermes-bridge/chat-messages.ts";

/** Hermes message shape drifts between builds and between the paths that wrote a message, so the
 *  mapping is deliberately tolerant. These are unit tests because the drift is invisible until a
 *  particular gateway build hands us a shape we did not expect, and by then it is a blank chat on
 *  someone's phone. */

describe("extractMessageText", () => {
  it("reads a plain string content", () => {
    expect(extractMessageText({ role: "assistant", content: "hello" })).toBe("hello");
  });

  it("joins an array of parts, whether the parts are strings or objects", () => {
    expect(
      extractMessageText({ content: ["one ", { text: "two " }, { content: "three" }] }),
    ).toBe("one two three");
  });

  it("ignores parts that carry no text at all, rather than stringifying them", () => {
    expect(extractMessageText({ content: [{ type: "tool_use", id: "t1" }, { text: "done" }] })).toBe("done");
  });

  it("falls back to msg.text when there is no content field", () => {
    expect(extractMessageText({ role: "user", text: "  typed this  " })).toBe("typed this");
  });

  it("yields the empty string for a message with nothing readable", () => {
    expect(extractMessageText({ role: "assistant" })).toBe("");
  });
});

describe("normalizeTimestamp", () => {
  it("promotes seconds to milliseconds and leaves milliseconds alone", () => {
    expect(normalizeTimestamp(1_755_000_000)).toBe(1_755_000_000_000);
    expect(normalizeTimestamp(1_755_000_000_000)).toBe(1_755_000_000_000);
  });

  it("accepts a numeric string and an ISO string", () => {
    expect(normalizeTimestamp("1755000000")).toBe(1_755_000_000_000);
    expect(normalizeTimestamp("2026-08-17T00:00:00.000Z")).toBe(Date.parse("2026-08-17T00:00:00.000Z"));
  });

  it("returns null for nothing usable", () => {
    expect(normalizeTimestamp(undefined)).toBeNull();
    expect(normalizeTimestamp(0)).toBeNull();
    expect(normalizeTimestamp("later")).toBeNull();
  });
});

describe("parseChatSnapshot", () => {
  const compactionCorpus = [
    {
      role: "user",
      text: [
        "[CONTEXT COMPACTION - REFERENCE ONLY]",
        "Earlier messages were compressed for the next turn.",
      ].join("\n"),
    },
    {
      role: "assistant",
      text: [
        "[PRIOR CONTEXT - for reference only; not a new message]",
        "[END OF PRIOR CONTEXT - COMPACTION SUMMARY BELOW]",
        "The user is working on a gateway.",
        "--- END OF CONTEXT SUMMARY ---",
      ].join("\n"),
    },
    {
      role: "system",
      text: [
        "--- BEGIN CONTEXT SUMMARY ---",
        "Keep the current implementation plan.",
        "--- END OF CONTEXT SUMMARY ---",
      ].join("\n"),
    },
    {
      role: "user",
      text: [
        "[SKILL_PRUNED: content lost in compression; reload with skill_view(name=diagnosing-bugs)]",
        "The remaining context summary follows.",
        "--- END OF CONTEXT SUMMARY",
      ].join("\n"),
    },
    {
      role: "assistant",
      text: [
        "[CONTEXT COMPACTION \u2014 REFERENCE ONLY]",
        "The live wire can use a Unicode dash.",
      ].join("\n"),
    },
  ] as const;

  it.each(compactionCorpus)("replaces a $role compaction corpus row with one marker", ({ role, text }) => {
    const snapshot = parseChatSnapshot({ messages: [{ role, content: text }] }, "canonical");
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({ text: CONTEXT_COMPACTION_MARKER });
    expect(snapshot.messages[0]!.text).not.toContain("SKILL_PRUNED");
    expect(snapshot.messages[0]!.text).not.toContain("CONTEXT SUMMARY");
  });

  it.each([
    "I pasted [SKILL_PRUNED: content lost in compression; reload with skill_view(name=demo)] in a normal message.",
    "Normal preface\n[CONTEXT COMPACTION - REFERENCE ONLY]\nquoted sentinel",
    "[SKILL_PRUNED: content lost in compression; reload with skill_view(name=demo)]",
    "--- BEGIN CONTEXT SUMMARY ---\nmissing the final sentinel",
    "Please explain --- END OF CONTEXT SUMMARY --- in prose.",
    "[PRIOR CONTEXT - for reference only; not a new message]\nnormal second line",
  ])("passes through a compaction near-miss: %s", (text) => {
    const snapshot = parseChatSnapshot({ messages: [{ role: "user", content: text }] }, "canonical");
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]!.text).toBe(text);
  });

  it("keeps marker ids stable across rereads and never fingerprints the full summary", () => {
    const first = parseChatSnapshot(
      {
        messages: [
          {
            role: "user",
            content: "[CONTEXT COMPACTION - REFERENCE ONLY]\nfirst private summary",
          },
          {
            id: "backend-marker-id",
            role: "assistant",
            content: "--- BEGIN CONTEXT SUMMARY ---\nprivate body\n--- END OF CONTEXT SUMMARY ---",
          },
        ],
      },
      "canonical",
    );
    const reread = parseChatSnapshot(
      {
        messages: [
          {
            role: "user",
            content: "[CONTEXT COMPACTION - REFERENCE ONLY]\nchanged private summary",
          },
          {
            id: "backend-marker-id",
            role: "assistant",
            content: "--- BEGIN CONTEXT SUMMARY ---\nchanged body\n--- END OF CONTEXT SUMMARY ---",
          },
        ],
      },
      "canonical",
    );
    expect(reread.messages.map((message) => message.id)).toEqual(first.messages.map((message) => message.id));
    expect(reread.messages.map((message) => message.text)).toEqual([
      CONTEXT_COMPACTION_MARKER,
      CONTEXT_COMPACTION_MARKER,
    ]);
    expect(first.messages[1]!.id).toBe("backend-marker-id");
  });

  it("maps a mixed-shape message list to the stable wire shape", () => {
    const snapshot = parseChatSnapshot(
      {
        session_id: "runtime-9",
        message_count: 3,
        running: true,
        inflight: false,
        messages: [
          { id: "m1", role: "user", content: "hey", at: 1_755_000_000 },
          { role: "assistant", content: [{ text: "hi " }, "there"], timestamp: 1_755_000_060_000 },
          { role: "assistant", text: "and again" },
        ],
      },
      "stored-9",
    );
    expect(snapshot.runtimeId).toBe("runtime-9");
    expect(snapshot.messageCount).toBe(3);
    expect(snapshot.running).toBe(true);
    expect(snapshot.inflight).toBe(false);
    expect(snapshot.messages).toEqual([
      { id: "m1", role: "user", text: "hey", at: 1_755_000_000_000 },
      { id: syntheticChatId("stored-9", "assistant", "hi there", 0), text: "hi there", role: "assistant", at: 1_755_000_060_000 },
      { id: syntheticChatId("stored-9", "assistant", "and again", 0), text: "and again", role: "assistant", at: null },
    ]);
  });

  it("reads an unrecognizable reply as an empty idle session instead of throwing", () => {
    expect(parseChatSnapshot("nope", "stored-1")).toEqual({
      runtimeId: undefined,
      messages: [],
      messageCount: 0,
      running: false,
      inflight: false,
    });
  });

  it("keeps the gateway's own count when messages were omitted", () => {
    const snapshot = parseChatSnapshot({ session_id: "runtime-1", message_count: 12 }, "stored-1");
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.messageCount).toBe(12);
  });

  it("drops a row that is neither an object nor carries a role or text", () => {
    const snapshot = parseChatSnapshot({ messages: [null, 7, {}, { role: "assistant", content: "kept" }] }, "s");
    expect(snapshot.messages.map((message) => message.text)).toEqual(["kept"]);
  });
  it("drops system and tool rows and blank tool-only turns (review I9)", () => {
    // The exact leak the review proved: everything but the two real bubbles reached the phone.
    const snapshot = parseChatSnapshot(
      {
        messages: [
          { role: "system", content: "you are a bot" },
          { role: "assistant", content: [{ type: "tool_use", name: "read" }] },
          { role: "tool", content: "file1\nfile2" },
          { role: "user", content: "what did you find" },
          { role: "assistant", content: "done" },
        ],
      },
      "canonical",
    );
    expect(snapshot.messages).toEqual([
      { id: syntheticChatId("canonical", "user", "what did you find", 0), role: "user", text: "what did you find", at: null },
      { id: syntheticChatId("canonical", "assistant", "done", 0), role: "assistant", text: "done", at: null },
    ]);
  });

  it("normalizes the role's case", () => {
    const snapshot = parseChatSnapshot(
      { messages: [{ role: "SYSTEM", content: "setup" }, { role: "Assistant", content: "hi" }] },
      "s",
    );
    expect(snapshot.messages).toEqual([
      { id: syntheticChatId("s", "assistant", "hi", 0), role: "assistant", text: "hi", at: null },
    ]);
  });

  // cozygateway#87: the synthesized id is derived from the row's CONTENT, never from where the row
  // sits, because a compaction rewrites the head of a transcript and every position under it moves.
  it("gives a row with no id of its own an identity that survives a head trim", () => {
    const before = parseChatSnapshot(
      {
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
      },
      "s",
    );
    const after = parseChatSnapshot(
      {
        messages: [
          { role: "assistant", content: "summary so far" },
          { role: "user", content: "three" },
        ],
      },
      "s",
    );
    expect(after.messages[1]!.id).toBe(before.messages[2]!.id);
    // And the summary row, which is genuinely new, does not inherit the id of the row that used to
    // sit where it sits.
    expect(after.messages[0]!.id).not.toBe(before.messages[0]!.id);
  });

  it("numbers repeated content, so two identical lines are two identities", () => {
    const snapshot = parseChatSnapshot(
      { messages: [{ role: "user", content: "ok" }, { role: "assistant", content: "sure" }, { role: "user", content: "ok" }] },
      "s",
    );
    expect(snapshot.messages[0]!.id).toBe(syntheticChatId("s", "user", "ok", 0));
    expect(snapshot.messages[2]!.id).toBe(syntheticChatId("s", "user", "ok", 1));
  });

  it("hands a re-based transcript the ids the ledger already delivered", () => {
    const ledger = new ChatIdentityLedger();
    const before = parseChatSnapshot(
      { messages: [{ role: "user", content: "ok" }, { role: "assistant", content: "sure" }, { role: "user", content: "ok" }] },
      "s",
      ledger,
    );
    // The compaction took the first "ok" with it. Content alone would renumber the survivor back to
    // occurrence 0; the ledger knows which copy it is.
    const after = parseChatSnapshot({ messages: [{ role: "user", content: "ok" }] }, "s", ledger);
    expect(after.messages[0]!.id).toBe(before.messages[2]!.id);
  });
});

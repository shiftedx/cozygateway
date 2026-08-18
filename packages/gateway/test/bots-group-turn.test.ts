import { describe, expect, it } from "vitest";

import type { HermesRpc } from "../src/hermes-bridge/canonical-chat.ts";
import {
  ensureGroupSession,
  findFreshReply,
  runMemberTurn,
  transcriptRewritten,
  type GroupSession,
} from "../src/hermes-bridge/group-turn.ts";

/** One member turn in isolation, and specifically the two things the room-level tests cannot pin
 *  deterministically: which coordinate space the reply baseline lives in, and what a turn does with
 *  an answer that completed at the instant it was superseded. */

/** A transcript row as Hermes hands it over. `system`, `tool` and tool-call-only assistant rows are
 *  ORDINARY, and they are exactly the rows the render filter drops. */
const systemRow = { role: "system", content: "you are scout" };
const toolCallRow = { role: "assistant", content: [{ type: "tool_use", name: "grep", input: {} }] };
const toolResultRow = { role: "tool", content: "3 matches" };

function rendered(session: string, index: number, role: string, text: string): {
  id: string;
  role: string;
  text: string;
  at: number | null;
} {
  return { id: `${session}#${index}`, role, text, at: null };
}

describe("findFreshReply", () => {
  it("indexes the FILTERED list, so dropped rows cannot empty the window", () => {
    // The transcript below has 6 raw rows and 3 rendered ones. A baseline taken from the raw count
    // (4 rows existed before the turn) would slice a 3-long list at 4 and find nothing at all,
    // which is the shape that made every member turn run to the 180 s cap.
    const messages = [
      rendered("s", 1, "user", "hello team"),
      rendered("s", 4, "assistant", "an older answer"),
      rendered("s", 5, "user", "second turn please"),
      rendered("s", 8, "assistant", "the fresh answer"),
    ];
    expect(findFreshReply(messages, { renderedCount: 3 })?.text).toBe("the fresh answer");
  });

  it("never returns a reply from BEFORE the baseline", () => {
    const messages = [
      rendered("s", 0, "user", "q1"),
      rendered("s", 1, "assistant", "a1"),
      rendered("s", 2, "user", "q2"),
    ];
    // The user's prompt has landed but the model has not answered yet: the previous turn's reply is
    // not this turn's, and a walk back over the whole transcript would return it.
    expect(findFreshReply(messages, { renderedCount: 2 })).toBeUndefined();
  });

  it("prefers the identity anchor when a compaction moved the count", () => {
    const messages = [
      rendered("s", 0, "user", "q2"),
      rendered("s", 1, "assistant", "the fresh answer"),
    ];
    // The count says 4 rendered messages existed before the turn; the transcript now holds 2,
    // because a compaction rewrote it. The anchor id is still there, so the window is still right.
    expect(
      findFreshReply(messages, { renderedCount: 4, lastRenderedId: "s#0" })?.text,
    ).toBe("the fresh answer");
  });

  it("re-bases when the anchor id is gone", () => {
    const messages = [rendered("s", 0, "user", "q"), rendered("s", 1, "assistant", "a")];
    expect(findFreshReply(messages, { renderedCount: 1, lastRenderedId: "vanished" })?.text).toBe("a");
  });

  it("re-bases when a compaction head-trimmed the transcript out from under the turn", () => {
    // Four rendered messages existed when the turn started; a compaction left three, and the anchor
    // row is not among them. Both anchors now describe a list that is gone, and a baseline of
    // `min(4, 3)` would leave no candidates at all: the zero-replies symptom, resurrected.
    const messages = [
      rendered("s", 0, "assistant", "an older answer"),
      rendered("s", 1, "user", "turn prompt"),
      rendered("s", 2, "assistant", "the fresh answer"),
    ];
    expect(
      findFreshReply(messages, {
        renderedCount: 4,
        lastRenderedId: "s#5",
        lastRenderedText: "the message that was trimmed away",
      })?.text,
    ).toBe("the fresh answer");
  });

  it("re-bases when the anchor id survived the trim but now names a different row", () => {
    // The hostile case a bare id comparison cannot see: `mapChatMessage` SYNTHESIZES ids from the
    // row index for rows carrying none, so a head trim renumbers them and `s#2` still "matches"
    // while pointing at somebody else's message. The recorded text is what gives it away.
    const messages = [
      rendered("s", 0, "assistant", "an older answer"),
      rendered("s", 1, "user", "turn prompt"),
      rendered("s", 2, "assistant", "the fresh answer"),
    ];
    expect(
      findFreshReply(messages, {
        renderedCount: 3,
        lastRenderedId: "s#2",
        lastRenderedText: "what s#2 used to say",
      })?.text,
    ).toBe("the fresh answer");
  });

  it("still trusts an anchor whose text matches, so nothing stale is returned", () => {
    const messages = [
      rendered("s", 0, "user", "q1"),
      rendered("s", 1, "assistant", "a1"),
      rendered("s", 2, "user", "turn prompt"),
    ];
    expect(
      findFreshReply(messages, { renderedCount: 2, lastRenderedId: "s#1", lastRenderedText: "a1" }),
    ).toBeUndefined();
  });
});

describe("transcriptRewritten", () => {
  const messages = [rendered("s", 0, "user", "q"), rendered("s", 1, "assistant", "a")];

  it("is false for a transcript that only grew", () => {
    expect(
      transcriptRewritten(messages, { renderedCount: 1, lastRenderedId: "s#0", lastRenderedText: "q" }),
    ).toBe(false);
  });

  it("is true when the anchor is gone, when its text changed, and when the list shrank", () => {
    expect(transcriptRewritten(messages, { renderedCount: 1, lastRenderedId: "gone" })).toBe(true);
    expect(
      transcriptRewritten(messages, { renderedCount: 1, lastRenderedId: "s#0", lastRenderedText: "elsewhere" }),
    ).toBe(true);
    expect(transcriptRewritten(messages, { renderedCount: 9 })).toBe(true);
  });
});

/** A Hermes whose transcript carries the rows a real bot's does. */
function transcriptRpc(rows: Array<Record<string, unknown>>, opts: { running?: boolean } = {}): {
  rpc: HermesRpc;
  rows: Array<Record<string, unknown>>;
  calls: string[];
} {
  const calls: string[] = [];
  const rpc: HermesRpc = {
    request: async (method) => {
      calls.push(method);
      if (method === "prompt.submit") return { ok: true };
      if (method === "session.resume") {
        return {
          session_id: "runtime-1",
          session_key: "stored-1",
          message_count: rows.length,
          running: opts.running === true,
          inflight: false,
          messages: rows,
        };
      }
      return {};
    },
  };
  return { rpc, rows, calls };
}

describe("ensureGroupSession", () => {
  it("records the RENDERED baseline and its anchor, not just the raw count", async () => {
    const { rpc } = transcriptRpc([systemRow, { role: "user", content: "hello team" }, toolCallRow, toolResultRow, { role: "assistant", content: "hi" }]);
    const session = await ensureGroupSession(rpc, "scout", "Release Room", { storedId: "stored-1", hidden: true });
    // Five raw rows, two of which a chat renders.
    expect(session.messageCount).toBe(5);
    expect(session.renderedCount).toBe(2);
    expect(session.lastRenderedId).toBe("stored-1#4");
    // The anchor's TEXT comes along, because a synthesized id alone cannot survive a renumbering.
    expect(session.lastRenderedText).toBe("hi");
  });
});

describe("runMemberTurn", () => {
  const baseSession = (over: Partial<GroupSession> = {}): GroupSession => ({
    storedId: "stored-1",
    runtimeId: "runtime-1",
    messageCount: 0,
    renderedCount: 0,
    created: false,
    ...over,
  });

  it("finds the reply in a transcript whose raw count runs ahead of its rendered one", async () => {
    // Four raw rows before the turn, one of which renders. The turn adds a user row, a tool round
    // trip and the reply: raw 8, rendered 3. A baseline of 4 in the filtered space finds nothing.
    const rows: Array<Record<string, unknown>> = [
      systemRow,
      { role: "user", content: "hello team" },
      toolCallRow,
      toolResultRow,
    ];
    const { rpc } = transcriptRpc(rows);
    const session = baseSession({ messageCount: 4, renderedCount: 1, lastRenderedId: "stored-1#1" });
    rows.push({ role: "user", content: "turn prompt" }, toolCallRow, toolResultRow, { role: "assistant", content: "here is my take" });

    const result = await runMemberTurn({
      rpc,
      member: "scout",
      group: "Release Room",
      prompt: "turn prompt",
      session,
      now: () => Date.now(),
      pollMs: 1,
      timeoutMs: 300,
    });
    expect(result).toEqual({ outcome: "spoke", text: "here is my take" });
  });

  it("posts a reply that had already completed when the room was superseded", async () => {
    const rows: Array<Record<string, unknown>> = [{ role: "user", content: "turn prompt" }, { role: "assistant", content: "the late answer" }];
    const { rpc, calls } = transcriptRpc(rows);
    const result = await runMemberTurn({
      rpc,
      member: "scout",
      group: "Release Room",
      prompt: "turn prompt",
      session: baseSession(),
      now: () => Date.now(),
      pollMs: 1,
      timeoutMs: 300,
      // Superseded the instant the prompt was accepted.
      live: () => false,
    });
    expect(result).toEqual({ outcome: "spoke", text: "the late answer" });
    // One submit and exactly ONE harvest read: a superseded turn must not hold the room up.
    expect(calls).toEqual(["prompt.submit", "session.resume"]);
  });

  it("abandons a superseded turn whose member is still thinking", async () => {
    const { rpc, calls } = transcriptRpc([{ role: "user", content: "turn prompt" }], { running: true });
    const result = await runMemberTurn({
      rpc,
      member: "scout",
      group: "Release Room",
      prompt: "turn prompt",
      session: baseSession(),
      now: () => Date.now(),
      pollMs: 1,
      timeoutMs: 300,
      live: () => false,
    });
    expect(result).toEqual({ outcome: "pass" });
    expect(calls).toEqual(["prompt.submit", "session.resume"]);
  });
});

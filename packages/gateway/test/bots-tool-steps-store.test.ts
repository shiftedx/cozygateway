/** The durable half of ext-bots capability 12 (issue #60): the table a turn's tool steps are
 *  written to, and the grouping that serves them back on `GET /bots/:name/chat/messages`.
 *
 *  This is what makes the collapsed "what did it do" strip expandable after the fact. Hermes replays
 *  no tool lifecycle on reconnect and persists none this gateway can read back, so without these
 *  rows a turn's activity would exist for exactly as long as one socket stayed open.
 */
import { describe, expect, it } from "vitest";

import { groupToolSteps } from "../src/hermes-bridge/tool-activity.ts";
import { openStorage } from "../src/storage.ts";

const T = 1_800_000_000_000;

function step(over: Partial<Parameters<ReturnType<typeof openStorage>["upsertBotChatToolStep"]>[0]> = {}) {
  return {
    bot: "sage",
    sessionId: "stored-1",
    turnId: "turn-1",
    stepId: "call_1",
    seq: 1,
    name: "terminal",
    status: "running",
    startedAt: T,
    endedAt: undefined,
    ...over,
  };
}

describe("bot_chat_tool_steps", () => {
  it("writes a step and then updates it in place when it ends", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step());
    storage.upsertBotChatToolStep(step({ status: "ok", endedAt: T + 1_200 }));

    expect(storage.botChatToolSteps("stored-1", 0)).toEqual([
      { turnId: "turn-1", stepId: "call_1", seq: 1, name: "terminal", status: "ok", startedAt: T, endedAt: T + 1_200 },
    ]);
    storage.close();
  });

  it("pins seq and startedAt to the FIRST write, so a step keeps the position it was first seen in", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step());
    // A later write arriving with different ordinals must not move the step.
    storage.upsertBotChatToolStep(step({ seq: 99, startedAt: T + 5_000, status: "ok", endedAt: T + 6_000 }));

    const rows = storage.botChatToolSteps("stored-1", 0);
    expect(rows[0]?.seq).toBe(1);
    expect(rows[0]?.startedAt).toBe(T);
    storage.close();
  });

  it("keeps one bot's steps out of another's, and one session's out of another's", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step());
    storage.upsertBotChatToolStep(step({ bot: "luna", sessionId: "stored-2", stepId: "call_2" }));

    expect(storage.botChatToolSteps("stored-1", 0).map((r) => r.stepId)).toEqual(["call_1"]);
    expect(storage.botChatToolSteps("stored-2", 0).map((r) => r.stepId)).toEqual(["call_2"]);
    storage.close();
  });

  it("drops a bot's steps on a chat reset and on a profile delete", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step());
    storage.deleteBotChatToolSteps("sage");
    expect(storage.botChatToolSteps("stored-1", 0)).toEqual([]);

    storage.upsertBotChatToolStep(step());
    // `forgetBot` is the delete path, and it takes the steps with everything else keyed on the name.
    storage.forgetBot("sage");
    expect(storage.botChatToolSteps("stored-1", 0)).toEqual([]);
    storage.close();
  });

  it("sweeps steps past the TTL and leaves the rest", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step({ stepId: "old", startedAt: T - 10_000 }));
    storage.upsertBotChatToolStep(step({ stepId: "new", startedAt: T }));

    expect(storage.sweepBotChatToolSteps(T, 5_000)).toBe(1);
    expect(storage.botChatToolSteps("stored-1", 0).map((r) => r.stepId)).toEqual(["new"]);
    storage.close();
  });
});

describe("groupToolSteps", () => {
  it("groups rows into turns, oldest turn first and in-turn order within each", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step({ turnId: "turn-2", stepId: "b", seq: 1, startedAt: T + 5_000, status: "ok", endedAt: T + 5_500 }));
    storage.upsertBotChatToolStep(step({ turnId: "turn-1", stepId: "a2", seq: 2, startedAt: T + 100, status: "ok", endedAt: T + 900 }));
    storage.upsertBotChatToolStep(step({ turnId: "turn-1", stepId: "a1", seq: 1, startedAt: T, status: "ok", endedAt: T + 400 }));

    expect(groupToolSteps(storage.botChatToolSteps("stored-1", 0))).toEqual([
      {
        turnId: "turn-1",
        startedAt: T,
        endedAt: T + 900,
        steps: [
          { stepId: "a1", seq: 1, name: "terminal", status: "ok", startedAt: T, endedAt: T + 400 },
          { stepId: "a2", seq: 2, name: "terminal", status: "ok", startedAt: T + 100, endedAt: T + 900 },
        ],
      },
      {
        turnId: "turn-2",
        startedAt: T + 5_000,
        endedAt: T + 5_500,
        steps: [{ stepId: "b", seq: 1, name: "terminal", status: "ok", startedAt: T + 5_000, endedAt: T + 5_500 }],
      },
    ]);
    storage.close();
  });

  it("leaves a turn open-ended when a step never ended, which after a restart is a turn whose end was never seen", () => {
    const storage = openStorage(":memory:");
    storage.upsertBotChatToolStep(step({ stepId: "a", status: "ok", endedAt: T + 100 }));
    storage.upsertBotChatToolStep(step({ stepId: "b", seq: 2, startedAt: T + 50 }));

    const turns = groupToolSteps(storage.botChatToolSteps("stored-1", 0));
    expect(turns[0]).not.toHaveProperty("endedAt");
    expect(turns[0]?.steps.map((s) => s.status)).toEqual(["ok", "running"]);
    storage.close();
  });

  it("answers with nothing for a chat that has run no tools, so the response field is simply absent", () => {
    const storage = openStorage(":memory:");
    expect(groupToolSteps(storage.botChatToolSteps("stored-1", 0))).toEqual([]);
    storage.close();
  });

  it("reads an unrecognized stored status as error rather than putting an unknown word on the wire", () => {
    const storage = openStorage(":memory:");
    // Belt and braces: nothing writes this today, and a future write that did must not leak a word
    // outside the closed vocabulary into a client's switch.
    storage.upsertBotChatToolStep(step({ status: "weird", endedAt: T + 1 }));

    expect(groupToolSteps(storage.botChatToolSteps("stored-1", 0))[0]?.steps[0]?.status).toBe("error");
    storage.close();
  });
});

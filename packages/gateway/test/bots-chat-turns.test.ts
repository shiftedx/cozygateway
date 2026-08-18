import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { BotChatTurns, CHAT_POLL_MS, CHAT_TURN_TIMEOUT_MS } from "../src/hermes-bridge/chat-turns.ts";

/** The turn poll, in isolation. The cadence and the cap are scaled down here so the loop's real
 *  behavior (one poll per bot, deltas only, an idle session ends the turn, the cap ends it anyway)
 *  runs in milliseconds instead of minutes. The production values are asserted below so the
 *  scaling cannot quietly become the contract. */

interface Reply {
  messages: Array<Record<string, unknown>>;
  running?: boolean;
  inflight?: boolean;
}

function stub(replies: () => Reply, opts: { failResume?: number } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let failures = opts.failResume ?? 0;
  return {
    calls,
    resumes: (): number => calls.filter((call) => call.method === "session.resume").length,
    polls: (): number =>
      calls.filter((call) => call.method === "session.resume" && call.params["omit_messages"] === false).length,
    request: async (method: string, params?: unknown): Promise<unknown> => {
      const record = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: record });
      if (method === "prompt.submit") return { ok: true };
      if (method !== "session.resume") throw new Error(`unexpected method ${method}`);
      if (failures > 0) {
        failures -= 1;
        throw new Error("session db busy");
      }
      const reply = replies();
      return {
        session_id: "runtime-1",
        message_count: reply.messages.length,
        running: reply.running ?? false,
        inflight: reply.inflight ?? false,
        messages: reply.messages,
      };
    },
  };
}

function harness(replies: () => Reply, overrides: { pollMs?: number; timeoutMs?: number; failResume?: number } = {}) {
  const frames: ServerFrame[] = [];
  const rpc = stub(replies, overrides.failResume === undefined ? {} : { failResume: overrides.failResume });
  // A fake epoch that advances with real time, so a scaled-down cap expires in scaled-down wall
  // time rather than one tick per clock read.
  const started = Date.now();
  const turns = new BotChatTurns({
    rpc,
    broadcast: (frame) => frames.push(frame),
    now: () => 1_800_000_000_000 + (Date.now() - started),
    pollMs: overrides.pollMs ?? 5,
    timeoutMs: overrides.timeoutMs ?? 300,
  });
  return { turns, frames, rpc };
}

const chatFrames = (frames: ServerFrame[]): Array<Extract<ServerFrame, { type: "bot_chat" }>> =>
  frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_chat" }> => frame.type === "bot_chat");
const stateFrames = (frames: ServerFrame[]): Array<Extract<ServerFrame, { type: "bot_chat_state" }>> =>
  frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_chat_state" }> => frame.type === "bot_chat_state");

describe("BotChatTurns", () => {
  it("keeps the desktop's cadence and cap", () => {
    expect(CHAT_POLL_MS).toBe(2_000);
    expect(CHAT_TURN_TIMEOUT_MS).toBe(180_000);
  });

  it("submits against the RUNTIME id and returns the committed user message", async () => {
    const { turns, rpc } = harness(() => ({ messages: [{ role: "user", content: "hi" }] }));
    const message = await turns.send("scout", "stored-1", "how is CI");
    expect(message).toMatchObject({ role: "user", text: "how is CI" });
    expect(typeof message.at).toBe("number");

    const submit = rpc.calls.find((call) => call.method === "prompt.submit");
    expect(submit?.params).toEqual({ session_id: "runtime-1", text: "how is CI" });
    // The baseline resume is the cheap one: no message bodies come back over it.
    expect(rpc.calls[0]).toMatchObject({
      method: "session.resume",
      params: { session_id: "stored-1", profile: "scout", omit_messages: true },
    });
    await turns.settled("scout");
  });

  it("broadcasts each new message once and ends the turn when hermes goes idle", async () => {
    let reply: Reply = { messages: [{ role: "user", content: "hi" }], running: true, inflight: true };
    const { turns, frames } = harness(() => reply);
    await turns.send("scout", "stored-1", "hi");
    // Mid-turn: the reply has landed but the session is still working.
    reply = {
      messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "on it" }],
      running: true,
    };
    await new Promise((resolve) => setTimeout(resolve, 20));
    reply = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "on it" },
        { role: "assistant", content: "all green" },
      ],
    };
    await turns.settled("scout");

    const messages = chatFrames(frames).flatMap((frame) => frame.messages);
    expect(messages.map((message) => message.text)).toEqual(["hi", "on it", "all green"]);
    // Deltas, never a re-send: each message appears in exactly one frame.
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    expect(stateFrames(frames).at(0)?.phase).toBe("polling");
    expect(stateFrames(frames).at(-1)).toMatchObject({ phase: "complete", running: false, inflight: false });
  });

  it("gives up at the cap and says so", async () => {
    // A session that never stops working: the only way out is the cap.
    const { turns, frames } = harness(() => ({ messages: [{ role: "assistant", content: "thinking" }], running: true }), {
      pollMs: 5,
      timeoutMs: 40,
    });
    await turns.send("scout", "stored-1", "hi");
    await turns.settled("scout");
    expect(stateFrames(frames).at(-1)).toMatchObject({ phase: "timeout" });
    expect(turns.polling("scout")).toBe(false);
  });

  it("runs one poll per bot no matter how fast sends arrive", async () => {
    const { turns, rpc } = harness(() => ({ messages: [{ role: "assistant", content: "working" }], running: true }), {
      pollMs: 5,
      timeoutMs: 60,
    });
    await turns.send("scout", "stored-1", "one");
    const pollsAfterFirst = rpc.polls();
    await turns.send("scout", "stored-1", "two");
    await turns.send("scout", "stored-1", "three");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const elapsedPolls = rpc.polls() - pollsAfterFirst;
    // Three sends over ~30 ms at a 5 ms cadence: one loop is at most ~7 polls, three loops would
    // be three times that.
    expect(elapsedPolls).toBeLessThanOrEqual(10);
    expect(turns.polling("scout")).toBe(true);
    turns.close();
  });

  it("rides out a transient resume failure and still delivers the reply", async () => {
    const { turns, frames } = harness(() => ({ messages: [{ role: "assistant", content: "recovered" }] }), {
      pollMs: 5,
      timeoutMs: 400,
      failResume: 2,
    });
    // The pre-submit resume is one of the failing ones, so the send is addressed with the runtime
    // id `session.create` handed back, exactly as the bridge does for a chat it just created.
    await turns.send("scout", "stored-1", "hi", { runtimeId: "runtime-1" });
    await turns.settled("scout");
    expect(chatFrames(frames).flatMap((frame) => frame.messages).map((message) => message.text)).toEqual([
      "recovered",
    ]);
    expect(stateFrames(frames).at(-1)).toMatchObject({ phase: "complete" });
  });

  it("stops polling when hermes keeps refusing", async () => {
    const { turns, frames } = harness(() => ({ messages: [] }), { pollMs: 5, timeoutMs: 400, failResume: 99 });
    await turns.send("scout", "stored-1", "hi", { runtimeId: "runtime-1" });
    await turns.settled("scout");
    expect(stateFrames(frames).at(-1)).toMatchObject({ phase: "failed" });
  });

  it("re-bases its delta watermark on a history read", async () => {
    const { turns, frames } = harness(() => ({
      messages: [{ role: "user", content: "old" }, { role: "assistant", content: "older reply" }],
    }));
    const history = await turns.history("scout", "stored-1");
    expect(history.messages.map((message) => message.text)).toEqual(["old", "older reply"]);
    await turns.send("scout", "stored-1", "next");
    await turns.settled("scout");
    // The two messages the client already has are not re-broadcast.
    expect(chatFrames(frames)).toHaveLength(0);
  });
  it("does not read the user's own committed message as the reply (review I4)", async () => {
    // prompt.submit PERSISTS the user message, so the count is past the baseline on the very first
    // poll. With hermes not yet reporting running/inflight (a queued turn, a serial scheduler) that
    // read as "complete", the loop returned, and the assistant's reply reached nobody.
    let reply: Reply = { messages: [{ role: "user", content: "hi" }] };
    const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });
    await turns.send("scout", "stored-1", "hi");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stateFrames(frames).some((frame) => frame.phase === "complete")).toBe(false);

    reply = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "all green" }] };
    await turns.settled("scout");
    expect(stateFrames(frames).at(-1)).toMatchObject({ phase: "complete" });
  });

  it("opens the turn with hermes' own flags, not invented ones (review M2)", async () => {
    const { turns, frames } = harness(() => ({ messages: [{ role: "user", content: "hi" }], running: true }), {
      pollMs: 5,
      timeoutMs: 40,
    });
    await turns.send("scout", "stored-1", "hi");
    expect(stateFrames(frames).at(0)).toMatchObject({ phase: "polling", running: true, inflight: false });
    await turns.settled("scout");
  });

  it("keeps delivering after a compaction shrinks the transcript (review I5)", async () => {
    // The canonical chat is where /new is rerouted to /compact (dissection 5.5), and compaction
    // REPLACES the message list. A count-only watermark can only move up, so one compaction left
    // the phone silent forever.
    let reply: Reply = {
      messages: [
        { id: "a", role: "user", content: "one" },
        { id: "b", role: "assistant", content: "two" },
        { id: "c", role: "user", content: "three" },
      ],
    };
    const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });
    await turns.history("scout", "stored-1");

    reply = {
      messages: [
        { id: "s1", role: "assistant", content: "summary so far" },
        { id: "d", role: "user", content: "after the compaction" },
      ],
    };
    await turns.send("scout", "stored-1", "after the compaction");
    reply = {
      messages: [
        { id: "s1", role: "assistant", content: "summary so far" },
        { id: "d", role: "user", content: "after the compaction" },
        { id: "e", role: "assistant", content: "still here" },
      ],
    };
    await turns.settled("scout");

    const delivered = chatFrames(frames).flatMap((frame) => frame.messages);
    expect(delivered.map((message) => message.text)).toEqual([
      "summary so far",
      "after the compaction",
      "still here",
    ]);
  });

  it("binds the runtime session to the bot before submitting, and drops it when the bot is cancelled", async () => {
    const bound: Array<{ id: string; binding: Record<string, unknown>; after: string[] }> = [];
    const forgotten: string[] = [];
    const frames: ServerFrame[] = [];
    const rpc = stub(() => ({ messages: [{ role: "user", content: "hi" }], running: true }));
    const turns = new BotChatTurns({
      rpc,
      broadcast: (frame) => frames.push(frame),
      now: () => 1_800_000_000_000,
      pollMs: 5,
      timeoutMs: 200,
      stream: {
        bind: (id, binding) =>
          bound.push({ id, binding: { ...binding }, after: rpc.calls.map((call) => call.method) }),
        forgetBot: (name) => forgotten.push(name),
      },
    });

    await turns.send("scout", "stored-1", "how is CI");
    // The RUNTIME id (what Hermes stamps its events with) mapped to the STORED id (what every bots
    // frame is keyed on), declared BEFORE `prompt.submit`, because the first token can arrive
    // before the submit's own reply does.
    expect(bound).toHaveLength(1);
    expect(bound[0]!.id).toBe("runtime-1");
    expect(bound[0]!.binding).toEqual({ bot: "scout", sessionId: "stored-1" });
    expect(bound[0]!.after).toEqual(["session.resume"]);

    turns.cancel("scout");
    expect(forgotten).toEqual(["scout"]);
    turns.close();
  });

  it("cancels a poll whose session id changed under it (review I8)", async () => {
    const { turns, frames } = harness(() => ({ messages: [{ role: "assistant", content: "working" }], running: true }), {
      pollMs: 5,
      timeoutMs: 400,
    });
    await turns.send("scout", "stored-1", "one");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A recovery re-pin, a desktop clear, or a writeback race moves the bot to another session.
    await turns.send("scout", "stored-2", "two");
    const sessionOf = (frame: ServerFrame): string | undefined => (frame as { sessionId?: string }).sessionId;
    const before = frames.filter((frame) => sessionOf(frame) === "stored-1").length;
    await new Promise((resolve) => setTimeout(resolve, 40));

    // The displaced poll is gone: no more frames for a chat the app has left.
    expect(frames.filter((frame) => sessionOf(frame) === "stored-1").length).toBe(before);
    expect(frames.some((frame) => sessionOf(frame) === "stored-2")).toBe(true);
    turns.close();
    expect(turns.polling("scout")).toBe(false);
  });
  // ext-bots-v1 sections 3 and 4: the `clientId` a sender put on a send comes back on THAT send's
  // message and on no other. Two sends of the same words are two different lines, and the app keys
  // its transcript on the id it is handed, so a clientId that crosses turns collapses two rows into
  // one and a user bubble disappears (cozychat#38).
  describe("clientId re-attachment", () => {
    const user = (id: string) => ({ id, role: "user", content: "another espresso" });
    const bot = (id: string) => ({ id, role: "assistant", content: "coming right up" });

    it("never stamps a newer identical send with an earlier turn's clientId (cozychat#38)", async () => {
      let reply: Reply = { messages: [user("m1")], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      // The app refreshes mid-turn. A history read re-bases the delta watermark PAST the user row,
      // so the poll never emits it and `phone-1` is left sitting in the pending queue.
      await turns.history("scout", "stored-1");
      reply = { messages: [user("m1"), bot("m2")] };
      await turns.settled("scout");

      // The same words again, a whole turn later.
      reply = { messages: [user("m1"), bot("m2"), user("m3")], running: true };
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      reply = { messages: [user("m1"), bot("m2"), user("m3"), bot("m4")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.find((message) => message.id === "m3")?.clientId).toBe("phone-2");
      expect(rows.every((message) => message.clientId !== "phone-1")).toBe(true);
    });

    it("gives two identical sends their own clientIds, one row each", async () => {
      let reply: Reply = { messages: [user("m1")], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), bot("m2")] };
      await turns.settled("scout");

      reply = { messages: [user("m1"), bot("m2"), user("m3")], running: true };
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), bot("m2"), user("m3"), bot("m4")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
      expect(rows.find((message) => message.id === "m1")?.clientId).toBe("phone-1");
      expect(rows.find((message) => message.id === "m3")?.clientId).toBe("phone-2");
      const stamped = rows.map((message) => message.clientId).filter((id) => id !== undefined);
      expect(new Set(stamped).size).toBe(stamped.length);
    });

    it("never re-uses an orphaned clientId for a repeat INSIDE one turn (review G1)", async () => {
      let reply: Reply = { messages: [user("m1")], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      // The app refreshes while the bot is still replying. The history read hands the client the
      // user row directly AND re-bases the watermark past it, so the poll will never emit it and
      // `phone-1` has nothing left to be attached to.
      await turns.history("scout", "stored-1");
      // The user asks again without waiting: same words, same LIVE turn, so no turn boundary is
      // crossed and the orphan is still in the queue.
      reply = { messages: [user("m1"), user("m2")], running: true };
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), user("m2"), bot("m3")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.find((message) => message.id === "m2")?.clientId).toBe("phone-2");
      expect(rows.every((message) => message.clientId !== "phone-1")).toBe(true);
    });

    it("a refresh does not spend the send it is racing against an OLD row (review R2-SELF2)", async () => {
      let reply: Reply = { messages: [user("m1")], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), bot("m2")] };
      await turns.settled("scout");

      // A whole turn later the user asks the same thing again, and the app refreshes before hermes
      // has persisted the new line. The snapshot therefore holds only the OLD copy of those words,
      // which this client was handed a turn ago and which no send is waiting for.
      reply = { messages: [user("m1"), bot("m2")], running: true };
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      await turns.history("scout", "stored-1");

      reply = { messages: [user("m1"), bot("m2"), user("m3")], running: true };
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), bot("m2"), user("m3"), bot("m4")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.find((message) => message.id === "m3")?.clientId).toBe("phone-2");
    });

    it("keeps both clientIds when two identical sends ride ONE turn", async () => {
      let reply: Reply = { messages: [], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      // A second tap before the poll has seen the first row: same turn, two live sends, and each
      // still owes its own row a clientId of its own.
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      reply = { messages: [user("m1"), user("m2")], running: true };
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), user("m2"), bot("m3")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.find((message) => message.id === "m1")?.clientId).toBe("phone-1");
      expect(rows.find((message) => message.id === "m2")?.clientId).toBe("phone-2");
    });

    it("does not re-stamp a replayed row when the watermark re-bases (cozychat#38)", async () => {
      let reply: Reply = { messages: [user("m1")], running: true };
      const { turns, frames } = harness(() => reply, { pollMs: 5, timeoutMs: 400 });

      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-1" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), bot("m2")] };
      await turns.settled("scout");

      // A compaction rewrote the tail: the id the watermark held is gone, so the whole transcript
      // is replayed. The replayed user row is one the client already has, and it must not be
      // handed the clientId belonging to the send now in flight.
      reply = { messages: [user("m1"), user("m3")], running: true };
      await turns.send("scout", "stored-1", "another espresso", { clientId: "phone-2" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      reply = { messages: [user("m1"), user("m3"), bot("m4")] };
      await turns.settled("scout");

      const rows = chatFrames(frames).flatMap((frame) => frame.messages);
      expect(rows.filter((message) => message.id === "m1").every((message) => message.clientId !== "phone-2")).toBe(
        true,
      );
      expect(rows.find((message) => message.id === "m3")?.clientId).toBe("phone-2");
    });
  });
});

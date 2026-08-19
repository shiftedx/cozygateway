/** The hermes tool-activity bridge, in isolation (issue #60, ext-bots capability 12).
 *
 *  Every event fed in here is the wire shape the 2026-08-19 probe read off hermes 0.20.3/0.20.4
 *  source, cited file:line in the PR body:
 *
 *  ```
 *  {"type":"tool.start","session_id":"runtime-1","payload":{
 *     "tool_id":"call_1","name":"terminal","context":"rm -rf /tmp/x",
 *     "args":{"command":"rm -rf /tmp/x"},"args_text":"{...}"}}
 *  {"type":"tool.complete","session_id":"runtime-1","payload":{
 *     "tool_id":"call_1","name":"terminal","args":{...},"duration_s":1.2,
 *     "result":{"exit_code":0,"stdout":"..."},"summary":"Did 2 searches in 1.2s"}}
 *  ```
 *
 *  `tool.start` carries NO turn id and `tool.complete` carries NO status flag, which is what these
 *  tests are mostly about: the turn comes from the gateway's own stream, and the status is
 *  classified here from structure. Nothing here talks to a real hermes.
 */
import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import type { StreamBinding } from "../src/hermes-bridge/chat-stream.ts";
import type { HermesEvent } from "../src/hermes-bridge/client.ts";
import {
  BotToolActivity,
  MAX_STEPS_PER_TURN,
  TOOL_ACTIVITY_THROTTLE_MS,
  TOOL_NAME_FALLBACK,
  TOOL_NAME_MAX,
  type ToolStepRecord,
  toolStepName,
  toolStepStatus,
} from "../src/hermes-bridge/tool-activity.ts";

const RUNTIME = "runtime-1";
type ActivityFrame = Extract<ServerFrame, { type: "bot_tool_activity" }>;

function harness(opts: { turnId?: string | undefined; throttleMs?: number } = {}) {
  const frames: ActivityFrame[] = [];
  const stored: ToolStepRecord[] = [];
  const logs: string[] = [];
  const bindings = new Map<string, StreamBinding>();
  let clock = 1_800_000_000_000;

  const activity = new BotToolActivity({
    chat: {
      binding: (runtimeId) => bindings.get(runtimeId),
      turnId: () => ("turnId" in opts ? opts.turnId : "turn-1"),
    },
    broadcast: (frame) => {
      if (frame.type === "bot_tool_activity") frames.push(frame);
    },
    now: () => clock,
    store: { record: (step) => void stored.push(step) },
    log: (line) => void logs.push(line),
    // Zero by default: these tests drive a FAKE clock, and a pending real-timer throttle window
    // would swallow every later emit. The throttle itself is exercised in its own test below,
    // which constructs with the production default.
    throttleMs: opts.throttleMs ?? 0,
  });

  return {
    activity,
    frames,
    stored,
    logs,
    bind(runtimeId: string, binding: StreamBinding) {
      bindings.set(runtimeId, binding);
    },
    unbind(runtimeId: string) {
      bindings.delete(runtimeId);
    },
    advance(ms: number) {
      clock += ms;
    },
    now: () => clock,
    /** Pushes the clock past the throttle window so the next change emits immediately. */
    settle() {
      clock += TOOL_ACTIVITY_THROTTLE_MS * 2;
    },
    event(type: string, payload: unknown, sessionId: string | undefined = RUNTIME): HermesEvent {
      return { type, sessionId, payload };
    },
    start(toolId: string, name = "terminal", extra: Record<string, unknown> = {}) {
      activity.handleEvent({
        type: "tool.start",
        sessionId: RUNTIME,
        payload: { tool_id: toolId, name, context: "rm -rf /tmp/x", args: { command: "rm -rf /tmp/x" }, ...extra },
      });
    },
    complete(toolId: string, result: unknown = { exit_code: 0 }, name = "terminal") {
      activity.handleEvent({
        type: "tool.complete",
        sessionId: RUNTIME,
        payload: {
          tool_id: toolId,
          name,
          args: { command: "rm -rf /tmp/x" },
          duration_s: 1.2,
          result,
          summary: "Ran a thing in 1.2s",
          inline_diff: "- secret\n+ secret2",
        },
      });
    },
    last(): ActivityFrame {
      const frame = frames.at(-1);
      if (frame === undefined) throw new Error("no bot_tool_activity frame was emitted");
      return frame;
    },
  };
}

const BOUND: StreamBinding = { bot: "sage", sessionId: "stored-1" };

describe("toolStepName", () => {
  it("passes an ordinary tool identifier through", () => {
    expect(toolStepName({ name: "terminal" })).toBe("terminal");
  });

  it("keeps the mcp namespacing convention intact", () => {
    expect(toolStepName({ name: "mcp__github__create_issue" })).toBe("mcp__github__create_issue");
  });

  it("replaces every character outside the identifier class, so a name cannot carry a path or a command", () => {
    expect(toolStepName({ name: "terminal rm -rf /etc/passwd" })).toBe("terminal_rm_-rf_etc_passwd");
    expect(toolStepName({ name: "read('/Users/kyle/.ssh/id_rsa')" })).toBe("read_Users_kyle_.ssh_id_rsa");
  });

  it("caps the length, because the codex path derives a name with no allow-list", () => {
    const name = toolStepName({ name: "a".repeat(TOOL_NAME_MAX + 500) });
    expect(name).toHaveLength(TOOL_NAME_MAX);
  });

  it("falls back to a fixed literal rather than guessing from any other member", () => {
    expect(toolStepName({ context: "rm -rf /", args: { command: "rm -rf /" } })).toBe(TOOL_NAME_FALLBACK);
    expect(toolStepName({ name: "   " })).toBe(TOOL_NAME_FALLBACK);
    expect(toolStepName({ name: "!!!!" })).toBe(TOOL_NAME_FALLBACK);
    expect(toolStepName(undefined)).toBe(TOOL_NAME_FALLBACK);
  });
});

describe("toolStepStatus", () => {
  it("reads a terminal exit code, the one truly structured signal hermes offers", () => {
    expect(toolStepStatus({ result: { exit_code: 0 } })).toBe("ok");
    expect(toolStepStatus({ result: { exit_code: 1 } })).toBe("error");
    expect(toolStepStatus({ result: { exit_code: 127 } })).toBe("error");
  });

  it("reads the error/success shape every other tool uses", () => {
    expect(toolStepStatus({ result: { error: "boom" } })).toBe("error");
    expect(toolStepStatus({ result: { success: false } })).toBe("error");
    expect(toolStepStatus({ result: { success: true } })).toBe("ok");
    expect(toolStepStatus({ result: { data: { web: [] } } })).toBe("ok");
  });

  it("treats an interrupt or a guardrail block as an error, because neither finished cleanly", () => {
    expect(toolStepStatus({ result: { error: "Tool execution cancelled by user", status: "cancelled" } })).toBe(
      "error",
    );
    expect(toolStepStatus({ result: { status: "failed" } })).toBe("error");
  });

  it("reads the synthesized error strings hermes returns unparsed", () => {
    expect(toolStepStatus({ result: "Error executing tool 'terminal': timed out after 120s" })).toBe("error");
    expect(toolStepStatus({ result: "[Tool execution cancelled - terminal was skipped due to user interrupt]" })).toBe(
      "error",
    );
  });

  it("does not call an ordinary string result an error just because it mentions one", () => {
    expect(toolStepStatus({ result: "the build succeeded with no errors" })).toBe("ok");
    expect(toolStepStatus({ result: "" })).toBe("ok");
  });

  it("defaults to ok when hermes reported no result at all", () => {
    expect(toolStepStatus({})).toBe("ok");
    expect(toolStepStatus(undefined)).toBe("ok");
  });
});

describe("BotToolActivity: the frame", () => {
  it("raises a running step on tool.start, keyed to the chat's own turn", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");

    expect(h.frames).toHaveLength(1);
    expect(h.last()).toEqual({
      type: "bot_tool_activity",
      bot: "sage",
      sessionId: "stored-1",
      turnId: "turn-1",
      seq: 1,
      updatedAt: h.now(),
      steps: [{ stepId: "call_1", seq: 1, name: "terminal", status: "running", startedAt: h.now() }],
    });
  });

  it("NOTHING free-text crosses the wire: no args, no context, no result, no summary, no diff", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.complete("call_1", { exit_code: 0, stdout: "AWS_SECRET=hunter2" });

    const serialized = JSON.stringify(h.frames);
    for (const leak of ["rm -rf", "/tmp/x", "hunter2", "AWS_SECRET", "secret2", "Ran a thing", "command"]) {
      expect(serialized).not.toContain(leak);
    }
    // And the same for what is written to disk.
    expect(JSON.stringify(h.stored)).not.toContain("rm -rf");
  });

  it("turns a step terminal on tool.complete and stamps when it ended", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    const startedAt = h.now();
    h.settle();
    h.complete("call_1");

    expect(h.last().steps).toEqual([
      { stepId: "call_1", seq: 1, name: "terminal", status: "ok", startedAt, endedAt: h.now() },
    ]);
  });

  it("reports a failed tool as error without saying why", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.complete("call_1", { exit_code: 1, stderr: "permission denied for /etc/shadow" });

    expect(h.last().steps[0]?.status).toBe("error");
    expect(JSON.stringify(h.last())).not.toContain("shadow");
  });

  it("is a FULL-REPLACE snapshot: every step of the turn rides every frame, in first-seen order", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1", "terminal");
    h.settle();
    h.start("call_2", "read_file");
    h.settle();
    h.start("call_3", "web_search");

    expect(h.last().steps.map((s) => [s.stepId, s.seq, s.name])).toEqual([
      ["call_1", 1, "terminal"],
      ["call_2", 2, "read_file"],
      ["call_3", 3, "web_search"],
    ]);
  });

  it("keeps a step's seq and startedAt pinned when it completes out of order, since tools run concurrently", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    const firstStartedAt = h.now();
    h.advance(10);
    h.start("call_2");
    h.settle();
    // The SECOND one finishes first, which a hermes thread pool makes routine.
    h.complete("call_2");
    const secondEndedAt = h.now();
    h.settle();
    h.complete("call_1");

    // Order is first-STARTED, not first-finished, and each step keeps its own two timestamps.
    expect(h.last().steps).toEqual([
      { stepId: "call_1", seq: 1, name: "terminal", status: "ok", startedAt: firstStartedAt, endedAt: h.now() },
      {
        stepId: "call_2",
        seq: 2,
        name: "terminal",
        status: "ok",
        startedAt: firstStartedAt + 10,
        endedAt: secondEndedAt,
      },
    ]);
    expect(secondEndedAt).toBeLessThan(h.now());
  });

  it("carries a frame seq that is monotonic within the turn, so a reordered frame is droppable", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.start("call_2");
    h.settle();
    h.complete("call_1");

    expect(h.frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(new Set(h.frames.map((f) => f.turnId))).toEqual(new Set(["turn-1"]));
  });

  it("records a step whose start was never seen, because an end alone is still a true thing that happened", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.complete("call_late");

    expect(h.last().steps).toEqual([
      { stepId: "call_late", seq: 1, name: "terminal", status: "ok", startedAt: h.now(), endedAt: h.now() },
    ]);
  });

  it("says nothing for a hermes session this gateway is not driving", () => {
    const h = harness();
    h.start("call_1");
    h.complete("call_1");

    expect(h.frames).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });

  it("ignores an event with no session id and every event type it does not name", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.activity.handleEvent({ type: "tool.start", sessionId: undefined, payload: { tool_id: "x", name: "terminal" } });
    h.activity.handleEvent(h.event("reasoning.delta", { text: "the user's password is hunter2" }));
    h.activity.handleEvent(h.event("thinking.delta", { text: "cogitating" }));
    h.activity.handleEvent(h.event("tool.generating", { name: "terminal" }));
    h.activity.handleEvent(h.event("message.delta", { text: "hello" }));

    expect(h.frames).toHaveLength(0);
  });

  it("drops a tool.start carrying no tool id, since there is nothing to correlate its end to", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.activity.handleEvent(h.event("tool.start", { name: "terminal" }));

    expect(h.frames).toHaveLength(0);
  });

  it("carries the room for a group member's turn, exactly as bot_chat_delta does", () => {
    const h = harness();
    h.bind(RUNTIME, { bot: "sage", sessionId: "stored-1", room: "standup" });
    h.start("call_1");

    expect(h.last().room).toBe("standup");
  });
});

describe("BotToolActivity: the end of a turn", () => {
  it("emits a done frame when the reply lands, with every step terminal", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.complete("call_1");
    h.settle();
    h.activity.handleEvent(h.event("message.complete", { text: "all done" }));

    expect(h.last().done).toBe(true);
    expect(h.last().steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("sweeps a step whose completion never arrived to error rather than leaving it running forever", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.start("call_2");
    h.settle();
    h.complete("call_1");
    h.settle();
    h.activity.handleEvent(h.event("message.complete", { text: "the turn died mid-tool" }));

    const final = h.last();
    expect(final.done).toBe(true);
    expect(final.steps.map((s) => [s.stepId, s.status])).toEqual([
      ["call_1", "ok"],
      ["call_2", "error"],
    ]);
  });

  it("emits nothing at all for a turn that ran no tools", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.activity.handleEvent(h.event("message.complete", { text: "just chatting" }));

    expect(h.frames).toHaveLength(0);
  });

  it("sends no further frame for a turn already marked done", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.activity.handleEvent(h.event("message.complete", {}));
    const after = h.frames.length;
    h.settle();
    h.complete("call_1");

    expect(h.frames).toHaveLength(after);
  });

  it("starts a fresh turn when the chat's turn id moves on, closing the previous one first", () => {
    const opts: { turnId?: string } = { turnId: "turn-1" };
    const frames: ActivityFrame[] = [];
    let clock = 1_800_000_000_000;
    const activity = new BotToolActivity({
      chat: { binding: () => BOUND, turnId: () => opts.turnId },
      broadcast: (frame) => {
        if (frame.type === "bot_tool_activity") frames.push(frame);
      },
      now: () => clock,
      store: { record: () => {} },
    });

    activity.handleEvent({ type: "tool.start", sessionId: RUNTIME, payload: { tool_id: "a", name: "terminal" } });
    clock += TOOL_ACTIVITY_THROTTLE_MS * 2;
    opts.turnId = "turn-2";
    activity.handleEvent({ type: "tool.start", sessionId: RUNTIME, payload: { tool_id: "b", name: "read_file" } });

    // The old turn was closed out, then the new one opened with only its own step.
    const closed = frames.filter((f) => f.turnId === "turn-1").at(-1);
    expect(closed?.done).toBe(true);
    expect(closed?.steps.map((s) => s.stepId)).toEqual(["a"]);
    const opened = frames.filter((f) => f.turnId === "turn-2").at(-1);
    expect(opened?.seq).toBe(1);
    expect(opened?.steps.map((s) => s.stepId)).toEqual(["b"]);
  });

  it("mints its own turn id when the chat has no turn in flight, and holds it for the whole turn", () => {
    const h = harness({ turnId: undefined });
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.start("call_2");

    const ids = new Set(h.frames.map((f) => f.turnId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.stringContaining(RUNTIME));
  });
});

describe("BotToolActivity: bounds and lifecycle", () => {
  it("throttles a busy turn instead of putting one frame on the radio per event", () => {
    const h = harness({ throttleMs: TOOL_ACTIVITY_THROTTLE_MS });
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    // Everything below lands inside one throttle window.
    for (let i = 2; i <= 10; i += 1) h.start(`call_${i}`);

    expect(h.frames).toHaveLength(1);
  });

  it("stops taking new steps past the per-turn cap, and lets the ones it has finish", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    for (let i = 0; i < MAX_STEPS_PER_TURN + 25; i += 1) h.start(`call_${i}`);
    h.settle();
    h.complete("call_0");

    expect(h.last().steps).toHaveLength(MAX_STEPS_PER_TURN);
    expect(h.last().steps[0]?.status).toBe("ok");
  });

  it("writes every step through to the store on start and again on completion", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.complete("call_1");

    expect(h.stored).toEqual([
      {
        bot: "sage",
        sessionId: "stored-1",
        turnId: "turn-1",
        stepId: "call_1",
        seq: 1,
        name: "terminal",
        status: "running",
        startedAt: expect.any(Number),
        endedAt: undefined,
      },
      {
        bot: "sage",
        sessionId: "stored-1",
        turnId: "turn-1",
        stepId: "call_1",
        seq: 1,
        name: "terminal",
        status: "ok",
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      },
    ]);
  });

  it("persists the swept status too, so history agrees with the last live frame", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    h.settle();
    h.activity.handleEvent(h.event("message.complete", {}));

    expect(h.stored.at(-1)?.status).toBe("error");
  });

  it("forgets a bot's turns without emitting anything for them", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    const before = h.frames.length;
    // The bridge forgets a bot on the stream and here at the same seam, so the binding goes too.
    h.unbind(RUNTIME);
    h.activity.forgetBot("sage");
    h.settle();
    h.complete("call_1");

    expect(h.frames).toHaveLength(before);
  });

  it("drops in-flight turns silently when the hermes link goes away", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.start("call_1");
    const before = h.frames.length;
    h.activity.reset();
    h.settle();
    h.complete("call_1");

    // The reset turn is gone; the late completion opens a fresh turn rather than reviving the one
    // whose start events went with the socket.
    expect(h.frames.length).toBeGreaterThan(before);
    expect(h.frames.at(-1)?.steps.map((s) => s.status)).toEqual(["ok"]);
  });

  it("goes quiet after close", () => {
    const h = harness();
    h.bind(RUNTIME, BOUND);
    h.activity.close();
    h.start("call_1");
    h.complete("call_1");

    expect(h.frames).toHaveLength(0);
    expect(h.stored).toHaveLength(0);
  });
});

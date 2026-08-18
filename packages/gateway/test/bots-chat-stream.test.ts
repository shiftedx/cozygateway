import { describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { BotChatStream, CHAT_DELTA_THROTTLE_MS } from "../src/hermes-bridge/chat-stream.ts";
import type { HermesEvent } from "../src/hermes-bridge/client.ts";

/** The live-draft producer, in isolation. Every event here is the wire shape the 2026-08-18 probe
 *  captured off a real Hermes 0.20.3 `/api/ws` socket, so what these tests feed in is what the
 *  gateway actually receives:
 *
 *  ```
 *  {"type":"message.start","session_id":"2df9dd5b"}
 *  {"type":"message.delta","session_id":"2df9dd5b","payload":{"text":"one"}}
 *  {"type":"thinking.delta","session_id":"2df9dd5b","payload":{"text":"( •_•)>⌐■-■ cogitating..."}}
 *  {"type":"message.complete","session_id":"2df9dd5b","payload":{"text":"one two ...","usage":{...}}}
 *  ```
 *
 *  The throttle is scaled down so the coalescing behavior runs in milliseconds; the production
 *  value is asserted below so the scaling cannot quietly become the contract. */

type DeltaFrame = Extract<ServerFrame, { type: "bot_chat_delta" }>;

const NOW = 1_800_000_000_000;

function harness(throttleMs = 20) {
  const frames: ServerFrame[] = [];
  const started = Date.now();
  const stream = new BotChatStream({
    broadcast: (frame) => frames.push(frame),
    // A fake epoch that advances with real time, so a scaled-down throttle window expires in
    // scaled-down wall time rather than one tick per clock read.
    now: () => NOW + (Date.now() - started),
    throttleMs,
  });
  const deltas = (): DeltaFrame[] =>
    frames.filter((frame): frame is DeltaFrame => frame.type === "bot_chat_delta");
  const event = (type: string, sessionId: string | undefined, payload?: unknown): void =>
    stream.handleEvent({ type, sessionId, payload } as HermesEvent);
  return { stream, frames, deltas, event };
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("BotChatStream", () => {
  it("throttles inside the design band", () => {
    expect(CHAT_DELTA_THROTTLE_MS).toBeGreaterThanOrEqual(150);
    expect(CHAT_DELTA_THROTTLE_MS).toBeLessThanOrEqual(250);
  });

  it("accumulates deltas and carries the FULL text on every frame", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "one" });
    await settle();
    event("message.delta", "runtime-1", { text: " two" });
    event("message.delta", "runtime-1", { text: " three" });
    await settle();

    // Never an increment: each frame is the whole draft so far, so a client renders the newest
    // frame and nothing else, and a dropped frame costs only staleness.
    expect(deltas().map((frame) => frame.text)).toEqual(["one", "one two", "one two three"]);
    expect(deltas().map((frame) => frame.seq)).toEqual([1, 2, 3]);
    for (const frame of deltas()) {
      // Keyed on the STORED session id, the one every other bots frame uses. The runtime id the
      // events carry is a Hermes internal and never reaches a client.
      expect(frame).toMatchObject({ bot: "scout", sessionId: "stored-1" });
      expect(frame.turnId).toBe(deltas()[0]!.turnId);
      expect(frame.updatedAt).toBeGreaterThanOrEqual(NOW);
      expect(frame.room).toBeUndefined();
    }
  });

  it("coalesces a burst of tokens into one frame per window", async () => {
    const { stream, deltas, event } = harness(40);
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    // Eleven tokens, the count the probe saw for a ten-word reply, all inside one window.
    for (const word of "one two three four five six seven eight nine ten .".split(" ")) {
      event("message.delta", "runtime-1", { text: `${word} ` });
    }
    // The leading edge went out immediately; the other ten tokens ride a single trailing frame.
    expect(deltas()).toHaveLength(1);
    await settle(80);
    expect(deltas()).toHaveLength(2);
    expect(deltas().at(-1)!.text).toBe("one two three four five six seven eight nine ten . ");
  });

  it("never forwards a chain-of-thought event of any kind", async () => {
    const { stream, deltas, frames, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    // The probe's own samples, verbatim, plus the two that carry real reasoning.
    event("thinking.delta", "runtime-1", { text: "( •_•)>⌐■-■ cogitating..." });
    event("reasoning.delta", "runtime-1", { text: "the user probably wants the CI status" });
    event("reasoning.available", "runtime-1", { text: "the user probably wants the CI status" });
    event("session.title", "runtime-1", { title: "CI check" });
    event("some.future.reasoning.kind", "runtime-1", { text: "secret plan" });
    await settle();

    // Not merely unforwarded: not buffered either, so it cannot surface later on some other frame.
    expect(frames).toHaveLength(0);
    event("message.delta", "runtime-1", { text: "all green" });
    await settle();
    expect(deltas()).toHaveLength(1);
    expect(deltas()[0]!.text).toBe("all green");
    const rendered = JSON.stringify(frames);
    expect(rendered).not.toContain("cogitating");
    expect(rendered).not.toContain("probably wants");
    expect(rendered).not.toContain("secret plan");
  });

  it("hands off to the canonical path on message.complete", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "all" });
    await settle();
    event("message.complete", "runtime-1", {
      text: "all green",
      usage: { model: "gpt-5.6-sol", input: 16_961, output: 15, total: 16_976 },
    });

    const last = deltas().at(-1)!;
    // `message.complete` carries the whole persisted reply, which is preferred over the
    // accumulation: it closes any gap left by a delta that arrived before the binding.
    expect(last).toMatchObject({ text: "all green", done: true });
    expect(deltas().slice(0, -1).every((frame) => frame.done === undefined)).toBe(true);
    expect(stream.drafting("runtime-1")).toBe(false);

    // Nothing more for that turn, whatever arrives afterwards.
    const before = deltas().length;
    event("message.delta", "runtime-1", { text: " and fast" });
    await settle();
    expect(deltas()).toHaveLength(before);
  });

  it("mints a fresh turn id when hermes reuses the session id for the next turn", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "first" });
    event("message.complete", "runtime-1", { text: "first" });
    // Second send, same session: the bridge re-binds and Hermes starts a new message on the very
    // same runtime id.
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "second" });
    await settle();

    const [firstTurn, secondTurn] = [deltas()[0]!, deltas().at(-1)!];
    expect(firstTurn.turnId).not.toBe(secondTurn.turnId);
    expect(secondTurn.text).toBe("second");
    // Seq restarts per turn, which is why a client compares seq only within a turnId.
    expect(secondTurn.seq).toBe(1);
  });

  it("ignores events for a session nobody bound", async () => {
    const { frames, event } = harness();
    event("message.start", "runtime-9");
    event("message.delta", "runtime-9", { text: "not ours" });
    event("message.complete", "runtime-9", { text: "not ours" });
    // A `gateway.ready` has no session id at all and must not throw its way through here either.
    event("gateway.ready", undefined, { skin: "fake" });
    await settle();
    expect(frames).toHaveLength(0);
  });

  it("picks a turn up mid-flight when the transport was re-claimed after it started", async () => {
    // Transport theft: a Hermes desktop resumed the session, so `message.start` and the first
    // tokens went to the dashboard. The bridge's 2 s poll resumes and takes the route back, and the
    // rest of the turn lands here with no start event to open it.
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.delta", "runtime-1", { text: "third of the reply" });
    await settle();
    expect(deltas()).toHaveLength(1);
    expect(deltas()[0]!.text).toBe("third of the reply");
    // And the complete still closes it with the WHOLE reply, so the visible effect of the theft is
    // a draft that jumps forward once rather than a reply missing its opening.
    event("message.complete", "runtime-1", { text: "first two thirds and third of the reply" });
    expect(deltas().at(-1)).toMatchObject({ text: "first two thirds and third of the reply", done: true });
  });

  it("drops a half-written draft when the hermes link goes away, silently", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "half a" });
    await settle();
    expect(deltas()).toHaveLength(1);

    stream.reset();
    // No `done` frame: the turn did not end, the socket did. The client keeps its draft until the
    // turn's own state frame or the canonical message retires it.
    expect(deltas()).toHaveLength(1);
    expect(stream.drafting("runtime-1")).toBe(false);

    // The binding survives, so the reconnected socket's next tokens open a NEW turn rather than
    // resuming a buffer whose beginning is gone.
    event("message.delta", "runtime-1", { text: "sentence" });
    await settle();
    expect(deltas().at(-1)!.text).toBe("sentence");
    expect(deltas().at(-1)!.turnId).not.toBe(deltas()[0]!.turnId);
  });

  it("forgets a bot outright", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    stream.bind("runtime-2", { bot: "cleo", sessionId: "stored-2" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "hi" });
    await settle();
    stream.forgetBot("scout");

    event("message.delta", "runtime-1", { text: " there" });
    event("message.start", "runtime-2");
    event("message.delta", "runtime-2", { text: "still here" });
    await settle();
    expect(deltas().map((frame) => `${frame.bot}:${frame.text}`)).toEqual(["scout:hi", "cleo:still here"]);
  });

  it("names the room for a group member's turn", async () => {
    const { stream, deltas, event } = harness();
    stream.bind("runtime-7", { bot: "scout", sessionId: "group-stored", room: "Release Room" });
    event("message.start", "runtime-7");
    event("message.delta", "runtime-7", { text: "ship it" });
    await settle();
    expect(deltas()[0]).toMatchObject({ bot: "scout", room: "Release Room", sessionId: "group-stored" });
  });

  it("ignores an empty or non-string delta payload", async () => {
    const { stream, frames, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "" });
    event("message.delta", "runtime-1", { rendered: "<b>bold</b>" });
    event("message.delta", "runtime-1", {});
    event("message.delta", "runtime-1", "just a string");
    await settle();
    expect(frames).toHaveLength(0);
  });

  it("goes quiet after close", async () => {
    const { stream, frames, event } = harness();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    stream.close();
    stream.bind("runtime-1", { bot: "scout", sessionId: "stored-1" });
    event("message.start", "runtime-1");
    event("message.delta", "runtime-1", { text: "too late" });
    await settle();
    expect(frames).toHaveLength(0);
  });
});

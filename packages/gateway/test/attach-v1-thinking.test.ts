import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** The `thinking` event is EPHEMERAL rendering state with the same stream hygiene as
 *  draft/tool/delegation: it must never dead-letter (a preview is never worth a blocked bot,
 *  issue #193), and a plugin that never negotiated the capability gets a loud discard ack, not
 *  a silent black hole. */
describe("attach-v1 thinking channel", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let accepted: AttachV1EventFrame[];
  let clock: number;
  let projectionSucceeds: boolean;
  let logs: string[];

  beforeEach(async () => {
    storage = openStorage(":memory:");
    accepted = [];
    clock = 0;
    projectionSucceeds = true;
    logs = [];
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      events: {
        onEvent: (_agent, frame) => { accepted.push(frame); return projectionSucceeds; },
        onPresence: () => {},
      },
      now: () => clock,
      heartbeatIntervalMs: 1000,
      heartbeatTimeoutMs: 5000,
      projectionRetryMs: 5,
      projectionMaxAttempts: 3,
      log: (line) => logs.push(line),
    });
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });

  afterEach(async () => {
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  async function dial(capabilities: string[]): Promise<{ ws: WebSocket; frames: AttachV1ServerFrame[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: "Bearer secret" } });
    const frames: AttachV1ServerFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "plugin", capabilities, resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return { ws, frames };
  }

  const thinking = (sequence: number, seq: number) => ({
    kind: "event", sequence, eventId: `think-${sequence}`,
    event: { kind: "thinking", threadId: "t", turnId: "u", text: "reading the diff", seq, lastActiveAt: 5 },
  });

  it("skips an undeliverable thinking preview after bounded retries instead of dead-lettering", async () => {
    projectionSucceeds = false;
    const { ws, frames } = await dial(["draft", "thinking"]);
    ws.send(JSON.stringify(thinking(1, 1)));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1));

    // The preview burns its retries and is skipped out loud: no dead letter, stream unblocked.
    await until(() => storage.unappliedAttachEvents("sage").length === 0);
    expect(storage.attachProjectionDeadLetters()).toEqual([]);
    expect(logs.some((line) => line.includes("skipped undeliverable thinking event"))).toBe(true);

    // The next durable event applies normally: the walk was never blocked.
    projectionSucceeds = true;
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "good-commit", event: { kind: "commit", threadId: "t", turnId: "u", messageId: "m", blocks: [{ type: "paragraph", text: "done" }] } }));
    await until(() => accepted.some((frame) => frame.eventId === "good-commit"));
    ws.close();
  });

  it("discards a thinking event from a plugin that never negotiated the capability", async () => {
    const { ws, frames } = await dial(["draft"]);
    ws.send(JSON.stringify(thinking(1, 1)));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1));
    const ack = frames.find((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1)!;
    // Discarded loudly at admission -- never projected, and below-capability peers are unchanged.
    expect(ack).toMatchObject({ discarded: true, reason: "capability_not_negotiated" });
    expect(accepted).toEqual([]);
    ws.close();
  });
});

async function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1EventFrame, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Issue #193 hygiene: a dead letter head-of-line blocks its agent's whole stream, so (a) an
 *  EPHEMERAL event (draft/tool) must never become one -- it is skipped after its retries, out
 *  loud -- and (b) the dead letters that durable events can still produce must be listable and
 *  releasable by an operator without DB surgery. */
describe("attach-v1 dead-letter hygiene", () => {
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

  async function dial(): Promise<{ ws: WebSocket; frames: AttachV1ServerFrame[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: "Bearer secret" } });
    const frames: AttachV1ServerFrame[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(String(data)) as AttachV1ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ kind: "hello", version: 2, instanceId: "plugin", capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    await until(() => frames.some((frame) => frame.kind === "hello_ack"));
    return { ws, frames };
  }

  it("skips an undeliverable draft after bounded retries instead of dead-lettering the stream", async () => {
    projectionSucceeds = false;
    const { ws, frames } = await dial();
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "bad-draft", event: { kind: "draft", threadId: "t", turnId: "u", blocks: [{ type: "paragraph", text: "half" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event" && frame.sequence === 1));

    // The draft burns its retries and is skipped: no dead letter, stream unblocked.
    await until(() => storage.unappliedAttachEvents("sage").length === 0);
    expect(storage.attachProjectionDeadLetters()).toEqual([]);
    expect(logs.some((line) => line.includes("skipped undeliverable draft event"))).toBe(true);

    // The next durable event applies normally.
    projectionSucceeds = true;
    ws.send(JSON.stringify({ kind: "event", sequence: 2, eventId: "good-commit", event: { kind: "commit", threadId: "t", turnId: "u", messageId: "m", blocks: [{ type: "paragraph", text: "done" }] } }));
    await until(() => accepted.some((frame) => frame.eventId === "good-commit"));
    ws.close();
  });

  it("still dead-letters a durable event, and lists it with its diagnosis", async () => {
    projectionSucceeds = false;
    const { ws, frames } = await dial();
    ws.send(JSON.stringify({ kind: "event", sequence: 1, eventId: "bad-commit", event: { kind: "commit", threadId: "t", turnId: "u", messageId: "m", blocks: [{ type: "paragraph", text: "done" }] } }));
    await until(() => frames.some((frame) => frame.kind === "ack" && frame.channel === "event"));
    await until(() => storage.attachProjectionDeadLetters().length === 1);
    expect(storage.attachProjectionDeadLetters()[0]).toMatchObject({
      agentId: "sage", sequence: 1, eventId: "bad-commit", kind: "commit",
      attempts: 3, error: "projection declined event",
    });
    expect(logs.some((line) => line.includes("dead-lettered after 3 projection attempts"))).toBe(true);
    ws.close();
  });
});

it("an operator can list and release a dead letter over the device API", async () => {
  process.env["DEADLETTER_DASHBOARD_TOKEN"] = "dashboard-secret";
  process.env["DEADLETTER_SAGE_TOKEN"] = "attach-secret";
  let gateway: RunningGateway | undefined;
  let hermes: FakeHermesServer | undefined;
  try {
    hermes = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [{ name: "sage", description: "native", has_avatar: false, ui_meta: { "hermes-bots": { title: "Sage" } } }], bot_mode_protocol: true }),
      },
    });
    gateway = await startGateway({
      name: "deadletter-e2e",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default",
        url: hermes.url,
        tokenEnv: "DEADLETTER_DASHBOARD_TOKEN",
        profiles: { sage: { tokenEnv: "DEADLETTER_SAGE_TOKEN", name: "Sage" } },
      }],
    });
    const pair = await fetch(`${gateway.url}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }) });
    const deviceToken = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const auth = { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" };

    // Fabricate the production shape directly in the journal: a journaled durable event whose
    // projection failed to the dead letter.
    const frame = { kind: "event", sequence: 1, eventId: "stuck-commit", event: { kind: "commit", threadId: "ghost-thread", turnId: "ghost-turn", messageId: "ghost-answer", blocks: [{ type: "paragraph", text: "stuck" }] } } as never;
    expect(gateway.storage.acceptAttachEvent("sage", frame, 1_000).status).toBe("accepted");
    gateway.storage.recordAttachProjectionFailure("sage", "stuck-commit", "projection declined event", 1_001, 1);

    const listed = (await (await fetch(`${gateway.url}/attach/deadletters`, { headers: auth })).json()) as { deadLetters: Array<Record<string, unknown>> };
    expect(listed.deadLetters).toHaveLength(1);
    expect(listed.deadLetters[0]).toMatchObject({ agentId: "sage", eventId: "stuck-commit", kind: "commit" });

    const missing = await fetch(`${gateway.url}/attach/deadletters/release`, { method: "POST", headers: auth, body: JSON.stringify({ agentId: "sage", eventId: "not-there" }) });
    expect(missing.status).toBe(404);

    const release = await fetch(`${gateway.url}/attach/deadletters/release`, { method: "POST", headers: auth, body: JSON.stringify({ agentId: "sage", eventId: "stuck-commit" }) });
    expect(release.status).toBe(200);
    expect(await release.json()).toEqual({ released: true });
    // The released event retries immediately; this one is an orphan (no turn command), so the
    // fixed chain acknowledges it and the stream is clean again.
    await until(() => gateway!.storage.attachProjectionDeadLetters().length === 0);
    await until(() => gateway!.storage.unappliedAttachEvents("sage").length === 0);

    const unauthorized = await fetch(`${gateway.url}/attach/deadletters`);
    expect(unauthorized.status).toBe(401);
  } finally {
    await gateway?.close();
    await hermes?.close();
    delete process.env["DEADLETTER_DASHBOARD_TOKEN"];
    delete process.env["DEADLETTER_SAGE_TOKEN"];
  }
});

async function until(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 4000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

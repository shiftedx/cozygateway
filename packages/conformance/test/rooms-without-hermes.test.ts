/** Capability 46 and 52, finding V1-F1: the room wire contract on a gateway with NO Hermes
 *  endpoint at all.
 *
 *  Every other runner in this package declares a Hermes endpoint, so the shape a CozyAgents-only
 *  deployment actually ships was the one shape nothing here booted. Rooms are gateway-owned
 *  attach-v1 conversations (contract, "Group rooms are gateway-owned attach-v1 conversations
 *  too"), so a room of runtime bots owes nothing to a Dashboard, and this pins the published
 *  schemas against the real bytes such a gateway serves.
 *
 *  The members are config-declared runtime bots (capability 45), which is how a gateway with no
 *  Hermes names its attach identities, and each is answered by the reference echo peer. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertValid,
  BotGroupDetailSchema,
  BotGroupMessageSchema,
  BotGroupSchema,
} from "cozygateway-contract";
import { startGateway, type RunningGateway } from "cozygateway";

import { AttachPeer } from "./reference-attach.ts";

let gateway: RunningGateway;
let deviceToken: string;
const peers: AttachPeer[] = [];

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function authed(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${gateway.url}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
  });
}

beforeAll(async () => {
  process.env.ROOMS_NO_HERMES_SAGE_TOKEN = "rooms-sage-secret";
  process.env.ROOMS_NO_HERMES_PIXEL_TOKEN = "rooms-pixel-secret";
  gateway = await startGateway({
    name: "conformance-rooms-without-hermes",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    // No `hermesEndpoints` at all. This is the whole point.
    bots: [
      { id: "sage", name: "Sage", tokenEnv: "ROOMS_NO_HERMES_SAGE_TOKEN", runtime: "cozyagents" },
      { id: "pixel", name: "Pixel", tokenEnv: "ROOMS_NO_HERMES_PIXEL_TOKEN", runtime: "cozyagents" },
    ],
  });
  const paired = (await (await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  })).json()) as { deviceToken: string };
  deviceToken = paired.deviceToken;
  for (const token of ["rooms-sage-secret", "rooms-pixel-secret"]) {
    const peer = new AttachPeer(() => gateway, token, "echo");
    peers.push(peer);
    await peer.connect();
  }
});

afterAll(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await gateway?.close();
  delete process.env.ROOMS_NO_HERMES_SAGE_TOKEN;
  delete process.env.ROOMS_NO_HERMES_PIXEL_TOKEN;
});

describe("rooms on a gateway with no Hermes endpoint", () => {
  it("advertises the bots capability and no rooms yet", async () => {
    const health = (await (await fetch(`${gateway.url}/health`)).json()) as {
      capabilities: Record<string, number>;
    };
    expect(health.capabilities["com.cozylabs.bots"]).toBeGreaterThanOrEqual(52);
    expect(((await (await authed("/bots/groups")).json()) as { groups: unknown[] }).groups).toEqual([]);
  });

  it("creates, lists and reads a room of two runtime bots, and fans a member turn out to both", async () => {
    const created = await authed("/bots/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch", members: ["sage", "pixel"] }),
    });
    expect(created.status).toBe(201);
    const room = ((await created.json()) as { group: unknown }).group;
    assertValid(BotGroupSchema, room);
    expect(room).toMatchObject({ name: "Launch", members: ["sage", "pixel"] });

    const listed = (await (await authed("/bots/groups")).json()) as { groups: unknown[] };
    expect(listed.groups).toHaveLength(1);
    for (const group of listed.groups) assertValid(BotGroupSchema, group);

    const sent = await authed("/bots/groups/launch/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "plan the launch @sage @pixel" }),
    });
    expect(sent.status).toBe(202);
    assertValid(BotGroupMessageSchema, ((await sent.json()) as { message: unknown }).message);

    // Both members answer on their own gateway-owned room threads, with nothing federated anywhere.
    await until(async () => {
      const detail = (await (await authed("/bots/groups/launch")).json()) as {
        messages: Array<{ from: { kind: string; name: string } }>;
      };
      return new Set(detail.messages.filter((message) => message.from.kind === "member")
        .map((message) => message.from.name)).size === 2;
    });
    const detail: unknown = await (await authed("/bots/groups/launch")).json();
    assertValid(BotGroupDetailSchema, detail);
  });

  it("deletes the room", async () => {
    expect((await authed("/bots/groups/launch", { method: "DELETE" })).status).toBe(204);
    expect(((await (await authed("/bots/groups")).json()) as { groups: unknown[] }).groups).toEqual([]);
  });
});

/** Capability 46 and 52, finding F8: the room wire contract on a gateway with TWO Hermes endpoints.
 *
 *  R1 booted the shape with NO endpoint. This is the other shape nothing in this package had ever
 *  booted: a federated gateway, where a bot's public name is `<endpoint>:<profile>` and a room can
 *  therefore resolve to one endpoint, to the gateway itself, or to neither.
 *
 *  Three rooms, three owners, one wire contract:
 *  - every member on endpoint `alpha` is hosted by `alpha`'s own rooms;
 *  - every member a gateway runtime bot is hosted by the Hermes-free host R1 added, on this same
 *    federated gateway;
 *  - a membership spanning `alpha` and `beta` still has no host and is still refused 503.
 *
 *  Every body is checked against the published schemas, which do not move for any of it: this is a
 *  server-side routing decision, not a wire change. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertValid,
  BotGroupDetailSchema,
  BotGroupMessageSchema,
  BotGroupSchema,
} from "cozygateway-contract";
import { startGateway, type RunningGateway } from "cozygateway";

import { startFakeHermesServer, type FakeHermesServer } from "../../gateway/test/support/fake-hermes-server.ts";
import { AttachPeer } from "./reference-attach.ts";

let gateway: RunningGateway;
let deviceToken: string;
const hermes: FakeHermesServer[] = [];
const peers: AttachPeer[] = [];

const TOKENS = {
  ROOMS_2EP_ALPHA_CONTROL: "rooms-2ep-alpha-control",
  ROOMS_2EP_BETA_CONTROL: "rooms-2ep-beta-control",
  ROOMS_2EP_LUNA: "rooms-2ep-luna",
  ROOMS_2EP_SAGE: "rooms-2ep-sage",
  ROOMS_2EP_NOVA: "rooms-2ep-nova",
  ROOMS_2EP_PIXEL: "rooms-2ep-pixel",
  ROOMS_2EP_BYTE: "rooms-2ep-byte",
} as const;

async function until(predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
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

function profileList(...names: string[]): unknown {
  return {
    profiles: names.map((name) => ({ name, description: name, has_avatar: false })),
    bot_mode_protocol: true,
  };
}

async function members(room: string): Promise<string[]> {
  const detail = (await (await authed(`/bots/groups/${room}`)).json()) as {
    messages: Array<{ from: { kind: string; name: string } }>;
  };
  return [...new Set(detail.messages.filter((message) => message.from.kind === "member").map((message) => message.from.name))].sort();
}

beforeAll(async () => {
  Object.assign(process.env, TOKENS);
  const alpha = await startFakeHermesServer({ methods: { "profiles.list": () => profileList("luna", "sage") } });
  const beta = await startFakeHermesServer({ methods: { "profiles.list": () => profileList("nova") } });
  hermes.push(alpha, beta);
  gateway = await startGateway({
    name: "conformance-rooms-two-endpoints",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermesEndpoints: [
      { id: "alpha", url: alpha.url, tokenEnv: "ROOMS_2EP_ALPHA_CONTROL",
        profiles: { luna: { tokenEnv: "ROOMS_2EP_LUNA" }, sage: { tokenEnv: "ROOMS_2EP_SAGE" } } },
      { id: "beta", url: beta.url, tokenEnv: "ROOMS_2EP_BETA_CONTROL",
        profiles: { nova: { tokenEnv: "ROOMS_2EP_NOVA" } } },
    ],
    // The same gateway also has runtime bots, so the Hermes-free host R1 added is exercised on a
    // federated gateway rather than only on one with no Hermes at all.
    bots: [
      { id: "pixel", name: "Pixel", tokenEnv: "ROOMS_2EP_PIXEL", runtime: "cozyagents" },
      { id: "byte", name: "Byte", tokenEnv: "ROOMS_2EP_BYTE", runtime: "cozyagents" },
    ],
  });
  const paired = (await (await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  })).json()) as { deviceToken: string };
  deviceToken = paired.deviceToken;
  for (const token of [TOKENS.ROOMS_2EP_LUNA, TOKENS.ROOMS_2EP_SAGE, TOKENS.ROOMS_2EP_NOVA, TOKENS.ROOMS_2EP_PIXEL, TOKENS.ROOMS_2EP_BYTE]) {
    const peer = new AttachPeer(() => gateway, token, "echo");
    peers.push(peer);
    await peer.connect();
  }
  await until(async () => ((await (await authed("/bots")).json()) as { bots: unknown[] }).bots.length === 5);
});

afterAll(async () => {
  for (const peer of peers.splice(0)) peer.close();
  await gateway?.close();
  await Promise.all(hermes.splice(0).map((server) => server.close()));
  for (const key of Object.keys(TOKENS)) delete process.env[key];
});

describe("rooms on a gateway with two Hermes endpoints", () => {
  it("advertises the bots capability, both endpoints' bots by public name, and no rooms yet", async () => {
    const health = (await (await fetch(`${gateway.url}/health`)).json()) as {
      capabilities: Record<string, number>;
    };
    expect(health.capabilities["com.cozylabs.bots"]).toBeGreaterThanOrEqual(52);
    const bots = ((await (await authed("/bots")).json()) as { bots: Array<{ name: string }> }).bots.map((bot) => bot.name).sort();
    expect(bots).toEqual(["alpha:luna", "alpha:sage", "beta:nova", "byte", "pixel"]);
    expect(((await (await authed("/bots/groups")).json()) as { groups: unknown[] }).groups).toEqual([]);
  });

  it("creates and runs a room whose members all live on one endpoint", async () => {
    const created = await authed("/bots/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch", members: ["alpha:luna", "alpha:sage"] }),
    });
    expect(created.status).toBe(201);
    const room = ((await created.json()) as { group: unknown }).group;
    assertValid(BotGroupSchema, room);
    expect(room).toMatchObject({ name: "Launch", members: ["alpha:luna", "alpha:sage"] });

    const sent = await authed("/bots/groups/launch/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "plan the launch @alpha:luna @alpha:sage" }),
    });
    expect(sent.status).toBe(202);
    assertValid(BotGroupMessageSchema, ((await sent.json()) as { message: unknown }).message);

    await until(async () => (await members("launch")).length === 2);
    expect(await members("launch")).toEqual(["alpha:luna", "alpha:sage"]);
    assertValid(BotGroupDetailSchema, await (await authed("/bots/groups/launch")).json());
  });

  it("creates and runs a room of gateway runtime bots on the same federated gateway", async () => {
    const created = await authed("/bots/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Standup", members: ["pixel", "byte"] }),
    });
    expect(created.status).toBe(201);
    assertValid(BotGroupSchema, ((await created.json()) as { group: unknown }).group);

    const sent = await authed("/bots/groups/standup/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "status please @pixel @byte" }),
    });
    expect(sent.status).toBe(202);
    await until(async () => (await members("standup")).length === 2);
    expect(await members("standup")).toEqual(["byte", "pixel"]);
    assertValid(BotGroupDetailSchema, await (await authed("/bots/groups/standup")).json());
  });

  it("still refuses a room spanning both endpoints", async () => {
    const spanning = await authed("/bots/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Spanning", members: ["alpha:luna", "beta:nova"] }),
    });
    expect(spanning.status).toBe(503);
    expect(await spanning.json()).toMatchObject({
      error: { code: "backend_unavailable", message: "cross-endpoint groups are not supported" },
    });
    expect(((await (await authed("/bots/groups")).json()) as { groups: Array<{ name: string }> }).groups.map((group) => group.name).sort())
      .toEqual(["Launch", "Standup"]);
  });

  it("lists and deletes both rooms", async () => {
    const listed = (await (await authed("/bots/groups")).json()) as { groups: unknown[] };
    for (const group of listed.groups) assertValid(BotGroupSchema, group);
    for (const room of ["launch", "standup"]) {
      expect((await authed(`/bots/groups/${room}`, { method: "DELETE" })).status).toBe(204);
    }
    expect(((await (await authed("/bots/groups")).json()) as { groups: unknown[] }).groups).toEqual([]);
  });
});

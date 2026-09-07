/** F8: rooms on a gateway with TWO OR MORE Hermes endpoints.
 *
 *  R1 gave a gateway with ZERO endpoints a room host and left every other federated shape refusing
 *  every room, including one whose members all live on a single endpoint. That is the real gap for
 *  a federated operator: `#route` already knows which endpoint owns a name, so a room that resolves
 *  entirely to one endpoint can be hosted by that endpoint's own `GroupRooms`, and only a room
 *  genuinely spanning two endpoints has no host.
 *
 *  Kyle's ruling on the membership question R1 flagged: a room stays on the endpoint it was created
 *  on. A membership that comes to name a bot on another endpoint is refused by name
 *  (`RoomEndpointMismatch`); migrating a live room's durable state between endpoints is out of
 *  scope. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { loadConfig } from "../src/config.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";
import { BackendUnavailable } from "../src/errors.ts";
import {
  FederatedBotControlSurface,
  RoomEndpointMismatch,
  type FederationMember,
} from "../src/hermes-bridge/federation.ts";
import type { GatewayRoomHost } from "../src/hermes-bridge/group-rooms.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

async function until(check: () => boolean | Promise<boolean>, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition not met");
}

/** A room host that records what it was asked to do, so a routing test can name the endpoint that
 *  actually received the call rather than inferring it from a side effect. */
class RecordingHost {
  readonly calls: string[] = [];
  readonly id: string;
  constructor(id: string) { this.id = id; }
  groups(): never[] { return []; }
  createGroup(name: string, members: string[]): Promise<{ name: string; members: string[] }> {
    this.calls.push(`create:${name}`);
    return Promise.resolve({ name, members });
  }
  deleteGroup(name: string): void { this.calls.push(`delete:${name}`); }
  groupDetail(name: string): { name: string } { this.calls.push(`detail:${name}`); return { name }; }
  sendGroupMessage(name: string): { id: string } { this.calls.push(`send:${name}`); return { id: `${this.id}:1` }; }
  setGroupNativeTurns(): void {}
  setGroupInteractionExpiry(): void {}
  canAcceptGroupAttachEvent(): boolean { return false; }
  handleGroupAttachEvent(): boolean { return false; }
}

function surface(rooms: Map<string, string[]>): {
  federation: FederatedBotControlSurface;
  hosts: { home: RecordingHost; studio: RecordingHost; gateway: RecordingHost };
} {
  const hosts = { home: new RecordingHost("home"), studio: new RecordingHost("studio"), gateway: new RecordingHost("gateway") };
  const members: FederationMember[] = [
    { id: "home", bridge: hosts.home as unknown as FederationMember["bridge"] },
    { id: "studio", bridge: hosts.studio as unknown as FederationMember["bridge"] },
  ];
  const federation = new FederatedBotControlSurface(
    members,
    undefined,
    hosts.gateway as unknown as GatewayRoomHost,
    (key) => rooms.get(key),
  );
  return { federation, hosts };
}

describe("room ownership on a federated control surface", () => {
  it("hosts a room whose members all live on one endpoint on that endpoint", async () => {
    const rooms = new Map<string, string[]>();
    const { federation, hosts } = surface(rooms);
    const created = await federation.createGroup("Launch", ["home:luna", "home:sage"]);
    expect(created.name).toBe("Launch");
    expect(hosts.home.calls).toEqual(["create:Launch"]);
    expect(hosts.studio.calls).toEqual([]);
    expect(hosts.gateway.calls).toEqual([]);
  });

  it("refuses a room spanning two endpoints exactly as before", async () => {
    const { federation, hosts } = surface(new Map());
    await expect(federation.createGroup("Launch", ["home:luna", "studio:nova"]))
      .rejects.toThrow("cross-endpoint groups are not supported");
    expect(hosts.home.calls).toEqual([]);
    expect(hosts.studio.calls).toEqual([]);
  });

  it("hosts a room of gateway runtime bots on the gateway's own host", async () => {
    const rooms = new Map<string, string[]>();
    const { federation, hosts } = surface(rooms);
    await federation.createGroup("Standup", ["pixel", "byte"]);
    expect(hosts.gateway.calls).toEqual(["create:Standup"]);
    expect(hosts.home.calls).toEqual([]);
  });

  it("routes every later call to the endpoint the room was created on", async () => {
    const rooms = new Map<string, string[]>();
    const { federation, hosts } = surface(rooms);
    await federation.createGroup("Launch", ["home:luna", "home:sage"]);
    rooms.set("launch", ["home:luna", "home:sage"]);
    federation.groupDetail("Launch");
    federation.sendGroupMessage("Launch", "ship it");
    federation.deleteGroup("Launch");
    expect(hosts.home.calls).toEqual(["create:Launch", "detail:Launch", "send:Launch", "delete:Launch"]);
    expect(hosts.studio.calls).toEqual([]);
    expect(hosts.gateway.calls).toEqual([]);
  });

  it("refuses by name when a member on another endpoint joins an existing single-endpoint room", async () => {
    const rooms = new Map<string, string[]>();
    const { federation, hosts } = surface(rooms);
    await federation.createGroup("Launch", ["home:luna", "home:sage"]);
    rooms.set("launch", ["home:luna", "home:sage", "studio:nova"]);
    let thrown: unknown;
    try {
      federation.sendGroupMessage("Launch", "ship it");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RoomEndpointMismatch);
    expect(thrown).toBeInstanceOf(BackendUnavailable);
    expect((thrown as RoomEndpointMismatch).host).toBe("home");
    expect((thrown as RoomEndpointMismatch).foreign).toEqual(["studio"]);
    expect((thrown as Error).message).toContain("a room stays on the endpoint it was created on");
    // The room is not silently re-homed, and nothing reached the other endpoint.
    expect(hosts.studio.calls).toEqual([]);
    expect(hosts.home.calls).toEqual(["create:Launch"]);
  });
});

describe("rooms on a gateway with two Hermes endpoints", () => {
  const gateways: RunningGateway[] = [];
  const servers: FakeHermesServer[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
    await Promise.all(servers.splice(0).map((server) => server.close()));
    for (const key of ["HOME_HERMES", "STUDIO_HERMES", "HOME_LUNA", "HOME_SAGE", "STUDIO_NOVA"]) delete process.env[key];
  });

  it("creates and runs a room whose members all live on one endpoint, and still refuses one that spans both", async () => {
    const list = (...names: string[]): unknown => ({
      profiles: names.map((name) => ({ name, description: name, has_avatar: false })),
      bot_mode_protocol: true,
    });
    const home = await startFakeHermesServer({ methods: { "profiles.list": () => list("luna", "sage") } });
    const studio = await startFakeHermesServer({ methods: { "profiles.list": () => list("nova") } });
    servers.push(home, studio);
    Object.assign(process.env, {
      HOME_HERMES: "h", STUDIO_HERMES: "s", HOME_LUNA: "hl", HOME_SAGE: "hs", STUDIO_NOVA: "sn",
    });
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-f8-"));
    const path = join(directory, "config.json");
    writeFileSync(path, JSON.stringify({
      name: "Two Endpoints",
      port: 8787,
      dbPath: join(directory, "gateway.sqlite"),
      turnTimeoutSeconds: 0,
      hermesEndpoints: [
        { id: "home", url: home.url, tokenEnv: "HOME_HERMES",
          profiles: { luna: { tokenEnv: "HOME_LUNA" }, sage: { tokenEnv: "HOME_SAGE" } } },
        { id: "studio", url: studio.url, tokenEnv: "STUDIO_HERMES",
          profiles: { nova: { tokenEnv: "STUDIO_NOVA" } } },
      ],
    }));
    const config = loadConfig(path);
    config.port = 0;
    const gateway = await startGateway(config, { configPath: path });
    gateways.push(gateway);
    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
    });
    const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const authed = (suffix: string, init?: RequestInit): Promise<Response> =>
      fetch(`${gateway.url}${suffix}`, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` } });

    // Each member answers on its own attach identity, which on a federated gateway IS the public
    // `<endpoint>:<profile>` name, so a room hosted by an endpoint addresses exactly what a 1:1
    // chat with that bot addresses.
    const echo = async (secret: string): Promise<void> => {
      const socket = new WebSocket(`${gateway.url.replace("http", "ws")}/attach/v1`, { headers: { authorization: `Bearer ${secret}` } });
      sockets.push(socket);
      let sequence = 0;
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data)) as { kind: string; sequence: number; commandId?: string; command?: { kind: string; threadId: string; turnId: string; text?: string } };
        if (frame.kind !== "command" || frame.command === undefined) return;
        socket.send(JSON.stringify({ kind: "ack", channel: "command", sequence: frame.sequence, id: frame.commandId }));
        if (frame.command.kind !== "turn") return;
        sequence += 1;
        socket.send(JSON.stringify({
          kind: "event", sequence, eventId: `${secret}:${sequence}`,
          event: { kind: "commit", threadId: frame.command.threadId, turnId: frame.command.turnId, messageId: `answer:${frame.command.turnId}`, blocks: [{ type: "paragraph", text: `${secret} here` }] },
        }));
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ kind: "hello", version: 2, instanceId: secret, capabilities: ["draft"], resume: { eventSequence: 0, commandSequence: 0 } }));
    };
    await echo("hl");
    await echo("hs");
    await until(async () => ((await (await authed("/bots")).json()) as { bots: unknown[] }).bots.length === 3);

    const created = await authed("/bots/groups", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Launch", members: ["home:luna", "home:sage"] }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { group: { members: string[] } }).group.members).toEqual(["home:luna", "home:sage"]);

    const spanning = await authed("/bots/groups", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Spanning", members: ["home:luna", "studio:nova"] }),
    });
    expect(spanning.status).toBe(503);
    expect(await spanning.json()).toMatchObject({ error: { code: "backend_unavailable", message: "cross-endpoint groups are not supported" } });

    const sent = await authed("/bots/groups/launch/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "plan the launch @home:luna @home:sage" }),
    });
    expect(sent.status).toBe(202);
    // Both members answered on the owning endpoint's rooms, addressed by their public names.
    await until(async () => {
      const detail = (await (await authed("/bots/groups/launch")).json()) as { messages: Array<{ from: { kind: string; name: string } }> };
      return new Set(detail.messages.filter((message) => message.from.kind === "member").map((message) => message.from.name)).size === 2;
    });
    const detail = (await (await authed("/bots/groups/launch")).json()) as { messages: Array<{ from: { kind: string; name: string } }> };
    expect([...new Set(detail.messages.filter((message) => message.from.kind === "member").map((message) => message.from.name))].sort())
      .toEqual(["home:luna", "home:sage"]);

    expect((await authed("/bots/groups/launch", { method: "DELETE" })).status).toBe(204);
  }, 30_000);
});

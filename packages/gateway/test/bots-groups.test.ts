import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { BotGroup, BotGroupDetail, BotGroupMessage, Message, RichBlock, ServerFrame } from "cozygateway-contract";
import { BotGroupSchema, BotGroupMessageSchema, check } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  NO_REPLY,
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** Server-side group chats end to end: the room CRUD, a full deliberation round against a fake
 *  Hermes, the caps, epoch supersession, a member whose turn fails, the frames, and durability
 *  across a restart.
 *
 *  Everything below the routes is the real bridge, the real orchestrator and the real device auth.
 *  Only the turn cadence is scaled down (10 ms polls instead of 2 s); `bots-group-protocol.test.ts`
 *  pins the production numbers. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

const NOW = 1_800_000_000_000;

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface FakeSession {
  stored: string;
  runtime: string;
  profile: string;
  title: string;
  messages: Array<Record<string, unknown>>;
}

interface FakeGroupOptions {
  /** Profiles `profiles.list` reports. */
  profiles?: string[];
  /** Scripted replies per profile, consumed in order. A profile with an exhausted (or absent)
   *  queue passes, which is the protocol's own default outcome. */
  replies?: Record<string, string[]>;
  /** Profiles that answer every turn with fresh text, for the cap tests. */
  alwaysSpeak?: boolean;
  /** Profiles whose `prompt.submit` rejects. */
  submitFails?: string[];
  /** Profiles that accept the prompt and never produce an assistant message: a turn that times
   *  out. */
  silent?: string[];
  /** Milliseconds a profile's reply takes to appear. */
  delayMs?: Record<string, number>;
  /** Rows every session is born with. Real bots have these (a `system` prompt is the first row of
   *  most transcripts) and they are exactly the rows `mapChatMessage` DROPS, so a fake that never
   *  emits one cannot see a baseline that indexes the wrong list. */
  seedRows?: Array<Record<string, unknown>>;
  /** True to write a tool round trip (an assistant turn whose content is a bare `tool_use` part,
   *  then a `tool` result row) in front of every reply. Both rows are dropped by the render filter,
   *  so the raw count and the rendered count diverge by two per turn. */
  toolNoise?: boolean;
  /** Head-trims every session to this many rows once a reply lands: a Hermes-side COMPACTION, which
   *  rewrites the transcript under a turn that is already in flight. Rows here carry no ids, so the
   *  synthesized `<session>#<index>` ids are renumbered by the trim as well, which is the case a
   *  bare id comparison cannot detect. */
  compactTo?: number;
  /** Holds the FIRST `session.create` open instead of answering it, so a test can act inside the
   *  window where a member's session is still resolving. Released through `releaseSession()`. */
  holdFirstSession?: boolean;
}

/** A Hermes with several profiles and lazily created, title-addressable sessions.
 *
 *  Strict about the two session ids for the same reason the 1:1 fake is: `prompt.submit` only
 *  accepts the RUNTIME id, `session.resume` answers on the stored id, and `session.resume` must also
 *  resolve a TITLE in the id slot, which is what makes a room rehydrate after its stored ids are
 *  gone (dissection 9.6). */
function fakeGroupHermes(options: FakeGroupOptions = {}): {
  behavior: FakeHermesBehavior;
  sessions: FakeSession[];
  /** Drops a profile from `profiles.list`, i.e. a bot deleted after a room was created. */
  removeProfile: (name: string) => void;
  /** Answers a `session.create` that `holdFirstSession` is holding open. */
  releaseSession: () => void;
} {
  const profiles = [...(options.profiles ?? ["scout", "luna"])];
  const sessions: FakeSession[] = [];
  const queues = new Map<string, string[]>(Object.entries(options.replies ?? {}).map(([k, v]) => [k, [...v]]));
  const spoken = new Map<string, number>();
  let seq = 0;
  let held: (() => void) | undefined;

  const find = (id: string, profile: string): FakeSession | undefined =>
    sessions.find(
      (session) =>
        session.stored === id ||
        session.runtime === id ||
        (session.title === id && session.profile === profile),
    );

  const nextReply = (profile: string): string | undefined => {
    if ((options.silent ?? []).includes(profile)) return undefined;
    const queued = queues.get(profile)?.shift();
    if (queued !== undefined) return queued;
    if (options.alwaysSpeak !== true) return "(pass)";
    const count = (spoken.get(profile) ?? 0) + 1;
    spoken.set(profile, count);
    return `${profile} adds point ${count}`;
  };

  const behavior: FakeHermesBehavior = {
    methods: {
      "profiles.list": () => ({
        profiles: profiles.map((name) => ({
          name,
          description: `${name} bot`,
          has_avatar: false,
          ui_meta: { "hermes-bots": { title: name.charAt(0).toUpperCase() + name.slice(1) } },
        })),
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: [] }),
      "session.create": (params, ctx) => {
        seq += 1;
        const session: FakeSession = {
          stored: `stored-${seq}`,
          runtime: `runtime-${seq}`,
          profile: String(params["profile"] ?? ""),
          title: String(params["title"] ?? ""),
          messages: (options.seedRows ?? []).map((row) => ({ ...row })),
        };
        sessions.push(session);
        const result = { stored_session_id: session.stored, session_id: session.runtime };
        if (options.holdFirstSession === true && held === undefined) {
          held = () => ctx.reply(result);
          return NO_REPLY;
        }
        return result;
      },
      "session.resume": (params) => {
        const id = String(params["session_id"] ?? "");
        const profile = String(params["profile"] ?? "");
        const session = find(id, profile);
        if (session === undefined) throw { code: 5003, message: "no such session" };
        return {
          session_id: session.runtime,
          session_key: session.stored,
          message_count: session.messages.length,
          running: false,
          inflight: false,
          ...(params["omit_messages"] === true ? {} : { messages: session.messages }),
        };
      },
      "prompt.submit": (params) => {
        const id = String(params["session_id"] ?? "");
        const session = sessions.find((candidate) => candidate.runtime === id);
        if (session === undefined) {
          throw { code: 5003, message: `prompt.submit needs the runtime session id, got ${id}` };
        }
        if ((options.submitFails ?? []).includes(session.profile)) {
          throw { code: 5010, message: `provider refused the turn for ${session.profile}` };
        }
        session.messages.push({ role: "user", content: String(params["text"] ?? "") });
        const reply = nextReply(session.profile);
        if (reply !== undefined) {
          const delay = options.delayMs?.[session.profile] ?? 0;
          const push = (): void => {
            if (options.toolNoise === true) {
              session.messages.push({
                role: "assistant",
                content: [{ type: "tool_use", name: "grep", input: { pattern: "release" } }],
              });
              session.messages.push({ role: "tool", content: "3 matches" });
            }
            session.messages.push({ role: "assistant", content: reply });
            // A compaction lands AFTER the reply, so the reply is present and the transcript that
            // carried the turn's baseline is gone: exactly the window the re-base rule exists for.
            if (options.compactTo !== undefined && session.messages.length > options.compactTo) {
              session.messages.splice(0, session.messages.length - options.compactTo);
            }
          };
          if (delay === 0) push();
          else setTimeout(push, delay).unref?.();
        }
        return { ok: true };
      },
    },
  };
  return {
    behavior,
    sessions,
    removeProfile: (name: string) => {
      const index = profiles.indexOf(name);
      if (index !== -1) profiles.splice(index, 1);
    },
    releaseSession: () => {
      held?.();
      held = undefined;
    },
  };
}

interface Harness {
  server: FakeHermesServer;
  bridge: HermesBridge;
  client: HermesClient;
  storage: Storage;
  frames: ServerFrame[];
  dbPath: string;
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  /** Every prompt this Hermes was asked, with the profile it was asked of. */
  prompts: () => Array<{ profile: string; text: string }>;
  /** Every out-of-band `@user` escalation the bridge raised. Stands in for the push notifier, which
   *  is what `server.ts` wires this seam to. */
  escalations: Array<{ group: string; member: string; displayName: string; text: string }>;
  /** Everything the bridge logged. A drive that dies is required to say so here rather than to
   *  reject into nothing, so this is where a swallowed failure becomes visible. */
  logs: string[];
}

async function setup(
  behavior: FakeHermesBehavior,
  overrides: { turnTimeoutMs?: number; dbPath?: string } = {},
): Promise<Harness> {
  const server = await startFakeHermesServer(behavior);
  servers.push(server);
  const dbPath = overrides.dbPath ?? ":memory:";
  const storage = openStorage(dbPath);
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  const logs: string[] = [];
  const escalations: Array<{ group: string; member: string; displayName: string; text: string }> = [];
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    onGroupEscalation: (event) => escalations.push(event),
    // Real wall-clock: the turn cap is a duration, and a per-read counter would make a 200 ms cap
    // mean "200 clock reads" instead.
    now: () => Date.now(),
    logSink: (line) => void logs.push(line),
    chatPollMs: 10,
    chatTurnTimeoutMs: overrides.turnTimeoutMs ?? 3_000,
    groupChainDelayMs: 10,
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 5 } },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
      storage.appendMessage(threadId, { role: "user", blocks }, 500),
    interruptThread: () => "idle",
    onDeviceRevoked: () => {},
    now: () => NOW,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

  bridge.start();
  await until(() => client.state() === "online");
  // The roster cache is what membership validation and member titles read, so let the first refresh
  // land before any test asks for a room.
  await bridge.refresh("test setup");

  const sessionProfileOf = (runtimeId: string): string => {
    const created = server.callsOf("session.create");
    // `session.create` answers in order, so the Nth create is runtime-N.
    const index = Number(runtimeId.replace("runtime-", "")) - 1;
    return String(created[index]?.params["profile"] ?? "");
  };

  return {
    server,
    bridge,
    client,
    storage,
    frames,
    dbPath,
    authed: async (path, init) =>
      app.request(path, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
      }),
    request: async (path, init) => app.request(path, init),
    escalations,
    logs,
    prompts: () =>
      server
        .callsOf("prompt.submit")
        .map((call) => ({
          profile: sessionProfileOf(String(call.params["session_id"] ?? "")),
          text: String(call.params["text"] ?? ""),
        })),
  };
}

async function createRoom(
  harness: Harness,
  name = "Release Room",
  members = ["scout", "luna"],
): Promise<BotGroup> {
  const res = await harness.authed("/bots/groups", {
    method: "POST",
    body: JSON.stringify({ name, members }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { group: BotGroup }).group;
}

function groupFrames(frames: ServerFrame[]): Array<Extract<ServerFrame, { type: "bot_group" }>> {
  return frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_group" }> => frame.type === "bot_group");
}

function stateFrames(frames: ServerFrame[]): Array<Extract<ServerFrame, { type: "bot_group_state" }>> {
  return frames.filter(
    (frame): frame is Extract<ServerFrame, { type: "bot_group_state" }> => frame.type === "bot_group_state",
  );
}

describe("room CRUD", () => {
  it("creates a room, lists it, reads it, and deletes it", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);

    const group = await createRoom(harness);
    expect(group.name).toBe("Release Room");
    expect(group.members).toEqual(["scout", "luna"]);
    expect(group.state).toBe("settled");
    expect(group.needsYou).toBe(false);
    expect(group.epoch).toBe(0);
    expect(check(BotGroupSchema, group)).toBe(true);

    const list = (await (await harness.authed("/bots/groups")).json()) as { groups: BotGroup[] };
    expect(list.groups.map((room) => room.name)).toEqual(["Release Room"]);

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.members).toEqual(["scout", "luna"]);
    expect(detail.messages).toEqual([]);

    expect((await harness.authed("/bots/groups/Release%20Room", { method: "DELETE" })).status).toBe(204);
    expect((await harness.authed("/bots/groups/Release%20Room")).status).toBe(404);
  });

  it("addresses a room case-insensitively and refuses a duplicate", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    await createRoom(harness);

    expect((await harness.authed("/bots/groups/release%20room")).status).toBe(200);
    const dup = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "RELEASE ROOM", members: ["scout", "luna"] }),
    });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("conflict");
  });

  it("404s an unknown room on every room route", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    expect((await harness.authed("/bots/groups/ghosts")).status).toBe(404);
    expect((await harness.authed("/bots/groups/ghosts", { method: "DELETE" })).status).toBe(404);
    const send = await harness.authed("/bots/groups/ghosts/messages", {
      method: "POST",
      body: JSON.stringify({ text: "anyone there" }),
    });
    expect(send.status).toBe(404);
    expect(((await send.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("validates membership against the roster", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    const res = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Ghost Room", members: ["scout", "ghost"] }),
    });
    expect(res.status).toBe(404);
    // Nothing was written: a room can never name a bot that does not exist.
    expect(((await (await harness.authed("/bots/groups")).json()) as { groups: BotGroup[] }).groups).toEqual([]);
  });

  it("holds the 2 to 6 member bounds", async () => {
    const { behavior } = fakeGroupHermes({ profiles: ["a", "b", "c", "d", "e", "f", "g"] });
    const harness = await setup(behavior);

    const tooFew = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Solo", members: ["a"] }),
    });
    expect(tooFew.status).toBe(400);

    const tooMany = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Crowd", members: ["a", "b", "c", "d", "e", "f", "g"] }),
    });
    expect(tooMany.status).toBe(400);

    // Duplicates collapse, and what is left has to still clear the floor.
    const dupes = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Echo", members: ["a", "A"] }),
    });
    expect(dupes.status).toBe(400);
    expect(((await dupes.json()) as { error: { message: string } }).error.message).toMatch(/distinct members/);

    const six = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Six", members: ["a", "b", "c", "d", "e", "f"] }),
    });
    expect(six.status).toBe(201);
  });

  it("refuses a room name that a per-bot route would shadow", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    const res = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "profile", members: ["scout", "luna"] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/reserved/);
  });

  it("refuses a device-less request", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    expect((await harness.request("/bots/groups")).status).toBe(401);
  });
});

describe("a deliberation round", () => {
  it("runs members serially, posts what they say, and drops what they pass on", async () => {
    const { behavior } = fakeGroupHermes({
      replies: { scout: ["CI is green, cutting the tag now"], luna: ["(pass)", "(pass)"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness);

    const send = await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "how is the release looking", clientId: "c-1" }),
    });
    expect(send.status).toBe(202);
    const accepted = (await send.json()) as { group: string; message: BotGroupMessage };
    expect(accepted.message.from).toEqual({ kind: "user", name: "You", displayName: "You" });
    expect(accepted.message.clientId).toBe("c-1");
    expect(check(BotGroupMessageSchema, accepted.message)).toBe(true);

    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.map((message) => [message.from.kind, message.from.name, message.text])).toEqual([
      ["user", "You", "how is the release looking"],
      ["member", "scout", "CI is green, cutting the tag now"],
    ]);
    expect(detail.state).toBe("settled");

    // Serial, and each member gets its own `Group: <name>` session.
    const created = harness.server.callsOf("session.create");
    expect(created.map((call) => [call.params["profile"], call.params["title"]])).toEqual([
      ["scout", "Group: Release Room"],
      ["luna", "Group: Release Room"],
    ]);
    // One prompt each, and then the room settled: round 1 asked nobody, because a member is only
    // asked when something it has not seen has landed, and by then neither had anything new.
    const prompts = harness.prompts();
    expect(prompts.map((prompt) => prompt.profile)).toEqual(["scout", "luna"]);
    expect(prompts[0]!.text).toContain('[Group chat: "Release Room"] You are @scout');
    expect(prompts[0]!.text).toContain("  You (user): how is the release looking");
    // Luna's turn came after scout's, so her delta carries both, with scout tagged as a peer.
    expect(prompts[1]!.text).toContain('You are @luna');
    expect(prompts[1]!.text).toContain("  You (user): how is the release looking");
    expect(prompts[1]!.text).toContain("  Scout: CI is green, cutting the tag now");
  });

  it("reuses each member's room session on the next send instead of minting a new one", async () => {
    const { behavior } = fakeGroupHermes({ replies: { scout: ["first"], luna: ["(pass)", "(pass)", "(pass)"] } });
    const harness = await setup(behavior);
    await createRoom(harness);

    for (const text of ["one", "two"]) {
      await harness.authed("/bots/groups/Release%20Room/messages", { method: "POST", body: JSON.stringify({ text }) });
      await harness.bridge.groupSettled("Release Room");
    }
    expect(harness.server.callsOf("session.create")).toHaveLength(2);
  });

  it("scopes the round to the members the user mentioned", async () => {
    const { behavior } = fakeGroupHermes({
      profiles: ["scout", "luna", "pixel"],
      replies: { luna: ["plan is drafted"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness, "Release Room", ["scout", "luna", "pixel"]);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "@luna what is the plan" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const asked = new Set(harness.prompts().map((prompt) => prompt.profile));
    expect([...asked]).toEqual(["luna"]);
    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.filter((message) => message.from.kind === "member").map((m) => m.from.name)).toEqual(["luna"]);
  });

  it("pulls in a teammate a member mentioned, on the next round", async () => {
    const { behavior } = fakeGroupHermes({
      profiles: ["scout", "luna", "pixel"],
      replies: { luna: ["@pixel can you take the build"], pixel: ["taking it"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness, "Release Room", ["scout", "luna", "pixel"]);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "@luna what is the plan" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.map((message) => message.from.name)).toEqual(["You", "luna", "pixel"]);
  });

  it("raises needs you when a member escalates, and clears it when the room is opened", async () => {
    const { behavior } = fakeGroupHermes({ replies: { scout: ["@user can you confirm the cut?"] } });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "ready to ship?" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const list = (await (await harness.authed("/bots/groups")).json()) as { groups: BotGroup[] };
    expect(list.groups[0]!.needsYou).toBe(true);
    expect(list.groups[0]!.state).toBe("needs_you");
    expect(stateFrames(harness.frames).at(-1)).toMatchObject({ state: "needs_you", epoch: 1 });

    // Opening the room is acknowledgement: the badge drops for every device, not only this one.
    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.needsYou).toBe(false);
    expect(stateFrames(harness.frames).at(-1)!.state).toBe("settled");
  });
});

describe("caps", () => {
  it("stops after three rounds even when everyone keeps talking", async () => {
    const { behavior } = fakeGroupHermes({ alwaysSpeak: true });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "brainstorm please" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    // Nobody ever passes here, so the ONLY thing that can stop this room is the round cap, and it
    // does. The count is four rather than six because a member is skipped in a round where nothing
    // it has not already seen has landed: round 0 posts both, round 1 posts scout, round 2 posts
    // luna. Without the cap it would run forever.
    expect(detail.messages.filter((message) => message.from.kind === "member")).toHaveLength(4);
    expect(detail.state).toBe("settled");
  });

  it("stops at ten posted messages inside one user send", async () => {
    const { behavior } = fakeGroupHermes({ profiles: ["a", "b", "c", "d"], alwaysSpeak: true });
    const harness = await setup(behavior);
    await createRoom(harness, "Big Room", ["a", "b", "c", "d"]);

    await harness.authed("/bots/groups/Big%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "everyone weigh in" }),
    });
    await harness.bridge.groupSettled("Big Room");

    const detail = (await (await harness.authed("/bots/groups/Big%20Room")).json()) as BotGroupDetail;
    // Four members would post twelve over three rounds; the cap lands first.
    expect(detail.messages.filter((message) => message.from.kind === "member")).toHaveLength(10);
  });
});

describe("epoch supersession", () => {
  it("abandons the rest of the rounds when the user sends again mid-round", async () => {
    const { behavior } = fakeGroupHermes({
      replies: { scout: ["still checking"], luna: ["(pass)", "(pass)", "(pass)"] },
      delayMs: { scout: 120 },
    });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "first question" }),
    });
    // Wait until scout's turn is actually in flight, then supersede it.
    await until(() => harness.prompts().length === 1);
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "second question" }),
    });
    await until(() => !harness.bridge.groupRunning("Release Room"));

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.epoch).toBe(2);
    // The superseded drive never reached luna: her first prompt carries the second user message.
    const lunaPrompts = harness.prompts().filter((prompt) => prompt.profile === "luna");
    expect(lunaPrompts.length).toBeGreaterThan(0);
    expect(lunaPrompts[0]!.text).toContain("second question");
    // Only the winning drive settles the room, so a stale `settled` cannot land on top of the new
    // conversation.
    for (const frame of stateFrames(harness.frames).filter((frame) => frame.state !== "running")) {
      expect(frame.epoch).toBe(2);
    }
  });
});

describe("failure honesty", () => {
  it("reports a member whose turn fails as a note and carries on with the others", async () => {
    const { behavior } = fakeGroupHermes({
      submitFails: ["scout"],
      replies: { luna: ["I will cover it"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "status please" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    // Nothing was invented on scout's behalf.
    expect(detail.messages.map((message) => message.from.name)).toEqual(["You", "luna"]);
    const note = stateFrames(harness.frames).find((frame) => frame.note !== undefined)!;
    expect(note.note).toMatchObject({ member: "scout", reason: "failed" });
    expect(note.note!.detail).toContain("provider refused the turn");
  });

  it("reports a member that never answers as a timeout, at the turn cap", async () => {
    const { behavior } = fakeGroupHermes({ silent: ["scout"], replies: { luna: ["carrying on"] } });
    const harness = await setup(behavior, { turnTimeoutMs: 200 });
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "status please" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.map((message) => message.from.name)).toEqual(["You", "luna"]);
    expect(stateFrames(harness.frames).find((frame) => frame.note !== undefined)!.note).toMatchObject({
      member: "scout",
      reason: "timeout",
    });
  });
});

describe("frames", () => {
  it("broadcasts each room message as a delta with its sender, and the round state around it", async () => {
    const { behavior } = fakeGroupHermes({ replies: { scout: ["on it"] } });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "kick off" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const messages = groupFrames(harness.frames).flatMap((frame) => frame.messages);
    expect(groupFrames(harness.frames).every((frame) => frame.group === "Release Room")).toBe(true);
    expect(messages.map((message) => [message.from.kind, message.from.displayName, message.text])).toEqual([
      ["user", "You", "kick off"],
      ["member", "Scout", "on it"],
    ]);
    // Every frame carries exactly the entries not broadcast before, keyed by a room-local seq.
    expect(messages.map((message) => message.seq)).toEqual([1, 2]);

    const states = stateFrames(harness.frames);
    expect(states[0]).toMatchObject({ state: "running", round: 0, epoch: 1 });
    expect(states.at(-1)).toMatchObject({ state: "settled", epoch: 1 });
  });
});

describe("durability", () => {
  it("serves a room, its log, its watermarks and its epoch after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-groups-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "gateway.db");

    const first = await setup(fakeGroupHermes({ replies: { scout: ["shipping now"] } }).behavior, { dbPath });
    await createRoom(first);
    await first.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "ready?" }),
    });
    await first.bridge.groupSettled("Release Room");
    // Everything the room knows is now on disk; drop the process's half of it.
    await first.bridge.close();
    bridges.splice(bridges.indexOf(first.bridge), 1);
    first.storage.close();
    storages.splice(storages.indexOf(first.storage), 1);

    const second = await setup(fakeGroupHermes({ replies: { scout: ["still shipping"] } }).behavior, { dbPath });
    const detail = (await (await second.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.members).toEqual(["scout", "luna"]);
    expect(detail.epoch).toBe(1);
    expect(detail.messages.map((message) => [message.from.name, message.text])).toEqual([
      ["You", "ready?"],
      ["scout", "shipping now"],
    ]);
    // A restored room is settled: the process that was driving it is gone, so nothing is running.
    expect(detail.state).toBe("settled");

    // And the watermarks came back too: the next round shows each member only what is new.
    await second.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "and now?" }),
    });
    await second.bridge.groupSettled("Release Room");
    const prompt = second.prompts()[0]!;
    expect(prompt.text).toContain("  You (user): and now?");
    expect(prompt.text).not.toContain("ready?");
  });
});

describe("transcripts a real bot actually has", () => {
  it("keeps finding replies once the transcript carries rows a chat does not render", async () => {
    // The regression this pins: the reply baseline used to be Hermes' RAW `message_count` while the
    // window it indexed was the FILTERED render list. One system row plus one tool round trip is
    // enough to make the window empty, and from then on EVERY member turn runs to the timeout cap
    // and the room is dead. Both row kinds are ordinary for any bot that has used a tool once.
    const { behavior } = fakeGroupHermes({
      seedRows: [{ role: "system", content: "you are a helpful bot" }],
      toolNoise: true,
      alwaysSpeak: true,
    });
    const harness = await setup(behavior, { turnTimeoutMs: 800 });
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello team" }),
    });
    await harness.bridge.groupSettled("Release Room");

    // The SECOND send is where the old code died: by then the dropped rows have accumulated.
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "second turn please" }),
    });
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    const afterSecond = detail.messages.slice(
      detail.messages.findIndex((message) => message.text === "second turn please") + 1,
    );
    expect(afterSecond.length).toBeGreaterThan(0);
    expect(afterSecond.map((message) => message.from.name)).toContain("scout");
    expect(afterSecond.map((message) => message.from.name)).toContain("luna");
    // And nothing timed out on the way: a note here would mean the window was empty again.
    const notes = stateFrames(harness.frames).flatMap((frame) => (frame.note === undefined ? [] : [frame.note]));
    expect(notes.filter((note) => note.reason === "timeout")).toEqual([]);
    // Every member message is a distinct reply, so no stale answer was returned twice either.
    const memberTexts = detail.messages.filter((message) => message.from.kind === "member").map((m) => m.text);
    expect(new Set(memberTexts).size).toBe(memberTexts.length);
  });
});

describe("delete racing a live drive", () => {
  it("never runs two drives against one room key, so a recreated room cannot duplicate messages", async () => {
    // The regression this pins: `remove()` used to DROP the drive handle while the drive was still
    // running. A room recreated under the same key then had nothing to chain behind, and the dead
    // drive's epoch guard matched the fresh room's epoch after its first send, so two drives ran
    // against one room and the log came back with duplicated messages.
    const { behavior } = fakeGroupHermes({ alwaysSpeak: true, delayMs: { scout: 200, luna: 200 } });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "original question" }),
    });
    // Delete while scout's turn is genuinely in flight.
    await until(() => harness.prompts().length === 1);
    const deleted = await harness.authed("/bots/groups/Release%20Room", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    await createRoom(harness);
    const sent = await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "fresh start" }),
    });
    expect(sent.status).toBe(202);

    await harness.bridge.groupSettled("Release Room");
    // The dying drive can still be finishing its own turn when the fresh one settles; give the key
    // one more settle so nothing it might write lands after the assertions.
    await harness.bridge.groupSettled("Release Room");

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    // The fresh room starts from nothing: the deleted room's transcript cascaded away, and the dead
    // drive wrote none of its own replies into the room that replaced it.
    expect(detail.messages[0]).toMatchObject({ seq: 1, text: "fresh start" });
    const texts = detail.messages.map((message) => message.text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts).not.toContain("original question");
    // Serial to the end: seqs are contiguous and each member message follows the one before it.
    expect(detail.messages.map((message) => message.seq)).toEqual(
      detail.messages.map((_message, index) => index + 1),
    );
  });

  it("does not report a recreated room as running just because the old drive is winding down", async () => {
    const { behavior } = fakeGroupHermes({ alwaysSpeak: true, delayMs: { scout: 200, luna: 200 } });
    const harness = await setup(behavior);
    await createRoom(harness);
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "original question" }),
    });
    await until(() => harness.prompts().length === 1);
    await harness.authed("/bots/groups/Release%20Room", { method: "DELETE" });
    const fresh = await createRoom(harness);
    expect(fresh.state).toBe("settled");
  });
});

describe("supersession keeps a completed answer", () => {
  it("posts an in-flight member's reply when it had already landed", async () => {
    // The contract's own rule: a turn already in flight when a newer user message arrives is not
    // waited on, but an answer that has ALREADY completed was a real answer to a real question and
    // is posted rather than discarded.
    const { behavior } = fakeGroupHermes({
      replies: { scout: ["the answer that just landed"], luna: ["(pass)", "(pass)", "(pass)"] },
      // Long enough that the room is superseded before the poll cadence would have picked the
      // reply up, short enough that it HAS landed by the time the harvest read goes out.
      delayMs: { scout: 60 },
    });
    const harness = await setup(behavior);
    await createRoom(harness);

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "first question" }),
    });
    await until(() => harness.prompts().length === 1);
    // Wait for scout's answer to exist in Hermes, THEN supersede: the harvest read must find it.
    await until(() => harness.server.callsOf("session.resume").length > 1);
    await new Promise((resolve) => setTimeout(resolve, 90));
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "second question" }),
    });
    await until(() => !harness.bridge.groupRunning("Release Room"));

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.map((message) => message.text)).toContain("the answer that just landed");
  });
});

describe("the @user escalation", () => {
  it("raises an out-of-band escalation alongside the durable badge", async () => {
    const { behavior } = fakeGroupHermes({
      replies: { scout: ["@user we need a decision on the cutoff"], luna: ["(pass)", "(pass)", "(pass)"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness);
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "what is blocking us" }),
    });
    await harness.bridge.groupSettled("Release Room");

    expect(harness.escalations).toEqual([
      {
        group: "Release Room",
        member: "scout",
        displayName: "Scout",
        text: "@user we need a decision on the cutoff",
      },
    ]);
  });

  it("does not raise one for an email address that merely contains @user", async () => {
    const { behavior } = fakeGroupHermes({
      replies: { scout: ["file it with ops@user.example.com"], luna: ["(pass)", "(pass)", "(pass)"] },
    });
    const harness = await setup(behavior);
    await createRoom(harness);
    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "where do bugs go" }),
    });
    await harness.bridge.groupSettled("Release Room");

    expect(harness.escalations).toEqual([]);
    const group = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(group.needsYou).toBe(false);
  });
});

describe("rooms say why they stopped", () => {
  it("reports the ten-message cap as a note instead of settling silently", async () => {
    // Four members would post twelve over three rounds; the cap lands first.
    const { behavior } = fakeGroupHermes({ profiles: ["a", "b", "c", "d"], alwaysSpeak: true });
    const harness = await setup(behavior);
    await createRoom(harness, "Loud Room", ["a", "b", "c", "d"]);
    await harness.authed("/bots/groups/Loud%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "everybody talk" }),
    });
    await harness.bridge.groupSettled("Loud Room");

    const notes = stateFrames(harness.frames).flatMap((frame) => (frame.note === undefined ? [] : [frame.note]));
    const capped = notes.filter((note) => note.reason === "capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]!.detail).toContain("10-message limit");
  });

  it("skips a member whose profile was deleted after the room was created", async () => {
    const { behavior, removeProfile } = fakeGroupHermes({ replies: { luna: ["I will cover it"] } });
    const harness = await setup(behavior);
    await createRoom(harness);
    // Scout is gone, and the roster cache has caught up.
    removeProfile("scout");
    await harness.bridge.refresh("test");

    await harness.authed("/bots/groups/Release%20Room/messages", {
      method: "POST",
      body: JSON.stringify({ text: "who is on this" }),
    });
    await harness.bridge.groupSettled("Release Room");

    // Not one prompt was spent on the deleted member, and the room said so.
    expect(harness.prompts().map((prompt) => prompt.profile)).not.toContain("scout");
    const notes = stateFrames(harness.frames).flatMap((frame) => (frame.note === undefined ? [] : [frame.note]));
    expect(notes.some((note) => note.member === "scout" && note.detail.includes("no longer a bot"))).toBe(true);
    // And the surviving member still answered.
    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    expect(detail.messages.map((message) => message.text)).toContain("I will cover it");
  });
});

describe("room names are addresses", () => {
  it("refuses a name that would need percent-encoding to reach", async () => {
    const { behavior } = fakeGroupHermes();
    const harness = await setup(behavior);
    for (const name of ["a/b", "back\\slash", "hash#tag", "pct%20", "q?uery"]) {
      const res = await harness.authed("/bots/groups", {
        method: "POST",
        body: JSON.stringify({ name, members: ["scout", "luna"] }),
      });
      expect([name, res.status]).toEqual([name, 400]);
    }
    // A space is fine: it is what `Release%20Room` already relies on.
    const ok = await harness.authed("/bots/groups", {
      method: "POST",
      body: JSON.stringify({ name: "Two Words", members: ["scout", "luna"] }),
    });
    expect(ok.status).toBe(201);
  });
});

describe("a hermes-side compaction inside a turn", () => {
  it("re-bases instead of going silent when the transcript is rewritten under the turn", async () => {
    // The residual half of G1. The baseline (a rendered count plus an anchor id) describes the
    // transcript as it was when the turn started; a compaction that lands before the reply is read
    // rewrites that transcript, and BOTH anchors fail in the same direction: the list is shorter
    // than the count says, and the synthesized `<session>#<index>` ids have been renumbered, so the
    // anchor id can still "match" a completely different row. A baseline of `messages.length` finds
    // nothing and the turn runs to the cap, which is the original zero-replies symptom returning.
    const { behavior } = fakeGroupHermes({ alwaysSpeak: true, compactTo: 3 });
    const harness = await setup(behavior, { turnTimeoutMs: 800 });
    await createRoom(harness);

    for (const text of ["hello team", "second turn please", "and once more"]) {
      await harness.authed("/bots/groups/Release%20Room/messages", {
        method: "POST",
        body: JSON.stringify({ text }),
      });
      await harness.bridge.groupSettled("Release Room");
    }

    const detail = (await (await harness.authed("/bots/groups/Release%20Room")).json()) as BotGroupDetail;
    const afterLast = detail.messages.slice(
      detail.messages.findIndex((message) => message.text === "and once more") + 1,
    );
    expect(afterLast.length).toBeGreaterThan(0);
    const notes = stateFrames(harness.frames).flatMap((frame) => (frame.note === undefined ? [] : [frame.note]));
    expect(notes.filter((note) => note.reason === "timeout")).toEqual([]);
    // Each reply is still a distinct one: re-basing must not resurrect an older answer either.
    const memberTexts = detail.messages.filter((message) => message.from.kind === "member").map((m) => m.text);
    expect(new Set(memberTexts).size).toBe(memberTexts.length);
  });
});

describe("deleting a room while a member session is resolving", () => {
  it("cannot take the process down with an unhandled rejection", async () => {
    // A `session.create` is a round trip to Hermes. A DELETE landing inside that window cascades the
    // room row away, and the member-session write that follows is a foreign key onto it: the write
    // fails, and because nothing awaits a drive the rejection escaped as an UNHANDLED one. The
    // gateway registers no `unhandledRejection` handler, so Node's default applies and the process
    // exits: a device could kill the gateway with a well-timed DELETE.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const { behavior, releaseSession } = fakeGroupHermes({
        replies: { scout: ["never posted"], luna: ["(pass)", "(pass)", "(pass)"] },
        holdFirstSession: true,
      });
      const harness = await setup(behavior);
      await createRoom(harness);

      await harness.authed("/bots/groups/Release%20Room/messages", {
        method: "POST",
        body: JSON.stringify({ text: "who is on this" }),
      });
      // Scout's session resolve is held open; delete the room from under it.
      await until(() => harness.server.callsOf("session.create").length === 1);
      const deleted = await harness.authed("/bots/groups/Release%20Room", { method: "DELETE" });
      expect(deleted.status).toBe(204);
      releaseSession();
      await harness.bridge.groupSettled("Release Room");
      // Two macrotasks: an unhandled rejection is reported at the end of a turn of the event loop,
      // so asserting on the same tick would pass whether or not one was raised.
      await new Promise((resolve) => setTimeout(resolve, 20));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
      // And it did not merely get swallowed by the drive's catch: the guarded write never ran.
      expect(harness.logs.filter((line) => line.includes("FOREIGN KEY"))).toEqual([]);
      expect(harness.logs.filter((line) => line.includes("group drive for"))).toEqual([]);
      // The room is gone and stayed gone.
      expect((await harness.authed("/bots/groups/Release%20Room")).status).toBe(404);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

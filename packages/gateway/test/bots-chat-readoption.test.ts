import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE } from "../src/hermes-bridge/canonical-chat.ts";
import {
  startFakeHermesServer,
  type FakeHermesBehavior,
  type FakeHermesServer,
} from "./support/fake-hermes-server.ts";

/** Capability 14 (issue #88): the canonical-chat pin FOLLOWS the bot's latest conversational
 *  session, and the move is announced on the socket.
 *
 *  The bug this file exists to keep fixed was a disagreement between two surfaces about one thing.
 *  `GET /bots` derives a bot's preview and `lastActiveAt` from its last activity across ALL its
 *  hermes sessions, while `GET /bots/:name/chat/messages` is scoped to the single pinned session, so
 *  a conversation held from a second device updated the roster row and never appeared in the chat
 *  the app opened. The messages were absent from the wire, not dropped by the client. So the
 *  assertions here are deliberately paired: whenever the chat re-adopts, the test also reads
 *  `GET /bots` back and asserts the two agree.
 *
 *  The other half is what may NOT move the pin. Routine fires and bot-to-bot deliveries mint
 *  sessions of their own by design, and a bot with an hourly routine would otherwise re-adopt away
 *  from its owner's conversation once an hour. Those cases are asserted on the wire, against a fake
 *  hermes that returns the same session shapes the real one does. */

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

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SessionRow {
  id: string;
  title: string;
  preview?: string;
  source?: string;
  last_active?: number;
}

/** The mutable hermes this suite drives. `sessions` is NEWEST FIRST, the ordering convention the
 *  real `session.list` observes, and `preview` is the roster line `profiles.list` reports for the
 *  bot's last activity WHATEVER session it happened in -- which is exactly the asymmetry the bug
 *  came out of. */
interface HermesState {
  meta: Record<string, unknown>;
  sessions: SessionRow[];
  transcripts: Record<string, string>;
  preview: string;
  lastActive: number;
}

function behaviorFor(state: HermesState): FakeHermesBehavior {
  let created = 0;
  return {
    methods: {
      "profiles.list": () => ({
        profiles: [
          {
            name: "scout",
            description: "watches CI",
            has_avatar: false,
            ui_meta: { "hermes-bots": state.meta },
            last_session: { last_active: state.lastActive, preview: state.preview },
          },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: state.sessions }),
      "session.create": () => {
        created += 1;
        return { stored_session_id: `stored-${created}`, session_id: `runtime-${created}` };
      },
      "session.resume": (params) => {
        const id = String(params["session_id"] ?? "");
        const text = state.transcripts[id];
        if (text === undefined) throw { code: 5003, message: "no such session" };
        return {
          session_id: `runtime-${id}`,
          session_key: "k",
          message_count: 1,
          running: false,
          inflight: false,
          messages: [{ id: `${id}-m1`, role: "user", content: text }],
        };
      },
      "prompt.submit": () => ({ ok: true }),
      "profiles.configure": (params) => {
        const uiMeta = params["ui_meta"] as Record<string, unknown> | undefined;
        const blob = uiMeta?.["hermes-bots"];
        if (typeof blob === "object" && blob !== null) state.meta = blob as Record<string, unknown>;
        return { applied: { ui_meta: true } };
      },
    },
  };
}

interface Harness {
  state: HermesState;
  bridge: HermesBridge;
  frames: ServerFrame[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  storage: Storage;
}

/** A bot whose canonical chat is `sess-1` and whose owner has already written in it. */
async function setup(): Promise<Harness> {
  const state: HermesState = {
    meta: { title: "Scout", chat: "sess-1" },
    sessions: [
      {
        id: "sess-1",
        title: CANONICAL_CHAT_TITLE,
        preview: "from the phone",
        last_active: Math.round(NOW / 1000) - 30,
      },
    ],
    transcripts: { "sess-1": "from the phone" },
    preview: "from the phone",
    lastActive: Math.round(NOW / 1000),
  };
  const server = await startFakeHermesServer(behaviorFor(state));
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  // A clock that ticks per read, as the duplex and suggestion suites do: the ORDER of a pin write
  // against the roster snapshot is what separates a pin this gateway just wrote from one the
  // snapshot has already had a chance to see, and a frozen clock makes every pin look stale.
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: () => {},
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 14 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not used");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  const authed = async (path: string, init?: RequestInit): Promise<Response> =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });

  bridge.start();
  await until(() => client.state() === "online", 4_000);
  await until(() => bridge.roster().bots.length === 1, 4_000);
  return { state, bridge, frames, authed, storage };
}

async function chatOf(authed: Harness["authed"]): Promise<{ sessionId: string; adoption: string }> {
  return (await (await authed("/bots/scout/chat")).json()) as { sessionId: string; adoption: string };
}

/** The roster row `GET /bots` serves, after a refresh, so the cache reflects the pin just written. */
async function rosterRow(
  harness: Harness,
): Promise<{
  active: boolean;
  chatSessionId: string | null;
  lastActiveAt: number | null;
  preview: { kind: string; text: string };
}> {
  await harness.bridge.refresh("test");
  const listed = (await (await harness.authed("/bots")).json()) as {
    bots: Array<{
      active: boolean;
      name: string;
      chatSessionId: string | null;
      lastActiveAt: number | null;
      preview: { kind: string; text: string };
    }>;
  };
  const row = listed.bots.find((bot) => bot.name === "scout");
  if (row === undefined) throw new Error("scout is not on the roster");
  return {
    active: row.active,
    chatSessionId: row.chatSessionId,
    lastActiveAt: row.lastActiveAt,
    preview: row.preview,
  };
}

function adoptedFrames(frames: ServerFrame[]): Array<Record<string, unknown>> {
  return frames.filter((frame) => frame.type === "bot_chat_adopted") as unknown as Array<
    Record<string, unknown>
  >;
}

describe("canonical chat re-adoption", () => {
  it("sources the roster preview and timestamp from the pinned chat while a newer cron exists", async () => {
    const harness = await setup();
    const { state, authed } = harness;
    await chatOf(authed);

    state.sessions = [
      {
        id: "cron_job7_1755600000",
        title: "Nightly digest Aug 20 03:00",
        source: "cron",
        preview: "Both zones are 79F. Tie rotation applied.",
        last_active: Math.round(NOW / 1000),
      },
      ...state.sessions,
    ];
    state.preview = "Both zones are 79F. Tie rotation applied.";

    const row = await rosterRow(harness);
    expect(row).toMatchObject({
      active: true,
      chatSessionId: "sess-1",
      lastActiveAt: NOW - 30_000,
      preview: { kind: "plain", text: "from the phone" },
    });
  });

  it("keeps an unlisted empty canonical chat empty while newer machine sessions exist", async () => {
    const harness = await setup();
    const { state, authed } = harness;
    await chatOf(authed);

    state.sessions = [
      {
        id: "sess-r",
        title: "Routine: Nightly digest",
        source: "cli",
        preview: "digest done",
        last_active: Math.round(NOW / 1000),
      },
    ];
    state.preview = "digest done";

    const row = await rosterRow(harness);
    expect(row.active).toBe(true);
    expect(row.chatSessionId).toBe("sess-1");
    expect(row.lastActiveAt).toBeNull();
    expect(row.preview.kind).toBe("empty");
    expect(row.preview.text).not.toContain("digest done");
    expect(row.preview.text).not.toContain("watches CI");
  });

  it.each([
    ["routine", { id: "sess-r", title: "Routine: Nightly digest", source: "cli" }],
    ["group", { id: "sess-g", title: "Group: Release Room" }],
    ["a2a", { id: "sess-a2a", title: "Chat", preview: "Message from agent 'pixel': deploy is green" }],
  ])("does not source the roster from a newer %s session", async (_kind, machine) => {
    const harness = await setup();
    const { state, authed } = harness;
    await chatOf(authed);

    state.sessions = [
      { ...machine, last_active: Math.round(NOW / 1000) },
      ...state.sessions,
    ];
    state.preview = "preview" in machine ? machine.preview : "machine output";

    const row = await rosterRow(harness);
    expect(row.chatSessionId).toBe("sess-1");
    expect(row.lastActiveAt).toBe(NOW - 30_000);
    expect(row.preview).toEqual({ kind: "plain", text: "from the phone" });
  });

  it("follows a conversation held from a second device, and says so on the socket", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;

    // The phone opens the bot and lands on the chat it has always been in, and READS it, which is
    // what puts the delivered-id watermark on `sess-1`. The re-adoption below has to leave that
    // behind rather than re-base anything onto the new session.
    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-1", adoption: "pin" });
    const before = (await (await authed("/bots/scout/chat/messages")).json()) as {
      sessionId: string;
      messages: Array<{ id: string; text: string }>;
    };
    expect(before.sessionId).toBe("sess-1");
    expect(before.messages.map((message) => message.text)).toEqual(["from the phone"]);

    // The PC now holds a conversation with the same bot. Hermes mints a session for it, and the
    // profile's `last_session` (what the roster preview reads) moves to it. This is the exact state
    // the bug reported: the preview updated, the chat did not.
    state.sessions = [
      {
        id: "sess-2",
        title: "Chat with scout",
        preview: "from the PC",
        last_active: Math.round(NOW / 1000),
      },
      ...state.sessions,
    ];
    state.transcripts["sess-2"] = "from the PC";
    state.preview = "from the PC";

    // The pin follows, under the existing adoption vocabulary.
    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-2", adoption: "latest" });

    // And every paired device is told, so the one sitting on the old transcript re-reads.
    expect(adoptedFrames(frames)).toEqual([
      {
        type: "bot_chat_adopted",
        bot: "scout",
        sessionId: "sess-2",
        previousSessionId: "sess-1",
        updatedAt: expect.any(Number),
      },
    ]);

    // The canonical chat now carries the messages the preview was quoting. This is the assertion the
    // whole issue reduces to: the transcript and the roster row describe one conversation.
    const history = (await (await authed("/bots/scout/chat/messages")).json()) as {
      sessionId: string;
      messages: Array<{ id: string; text: string }>;
    };
    expect(history.sessionId).toBe("sess-2");
    expect(history.messages.map((message) => message.text)).toEqual(["from the PC"]);
    // Under its OWN ids. The delivered-id watermark is scoped to the session it was taken on
    // (PR #89), so nothing the phone had already seen in `sess-1` suppresses or re-bases a row in
    // `sess-2`, and no id crosses the switch.
    expect(history.messages.every((message) => message.id !== before.messages[0]!.id)).toBe(true);
    // And the read is repeatable: a second one returns the same transcript rather than a transcript
    // filtered by what the first delivered.
    const again = (await (await authed("/bots/scout/chat/messages")).json()) as {
      sessionId: string;
      messages: Array<{ id: string }>;
    };
    expect(again.sessionId).toBe("sess-2");
    expect(again.messages.map((message) => message.id)).toEqual(history.messages.map((m) => m.id));

    const row = await rosterRow(harness);
    expect(row.chatSessionId).toBe("sess-2");
    expect(row.preview).toEqual({ kind: "plain", text: "from the PC" });
  });

  it("re-adopts once and then holds, rather than announcing on every open", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);
    state.sessions = [{ id: "sess-2", title: "Chat with scout" }, ...state.sessions];
    state.transcripts["sess-2"] = "from the PC";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-2", adoption: "latest" });
    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-2", adoption: "pin" });
    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-2", adoption: "pin" });
    expect(adoptedFrames(frames)).toHaveLength(1);
  });

  it("never follows a routine fire", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);

    // A cron fire mints its own session and ENDS it, by design (contract/ext-bots-v1.md, "Where a
    // routine's runs land"), and it is not hidden, so it sorts to the top of `session.list` and it
    // moves the roster preview. A bot with an hourly routine would re-adopt hourly if this rule
    // leaked, and its owner would find a machine transcript where their conversation was.
    state.sessions = [
      { id: "cron_job7_1755600000", title: "Nightly digest · Aug 20 03:00", source: "cron" },
      ...state.sessions,
    ];
    state.transcripts["cron_job7_1755600000"] = "digest done";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-1", adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);

    // The delegated half of the same feature: when the routine's bot is not the profile the gateway
    // runs as, the fire is delegated with `hermes -p <bot> chat -c "Routine: <title>"`, which lands
    // in that bot's own history with source `cli` rather than `cron`.
    state.sessions = [{ id: "sess-r", title: "Routine: Nightly digest", source: "cli" }, ...state.sessions];
    state.transcripts["sess-r"] = "digest done";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-1", adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);
  });

  it("never follows a bot-to-bot delivery", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);

    // The roster classifies this preview as `kind: "a2a"` rather than as conversation, and the pin
    // follows exactly what the preview would present as conversation.
    state.sessions = [
      { id: "sess-a2a", title: "Chat", preview: "Message from agent 'pixel': deploy is green" },
      ...state.sessions,
    ];
    state.transcripts["sess-a2a"] = "Message from agent 'pixel': deploy is green";
    state.preview = "Message from agent 'pixel': deploy is green";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-1", adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);
  });

  it("never follows a group room session", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);

    state.sessions = [{ id: "sess-g", title: "Group: Release Room" }, ...state.sessions];
    state.transcripts["sess-g"] = "room chatter";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-1", adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);
  });

  it("does not resurrect a retired chat when activity lands after a reset", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);

    const reset = (await (await authed("/bots/scout/chat/reset", { method: "POST" })).json()) as {
      sessionId: string;
      previousSessionId: string;
    };
    expect(reset.previousSessionId).toBe("sess-1");

    // A reset RETIRES nothing hermes-side: `sess-1` is still listed, still carries the whole
    // transcript, and (because the replacement has no row until the user writes in it) still sorts
    // above the chat the user is actually in. This is the ordering the cozychat work surfaced: the
    // re-adoption rule must not read "the newest listed session" as "the conversation to go back
    // to", or clearing a chat would undo itself on the very next open.
    expect(await chatOf(authed)).toMatchObject({ sessionId: reset.sessionId, adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);

    // And it still must not, once the retired session sees more traffic and stays at the top.
    state.preview = "one more line in the old chat";
    expect(await chatOf(authed)).toMatchObject({ sessionId: reset.sessionId, adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);

    // Nor once the replacement becomes listable, which is what the user's first message does. The
    // pin is already the newest conversation at that point, so there is nothing to follow.
    state.sessions = [{ id: reset.sessionId, title: CANONICAL_CHAT_TITLE }, ...state.sessions];
    state.transcripts[reset.sessionId] = "starting over";
    expect(await chatOf(authed)).toMatchObject({ sessionId: reset.sessionId, adoption: "pin" });
    expect(adoptedFrames(frames)).toEqual([]);
  });

  it("still follows a genuinely new conversation after a reset", async () => {
    const harness = await setup();
    const { state, authed, frames } = harness;
    await chatOf(authed);
    const reset = (await (await authed("/bots/scout/chat/reset", { method: "POST" })).json()) as {
      sessionId: string;
    };
    // The user writes in the replacement, so it becomes listable and sorts newest.
    state.sessions = [{ id: reset.sessionId, title: CANONICAL_CHAT_TITLE }, ...state.sessions];
    state.transcripts[reset.sessionId] = "starting over";
    expect(await chatOf(authed)).toMatchObject({ sessionId: reset.sessionId, adoption: "pin" });

    // Then the PC holds a conversation of its own. A reset suppresses the session it retired, not
    // the rule.
    state.sessions = [{ id: "sess-3", title: "Chat with scout" }, ...state.sessions];
    state.transcripts["sess-3"] = "from the PC";
    state.preview = "from the PC";

    expect(await chatOf(authed)).toMatchObject({ sessionId: "sess-3", adoption: "latest" });
    expect(adoptedFrames(frames)).toEqual([
      {
        type: "bot_chat_adopted",
        bot: "scout",
        sessionId: "sess-3",
        previousSessionId: reset.sessionId,
        updatedAt: expect.any(Number),
      },
    ]);
    expect((await rosterRow(harness)).chatSessionId).toBe("sess-3");
  });
});

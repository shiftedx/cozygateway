import { describe, expect, it } from "vitest";

import type { BotGroup, BotGroupMessage, BotSummary, ServerFrame } from "../src/index.ts";
import {
  BotCreateRequestSchema,
  BotCreateResponseSchema,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotChatDeltaFrameSchema,
  BotChatDisplayedRequestSchema,
  BotChatDisplayedResponseSchema,
  BotChatStateFrameSchema,
  BotChatMessageSchema,
  BotChatResetFrameSchema,
  BotChatResetResponseSchema,
  BotChatStopResponseSchema,
  BotFocusRequestSchema,
  BotGroupCreateRequestSchema,
  BotGroupDetailSchema,
  BotGroupMessageSchema,
  BotGroupSchema,
  BotGroupSendRequestSchema,
  BotInboxActivityFrameSchema,
  BotInboxMessagesResponseSchema,
  BotInboxResponseSchema,
  BotModelConfigPatchSchema,
  BotModelConfigSchema,
  BotNewSessionResponseSchema,
  BotProfilePatchSchema,
  BotProfileSchema,
  BotRoutineCreateRequestSchema,
  BotRoutinePatchSchema,
  BotRoutineSchema,
  BotSessionAdoptResponseSchema,
  BotSessionsResponseSchema,
  BotSummarySchema,
  BotToolActivityFrameSchema,
  BotDelegationChildSchema,
  BotDelegationActivityFrameSchema,
  BotThinkingActivityFrameSchema,
  BotTurnDelegationsSchema,
  BotToolStepSchema,
  BotTurnToolStepsSchema,
  ServerFrameSchema,
  check,
} from "../src/index.ts";

const bot: BotSummary = {
  name: "scout",
  displayName: "Scout",
  handle: "scout",
  description: "watches CI",
  hasAvatar: true,
  group: "Ops",
  pinned: false,
  active: true,
  lastActiveAt: 1_800_000_000_000,
  chatSessionId: "sess-1",
  preview: { kind: "a2a", text: "the build is green", sender: "luna" },
  meta: { title: "Scout", created: 1_799_000_000_000 },
};

const groupMessage: BotGroupMessage = {
  seq: 2,
  from: { kind: "member", name: "scout", displayName: "Scout" },
  text: "CI is green",
  at: 1_800_000_000_000,
};

const group: BotGroup = {
  name: "Release Room",
  members: ["scout", "luna"],
  createdAt: 1_799_000_000_000,
  state: "settled",
  needsYou: false,
  epoch: 2,
  updatedAt: 1_800_000_000_000,
};

describe("bot summary", () => {
  it("accepts a full row and one with every nullable field empty", () => {
    expect(check(BotSummarySchema, bot)).toBe(true);
    expect(
      check(BotSummarySchema, {
        ...bot,
        description: null,
        group: null,
        lastActiveAt: null,
        chatSessionId: null,
        meta: null,
        preview: { kind: "empty", text: "" },
      }),
    ).toBe(true);
  });

  it("rejects an unknown preview kind", () => {
    expect(check(BotSummarySchema, { ...bot, preview: { kind: "toast", text: "x" } })).toBe(false);
  });
});

describe("bots server frames", () => {
  it("are members of the server frame union", () => {
    const frames: ServerFrame[] = [
      { type: "bot_roster", bots: [bot], updatedAt: 1 },
      { type: "bot_presence", active: ["scout"], updatedAt: 1 },
      { type: "bot_group", group: "Release Room", messages: [groupMessage], updatedAt: 1 },
      { type: "bot_group_state", group: "Release Room", state: "running", round: 0, epoch: 2, updatedAt: 1 },
      {
        type: "bot_group_state",
        group: "Release Room",
        state: "needs_you",
        round: 1,
        epoch: 2,
        note: { member: "scout", reason: "timeout", detail: "no reply within 180s" },
        updatedAt: 1,
      },
    ];
    for (const frame of frames) expect(check(ServerFrameSchema, frame)).toBe(true);
  });

  it("carries the live reply draft, room and all", () => {
    const draft: ServerFrame = {
      type: "bot_chat_delta",
      bot: "scout",
      sessionId: "canonical",
      turnId: "canonical#1-1",
      text: "all green on",
      seq: 3,
      updatedAt: 1_800_000_000_000,
    };
    expect(check(ServerFrameSchema, draft)).toBe(true);
    // The last frame of a turn, and the group-room shape: same frame, two optional fields.
    expect(check(ServerFrameSchema, { ...draft, done: true })).toBe(true);
    expect(check(ServerFrameSchema, { ...draft, room: "Release Room", done: true })).toBe(true);
    // An empty draft is legal (a turn that has produced no text yet); a missing one is not.
    expect(check(BotChatDeltaFrameSchema, { ...draft, text: "" })).toBe(true);
    expect(check(BotChatDeltaFrameSchema, { ...draft, text: undefined })).toBe(false);
    // `seq` is an ordinal, not a stamp: a fractional one would break the drop-stale rule.
    expect(check(BotChatDeltaFrameSchema, { ...draft, seq: 1.5 })).toBe(false);
    expect(check(BotChatDeltaFrameSchema, { ...draft, turnId: 7 })).toBe(false);
  });

  it("still rejects an unknown frame type, since the union stays closed", () => {
    expect(check(ServerFrameSchema, { type: "bot_routines", jobs: [] })).toBe(false);
  });
});

describe("tool activity (capability 12)", () => {
  const step = { stepId: "call_1", seq: 1, name: "terminal", status: "running", startedAt: 1_800_000_000_000 };
  const frame = {
    type: "bot_tool_activity",
    bot: "scout",
    sessionId: "sess-1",
    turnId: "sess-1#1800000000000-1",
    steps: [step],
    seq: 1,
    updatedAt: 1_800_000_000_000,
  };

  it("accepts a running step, a terminal one, and the frame that carries them", () => {
    expect(check(BotToolStepSchema, step)).toBe(true);
    expect(check(BotToolStepSchema, { ...step, status: "ok", endedAt: 1_800_000_001_000 })).toBe(true);
    expect(check(BotToolStepSchema, { ...step, status: "error", endedAt: 1_800_000_001_000 })).toBe(true);
    expect(check(BotToolActivityFrameSchema, frame)).toBe(true);
    expect(check(BotToolActivityFrameSchema, { ...frame, done: true, room: "standup" })).toBe(true);
    expect(check(ServerFrameSchema, frame)).toBe(true);
  });

  it("keeps the status vocabulary closed, and closed on the CORE three words", () => {
    // Shape parity with `ToolCall` in contract/v1.md is the point: one client switch renders a
    // threads chip and a bots chip. A fourth word here would fork that.
    expect(check(BotToolStepSchema, { ...step, status: "done" })).toBe(false);
    expect(check(BotToolStepSchema, { ...step, status: "failed" })).toBe(false);
    expect(check(BotToolStepSchema, { ...step, status: "pending" })).toBe(false);
  });

  it("declares only bounded display detail, never raw tool input or output fields", () => {
    // The narrow allow-list is part of the redaction guard, so this pins the shape. Asserted as the declared
    // property SET rather than by feeding extras through `check`: every schema in this contract is
    // deliberately open, because a client must ignore members it does not know for the whole
    // additive-versioning scheme to work. What must never happen is this contract GROWING one of
    // the names below -- each is a field hermes offers on `tool.start` / `tool.complete` and this
    // wire refuses (see `tool-activity.ts` for what each one leaks).
    expect(Object.keys(BotToolStepSchema.properties).sort()).toEqual([
      "detail",
      "endedAt",
      "errorText",
      "name",
      "seq",
      "startedAt",
      "status",
      "stepId",
    ]);
    for (const leak of ["args", "argSummary", "context", "result", "summary", "inlineDiff", "todos"]) {
      expect(BotToolStepSchema.properties).not.toHaveProperty(leak);
    }
    expect(check(BotToolStepSchema, { ...step, detail: "Reading calendar" })).toBe(true);
    expect(check(BotToolStepSchema, { ...step, status: "error", errorText: "Calendar unavailable" })).toBe(true);
  });

  it("holds the ordinals as integers, since both seqs are drop-stale keys and not stamps", () => {
    expect(check(BotToolStepSchema, { ...step, seq: 1.5 })).toBe(false);
    expect(check(BotToolActivityFrameSchema, { ...frame, seq: 1.5 })).toBe(false);
    expect(check(BotToolActivityFrameSchema, { ...frame, turnId: 7 })).toBe(false);
    // `steps` is required and may be empty; it is never absent.
    expect(check(BotToolActivityFrameSchema, { ...frame, steps: undefined })).toBe(false);
    expect(check(BotToolActivityFrameSchema, { ...frame, steps: [] })).toBe(true);
  });

  it("accepts the history shape, whose end is absent while any step is still running", () => {
    expect(check(BotTurnToolStepsSchema, { turnId: "t1", startedAt: 1_800_000_000_000, steps: [step] })).toBe(true);
    expect(
      check(BotTurnToolStepsSchema, {
        turnId: "t1",
        startedAt: 1_800_000_000_000,
        endedAt: 1_800_000_002_000,
        steps: [{ ...step, status: "ok", endedAt: 1_800_000_002_000 }],
      }),
    ).toBe(true);
    // It names a TURN and never a message: the gateway will not guess which row a turn produced,
    // so there is no `messageId` here to guess with.
    expect(Object.keys(BotTurnToolStepsSchema.properties).sort()).toEqual([
      "endedAt",
      "startedAt",
      "steps",
      "turnId",
    ]);
  });
});

describe("group rooms", () => {
  it("accepts a room, its log, and a room plus log", () => {
    expect(check(BotGroupMessageSchema, groupMessage)).toBe(true);
    expect(check(BotGroupSchema, group)).toBe(true);
    expect(check(BotGroupDetailSchema, { ...group, messages: [groupMessage] })).toBe(true);
    // The log is required on the detail shape: a room with no messages sends `[]`, never nothing.
    expect(check(BotGroupDetailSchema, group)).toBe(false);
  });

  it("keeps the state and sender unions closed", () => {
    expect(check(BotGroupSchema, { ...group, state: "thinking" })).toBe(false);
    expect(
      check(BotGroupMessageSchema, { ...groupMessage, from: { kind: "bot", name: "scout", displayName: "Scout" } }),
    ).toBe(false);
  });

  it("holds the 2 to 6 membership bounds at the wire boundary", () => {
    const base = { name: "Release Room" };
    expect(check(BotGroupCreateRequestSchema, { ...base, members: ["scout"] })).toBe(false);
    expect(check(BotGroupCreateRequestSchema, { ...base, members: ["scout", "luna"] })).toBe(true);
    expect(check(BotGroupCreateRequestSchema, { ...base, members: ["a", "b", "c", "d", "e", "f"] })).toBe(true);
    expect(check(BotGroupCreateRequestSchema, { ...base, members: ["a", "b", "c", "d", "e", "f", "g"] })).toBe(false);
  });

  it("requires text on a send, and bounds the client id", () => {
    expect(check(BotGroupSendRequestSchema, { text: "" })).toBe(false);
    expect(check(BotGroupSendRequestSchema, { text: "hi", clientId: "c-1" })).toBe(true);
  });
});

describe("focus request", () => {
  it("accepts the two screens and null, and nothing else", () => {
    expect(check(BotFocusRequestSchema, { screen: "roster" })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: "routines" })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: null })).toBe(true);
    expect(check(BotFocusRequestSchema, { screen: "kitchen" })).toBe(false);
    expect(check(BotFocusRequestSchema, {})).toBe(false);
  });
});

describe("profile patch", () => {
  it("accepts any single section, and all of them at once", () => {
    expect(check(BotProfilePatchSchema, { soul: "# Scout" })).toBe(true);
    expect(check(BotProfilePatchSchema, { disabledSkills: ["deploy"] })).toBe(true);
    // Empty is meaningful for toolsets: it POPS the pin rather than disabling everything.
    expect(check(BotProfilePatchSchema, { enabledToolsets: [] })).toBe(true);
    expect(
      check(BotProfilePatchSchema, {
        soul: "s",
        disabledSkills: [],
        enabledToolsets: ["files"],
        enabledMcpServers: ["github"],
      }),
    ).toBe(true);
  });

  it("rejects a list that is not a list of names", () => {
    expect(check(BotProfilePatchSchema, { disabledSkills: "deploy" })).toBe(false);
    expect(check(BotProfilePatchSchema, { enabledMcpServers: [{ name: "github" }] })).toBe(false);
  });

  // A single space passes `minLength: 1`, and the backend then filters it, leaving an EMPTY
  // `enabled_toolsets`, which POPS the pin and enables every toolset. A typo must not be the
  // maximum-permission request, so the item rule requires a non-whitespace character.
  it("rejects a whitespace-only name in any of the three lists", () => {
    expect(check(BotProfilePatchSchema, { enabledToolsets: ["  "] })).toBe(false);
    expect(check(BotProfilePatchSchema, { disabledSkills: ["\t"] })).toBe(false);
    expect(check(BotProfilePatchSchema, { enabledMcpServers: ["\n"] })).toBe(false);
    // A name with padding around real characters is still a name; the bridge trims it.
    expect(check(BotProfilePatchSchema, { enabledToolsets: [" files "] })).toBe(true);
  });
});

describe("profile", () => {
  it("accepts the mapped edit-screen shape, optional fields omitted", () => {
    expect(
      check(BotProfileSchema, {
        name: "scout",
        description: "watches CI",
        soul: "# Scout",
        skills: [{ name: "ci-watch", enabled: true }],
        toolsets: [{ name: "files", enabled: true, label: "Files", toolCount: 7 }],
        toolsetsPinned: true,
        mcpServers: [{ name: "github", installed: true, enabled: true }],
        model: { provider: "", default: "" },
        runtimeInert: ["toolsets", "mcpServers"],
      }),
    ).toBe(true);
  });

  // Required, not optional: a client gates its honesty note on this field, and an absent one would
  // read as "everything works" on exactly the backends where it does not.
  it("requires runtimeInert, and only knows the two section names", () => {
    const base = {
      name: "scout",
      description: "",
      soul: "",
      skills: [],
      toolsets: [],
      toolsetsPinned: false,
      mcpServers: [],
      model: { provider: "", default: "" },
    };
    expect(check(BotProfileSchema, base)).toBe(false);
    expect(check(BotProfileSchema, { ...base, runtimeInert: [] })).toBe(true);
    expect(check(BotProfileSchema, { ...base, runtimeInert: ["skills"] })).toBe(false);
  });
});

describe("routines", () => {
  const routine = {
    id: "job_7f2c19",
    title: "Morning digest",
    schedule: { raw: "every 120m", human: "Every 2h" },
    enabled: true,
    lastRun: null,
    nextRun: 1_800_000_600_000,
  };

  it("accepts a minimal routine and one carrying every optional field", () => {
    expect(check(BotRoutineSchema, routine)).toBe(true);
    expect(
      check(BotRoutineSchema, {
        ...routine,
        state: "paused",
        prompt: "check the build...",
        lastStatus: "success",
        // A DISPLAY string, never a number: the remaining run count is not recoverable from it.
        repeat: "1/3",
        continuity: true,
        model: "openrouter:google/gemini-2.5-flash",
        effort: "low",
      }),
    ).toBe(true);
    expect(check(BotRoutineSchema, { ...routine, repeat: 3 })).toBe(false);
    // Timestamps are nullable but never absent, so a client has one shape to read.
    expect(check(BotRoutineSchema, { ...routine, nextRun: "2026-08-18T09:00:00Z" })).toBe(false);
  });

  it("refuses a NUL and a whitespace-only field on a create", () => {
    const create = { title: "Digest", schedule: "0 9 * * *", prompt: "summarize the overnight builds" };
    expect(check(BotRoutineCreateRequestSchema, create)).toBe(true);
    // A prompt spans lines, so the NUL rule cannot be a `.`-based pattern.
    expect(check(BotRoutineCreateRequestSchema, { ...create, prompt: "summarize\nthe builds" })).toBe(true);
    expect(check(BotRoutineCreateRequestSchema, { ...create, title: "Dig\u0000est" })).toBe(false);
    expect(check(BotRoutineCreateRequestSchema, { ...create, prompt: "sum\u0000marize" })).toBe(false);
    expect(check(BotRoutineCreateRequestSchema, { ...create, title: "   " })).toBe(false);
    expect(check(BotRoutineCreateRequestSchema, { ...create, repeat: 0 })).toBe(false);
    expect(check(BotRoutineCreateRequestSchema, { ...create, model: null, effort: null })).toBe(true);
  });

  it("takes any single field on a patch, including the row switch alone", () => {
    expect(check(BotRoutinePatchSchema, { enabled: false })).toBe(true);
    expect(check(BotRoutinePatchSchema, { title: "Digest v2", prompt: "summarize" })).toBe(true);
    expect(check(BotRoutinePatchSchema, { model: null, effort: "minimal" })).toBe(true);
    // Emptiness is refused at the schema level for each field; "no fields at all" is the route's
    // rule, since an empty object is a legal patch shape.
    expect(check(BotRoutinePatchSchema, { title: "" })).toBe(false);
  });

  it("carries bot_routines in the ServerFrame union", () => {
    const frame: ServerFrame = { type: "bot_routines", bot: "scout", routines: [routine], updatedAt: 1_800_000_000_000 };
    expect(check(ServerFrameSchema, frame)).toBe(true);
  });
});

describe("bot model config", () => {
  it("fixes the catalog, nullable defaults, and partial write shapes", () => {
    expect(
      check(BotModelConfigSchema, {
        model: "openrouter:google/gemini-2.5-flash",
        effort: "low",
        catalog: [{ id: "openrouter:google/gemini-2.5-flash", displayName: "OpenRouter: Gemini Flash" }],
        efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
      }),
    ).toBe(true);
    expect(check(BotModelConfigSchema, { model: null, effort: null, catalog: [], efforts: [] })).toBe(true);
    expect(check(BotModelConfigPatchSchema, { model: null })).toBe(true);
    expect(check(BotModelConfigPatchSchema, { effort: "low" })).toBe(true);
    expect(check(BotModelConfigPatchSchema, { model: 1 })).toBe(false);
  });
});

describe("chat reset", () => {
  it("carries bot_chat_reset in the ServerFrame union, with and without a retired id", () => {
    const withPrevious: ServerFrame = {
      type: "bot_chat_reset",
      bot: "scout",
      sessionId: "stored-2",
      previousSessionId: "stored-1",
      updatedAt: 1_800_000_000_000,
    };
    // A bot that had nothing to retire sends the same frame with the optional id absent, rather
    // than a null a client would have to special-case.
    const withoutPrevious: ServerFrame = {
      type: "bot_chat_reset",
      bot: "scout",
      sessionId: "stored-2",
      updatedAt: 1_800_000_000_000,
    };
    expect(check(ServerFrameSchema, withPrevious)).toBe(true);
    expect(check(ServerFrameSchema, withoutPrevious)).toBe(true);
    expect(check(BotChatResetFrameSchema, withPrevious)).toBe(true);
  });

  it("answers the route with the new id, and the retired one only when there was one", () => {
    expect(check(BotChatResetResponseSchema, { name: "scout", sessionId: "s2", previousSessionId: "s1" })).toBe(true);
    expect(check(BotChatResetResponseSchema, { name: "scout", sessionId: "s2" })).toBe(true);
    expect(check(BotChatResetResponseSchema, { name: "scout" })).toBe(false);
  });
});

describe("capability advertisement", () => {
  it("is a vendor-scoped id with an integer version", () => {
    expect(BOTS_CAPABILITY_ID).toBe("com.cozylabs.bots");
    // 2 for the composer (a v1 gateway 404s the send route), 3 for the edit-profile surface
    // (a v2 gateway 404s the profile routes, which reads as a Save that silently does nothing),
    // 4 for the routines surface (a v3 gateway 404s them and never sends `bot_routines`),
    // 5 for the group-chat rooms (a v4 gateway 404s them and never sends `bot_group`),
    // 6 for `bot_chat_delta`, the live draft of a reply, which adds no route: a client gates the
    // drawing of a growing bubble on it rather than on a gateway that just happens to be quiet,
    // 7 for `GET /bots/:name/media`, the image proxy (a v6 gateway 404s it, so a client that
    // rendered inline images anyway would turn working links into broken-image chips),
    // 8 for `POST /bots/:name/chat/reset` and the `bot_chat_reset` frame (a v7 gateway 404s the
    // route, and a client that does not know the frame keeps writing into a retired chat),
    // 9 for photos to bots: `POST /bots/:name/chat/photos`,
    // `GET /bots/:name/chat/attachments/:fileId`, and `BotChatMessage.attachments` (a v8 gateway
    // 404s both routes, so a picker offered against one silently fails on send),
    // 10 for mobile approve/deny on bot chats: the `bot_approval_pending` / `bot_approval_resolved`
    // frames and `POST /bots/:name/approvals/:toolCallId/approve` and `.../deny` (a v9 gateway 404s
    // both routes and never sends either frame, so the buttons would do nothing),
    // 11 for fresh bot chats being born EMPTY plus the optional `suggestion` field on
    // `GET /bots/:name/chat/messages` (a v10 gateway submits a canned opener by itself and never
    // sends the field, so a client cannot offer a chip and cannot assume an untouched chat is bare),
    // 12 for live tool activity: the `bot_tool_activity` frame and the `toolSteps` array on
    // `GET /bots/:name/chat/messages` (a v11 gateway sends neither, so a step-by-step chip strip
    // offered against one would sit permanently empty while the turn looked like plain "thinking"),
    // 14 for the canonical-chat pin FOLLOWING the bot's latest conversational session, plus the
    // `bot_chat_adopted` frame that announces the move (a v13 gateway pins once and then holds, so a
    // conversation held from a second device updates the roster preview and never appears in the
    // chat the app opens, and nothing on the wire ever says the pin moved).
    // 15 for settled assistant MEDIA lines becoming attachment blocks. The field is optional, so
    // clients below 15 keep rendering text and ignore the new block.
    // 16 for listing and manually restoring one of a bot's Hermes sessions. A manual restore emits
    // the existing adoption frame and holds until the next new conversational session appears.
    // 17 for the read-only agent inbox routes and their coarse activity invalidation frame.
    // 18 for bot model config plus accepted-but-inert per-routine model and effort metadata.
    // 19 for the authenticated hard-stop route and its existing complete state-frame terminal edge,
    // plus new-session minting through the existing adoption frame without retiring the old chat.
    // 20 adds assistant audio/video metadata and ranged attachment delivery.
    // 22 adds durable native clarification cards plus their idempotent selection route.
    // 23 adds exact native turn status/cause and queued-at recovery metadata; 24 adds files;
    // 25 adds slash commands; 26 adds attachment history; 27 adds pending approval recovery;
    // 28 distinguishes a durable resolution request from Hermes terminal confirmation;
    // 29 adds clarification recovery and terminal settlement receipts; 30 adds
    // attached-profile Memory management; 31 adds durable delivery receipts (the displayed
    // report, `BotChatMessage.marker`, and role `system` on gateway-authored marker rows);
    // 32 adds inline media ordering (`BotChatMessage.attachments[].position`);
    // 33 adds create-time tool selection: optional `toolsets` / `mcpServers` on `POST /bots` and
    // the optional `warnings` on its reply. Both request fields are additive and a gateway below
    // 33 ignores them silently, so a picker UI gates on this version rather than on hope.
    // 34 adds subagent visibility: `bot_delegation_activity` full-replace batch snapshots and
    // the optional `delegations` array on chat history. A client below 34 ignores both and
    // keeps today's behavior (the outer delegate_task chip plus the terminal completion card).
    // 35 adds the live thinking preview: latest-only `bot_thinking_activity` frames, sanitized
    // and schema-capped at 280 chars, ephemeral end to end. A client below 35 ignores the
    // unknown frame and keeps today's generic shimmer.
    expect(BOTS_CAPABILITY_VERSION).toBe(35);
  });

  it("accepts a capability-33 create with tool selections, and keeps them optional", () => {
    expect(check(BotCreateRequestSchema, { name: "night-owl" })).toBe(true);
    expect(
      check(BotCreateRequestSchema, { name: "night-owl", toolsets: ["web"], mcpServers: ["github"] }),
    ).toBe(true);
    // A blank name in a selection is not a name: it would ride through to a resolver as noise.
    expect(check(BotCreateRequestSchema, { name: "night-owl", toolsets: [""] })).toBe(false);
    expect(check(BotCreateRequestSchema, { name: "night-owl", toolsets: "web" })).toBe(false);
  });

  it("keeps warnings optional on the create reply, and bounded when present", () => {
    const bot = {
      name: "night-owl", displayName: "Night Owl", handle: "@night-owl", description: null,
      hasAvatar: false, group: null, pinned: false, active: false, lastActiveAt: null,
      chatSessionId: null, preview: { kind: "empty", text: "" }, meta: null,
    };
    expect(check(BotCreateResponseSchema, { bot })).toBe(true);
    expect(check(BotCreateResponseSchema, { bot, warnings: ["skipped: telepathy"] })).toBe(true);
    expect(check(BotCreateResponseSchema, { bot, warnings: [""] })).toBe(false);
  });

  it("accepts capability-23 native turn status without changing legacy state fields", () => {
    expect(check(BotChatStateFrameSchema, {
      type: "bot_chat_state", bot: "sage", sessionId: "local-1",
      phase: "polling", running: true, inflight: true,
      status: "queued", cause: "attach_absent", queuedAt: 1,
      updatedAt: 2,
    })).toBe(true);
  });

  it("accepts only the capability-19 hard-stop success body", () => {
    expect(check(BotChatStopResponseSchema, { status: "stopped" })).toBe(true);
    expect(check(BotChatStopResponseSchema, { status: "interrupting" })).toBe(false);
  });

  it("accepts only the fixed capability-19 new-session response", () => {
    expect(
      check(BotNewSessionResponseSchema, {
        name: "scout",
        sessionId: "session-new",
        previousSessionId: "session-old",
      }),
    ).toBe(true);
    expect(
      check(BotNewSessionResponseSchema, {
        name: "scout",
        sessionId: "session-new",
      }),
    ).toBe(false);
  });

  it("accepts attachments on an assistant chat row", () => {
    expect(
      check(BotChatMessageSchema, {
        id: "assistant-1",
        role: "assistant",
        text: "Here it is.",
        at: 1_800_000_000_000,
        attachments: [
          {
            type: "attachment",
            fileId: "0123456789abcdef0123456789abcdef",
            name: "photo.png",
            mimeType: "image/png",
            size: 9,
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts a capability-32 inline position on an attachment, and only a bounded one", () => {
    const row = (attachment: Record<string, unknown>) => ({
      id: "assistant-2", role: "assistant", text: "Sales are up.", at: 1_800_000_000_000,
      attachments: [{
        type: "attachment", fileId: "0123456789abcdef0123456789abcdef",
        name: "chart.png", mimeType: "image/png", size: 9, ...attachment,
      }],
    });
    // 0 is above everything, and a mixed message (one positioned, one not) is legal.
    expect(check(BotChatMessageSchema, row({ position: 0 }))).toBe(true);
    expect(check(BotChatMessageSchema, row({ position: 3 }))).toBe(true);
    expect(check(BotChatMessageSchema, row({}))).toBe(true);
    expect(check(BotChatMessageSchema, row({ position: -1 }))).toBe(false);
    expect(check(BotChatMessageSchema, row({ position: 1.5 }))).toBe(false);
    expect(check(BotChatMessageSchema, row({ position: "1" }))).toBe(false);
  });

  it("accepts capability-16 session list and adoption responses", () => {
    expect(
      check(BotSessionsResponseSchema, {
        sessions: [
          {
            id: "session-1",
            startedAt: 1_800_000_000_000,
            lastActiveAt: 1_800_000_001_000,
            kind: "conversation",
            title: "Bot Chat",
            preview: "hello",
          },
        ],
        activeSessionId: "session-1",
      }),
    ).toBe(true);
    expect(
      check(BotSessionAdoptResponseSchema, {
        name: "scout",
        sessionId: "session-1",
        previousSessionId: "session-0",
      }),
    ).toBe(true);
  });

  it("accepts capability-17 inbox responses and activity frames", () => {
    expect(
      check(BotInboxResponseSchema, {
        threads: [
          {
            id: "a2a-1",
            peers: ["pixel"],
            startedAt: 1_800_000_000_000,
            lastActiveAt: 1_800_000_001_000,
            preview: "deploy is green",
            messageCount: 2,
          },
        ],
      }),
    ).toBe(true);
    expect(
      check(BotInboxMessagesResponseSchema, {
        messages: [
          {
            seq: 1,
            from: { kind: "member", name: "pixel", displayName: "Pixel" },
            text: "deploy is green",
            at: 1_800_000_000_000,
          },
        ],
      }),
    ).toBe(true);
    const activity = {
      type: "bot_inbox_activity",
      bot: "scout",
      threadId: "a2a-1",
      updatedAt: 1_800_000_002_000,
    };
    expect(check(BotInboxActivityFrameSchema, activity)).toBe(true);
    expect(check(ServerFrameSchema, activity)).toBe(true);
  });

  it("bounds the capability-31 displayed report and keeps its response a plain count", () => {
    expect(check(BotChatDisplayedRequestSchema, { messageIds: ["m1", "m2"] })).toBe(true);
    // Empty is not a report, it is a wasted round trip; 64 is the coalesced-scroll batch bound.
    expect(check(BotChatDisplayedRequestSchema, { messageIds: [] })).toBe(false);
    expect(check(BotChatDisplayedRequestSchema, {
      messageIds: Array.from({ length: 65 }, (_, index) => `m${index}`),
    })).toBe(false);
    expect(check(BotChatDisplayedRequestSchema, { messageIds: ["x".repeat(129)] })).toBe(false);
    expect(check(BotChatDisplayedResponseSchema, { recorded: 0 })).toBe(true);
    expect(check(BotChatDisplayedResponseSchema, { recorded: -1 })).toBe(false);
  });

  it("carries a capability-31 marker on a gateway-authored system row without changing older rows", () => {
    expect(check(BotChatMessageSchema, {
      id: "delivery-failed:cron-1", role: "system", text: "could not be delivered",
      at: 1_800_000_000_000, marker: "delivery.failed",
    })).toBe(true);
    // Additive: a row without the field is exactly the row every pre-31 gateway already sent.
    expect(check(BotChatMessageSchema, {
      id: "m1", role: "assistant", text: "hi", at: null,
    })).toBe(true);
    expect(check(BotChatMessageSchema, {
      id: "m1", role: "assistant", text: "hi", at: null, marker: "x".repeat(65),
    })).toBe(false);
  });
});

describe("delegation activity (capability 34)", () => {
  const child = { childId: "sa-0", index: 0, status: "running", lastActiveAt: 1_800_000_000_000, startedAt: 1_800_000_000_000 };
  const frame = {
    type: "bot_delegation_activity",
    bot: "scout",
    sessionId: "sess-1",
    turnId: "sess-1#1800000000000-1",
    batchId: "call-1",
    count: 5,
    children: [child],
    seq: 1,
    updatedAt: 1_800_000_000_000,
  };

  it("accepts a live child, a settled one, and the frame that carries them", () => {
    expect(check(BotDelegationChildSchema, child)).toBe(true);
    expect(check(BotDelegationChildSchema, { ...child, status: "succeeded", endedAt: 1_800_000_001_000, label: "Rewrite the skill", currentTool: "write_file", apiCalls: 4, toolCount: 7 })).toBe(true);
    expect(check(BotDelegationActivityFrameSchema, frame)).toBe(true);
    expect(check(BotDelegationActivityFrameSchema, { ...frame, done: true, children: [] })).toBe(true);
    expect(check(ServerFrameSchema, frame)).toBe(true);
  });

  it("keeps the status vocabulary closed on the nine agreed words", () => {
    for (const status of ["queued", "starting", "running", "stalling", "succeeded", "failed", "interrupted", "stalled", "unknown"]) {
      expect(check(BotDelegationChildSchema, { ...child, status })).toBe(true);
    }
    // `unknown` exists precisely so a fourth terminal word is never invented; `cancelled`
    // renders as `interrupted` upstream and `done`/`completed` never reach this wire.
    for (const status of ["done", "completed", "cancelled", "pending"]) {
      expect(check(BotDelegationChildSchema, { ...child, status })).toBe(false);
    }
  });

  it("declares only bounded display metadata, never child transcripts or tool payloads", () => {
    // Same redaction-guard shape pin as BotToolStepSchema: the property SET is the contract.
    expect(Object.keys(BotDelegationChildSchema.properties).sort()).toEqual([
      "apiCalls",
      "childId",
      "currentTool",
      "endedAt",
      "index",
      "label",
      "lastActiveAt",
      "startedAt",
      "status",
      "toolCount",
    ]);
    for (const leak of ["args", "result", "summary", "goal", "reasoning", "prompt", "transcript", "sessionPath", "model", "provider"]) {
      expect(BotDelegationChildSchema.properties).not.toHaveProperty(leak);
    }
  });

  it("holds ordinals as integers and keeps history batches joinable by turn", () => {
    expect(check(BotDelegationActivityFrameSchema, { ...frame, seq: 1.5 })).toBe(false);
    expect(check(BotDelegationActivityFrameSchema, { ...frame, count: undefined })).toBe(false);
    expect(check(BotDelegationChildSchema, { ...child, index: 0.5 })).toBe(false);
    expect(check(BotTurnDelegationsSchema, {
      turnId: frame.turnId, batchId: "call-1", count: 5,
      startedAt: 1_800_000_000_000, endedAt: 1_800_000_002_000, children: [child],
    })).toBe(true);
  });
});

describe("thinking preview (capability 35)", () => {
  const frame = {
    type: "bot_thinking_activity",
    bot: "scout",
    sessionId: "sess-1",
    turnId: "sess-1#1800000000000-1",
    text: "weighing the two options",
    seq: 1,
    updatedAt: 1_800_000_000_000,
  };

  it("accepts a bounded preview and keeps it a ServerFrame member", () => {
    expect(check(BotThinkingActivityFrameSchema, frame)).toBe(true);
    expect(check(BotThinkingActivityFrameSchema, { ...frame, text: "x".repeat(280) })).toBe(true);
    expect(check(ServerFrameSchema, frame)).toBe(true);
  });

  it("enforces the 280-char cap and a monotonic integer seq on the schema itself", () => {
    expect(check(BotThinkingActivityFrameSchema, { ...frame, text: "x".repeat(281) })).toBe(false);
    expect(check(BotThinkingActivityFrameSchema, { ...frame, seq: 0 })).toBe(false);
    expect(check(BotThinkingActivityFrameSchema, { ...frame, seq: 1.5 })).toBe(false);
  });

  it("declares only the preview text -- the property set is the privacy contract", () => {
    // Same redaction-guard shape pin as BotDelegationChildSchema: reasoning crosses this wire
    // ONLY as the one bounded display tail; nothing structural can ride along.
    expect(Object.keys(BotThinkingActivityFrameSchema.properties).sort()).toEqual([
      "bot", "seq", "sessionId", "text", "turnId", "type", "updatedAt",
    ]);
    for (const leak of ["reasoning", "args", "result", "prompt", "blocks", "raw", "detail"]) {
      expect(BotThinkingActivityFrameSchema.properties).not.toHaveProperty(leak);
    }
  });
});

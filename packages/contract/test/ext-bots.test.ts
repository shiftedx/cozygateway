import { describe, expect, it } from "vitest";

import type { BotGroup, BotGroupMessage, BotSummary, ServerFrame } from "../src/index.ts";
import {
  AGENT_INBOX_CAPABILITY_ID,
  RunnerSchema,
  RunnerDeleteResponseSchema,
  RunnerChoiceRequiredBodySchema,
  RunnersResponseSchema,
  RunnerSelfSchema,
  RunnerPairResponseSchema,
  RunnerPairCodeResponseSchema,
  RunnerPatchRequestSchema,
  PairRequestSchema,
  BotCreateRequestSchema,
  BotRuntimeProjectionSchema,
  BotCreateResponseSchema,
  BotDeleteResponseSchema,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotChatDeltaFrameSchema,
  BotChatDisplayedRequestSchema,
  BotChatDisplayedResponseSchema,
  BotChatStateFrameSchema,
  BotChatMessageSchema,
  BotMobileReceiptFrameSchema,
  BotMobileReceiptSchema,
  BotMemorySetupRequestSchema,
  BotChatResetFrameSchema,
  BotChatResetResponseSchema,
  BotChatStopResponseSchema,
  BotFocusRequestSchema,
  BotGroupCreateRequestSchema,
  BotGroupDetailSchema,
  BotGroupMessageSchema,
  BotGroupNoteSchema,
  BotGroupSchema,
  BotGroupSendRequestSchema,
  BotModelConfigPatchSchema,
  BotModelConfigSchema,
  BotModelProviderFieldUpdateSchema,
  BotModelProviderOAuthSessionSchema,
  BotModelProviderSetupCatalogSchema,
  BotNewSessionResponseSchema,
  BotProfilePatchSchema,
  BotProfileSchema,
  BotPreviewSchema,
  BotReadinessSchema,
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
  BotHistoryCheckpointSchema,
  BotHistoryDiffFileSchema,
  BotHistoryDiffResponseSchema,
  BotHistoryListResponseSchema,
  BotHistoryResolveRequestSchema,
  BotHistoryRestoreRequestSchema,
  BotHistoryTryKeepResponseSchema,
  BotHistoryTryRequestSchema,
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
  preview: { kind: "plain", text: "the build is green" },
  syncState: "ready",
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

  it("rejects inferred a2a previews and has no sender field", () => {
    expect(check(BotSummarySchema, { ...bot, preview: { kind: "a2a", text: "the build is green", sender: "luna" } })).toBe(false);
    expect(check(BotSummarySchema, { ...bot, preview: { kind: "toast", text: "x" } })).toBe(false);
    expect(Object.keys(BotPreviewSchema.properties).sort()).toEqual(["kind", "text"]);
  });

  it("adds per-profile CozyApps readiness without changing older roster rows", () => {
    const degraded = {
      status: "degraded",
      reason: "cozyapps_not_negotiated",
      repair: "restart_profile",
    } as const;
    expect(check(BotSummarySchema, {
      ...bot,
      syncState: "starting",
      cozyApps: degraded,
      syncReason: degraded.reason,
      syncRepair: degraded.repair,
    })).toBe(true);
    expect(check(BotReadinessSchema, {
      name: "scout",
      status: "starting",
      cozyApps: degraded,
      reason: degraded.reason,
      repair: degraded.repair,
      updatedAt: 1,
    })).toBe(true);
    expect(check(BotReadinessSchema, {
      name: "scout",
      status: "starting",
      cozyApps: { status: "degraded", reason: "unknown", repair: "restart_profile" },
      updatedAt: 1,
    })).toBe(false);
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

  it("carries capability-47 provenance on a room row, and keeps a pre-47 row valid", () => {
    expect(check(BotGroupMessageSchema, {
      ...groupMessage,
      messageId: "b7c1", turnId: "t-1", epoch: 3,
      cause: { kind: "user", seq: 11 },
      attachTurn: { threadId: "group:release:scout", turnId: "t-1" },
    })).toBe(true);
    // Additive: a row without any of it is exactly the row every pre-47 gateway already sent.
    expect(check(BotGroupMessageSchema, groupMessage)).toBe(true);
    // The causation union stays closed: only the human and a member can cause a member turn.
    expect(check(BotGroupMessageSchema, { ...groupMessage, cause: { kind: "bot", seq: 11 } })).toBe(false);
    // A note names a turn when one was started, and is unchanged when none was.
    expect(check(BotGroupNoteSchema, { member: "scout", reason: "failed", detail: "crashed", turnId: "t-1" })).toBe(true);
    expect(check(BotGroupNoteSchema, { member: "scout", reason: "capped", detail: "cap reached" })).toBe(true);
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
        lastDeliveryError: "Telegram delivery timed out",
        // A DISPLAY string, never a number: the remaining run count is not recoverable from it.
        repeat: "1/3",
        continuity: true,
        model: "openrouter:google/gemini-2.5-flash",
        effort: "low",
      }),
    ).toBe(true);
    expect(check(BotRoutineSchema, { ...routine, repeat: 3 })).toBe(false);
    expect(check(BotRoutineSchema, { ...routine, lastDeliveryError: "x".repeat(513) })).toBe(false);
    expect(check(BotRoutineSchema, { ...routine, lastDeliveryError: "unsafe\u0000text" })).toBe(false);
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
    expect(BotRoutineCreateRequestSchema.properties).not.toHaveProperty("lastDeliveryError");
    expect(BotRoutinePatchSchema.properties).not.toHaveProperty("lastDeliveryError");
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
    // Capability 36: providers summary and the unauthenticated catalog marker are additive.
    expect(
      check(BotModelConfigSchema, {
        model: null,
        effort: null,
        catalog: [{ id: "anthropic:claude-sonnet-4", displayName: "Anthropic: claude-sonnet-4", unauthenticated: true }],
        efforts: [],
        providers: [
          { slug: "anthropic", name: "Anthropic", authenticated: false, modelCount: 1 },
          { slug: "mtplx", name: "MTPLX", authenticated: true, modelCount: 0, baseUrl: "http://127.0.0.1:8000/v1" },
        ],
      }),
    ).toBe(true);
    // The marker is `true` or absent, never `false`; a count below zero is not a count.
    expect(
      check(BotModelConfigSchema, {
        model: null, effort: null, efforts: [],
        catalog: [{ id: "a:b", displayName: "A: b", unauthenticated: false }],
      }),
    ).toBe(false);
    expect(
      check(BotModelConfigSchema, {
        model: null, effort: null, catalog: [], efforts: [],
        providers: [{ slug: "anthropic", name: "Anthropic", authenticated: true, modelCount: -1 }],
      }),
    ).toBe(false);
    expect(check(BotModelConfigPatchSchema, { model: null })).toBe(true);
    expect(check(BotModelConfigPatchSchema, { effort: "low" })).toBe(true);
    expect(check(BotModelConfigPatchSchema, { model: 1 })).toBe(false);
  });

  it("keeps capability 41 provider setup valid without the harness-level models field", () => {
    expect(
      check(BotModelProviderSetupCatalogSchema, {
        providers: [{
          slug: "openrouter",
          name: "OpenRouter",
          authenticated: false,
          modelCount: 0,
          methods: [{
            id: "fields",
            kind: "fields",
            label: "API key",
            connected: false,
            fields: [{
              key: "OPENROUTER_API_KEY",
              label: "OpenRouter API key",
              secret: true,
              advanced: false,
              isSet: false,
              helpUrl: "https://openrouter.ai/keys",
            }],
          }],
        }],
        updatedAt: 1_800_000_000_000,
      }),
    ).toBe(true);
    expect(check(BotModelProviderFieldUpdateSchema, { value: "sk-secret" })).toBe(true);
    expect(check(BotModelProviderFieldUpdateSchema, { value: "" })).toBe(false);
    expect(
      check(BotModelProviderOAuthSessionSchema, {
        provider: "openai-codex",
        sessionId: "oauth-1",
        flow: "device_code",
        status: "pending",
        authorizationUrl: "https://example.test/device",
        userCode: "ABCD-EFGH",
        pollIntervalMs: 2_000,
      }),
    ).toBe(true);
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
    expect(AGENT_INBOX_CAPABILITY_ID).toBe("com.cozylabs.agent-inbox");
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
    // 17 was the withdrawn heuristic agent inbox. Its replacement has a separate dormant
    // capability id, so later bots capability bumps still do not revive the withdrawn surface.
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
    // 36 adds full provider visibility on `BotModelConfig`: the optional `providers` summary and
    // the optional `unauthenticated: true` catalog marker. A client below 36 ignores both and
    // keeps rendering the catalog alone.
    // 37 adds bot deletion: `DELETE /bots/:name`, the inverse of `POST /bots`. Additive in the
    // simplest possible way, since a client below 37 simply never calls the route.
    // 38 replaces device status v1; 39 adds leases and durable metadata-only sharing receipts;
    // 40 distinguishes a created profile from an attached, writable bot; 41 wraps Hermes' model
    // provider setup catalog, credential lifecycle, and OAuth sessions for the phone; 42 adds
    // exact credential-free memory setup through the attached profile plugin; 43 makes every
    // Hermes profile visible with an exact synchronization state. 44 adds per-profile CozyApps
    // readiness so a globally capable gateway cannot misrepresent an older attached plugin.
    // 45 adds native runtime bots; 46 makes one a full room member and streams a room turn's
    // live draft as `bot_chat_delta` carrying `room`. 47 adds auditable ids: recorded
    // provenance on room and 1:1 transcript rows (`turnId`, `messageId`, `epoch`, `cause`,
    // `attachTurn`, `authorBot`, `inReplyToId`) plus typed room `context` on the attach turn
    // command. Every field is optional and absent on rows written before 47, so a client
    // below 47 is unchanged. 48 adds the bot config lane: a runtime bot answers the profile,
    // model-config, and routines routes over attach-v1 instead of 409, with the wire shapes
    // unchanged, so a client below 48 sees the 409 it already handles. 49 lets the app create a
    // runtime bot outright: `POST /bots {runtime: "cozyagents"}` writes a gateway-owned row, mints
    // the attach token, and enqueues the operation a CozyRunner reconciles, with
    // `GET /bots/:name/runtime` projecting the stage and `DELETE /bots/:name` answering for it.
    // A client below 49 never sends the field and never calls the route. 50 adds the bot history
    // lane. 51 lets a room member turn ask: approval and clarify events on a runtime member's room
    // turn land in the existing interaction inbox and resolve through the existing routes, tool
    // events project as ephemeral `bot_tool_activity` carrying `room`, and a room advertises its
    // pending interactions. Additive: no new route, every new field optional, Hermes members
    // unchanged. 52 pairs the computers themselves: `POST /pair {kind: "runner"}` mints a
    // per-runner token, `GET /runners`, `PATCH /runners/:id` and `DELETE /runners/:id` manage the
    // roster, `/runner/v1` carries one socket per runner, and a gateway with no Hermes endpoint is
    // a supported configuration whose readiness reports the bridge as absent. A client below 52
    // never sends `kind` and never calls the routes.
    expect(BOTS_CAPABILITY_VERSION).toBe(56);
  });

  it("accepts a capability-49 runtime create and its runtime projection", () => {
    // The field is optional and closed: absent is the Hermes create every client already sends,
    // and the only named runtime is the one this gateway can actually serve.
    expect(check(BotCreateRequestSchema, { name: "sage" })).toBe(true);
    expect(check(BotCreateRequestSchema, { name: "sage", runtime: "cozyagents" })).toBe(true);
    expect(check(BotCreateRequestSchema, { name: "sage", runtime: "hermes" })).toBe(false);
    // The projection carries generations and contact, never a token, an env value, or a host path.
    expect(
      check(BotRuntimeProjectionSchema, {
        stage: "waiting_for_runner",
        specGeneration: 1,
        observedGeneration: null,
        lastRunnerContactAt: null,
      }),
    ).toBe(true);
    expect(
      check(BotRuntimeProjectionSchema, {
        stage: "ready",
        specGeneration: 2,
        observedGeneration: 2,
        lastRunnerContactAt: 1_800_000_000_000,
        code: "isolation_unavailable",
      }),
    ).toBe(true);
    expect(check(BotRuntimeProjectionSchema, { stage: "invented", specGeneration: 1, observedGeneration: null, lastRunnerContactAt: null })).toBe(false);
    // The two stages a delete moves through are part of the closed union, so a client can render
    // the cleanup finishing instead of the bot simply vanishing mid-operation.
    for (const stage of ["deletion_pending", "deleting", "deleted"]) {
      expect(check(BotRuntimeProjectionSchema, { stage, specGeneration: 1, observedGeneration: 1, lastRunnerContactAt: 1 })).toBe(true);
    }
    expect(
      check(BotRuntimeProjectionSchema, {
        stage: "ready", specGeneration: 1, observedGeneration: 1, lastRunnerContactAt: 1,
        attachToken: "secret",
      }),
    ).toBe(false);
  });

  it("carries capability-54 runner placement on the create, the row, and the projection", () => {
    // The create body a client below 54 sends is accepted unchanged; naming a computer is one more
    // optional field beside the runtime it already names.
    expect(check(BotCreateRequestSchema, { name: "sage", runtime: "cozyagents", runnerId: "runner-1" })).toBe(true);
    expect(check(BotCreateRequestSchema, { name: "sage", runnerId: "" })).toBe(false);
    // Absent rather than null on a roster row: a Hermes bot and a pre-54 runtime bot have no
    // computer to name, and null would claim the gateway knew of one and lost it.
    expect(check(BotSummarySchema, bot)).toBe(true);
    expect(check(BotSummarySchema, { ...bot, runnerId: "runner-1", runnerName: "kyle-mbp" })).toBe(true);
    expect(check(BotSummarySchema, { ...bot, runnerId: null })).toBe(false);
    const projection = { stage: "ready", specGeneration: 1, observedGeneration: 1, lastRunnerContactAt: 1 };
    expect(check(BotRuntimeProjectionSchema, { ...projection, runnerId: "runner-1", runnerName: "kyle-mbp" })).toBe(true);
    // A revoked computer leaves the id behind with no name to render, which is the honest shape.
    expect(check(BotRuntimeProjectionSchema, { ...projection, runnerId: "runner-1" })).toBe(true);
    // The roster screen reads the count off the runner row, and a delete answers it too.
    const runnerRow = {
      id: "runner-1", name: "kyle-mbp", platform: null, version: null, backends: [],
      default: true, createdAt: 1, lastSeenAt: null, online: false, renamed: false,
    };
    expect(check(RunnerSchema, { ...runnerRow, botCount: 3 })).toBe(true);
    expect(check(RunnerSchema, { ...runnerRow, botCount: -1 })).toBe(false);
    expect(check(RunnerDeleteResponseSchema, { ok: true, botCount: 2 })).toBe(true);
    expect(check(RunnerDeleteResponseSchema, { ok: true })).toBe(true);
    expect(check(RunnerDeleteResponseSchema, { ok: false })).toBe(false);
    // A revoke that moved the stranded work says where it went, and how much of it there was.
    expect(
      check(RunnerDeleteResponseSchema, { ok: true, botCount: 2, reassignedOperations: 1, reassignedTo: "runner-2" }),
    ).toBe(true);
    expect(check(RunnerDeleteResponseSchema, { ok: true, reassignedOperations: 0 })).toBe(true);
    expect(check(RunnerDeleteResponseSchema, { ok: true, reassignedTo: "" })).toBe(false);
    // The chooser is built from ids, which live only in this array: the message carries names.
    expect(
      check(RunnerChoiceRequiredBodySchema, {
        error: { code: "runner_choice_required", message: "name one in runnerId: kyle-mbp, studio" },
        runners: [
          { id: "runner-1", name: "kyle-mbp", isDefault: false },
          { id: "runner-2", name: "studio", isDefault: false },
        ],
      }),
    ).toBe(true);
    expect(
      check(RunnerChoiceRequiredBodySchema, {
        error: { code: "no_runner_paired", message: "add a computer" },
        runners: [],
      }),
    ).toBe(false);
    expect(
      check(RunnerChoiceRequiredBodySchema, {
        error: { code: "runner_choice_required", message: "pick one" },
        runners: [{ name: "kyle-mbp", isDefault: false }],
      }),
    ).toBe(false);
  });

  it("keeps capability-42 memory setup closed and requires at least one source", () => {
    expect(check(BotMemorySetupRequestSchema, {
      memoryEnabled: true, userProfileEnabled: false, holographicEnabled: false,
    })).toBe(true);
    expect(check(BotMemorySetupRequestSchema, {
      memoryEnabled: false, userProfileEnabled: true, holographicEnabled: true,
    })).toBe(true);
    expect(check(BotMemorySetupRequestSchema, {
      memoryEnabled: false, userProfileEnabled: false, holographicEnabled: false,
    })).toBe(false);
    expect(check(BotMemorySetupRequestSchema, {
      memoryEnabled: true, userProfileEnabled: false,
    })).toBe(false);
    expect(check(BotMemorySetupRequestSchema, {
      memoryEnabled: true, userProfileEnabled: false, holographicEnabled: false, provider: "external",
    })).toBe(false);
  });

  it("keeps mobile receipts closed and metadata-only", () => {
    const receipt = {
      requestId: "request-1",
      bot: "sage",
      sessionId: "session-1",
      turnId: "turn-1",
      command: "location.current",
      sharedDescription: "Approximate location",
      purpose: "Find nearby coffee",
      sharedAt: 100,
    };
    expect(check(BotMobileReceiptSchema, receipt)).toBe(true);
    expect(check(BotMobileReceiptFrameSchema, {
      type: "bot_mobile_receipt",
      ...receipt,
    })).toBe(true);
    for (const forbidden of ["lease", "deviceId", "result", "latitude", "longitude"]) {
      expect(check(BotMobileReceiptSchema, { ...receipt, [forbidden]: "secret" })).toBe(false);
    }
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
      chatSessionId: null, preview: { kind: "empty", text: "" }, syncState: "starting", meta: null,
    };
    expect(check(BotCreateResponseSchema, { bot })).toBe(true);
    expect(check(BotCreateResponseSchema, { bot, warnings: ["skipped: telepathy"] })).toBe(true);
    expect(check(BotCreateResponseSchema, { bot, warnings: [""] })).toBe(false);
  });

  it("keeps the capability-37 delete reply honest about what it removed", () => {
    const reply = {
      name: "night-owl",
      hermesProfile: "deleted",
      purged: { roster: 1, sessions: 2 },
      tokenRevoked: true,
      residue: ["run scripts/deprovision-bot.sh night-owl"],
    };
    expect(check(BotDeleteResponseSchema, reply)).toBe(true);
    // The recovery half: Hermes no longer had the profile, only gateway state remained.
    expect(check(BotDeleteResponseSchema, { ...reply, hermesProfile: "already_absent" })).toBe(true);
    // A bot that owned nothing purges nothing and leaves nothing behind; both stay valid.
    expect(check(BotDeleteResponseSchema, { ...reply, purged: {}, residue: [] })).toBe(true);
    // "maybe deleted" is not one of the two answers this route is allowed to give.
    expect(check(BotDeleteResponseSchema, { ...reply, hermesProfile: "partial" })).toBe(false);
    // A count is a count: never negative, and never a presentation string.
    expect(check(BotDeleteResponseSchema, { ...reply, purged: { roster: -1 } })).toBe(false);
    expect(check(BotDeleteResponseSchema, { ...reply, purged: { roster: "one" } })).toBe(false);
    // Residue lines are operator English, so an empty line is noise rather than a line.
    expect(check(BotDeleteResponseSchema, { ...reply, residue: [""] })).toBe(false);
    // tokenRevoked is a fact the caller acts on, so it is required rather than assumed.
    const { tokenRevoked: _dropped, ...withoutFlag } = reply;
    expect(check(BotDeleteResponseSchema, withoutFlag)).toBe(false);
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
    // Capability 47 provenance is additive the same way: recorded when the gateway holds the
    // fact, absent otherwise, and a pre-47 row above stays valid without any of it.
    expect(check(BotChatMessageSchema, {
      id: "answer-1", role: "assistant", text: "hi", at: null,
      turnId: "t-1", authorBot: "sage", inReplyToId: "ask-1",
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
      "costStatus",
      "costUsd",
      "currentTool",
      "durationMs",
      "endedAt",
      "index",
      "label",
      "lastActiveAt",
      "schemaValidation",
      "startedAt",
      "status",
      "toolCount",
    ]);
    for (const leak of ["args", "result", "summary", "goal", "reasoning", "prompt", "transcript", "sessionPath", "model", "provider"]) {
      expect(BotDelegationChildSchema.properties).not.toHaveProperty(leak);
    }
  });

  it("bounds synchronous result enrichment and keeps unavailable distinct from false", () => {
    expect(check(BotDelegationChildSchema, {
      ...child,
      costUsd: 0.125,
      costStatus: "estimated",
      schemaValidation: { valid: false, retries: 1 },
      durationMs: 2345,
    })).toBe(true);
    // Absent is unavailable/not requested, while false is an explicit failed validation verdict.
    expect(check(BotDelegationChildSchema, child)).toBe(true);
    expect(check(BotDelegationChildSchema, { ...child, schemaValidation: { valid: false } })).toBe(true);
    expect(check(BotDelegationChildSchema, {
      ...child,
      schemaValidation: { valid: false, retries: 1, schema_errors: ["/private/path"] },
    })).toBe(false);
    for (const costStatus of ["estimated", "reported", "unknown"])
      expect(check(BotDelegationChildSchema, { ...child, costUsd: 0, costStatus })).toBe(true);
    for (const invalid of [
      { costUsd: -1 },
      { costUsd: 1_000_001 },
      { costStatus: "exact" },
      { schemaValidation: { valid: false, retries: 2 } },
      { durationMs: -1 },
      { durationMs: 2_147_483_648 },
    ]) expect(check(BotDelegationChildSchema, { ...child, ...invalid })).toBe(false);
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

  it("carries the canonical Hermes alias as an optional batch-level field only", () => {
    // `aliasId` is the canonical `deleg_...` id learned from the delegate_task result; it
    // rides the frame and history batch so clients can reconcile the async completion row
    // when the exact `batchId` match fails. Additive under capability 34.
    expect(check(BotDelegationActivityFrameSchema, { ...frame, aliasId: "deleg_c6eb9310" })).toBe(true);
    expect(check(ServerFrameSchema, { ...frame, aliasId: "deleg_c6eb9310" })).toBe(true);
    expect(check(BotTurnDelegationsSchema, {
      turnId: frame.turnId, batchId: "call-1", aliasId: "deleg_c6eb9310", count: 5,
      startedAt: 1_800_000_000_000, children: [child],
    })).toBe(true);
    // Alias-absent frames stay exactly as they were (an older gateway never sends it).
    expect(check(BotDelegationActivityFrameSchema, frame)).toBe(true);
    // Batch-level, never child-level: the child property set is the privacy contract.
    expect(BotDelegationChildSchema.properties).not.toHaveProperty("aliasId");
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

describe("capability 50 bot history", () => {
  const checkpoint = {
    id: "c1", at: 1_700_000_000_000, summary: "Add the sign-in page",
    checks: "passed" as const, turnId: "turn-1", messageId: "msg-1", epoch: 7,
  };

  it("accepts a checkpoint row with and without its optional audit ids", () => {
    expect(check(BotHistoryCheckpointSchema, checkpoint)).toBe(true);
    // An "as found" checkpoint, written when a human edited files outside the bot, has no turn
    // and no message behind it, and must still be a row the Changes list can show.
    const { turnId: _turn, messageId: _message, ...asFound } = checkpoint;
    expect(check(BotHistoryCheckpointSchema, asFound)).toBe(true);
    expect(check(BotHistoryListResponseSchema, { checkpoints: [checkpoint] })).toBe(true);
    expect(check(BotHistoryListResponseSchema, { checkpoints: [] })).toBe(true);
  });

  // `unavailable` is its own answer and not a synonym for `failed`: a turn whose checks could not
  // run is not a turn whose checks failed, and a Changes row that conflates them is the difference
  // between "do not restore this" and "nobody knows".
  it("keeps the three check outcomes apart and admits no fourth", () => {
    for (const checks of ["passed", "failed", "unavailable"])
      expect(check(BotHistoryCheckpointSchema, { ...checkpoint, checks })).toBe(true);
    expect(check(BotHistoryCheckpointSchema, { ...checkpoint, checks: "skipped" })).toBe(false);
  });

  // These schemas are closed, unlike most of this contract: they are the boundary that keeps a
  // workspace's contents off this wire, and a boundary with an open door is not one.
  it("refuses an unknown field on every history shape", () => {
    expect(check(BotHistoryCheckpointSchema, { ...checkpoint, branch: "cozy/main" })).toBe(false);
    expect(check(BotHistoryListResponseSchema, { checkpoints: [], cursor: "x" })).toBe(false);
    expect(check(BotHistoryDiffFileSchema, { path: "a.ts", added: 1, removed: 0, status: "modified", patch: "@@" })).toBe(false);
    expect(check(BotHistoryDiffResponseSchema, { files: [], raw: "diff" })).toBe(false);
    expect(check(BotHistoryRestoreRequestSchema, { checkpoint: "c1", hard: true })).toBe(false);
    expect(check(BotHistoryTryRequestSchema, { action: "start", label: "x", branch: "main" })).toBe(false);
    expect(check(BotHistoryResolveRequestSchema, { choices: [{ path: "a.ts", pick: "ours", content: "x" }] })).toBe(false);
  });

  it("carries per-file counts and never the change itself", () => {
    expect(Object.keys(BotHistoryDiffFileSchema.properties).sort()).toEqual([
      "added", "path", "removed", "status",
    ]);
    for (const leak of ["patch", "diff", "hunks", "content", "before", "after", "preview", "blob"])
      expect(BotHistoryDiffFileSchema.properties).not.toHaveProperty(leak);
  });

  // `ours` and `theirs` name the two sides for a person choosing between them. They are labels,
  // and the two versions themselves stay in the workspace where they live.
  it("describes a conflict with two bounded labels, not two versions", () => {
    const conflicts = [{ path: "src/app.ts", ours: "Sage's version", theirs: "the other change" }];
    expect(check(BotHistoryTryKeepResponseSchema, { merged: false, conflicts })).toBe(true);
    expect(check(BotHistoryTryKeepResponseSchema, { merged: true })).toBe(true);
    expect(check(BotHistoryTryKeepResponseSchema, {
      merged: false, conflicts: [{ ...conflicts[0], ours: "x".repeat(201) }],
    })).toBe(false);
  });

  it("refuses a resolve that answers nothing and a try action it does not know", () => {
    expect(check(BotHistoryResolveRequestSchema, { choices: [] })).toBe(false);
    expect(check(BotHistoryResolveRequestSchema, { choices: [{ path: "a.ts", pick: "mine" }] })).toBe(false);
    expect(check(BotHistoryTryRequestSchema, { action: "abandon" })).toBe(false);
  });
});

/** Capability 52. These five shapes are what the app reads to answer "which of my computers is
 *  here", and what the installer reads to know it succeeded. Every case below is the EXACT JSON the
 *  gateway routes emit (`packages/gateway/src/runner/roster.ts` and the `/runners` routes in
 *  `http.ts`), so a change to either side that drifts from the other fails here rather than on a
 *  phone. They are closed, so an unknown field is a refusal in every direction. */
describe("paired runners (capability 52)", () => {
  // The bytes `GET /runners` puts in each array element, and `POST /pair {kind: "runner"}` puts in
  // `runner`: a machine that has connected once, so nothing is null.
  const runner = {
    id: "3f8c1b2e-6a4d-4f52-9c31-0d5a7e9b2c44",
    name: "kyle-mbp",
    platform: "darwin/arm64/24.5.0",
    version: "0.1.0",
    backends: ["process"],
    default: true,
    createdAt: 1_800_000_000_000,
    lastSeenAt: 1_800_000_015_000,
    online: true,
    renamed: false,
  };
  // The same row the moment after pairing, before the runner has ever dialed in. Every optional
  // fact is null rather than absent or invented, which is what the gateway actually answers.
  const fresh = { ...runner, platform: null, version: null, backends: [], lastSeenAt: null, online: false };

  it("accepts a runner row, connected and freshly paired, and refuses an unknown field", () => {
    expect(check(RunnerSchema, runner)).toBe(true);
    expect(check(RunnerSchema, fresh)).toBe(true);
    expect(check(RunnersResponseSchema, { runners: [runner, fresh] })).toBe(true);
    expect(check(RunnersResponseSchema, { runners: [] })).toBe(true);
    expect(check(RunnerSchema, { ...runner, token: "secret" })).toBe(false);
    expect(check(RunnersResponseSchema, { runners: [runner], cursor: "next" })).toBe(false);
  });

  it("keeps every field of a runner row required, so a client never guesses at an absent one", () => {
    for (const field of Object.keys(runner)) {
      const { [field]: _dropped, ...without } = runner as Record<string, unknown>;
      expect(check(RunnerSchema, without)).toBe(false);
    }
    // `default` and `online` are booleans, not the truthy strings a hand-written client might send.
    expect(check(RunnerSchema, { ...runner, default: "true" })).toBe(false);
    expect(check(RunnerSchema, { ...runner, online: 1 })).toBe(false);
    // `platform` and `lastSeenAt` are nullable, never merely absent.
    expect(check(RunnerSchema, { ...runner, platform: undefined })).toBe(false);
  });

  it("accepts the pair reply the runner installer reads, and refuses one carrying anything else", () => {
    const gateway = { name: "cozygateway", version: "0.6.5", contract: "v1", capabilities: { "com.cozylabs.bots": 52 } };
    expect(check(RunnerPairResponseSchema, {
      runnerToken: "sYqQvJ0aVvkq3aQ4h4Jm2m8YxK2xkNRs9xVQ2m6vqfw",
      runner: fresh,
      gateway,
    })).toBe(true);
    // The token is on this reply and nowhere else, and nothing else rides along with it.
    expect(check(RunnerPairResponseSchema, { runnerToken: "t", runner: fresh, gateway, setupCode: "AAAA-BBBB" })).toBe(false);
    expect(check(RunnerPairResponseSchema, { runner: fresh, gateway })).toBe(false);
  });

  it("accepts what GET /runners/self answers, which is seven fields and no credential", () => {
    const self = {
      id: runner.id,
      name: "kyle-mbp",
      platform: "darwin/arm64/24.5.0",
      default: true,
      lastSeenAt: 1_800_000_015_000,
      attached: true,
      // Capability 55.
      renamed: false,
    };
    expect(check(RunnerSelfSchema, self)).toBe(true);
    // Paired but not yet dialed in: the row exists and says so honestly.
    expect(check(RunnerSelfSchema, { ...self, platform: null, lastSeenAt: null, attached: false })).toBe(true);
    expect(Object.keys(RunnerSelfSchema.properties).sort()).toEqual([
      "attached", "default", "id", "lastSeenAt", "name", "platform", "renamed",
    ]);
    // It is a runner's view of itself, not the roster row: no token, and no other machine's facts.
    for (const leak of ["token", "runnerToken", "tokenHash", "backends"])
      expect(RunnerSelfSchema.properties).not.toHaveProperty(leak);
    expect(check(RunnerSelfSchema, { ...self, token: "secret" })).toBe(false);
    expect(check(RunnerSelfSchema, { ...self, online: true })).toBe(false);
    expect(check(RunnerSelfSchema, { ...self, renamed: undefined })).toBe(false);
  });

  it("accepts the minted pairing code with the origin to dial, and nothing more", () => {
    const minted = {
      setupCode: "K7QP-3MRT",
      expiresAt: 1_800_000_600_000,
      gatewayUrl: "http://192.168.1.24:8787",
    };
    expect(check(RunnerPairCodeResponseSchema, minted)).toBe(true);
    expect(check(RunnerPairCodeResponseSchema, { ...minted, kind: "runner" })).toBe(false);
    expect(check(RunnerPairCodeResponseSchema, { setupCode: "K7QP-3MRT", expiresAt: 1 })).toBe(false);
    // A code is minted, never echoed back with the credential it will become.
    for (const leak of ["runnerToken", "deviceToken", "token"])
      expect(RunnerPairCodeResponseSchema.properties).not.toHaveProperty(leak);
  });

  it("moves the default by naming one runner, and refuses a patch that says anything else", () => {
    expect(check(RunnerPatchRequestSchema, { default: true })).toBe(true);
    expect(check(RunnerPatchRequestSchema, { default: false })).toBe(true);
    // Capability 55: an empty body is a valid SHAPE (both fields are optional at the schema
    // level); the route is what refuses one naming neither field, since that has nothing to do.
    expect(check(RunnerPatchRequestSchema, {})).toBe(true);
  });

  it("capability 55: renames alongside or instead of moving the default", () => {
    expect(check(RunnerPatchRequestSchema, { name: "Kyle's Laptop" })).toBe(true);
    expect(check(RunnerPatchRequestSchema, { default: true, name: "Kyle's Laptop" })).toBe(true);
    // Clearing: an empty string or null both validate at the schema level.
    expect(check(RunnerPatchRequestSchema, { name: "" })).toBe(true);
    expect(check(RunnerPatchRequestSchema, { name: null })).toBe(true);
    expect(check(RunnerPatchRequestSchema, { name: 5 })).toBe(false);
    expect(check(RunnerPatchRequestSchema, { name: "x", extra: true })).toBe(false);
  });

  it("keeps the pair request additive: a pre-52 device body is still exactly valid", () => {
    // The body every shipped client sends, unchanged by 52.
    expect(check(PairRequestSchema, { setupCode: "K7QP-3MRT", deviceName: "Kyle's iPhone" })).toBe(true);
    // The runner body, where `deviceName` carries the runner's name (controller ruling 6).
    expect(check(PairRequestSchema, { setupCode: "K7QP-3MRT", deviceName: "kyle-mbp", kind: "runner" })).toBe(true);
    // `deviceName` is optional in the SCHEMA and required at the route for a device pair, which is
    // what leaves every existing client's request and error untouched.
    expect(check(PairRequestSchema, { setupCode: "K7QP-3MRT", kind: "runner" })).toBe(true);
    expect(check(PairRequestSchema, { setupCode: "K7QP-3MRT", kind: "phone" })).toBe(false);
  });
});

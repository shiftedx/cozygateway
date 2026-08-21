/** Black-box conformance suite for the cozygateway wire contract v1.
 *
 * Every assertion here is authored from `contract/v1.md` (the frozen human-readable
 * authority) and the `cozygateway-contract` schemas, NEVER from any gateway's source. The
 * suite drives a gateway only over its public HTTP + WebSocket surface, so a passing run is
 * evidence the implementation speaks the wire, not that it shares our code. A third-party
 * gateway wires `registerConformanceSuite` into its own vitest run, points it at itself, and
 * proves conformance the same way the reference gateway does.
 *
 * The suite exercises the reference echo backend, whose semantics are frozen in section 7 of
 * the contract: a reply to `{ type: "paragraph", text: T }` is exactly two draft frames then a
 * commit of `[{ type: "paragraph", text: "Echo: " + T }]`; a `T` containing `[[fail]]` fails
 * the turn as a `turn.failed` system message instead of an echo commit. */
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import {
  type Message,
  type ServerFrame,
  type Thread,
  APPROVALS_CAPABILITY_ID,
  APPROVALS_CAPABILITY_VERSION,
  AgentSchema,
  ApprovalPendingFrameSchema,
  ApprovalResolveResponseSchema,
  ApprovalResolvedFrameSchema,
  BotChatStopResponseSchema,
  BotInboxMessagesResponseSchema,
  BotInboxResponseSchema,
  BotModelConfigSchema,
  CommittedFrameSchema,
  DeviceSchema,
  DoneFrameSchema,
  DraftFrameSchema,
  ErrorBodySchema,
  ErrorFrameSchema,
  GatewayInfoSchema,
  InterruptResponseSchema,
  ListMessagesResponseSchema,
  MessageSchema,
  PairResponseSchema,
  ReadyFrameSchema,
  SendMessageResponseSchema,
  ServerFrameSchema,
  SyncedFrameSchema,
  ThreadSchema,
  assertValid,
  check,
} from "cozygateway-contract";

/** Everything the suite needs to reach one gateway under test. A host supplies these. */
export interface ConformanceEnv {
  /** Base HTTP URL of the gateway under test, no trailing slash. */
  baseUrl: () => string;
  /** Mint a fresh single-use setup code on the gateway under test. */
  issueSetupCode: () => Promise<string>;
  /** Agent id of the reference echo backend on the gateway under test. */
  echoAgentId: string;
  /** OPTIONAL stall hook (issue #21). Agent id of a stall-capable, interruptible backend on the
   *  gateway under test. Declaring it activates the live in-flight interrupt group, which is the
   *  only way a black-box run can prove the 202 path of POST /threads/:id/interrupt end to end.
   *
   *  A gateway that declares this id promises the backend behind it:
   *  - on a send, emits at least one `draft` frame for the turn and then STAYS IN FLIGHT: it
   *    never commits, never emits `done`, and never fails on its own;
   *  - honors a hard interrupt, so `POST /threads/:id/interrupt` during that window answers
   *    `202 { "status": "interrupting" }` and the turn then ends as a committed `role: "system"`
   *    message carrying `marker: "turn.interrupted"` followed by a `done` frame for the same
   *    turn, with no `error` frame (contract v1.md section 5, POST /threads/:id/interrupt).
   *
   *  Omit it and the suite skips that group; every other assertion is unaffected, so a gateway
   *  with no stall-capable backend still passes exactly what it passes today. */
  stallAgentId?: string;
  /** OPTIONAL approval hook (issue #19). Agent id of an approval-capable backend on the gateway
   *  under test. Declaring it activates the approval group, which is the only way a black-box run
   *  can prove the approve/deny verbs and the approval frames end to end.
   *
   *  A gateway that declares this id promises the backend behind it:
   *  - on a send, emits at least one `approval_pending` frame for the turn (carrying that turn's
   *    `turnId`, a `toolCallId`, and a tool `name`) and then STAYS IN FLIGHT until the approval
   *    is resolved: it never commits and never emits `done` on its own;
   *  - honors `POST /threads/:id/approvals/:toolCallId/{approve,deny}`, so the call answers
   *    `202 { "status": "approved" | "denied" }` and an `approval_resolved` frame carrying the
   *    matching outcome follows on the socket (contract v1.md section 5a);
   *  - and the gateway advertises the `approvals` capability, since it implements the surface.
   *
   *  Omit it and the suite skips that group; every other assertion is unaffected, so a gateway
   *  with no approval-capable backend still passes exactly what it passes today. */
  approvalAgentId?: string;
  /** OPTIONAL agent-inbox fixture (vendor capability com.cozylabs.bots >= 17). The named bot must
   *  expose the named a2a thread in its newest 50 so both read routes can be checked black-box. */
  botInbox?: { botName: string; threadId: string };
  /** OPTIONAL capability-18 bot whose live Hermes model config may be read. The suite sends only a
   *  rejected unknown-model PUT, so it never changes the fixture's config. */
  botModelConfig?: { botName: string };
  /** OPTIONAL capability-19 bot whose configured model stays in flight after a chat send until
   *  `POST /bots/:name/chat/stop` interrupts it. The fixture must be idle when the group starts. */
  botChatStop?: { botName: string; prompt?: string };
}

const TEST_TIMEOUT_MS = 10_000;
const WAIT_TIMEOUT_MS = 8_000;
const JSON_HEADERS: Record<string, string> = { "content-type": "application/json" };

function assertArray(value: unknown, label: string): unknown[] {
  expect(Array.isArray(value), `${label} should be a JSON array`).toBe(true);
  return value as unknown[];
}

function framesOfType<T extends ServerFrame["type"]>(
  frames: ServerFrame[],
  type: T,
): Extract<ServerFrame, { type: T }>[] {
  return frames.filter((f): f is Extract<ServerFrame, { type: T }> => f.type === type);
}

function isStrictlyAscending(nums: number[]): boolean {
  let prev = Number.NEGATIVE_INFINITY;
  for (const n of nums) {
    if (n <= prev) return false;
    prev = n;
  }
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function registerConformanceSuite(env: ConformanceEnv): void {
  // ---- HTTP helpers -------------------------------------------------------------------

  async function pairDevice(deviceName: string): Promise<{ token: string; deviceId: string }> {
    const setupCode = await env.issueSetupCode();
    const res = await fetch(`${env.baseUrl()}/pair`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ setupCode, deviceName }),
    });
    expect(res.status).toBe(200);
    const paired = assertValid(PairResponseSchema, await res.json());
    return { token: paired.deviceToken, deviceId: paired.device.id };
  }

  function authFetch(
    token: string,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    return fetch(`${env.baseUrl()}${path}`, {
      method: init.method,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      body: init.body,
    });
  }

  async function createThreadWith(token: string, agentId: string, title?: string): Promise<Thread> {
    const res = await authFetch(token, "/threads", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agentId, ...(title === undefined ? {} : { title }) }),
    });
    expect(res.status).toBe(200);
    return assertValid(ThreadSchema, await res.json());
  }

  function createThread(token: string, title?: string): Promise<Thread> {
    return createThreadWith(token, env.echoAgentId, title);
  }

  async function sendMessage(token: string, threadId: string, text: string): Promise<Message> {
    const res = await authFetch(token, `/threads/${threadId}/messages`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ blocks: [{ type: "paragraph", text }] }),
    });
    expect(res.status).toBe(200);
    return assertValid(SendMessageResponseSchema, await res.json()).message;
  }

  async function listMessages(token: string, threadId: string, query = ""): Promise<Message[]> {
    const res = await authFetch(token, `/threads/${threadId}/messages${query}`);
    expect(res.status).toBe(200);
    return assertValid(ListMessagesResponseSchema, await res.json()).messages;
  }

  async function waitForMessageCount(token: string, threadId: string, count: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      if ((await listMessages(token, threadId)).length >= count) return;
      if (Date.now() - start > WAIT_TIMEOUT_MS) throw new Error(`timeout waiting for ${count} messages`);
      await sleep(15);
    }
  }

  // ---- WebSocket helpers --------------------------------------------------------------

  function wsUrl(): string {
    return `${env.baseUrl().replace(/^http/, "ws")}/ws`;
  }

  interface Socket {
    ws: WebSocket;
    frames: ServerFrame[];
  }

  async function openSocket(): Promise<Socket> {
    const ws = new WebSocket(wsUrl());
    // Swallow post-open errors so a fatal 1008 close never crashes the runner as an
    // unhandled 'error' event.
    ws.on("error", () => {});
    const frames: ServerFrame[] = [];
    ws.on("message", (data) => {
      // Narrowing a parsed WS frame: the contract guarantees a ServerFrame, and every group
      // that inspects one re-validates it against a schema below.
      frames.push(JSON.parse(String(data)) as ServerFrame);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err instanceof Error ? err : new Error("ws error")));
    });
    return { ws, frames };
  }

  async function waitFor(socket: Socket, predicate: () => boolean, label: string): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > WAIT_TIMEOUT_MS) {
        throw new Error(`timeout waiting for ${label}; saw ${JSON.stringify(socket.frames)}`);
      }
      await sleep(10);
    }
  }

  /** Open a socket and complete the auth handshake up to the `ready` frame. */
  async function authedSocket(token: string): Promise<Socket> {
    const socket = await openSocket();
    socket.ws.send(JSON.stringify({ type: "auth", token }));
    await waitFor(socket, () => socket.frames.some((f) => f.type === "ready"), "ready");
    const ready = framesOfType(socket.frames, "ready")[0];
    if (ready !== undefined) assertValid(ReadyFrameSchema, ready);
    return socket;
  }

  // =====================================================================================

  describe("cozygateway wire contract v1 conformance", () => {
    // Spec section 1 / 5: GET /health is unauthenticated and returns GatewayInfo.
    describe("health", () => {
      it(
        "GET /health returns a GatewayInfo with contract v1, unauthenticated",
        async () => {
          const res = await fetch(`${env.baseUrl()}/health`);
          expect(res.status).toBe(200);
          const info = assertValid(GatewayInfoSchema, await res.json());
          expect(info.contract).toBe("v1");
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5: GatewayInfo.capabilities is an additive v1.x field (issue #16). It rides
    // in three positions (GET /health, the pair response, and the ready frame) as one shared
    // shape. These assertions are deliberately generic, never pinned to any one implementation's
    // own capability ids, so this describe block stays portable across gateways under test: a
    // third-party gateway that advertises no capabilities at all, or a different vendor's ids
    // entirely, still passes.
    describe("capabilities", () => {
      it(
        "GatewayInfo.capabilities, when present, agrees across health, pair, and ready, and is a map of positive-integer versions",
        async () => {
          const health = assertValid(GatewayInfoSchema, await (await fetch(`${env.baseUrl()}/health`)).json());

          const setupCode = await env.issueSetupCode();
          const pairRes = await fetch(`${env.baseUrl()}/pair`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ setupCode, deviceName: "capabilities-reader" }),
          });
          expect(pairRes.status).toBe(200);
          const paired = assertValid(PairResponseSchema, await pairRes.json());

          const socket = await authedSocket(paired.deviceToken);
          try {
            const ready = framesOfType(socket.frames, "ready")[0];
            expect(ready).toBeDefined();
            if (ready === undefined) throw new Error("no ready frame");

            // Absence is valid on any of the three (an older gateway, or one implementation
            // choosing to omit an empty map); the requirement is only internal agreement.
            expect(paired.gateway.capabilities).toEqual(health.capabilities);
            expect(ready.gateway.capabilities).toEqual(health.capabilities);

            if (health.capabilities !== undefined) {
              for (const version of Object.values(health.capabilities)) {
                expect(Number.isInteger(version)).toBe(true);
                expect(version).toBeGreaterThanOrEqual(1);
              }
            }
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      // Pure schema-level checks: no live gateway is required to prove the wire TYPE itself
      // tolerates an absent block and unrecognized ids. This is what makes the field additive:
      // a v1.0 client, or any client that has never heard of a given capability id, keeps
      // working, because GatewayInfo was already an open object and this field changes nothing
      // about the fields that came before it.
      it("the GatewayInfo schema accepts a gateway that predates the capabilities field entirely", () => {
        const legacy = { name: "legacy-gateway", version: "0.9.0", contract: "v1" };
        expect(check(GatewayInfoSchema, legacy)).toBe(true);
      });

      it("the GatewayInfo schema tolerates capability ids a client has never heard of", () => {
        const withUnknown = {
          name: "n",
          version: "1.0.0",
          contract: "v1",
          capabilities: { "com.cozylabs.test": 1, "com.example.totally-unrecognized": 42 },
        };
        expect(check(GatewayInfoSchema, withUnknown)).toBe(true);
      });
    });

    describe("agent inbox (optional com.cozylabs.bots capability 17)", () => {
      const inboxIt = env.botInbox === undefined ? it.skip : it;

      inboxIt(
        "lists a bounded newest-first a2a inbox behind device authentication",
        async () => {
          const fixture = env.botInbox;
          if (fixture === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("bot-inbox-list");
          const path = `/bots/${encodeURIComponent(fixture.botName)}/inbox`;
          const response = await authFetch(token, path);
          expect(response.status).toBe(200);
          const body = assertValid(BotInboxResponseSchema, await response.json());
          expect(body.threads.length).toBeLessThanOrEqual(50);
          expect(body.threads.some((thread) => thread.id === fixture.threadId)).toBe(true);
          for (let index = 1; index < body.threads.length; index += 1) {
            expect(body.threads[index - 1]!.lastActiveAt).toBeGreaterThanOrEqual(
              body.threads[index]!.lastActiveAt,
            );
          }
          expect((await fetch(`${env.baseUrl()}${path}`)).status).toBe(401);
        },
        TEST_TIMEOUT_MS,
      );

      inboxIt(
        "returns a read-only group-room transcript with per-agent attribution",
        async () => {
          const fixture = env.botInbox;
          if (fixture === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("bot-inbox-messages");
          const path =
            `/bots/${encodeURIComponent(fixture.botName)}/inbox/` +
            `${encodeURIComponent(fixture.threadId)}/messages`;
          const response = await authFetch(token, path);
          expect(response.status).toBe(200);
          const body = assertValid(BotInboxMessagesResponseSchema, await response.json());
          expect(body.messages.every((message) => message.from.kind === "member")).toBe(true);
          expect((await authFetch(token, path, { method: "POST" })).status).toBe(404);
          expect((await fetch(`${env.baseUrl()}${path}`)).status).toBe(401);
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("bot model config (optional com.cozylabs.bots capability 18)", () => {
      const modelIt = env.botModelConfig === undefined ? it.skip : it;

      modelIt(
        "reads the fixed live shape behind device auth and rejects an unknown model",
        async () => {
          const fixture = env.botModelConfig;
          if (fixture === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("bot-model-config");
          const path = `/bots/${encodeURIComponent(fixture.botName)}/model-config`;
          const response = await authFetch(token, path);
          expect(response.status).toBe(200);
          const config = assertValid(BotModelConfigSchema, await response.json());
          expect(config.efforts.length).toBeGreaterThan(0);
          expect(new Set(config.catalog.map((entry) => entry.id)).size).toBe(config.catalog.length);
          expect((await fetch(`${env.baseUrl()}${path}`)).status).toBe(401);

          const rejected = await authFetch(token, path, {
            method: "PUT",
            headers: JSON_HEADERS,
            body: JSON.stringify({ model: "conformance:unknown-model-that-must-not-exist" }),
          });
          expect(rejected.status).toBe(400);
          expect(assertValid(ErrorBodySchema, await rejected.json()).error.code).toBe("invalid_request");
        },
        TEST_TIMEOUT_MS,
      );
    });

    describe("bot chat hard stop (optional com.cozylabs.bots capability 19)", () => {
      const stopIt = env.botChatStop === undefined ? it.skip : it;

      stopIt(
        "requires a device, 409s while idle, interrupts a live turn, and broadcasts complete",
        async () => {
          const fixture = env.botChatStop;
          if (fixture === undefined) throw new Error("unreachable: skipped without hook");
          const botName = fixture.botName.trim().toLowerCase();
          const path = `/bots/${encodeURIComponent(fixture.botName)}/chat/stop`;
          expect((await fetch(`${env.baseUrl()}${path}`, { method: "POST" })).status).toBe(401);

          const { token } = await pairDevice("bot-chat-stop");
          expect((await authFetch(token, path, { method: "POST" })).status).toBe(409);
          const socket = await authedSocket(token);
          try {
            const sent = await authFetch(
              token,
              `/bots/${encodeURIComponent(fixture.botName)}/chat/messages`,
              {
                method: "POST",
                headers: JSON_HEADERS,
                body: JSON.stringify({ text: fixture.prompt ?? "wait until I stop this turn" }),
              },
            );
            expect(sent.status).toBe(202);
            await waitFor(
              socket,
              () =>
                framesOfType(socket.frames, "bot_chat_state").some(
                  (frame) => frame.bot === botName && frame.phase === "polling",
                ),
              "bot chat polling",
            );

            const stopped = await authFetch(token, path, { method: "POST" });
            expect(stopped.status).toBe(200);
            assertValid(BotChatStopResponseSchema, await stopped.json());
            await waitFor(
              socket,
              () =>
                framesOfType(socket.frames, "bot_chat_state").some(
                  (frame) =>
                    frame.bot === botName &&
                    frame.phase === "complete" &&
                    frame.running === false &&
                    frame.inflight === false,
                ),
              "bot chat complete after stop",
            );
            expect((await authFetch(token, path, { method: "POST" })).status).toBe(409);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 4: pairing binds a device and mints a single-use-consuming token.
    describe("pairing", () => {
      it(
        "a valid setup code pairs and returns a PairResponse",
        async () => {
          const setupCode = await env.issueSetupCode();
          const res = await fetch(`${env.baseUrl()}/pair`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ setupCode, deviceName: "pair-ok" }),
          });
          expect(res.status).toBe(200);
          const paired = assertValid(PairResponseSchema, await res.json());
          expect(paired.gateway.contract).toBe("v1");
          expect(paired.deviceToken.length).toBeGreaterThan(0);
          expect(paired.device.name).toBe("pair-ok");
          expect(paired.device.lastSeenAt).toBeNull();
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "a setup code is single-use: the second pair with it is 401 setup_code_invalid",
        async () => {
          const setupCode = await env.issueSetupCode();
          const body = JSON.stringify({ setupCode, deviceName: "first-then-reuse" });
          const first = await fetch(`${env.baseUrl()}/pair`, { method: "POST", headers: JSON_HEADERS, body });
          expect(first.status).toBe(200);
          const second = await fetch(`${env.baseUrl()}/pair`, { method: "POST", headers: JSON_HEADERS, body });
          expect(second.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await second.json()).error.code).toBe("setup_code_invalid");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "a garbage setup code is 401 setup_code_invalid",
        async () => {
          const res = await fetch(`${env.baseUrl()}/pair`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ setupCode: "definitely-not-a-real-code", deviceName: "garbage" }),
          });
          expect(res.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("setup_code_invalid");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "a malformed pair body is 400 invalid_request",
        async () => {
          const res = await fetch(`${env.baseUrl()}/pair`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ deviceName: "missing setup code" }),
          });
          expect(res.status).toBe(400);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("invalid_request");
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 1: only GET /health and POST /pair are unauthenticated; everything else
    // returns `unauthorized` without a valid device token.
    describe("auth wall", () => {
      for (const path of ["/devices", "/agents", "/threads"]) {
        it(
          `GET ${path} without a token is 401 unauthorized`,
          async () => {
            const res = await fetch(`${env.baseUrl()}${path}`);
            expect(res.status).toBe(401);
            expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("unauthorized");
          },
          TEST_TIMEOUT_MS,
        );
      }
    });

    // Spec section 3: `not_found` means "no such resource (device, thread, agent, message)".
    // A request naming a nonexistent thread resolves to that code, not a validation error.
    describe("not found", () => {
      it(
        "GET messages of a nonexistent thread is 404 not_found",
        async () => {
          const { token } = await pairDevice("not-found-reader");
          const res = await authFetch(token, "/threads/no-such-thread-id/messages");
          expect(res.status).toBe(404);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("not_found");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "PATCH rename of a nonexistent thread is 404 not_found",
        async () => {
          const { token } = await pairDevice("not-found-renamer");
          const res = await authFetch(token, "/threads/no-such-thread-id", {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ title: "rename a ghost" }),
          });
          expect(res.status).toBe(404);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("not_found");
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 4: DELETE /devices/:id revokes at once; the revoked token stops working
    // while other devices are unaffected.
    describe("device lifecycle", () => {
      it(
        "lists paired devices and revocation kills exactly one token",
        async () => {
          const a = await pairDevice("device-a");
          const b = await pairDevice("device-b");

          const listed = assertArray(await (await authFetch(a.token, "/devices")).json(), "devices").map(
            (d) => assertValid(DeviceSchema, d),
          );
          const ids = listed.map((d) => d.id);
          expect(ids).toContain(a.deviceId);
          expect(ids).toContain(b.deviceId);

          const del = await authFetch(a.token, `/devices/${b.deviceId}`, { method: "DELETE" });
          expect(del.status).toBe(200);

          const bAfter = await authFetch(b.token, "/devices");
          expect(bAfter.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await bAfter.json()).error.code).toBe("unauthorized");

          const aAfter = await authFetch(a.token, "/devices");
          expect(aAfter.status).toBe(200);
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5: GET /agents lists Agent objects with a PresenceState.
    describe("agents", () => {
      it(
        "GET /agents contains the echo agent with a valid presence",
        async () => {
          const { token } = await pairDevice("agents-reader");
          const agents = assertArray(await (await authFetch(token, "/agents")).json(), "agents").map((a) =>
            assertValid(AgentSchema, a),
          );
          const echo = agents.find((a) => a.id === env.echoAgentId);
          expect(echo).toBeDefined();
          // The schema already constrained presence to the closed PresenceState union.
          expect(["online", "absent", "unknown"]).toContain(echo?.presence);
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5: create / rename / archive. An archived thread is hidden from GET
    // /threads, stays readable through its messages, and rejects new sends with thread_archived.
    describe("thread lifecycle", () => {
      it(
        "creates, renames, archives; archived thread hidden but readable and rejects sends",
        async () => {
          const { token } = await pairDevice("thread-lifecycle");
          const thread = await createThread(token, "Original title");

          const renameRes = await authFetch(token, `/threads/${thread.id}`, {
            method: "PATCH",
            headers: JSON_HEADERS,
            body: JSON.stringify({ title: "Renamed title" }),
          });
          expect(renameRes.status).toBe(200);
          expect(assertValid(ThreadSchema, await renameRes.json()).title).toBe("Renamed title");

          // Give the thread readable history before archiving.
          await sendMessage(token, thread.id, "a message before archive");
          await waitForMessageCount(token, thread.id, 1);

          const archiveRes = await authFetch(token, `/threads/${thread.id}`, { method: "DELETE" });
          expect(archiveRes.status).toBe(200);

          const threads = assertArray(await (await authFetch(token, "/threads")).json(), "threads").map((t) =>
            assertValid(ThreadSchema, t),
          );
          expect(threads.some((t) => t.id === thread.id)).toBe(false);

          // Messages of an archived thread stay readable.
          expect((await listMessages(token, thread.id)).length).toBeGreaterThanOrEqual(1);

          const blocked = await authFetch(token, `/threads/${thread.id}/messages`, {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ blocks: [{ type: "paragraph", text: "after archive" }] }),
          });
          expect(blocked.status).toBe(409);
          expect(assertValid(ErrorBodySchema, await blocked.json()).error.code).toBe("thread_archived");
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5 + 6 seq semantics: per-thread seq is gapless, starts at 1, allocated in
    // commit order. GET /messages returns ascending pages; `before`/`limit` page backward.
    describe("message round trip and seq discipline", () => {
      it(
        "commits users and agent echoes with strictly increasing gapless seq, and pages correctly",
        async () => {
          const { token } = await pairDevice("round-trip");
          const thread = await createThread(token, "seq discipline");
          const socket = await authedSocket(token);
          try {
            for (const text of ["one", "two", "three"]) {
              const doneBefore = framesOfType(socket.frames, "done").length;
              await sendMessage(token, thread.id, text);
              await waitFor(
                socket,
                () => framesOfType(socket.frames, "done").length > doneBefore,
                `done for "${text}"`,
              );
            }
            const commits = framesOfType(socket.frames, "committed");
            for (const c of commits) assertValid(CommittedFrameSchema, c);
            expect(commits.map((c) => c.message.role)).toEqual([
              "user",
              "agent",
              "user",
              "agent",
              "user",
              "agent",
            ]);
            const seqs = commits.map((c) => c.seq);
            expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
            expect(isStrictlyAscending(seqs)).toBe(true);
            // Each committed frame's own seq matches the message it carries.
            for (const c of commits) expect(c.message.seq).toBe(c.seq);
          } finally {
            socket.ws.close();
          }

          // Pagination (spec section 5): ascending within a page; newest page when `before`
          // is omitted; `before`+`limit` returns the <limit> newest messages below `before`.
          expect((await listMessages(token, thread.id, "?limit=2")).map((m) => m.seq)).toEqual([5, 6]);
          expect((await listMessages(token, thread.id, "?before=5&limit=2")).map((m) => m.seq)).toEqual([3, 4]);
          expect((await listMessages(token, thread.id, "?before=3")).map((m) => m.seq)).toEqual([1, 2]);
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 6: auth is the first frame; a good token yields `ready`; a bad token is a
    // fatal 1008 close (no error frame); sync from high-water 0 replays every committed
    // message ascending then `synced`.
    describe("websocket lifecycle", () => {
      it(
        "auths to ready, rejects a bad token with a 1008 close, and replays from high-water 0",
        async () => {
          const { token } = await pairDevice("ws-lifecycle");
          const thread = await createThread(token, "ws lifecycle");

          // Seed two turns (four committed messages) over a first socket.
          const seeder = await authedSocket(token);
          try {
            await sendMessage(token, thread.id, "seed one");
            await waitFor(seeder, () => framesOfType(seeder.frames, "done").length >= 1, "first done");
            await sendMessage(token, thread.id, "seed two");
            await waitFor(seeder, () => framesOfType(seeder.frames, "done").length >= 2, "second done");
          } finally {
            seeder.ws.close();
          }

          // A bad auth token is a fatal 1008 close, not an error frame (spec section 3).
          const bad = await openSocket();
          const badClose = new Promise<number>((resolve) => bad.ws.once("close", (code) => resolve(code)));
          bad.ws.send(JSON.stringify({ type: "auth", token: "not-a-valid-token" }));
          expect(await badClose).toBe(1008);

          // Sync from 0 replays every committed message ascending, then synced.
          const reader = await authedSocket(token);
          try {
            reader.ws.send(JSON.stringify({ type: "sync", threads: { [thread.id]: 0 } }));
            await waitFor(reader, () => reader.frames.some((f) => f.type === "synced"), "synced");
            const syncedFrame = framesOfType(reader.frames, "synced")[0];
            if (syncedFrame !== undefined) assertValid(SyncedFrameSchema, syncedFrame);

            const commits = framesOfType(reader.frames, "committed");
            const seqs = commits.map((c) => c.seq);
            expect(seqs).toEqual([1, 2, 3, 4]);
            expect(isStrictlyAscending(seqs)).toBe(true);

            // `synced` lands after every replayed commit.
            const syncedIdx = reader.frames.findIndex((f) => f.type === "synced");
            const lastCommitIdx = reader.frames.map((f) => f.type).lastIndexOf("committed");
            expect(syncedIdx).toBeGreaterThan(lastCommitIdx);
          } finally {
            reader.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      // Spec section 8: "The gateway answers an unknown or malformed CLIENT frame with an
      // `error` frame." The frame is non-fatal (section 3): the socket stays open and usable.
      it(
        "answers an unknown client frame with an error frame and keeps the socket open",
        async () => {
          const { token } = await pairDevice("ws-unknown-frame");
          const thread = await createThread(token, "unknown client frame");
          const socket = await authedSocket(token);
          try {
            socket.ws.send(JSON.stringify({ type: "bogus" }));
            await waitFor(socket, () => socket.frames.some((f) => f.type === "error"), "error frame");
            const errorFrame = socket.frames.find((f) => f.type === "error");
            assertValid(ErrorFrameSchema, errorFrame);

            // The socket survived: a follow-up sync round trip still completes.
            socket.ws.send(JSON.stringify({ type: "sync", threads: { [thread.id]: 0 } }));
            await waitFor(socket, () => socket.frames.some((f) => f.type === "synced"), "synced");
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5: POST /push/register accepts a PushRegisterRequest from a paired device.
    // The contract freezes the request shape; the response is only required to succeed.
    describe("push registration", () => {
      it(
        "POST /push/register accepts a valid registration",
        async () => {
          const { token } = await pairDevice("push-registrar");
          const res = await authFetch(token, "/push/register", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({
              pushId: "push-1",
              relayUrl: "https://relay.example.com",
              pushKey: "0123456789abcdef",
            }),
          });
          expect(res.ok).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "a malformed push registration is 400 invalid_request",
        async () => {
          const { token } = await pairDevice("push-malformed");
          const res = await authFetch(token, "/push/register", {
            method: "POST",
            headers: JSON_HEADERS,
            body: JSON.stringify({ pushId: "push-1" }),
          });
          expect(res.status).toBe(400);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("invalid_request");
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 6 + 7: for one turn the order is user committed, one-or-more drafts (the
    // reference backend emits exactly two), the agent commit, then done. No draft may follow
    // the commit for that turn.
    describe("streaming order", () => {
      it(
        "streams a turn as committed(user), drafts, committed(agent), done in order",
        async () => {
          const { token } = await pairDevice("streaming");
          const thread = await createThread(token, "streaming");
          const socket = await authedSocket(token);
          try {
            const text = "streamed hello";
            await sendMessage(token, thread.id, text);
            await waitFor(socket, () => framesOfType(socket.frames, "done").length >= 1, "done");

            // Every server frame is a valid ServerFrame.
            for (const f of socket.frames) assertValid(ServerFrameSchema, f);

            const drafts = framesOfType(socket.frames, "draft");
            const firstDraft = drafts[0];
            expect(firstDraft).toBeDefined();
            if (firstDraft === undefined) throw new Error("no draft frame");
            const turnId = firstDraft.turnId;

            const turnDrafts = drafts.filter((d) => d.turnId === turnId);
            for (const d of turnDrafts) assertValid(DraftFrameSchema, d);
            // Contract section 7 freezes the reference echo backend at exactly two drafts.
            expect(turnDrafts.length).toBe(2);

            const agentCommit = framesOfType(socket.frames, "committed").find(
              (c) => c.message.role === "agent",
            );
            expect(agentCommit).toBeDefined();
            expect(agentCommit?.message.blocks).toEqual([{ type: "paragraph", text: `Echo: ${text}` }]);
            expect(agentCommit?.message.turnId).toBe(turnId);

            // Ordering: user commit < first draft; last draft < agent commit; agent commit < done.
            const types = socket.frames.map((f) => f.type);
            const userCommitIdx = socket.frames.findIndex(
              (f) => f.type === "committed" && f.message.role === "user",
            );
            const agentCommitIdx = socket.frames.findIndex(
              (f) => f.type === "committed" && f.message.role === "agent",
            );
            const firstDraftIdx = types.indexOf("draft");
            const lastDraftIdx = types.lastIndexOf("draft");
            const doneIdx = socket.frames.findIndex((f) => f.type === "done" && f.turnId === turnId);

            expect(userCommitIdx).toBeGreaterThanOrEqual(0);
            expect(firstDraftIdx).toBeGreaterThan(userCommitIdx);
            expect(agentCommitIdx).toBeGreaterThan(lastDraftIdx);
            expect(doneIdx).toBeGreaterThan(agentCommitIdx);

            // No draft for this turn arrives after its commit.
            const draftIdxAfterCommit = socket.frames.findIndex(
              (f, i) => f.type === "draft" && f.turnId === turnId && i > agentCommitIdx,
            );
            expect(draftIdxAfterCommit).toBe(-1);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 6 reconnect: after a drop, sync from the high-water mark replays only the
    // missed committed messages, in seq order; nothing is replayed twice; drafts are not replayed.
    describe("reconnect dedup", () => {
      it(
        "replays only the committed frames missed while disconnected",
        async () => {
          const { token } = await pairDevice("reconnect");
          const thread = await createThread(token, "reconnect");

          const first = await authedSocket(token);
          let highWater = 0;
          try {
            await sendMessage(token, thread.id, "before disconnect");
            await waitFor(first, () => framesOfType(first.frames, "done").length >= 1, "done");
            highWater = Math.max(...framesOfType(first.frames, "committed").map((c) => c.seq));
          } finally {
            first.ws.close();
          }
          expect(highWater).toBe(2);

          // Disconnected: a new message + echo commit durably (four messages total).
          await sendMessage(token, thread.id, "while disconnected");
          await waitForMessageCount(token, thread.id, 4);

          const reconnected = await authedSocket(token);
          try {
            reconnected.ws.send(JSON.stringify({ type: "sync", threads: { [thread.id]: highWater } }));
            await waitFor(reconnected, () => reconnected.frames.some((f) => f.type === "synced"), "synced");
            const seqs = framesOfType(reconnected.frames, "committed").map((c) => c.seq);
            // Exactly the missed user + agent commit, nothing at or below the mark.
            expect(seqs).toEqual([3, 4]);
          } finally {
            reconnected.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 7 + section 6 reconnect prose: a [[fail]] turn completes as a committed
    // system message carrying marker "turn.failed" plus a turn_failed error frame, with no
    // done frame; the thread stays usable afterward.
    // Note: the "no done frame" and "turn_failed error frame" assertions extend beyond the
    // literal section 7 text and are scoped to the reference backend's frozen behavior.
    describe("turn failure", () => {
      it(
        "fails a [[fail]] turn with a turn.failed system commit and a turn_failed error, staying usable",
        async () => {
          const { token } = await pairDevice("turn-failure");
          const thread = await createThread(token, "turn failure");
          const socket = await authedSocket(token);
          try {
            await sendMessage(token, thread.id, "[[fail]] please");

            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "error" && f.code === "turn_failed"),
              "turn_failed error frame",
            );
            await waitFor(
              socket,
              () =>
                framesOfType(socket.frames, "committed").some(
                  (c) => c.message.role === "system" && c.message.marker === "turn.failed",
                ),
              "turn.failed system commit",
            );

            const errorFrame = socket.frames.find((f) => f.type === "error");
            assertValid(ErrorFrameSchema, errorFrame);

            const systemCommit = framesOfType(socket.frames, "committed").find(
              (c) => c.message.role === "system",
            );
            expect(systemCommit?.message.marker).toBe("turn.failed");
            const failedTurnId = systemCommit?.message.turnId;
            expect(failedTurnId).toBeDefined();

            // A failed turn emits no done frame (spec section 7 mock semantics).
            expect(socket.frames.some((f) => f.type === "done" && f.turnId === failedTurnId)).toBe(false);

            // The thread stays usable: a follow-up echoes normally.
            const doneBefore = framesOfType(socket.frames, "done").length;
            await sendMessage(token, thread.id, "recover");
            await waitFor(
              socket,
              () => framesOfType(socket.frames, "done").length > doneBefore,
              "recovery done",
            );
            const recovered = framesOfType(socket.frames, "committed").find(
              (c) => c.message.role === "agent",
            );
            expect(recovered?.message.blocks).toEqual([{ type: "paragraph", text: "Echo: recover" }]);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5: POST /threads/:id/interrupt. On an idle thread it is a no-op returning 204;
    // auth is required exactly as for every other route. Steer behavior is out of scope for the
    // portable suite (the reference echo backend is queue-only), so only the contract-level shape
    // and the idle no-op are asserted here.
    describe("mid-turn interrupt", () => {
      it(
        "POST interrupt without a token is 401 unauthorized",
        async () => {
          const res = await fetch(`${env.baseUrl()}/threads/anything/interrupt`, { method: "POST" });
          expect(res.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("unauthorized");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "POST interrupt on a nonexistent thread is 404 not_found",
        async () => {
          const { token } = await pairDevice("interrupt-404");
          const res = await authFetch(token, "/threads/no-such-thread/interrupt", { method: "POST" });
          expect(res.status).toBe(404);
          expect(assertValid(ErrorBodySchema, await res.json()).error.code).toBe("not_found");
        },
        TEST_TIMEOUT_MS,
      );

      it(
        "POST interrupt on an idle thread is 204 with no body",
        async () => {
          const { token } = await pairDevice("interrupt-idle");
          const thread = await createThread(token, "idle interrupt");
          const res = await authFetch(token, `/threads/${thread.id}/interrupt`, { method: "POST" });
          expect(res.status).toBe(204);
          expect(await res.text()).toBe("");
        },
        TEST_TIMEOUT_MS,
      );

      it("the InterruptResponse and delivery shapes are valid additive v1.x contract types", () => {
        // Pure schema checks: no backend dependency. A v1.0 client that predates delivery keeps
        // working because MessageSchema stays OPEN, and the 202 body shape is fixed.
        expect(check(InterruptResponseSchema, { status: "interrupting" })).toBe(true);
        const userMsg = {
          threadId: "t",
          seq: 1,
          role: "user" as const,
          blocks: [{ type: "paragraph", text: "x" }],
          delivery: "steer" as const,
          createdAt: 0,
        };
        expect(check(MessageSchema, userMsg)).toBe(true);
        const { delivery: _drop, ...withoutDelivery } = userMsg;
        expect(check(MessageSchema, withoutDelivery)).toBe(true);
      });
    });

    // Spec section 5, POST /threads/:id/interrupt, 202 path: "when a turn was in flight and the
    // interrupt was dispatched to the backend. For a steer-capable backend the turn ends as a
    // committed system message with `marker: "turn.interrupted"` followed by a `done` frame."
    //
    // The group above can only schema-check that body, because the reference echo backend is
    // queue-only: it finishes a turn immediately, so no in-flight window exists to interrupt.
    // This group drives the real thing, and therefore needs the OPTIONAL stall hook
    // (`ConformanceEnv.stallAgentId`, issue #21): an agent whose backend stalls in flight after
    // one draft and honors a hard interrupt. A gateway that declares no such agent skips this
    // group and is held to exactly what it was held to before the hook existed.
    describe("mid-turn interrupt, live 202 (requires the stall hook)", () => {
      const stallAgentId = env.stallAgentId;
      // `it.skip` rather than an empty describe: a skipped-and-named case in the report is the
      // honest signal that this gateway declared no stall backend, not that the case vanished.
      const liveIt = stallAgentId === undefined ? it.skip : it;

      liveIt(
        "interrupting an in-flight turn is 202 {status:interrupting}, then turn.interrupted then done",
        async () => {
          if (stallAgentId === undefined) throw new Error("unreachable: skipped without stall hook");
          const { token } = await pairDevice("interrupt-live");
          const thread = await createThreadWith(token, stallAgentId, "live interrupt");
          const socket = await authedSocket(token);
          try {
            await sendMessage(token, thread.id, "a long task");

            // The hook's contract: at least one draft, and then the turn stays in flight.
            await waitFor(
              socket,
              () => framesOfType(socket.frames, "draft").some((d) => d.threadId === thread.id),
              "draft from the stall backend",
            );
            const draft = framesOfType(socket.frames, "draft").find((d) => d.threadId === thread.id);
            if (draft === undefined) throw new Error("no draft frame");
            assertValid(DraftFrameSchema, draft);
            const turnId = draft.turnId;

            // The in-flight window is real: nothing has finished this turn yet.
            expect(socket.frames.some((f) => f.type === "done" && f.turnId === turnId)).toBe(false);
            expect(
              framesOfType(socket.frames, "committed").some(
                (c) => c.threadId === thread.id && c.message.role === "agent",
              ),
            ).toBe(false);

            const res = await authFetch(token, `/threads/${thread.id}/interrupt`, { method: "POST" });
            expect(res.status).toBe(202);
            const body = assertValid(InterruptResponseSchema, await res.json());
            expect(body.status).toBe("interrupting");

            // The turn ends as a turn.interrupted system commit, THEN a done frame for that turn.
            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "done" && f.turnId === turnId),
              "done for the interrupted turn",
            );
            const systemCommit = framesOfType(socket.frames, "committed").find(
              (c) => c.threadId === thread.id && c.message.role === "system",
            );
            expect(systemCommit).toBeDefined();
            if (systemCommit === undefined) throw new Error("no system commit");
            assertValid(CommittedFrameSchema, systemCommit);
            expect(systemCommit.message.marker).toBe("turn.interrupted");
            expect(systemCommit.message.turnId).toBe(turnId);

            const doneFrame = socket.frames.find((f) => f.type === "done" && f.turnId === turnId);
            assertValid(DoneFrameSchema, doneFrame);
            const systemIdx = socket.frames.indexOf(systemCommit);
            const doneIdx = socket.frames.findIndex((f) => f.type === "done" && f.turnId === turnId);
            expect(doneIdx).toBeGreaterThan(systemIdx);

            // A deliberate interrupt is not a failure: no error frame for this thread, and in
            // particular not turn_failed or interrupt_unsupported.
            const errors = framesOfType(socket.frames, "error").filter(
              (e) => e.threadId === undefined || e.threadId === thread.id,
            );
            expect(errors).toEqual([]);

            // The outcome is durable, not just a broadcast: the system message is in history.
            const history = await listMessages(token, thread.id);
            expect(history.some((m) => m.role === "system" && m.marker === "turn.interrupted")).toBe(
              true,
            );
            expect(history.some((m) => m.role === "agent")).toBe(false);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      liveIt(
        "the thread is idle again after the interrupt: a second interrupt is 204",
        async () => {
          if (stallAgentId === undefined) throw new Error("unreachable: skipped without stall hook");
          const { token } = await pairDevice("interrupt-live-then-idle");
          const thread = await createThreadWith(token, stallAgentId, "interrupt then idle");
          const socket = await authedSocket(token);
          try {
            await sendMessage(token, thread.id, "another long task");
            await waitFor(
              socket,
              () => framesOfType(socket.frames, "draft").some((d) => d.threadId === thread.id),
              "draft from the stall backend",
            );
            const first = await authFetch(token, `/threads/${thread.id}/interrupt`, { method: "POST" });
            expect(first.status).toBe(202);
            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "done" && f.threadId === thread.id),
              "done for the interrupted turn",
            );

            const second = await authFetch(token, `/threads/${thread.id}/interrupt`, { method: "POST" });
            expect(second.status).toBe(204);
            expect(await second.text()).toBe("");
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );
    });

    // Spec section 5a: the approval lifecycle (approval_pending / approval_resolved frames plus
    // the approve/deny verbs). Like the live-202 group above, it can only be driven against a
    // backend that actually parks on an approval, so it rides the OPTIONAL approval hook
    // (`ConformanceEnv.approvalAgentId`, issue #19). A gateway that declares no such agent skips
    // this group and is held to exactly what it was held to before the hook existed.
    describe("approval lifecycle (requires the approval hook)", () => {
      const approvalAgentId = env.approvalAgentId;
      // it.skip rather than an empty describe, for the same reason as the stall hook: a named,
      // skipped case is the honest report that this gateway declared no approval backend.
      const approvalIt = approvalAgentId === undefined ? it.skip : it;

      /** Send into an approval thread and return the pending frame the backend raises. */
      async function raiseApproval(
        token: string,
        threadId: string,
        socket: Socket,
      ): Promise<{ toolCallId: string; turnId: string }> {
        await sendMessage(token, threadId, "do something dangerous");
        await waitFor(
          socket,
          () =>
            socket.frames.some((f) => f.type === "approval_pending" && f.threadId === threadId),
          "approval_pending",
        );
        const frame = socket.frames.find(
          (f) => f.type === "approval_pending" && f.threadId === threadId,
        );
        const valid = assertValid(ApprovalPendingFrameSchema, frame);
        expect(valid.toolCallId.length).toBeGreaterThan(0);
        expect(valid.name.length).toBeGreaterThan(0);
        // The turn is genuinely parked on the decision: nothing has ended it.
        expect(socket.frames.some((f) => f.type === "done" && f.turnId === valid.turnId)).toBe(false);
        return { toolCallId: valid.toolCallId, turnId: valid.turnId };
      }

      approvalIt(
        "a pending approval is announced on the live channel, with a turnId, a toolCallId and a tool name",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("approval-pending");
          const thread = await createThreadWith(token, approvalAgentId, "pending approval");
          const socket = await authedSocket(token);
          try {
            const { turnId } = await raiseApproval(token, thread.id, socket);
            const draft = framesOfType(socket.frames, "draft").find((d) => d.threadId === thread.id);
            // The approval belongs to the turn that raised it, not to some other identifier.
            if (draft !== undefined) expect(draft.turnId).toBe(turnId);

            // An approval is live-channel only: it never lands in durable history.
            const history = await listMessages(token, thread.id);
            expect(history.every((m) => m.role !== "agent")).toBe(true);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      approvalIt(
        "approve is 202 {status:approved} and produces one approval_resolved(approved)",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("approval-approve");
          const thread = await createThreadWith(token, approvalAgentId, "approve");
          const socket = await authedSocket(token);
          try {
            const { toolCallId, turnId } = await raiseApproval(token, thread.id, socket);
            const res = await authFetch(
              token,
              `/threads/${thread.id}/approvals/${toolCallId}/approve`,
              { method: "POST" },
            );
            expect(res.status).toBe(202);
            expect(assertValid(ApprovalResolveResponseSchema, await res.json()).status).toBe(
              "approved",
            );

            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "approval_resolved"),
              "approval_resolved",
            );
            const resolved = socket.frames.filter((f) => f.type === "approval_resolved");
            expect(resolved).toHaveLength(1);
            const valid = assertValid(ApprovalResolvedFrameSchema, resolved[0]);
            expect(valid).toMatchObject({
              threadId: thread.id,
              turnId,
              toolCallId,
              outcome: "approved",
            });
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      approvalIt(
        "deny is 202 {status:denied} and produces one approval_resolved(denied)",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("approval-deny");
          const thread = await createThreadWith(token, approvalAgentId, "deny");
          const socket = await authedSocket(token);
          try {
            const { toolCallId } = await raiseApproval(token, thread.id, socket);
            const res = await authFetch(token, `/threads/${thread.id}/approvals/${toolCallId}/deny`, {
              method: "POST",
            });
            expect(res.status).toBe(202);
            expect(assertValid(ApprovalResolveResponseSchema, await res.json()).status).toBe("denied");

            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "approval_resolved"),
              "approval_resolved",
            );
            const resolved = socket.frames.filter((f) => f.type === "approval_resolved");
            expect(resolved).toHaveLength(1);
            expect(assertValid(ApprovalResolvedFrameSchema, resolved[0]).outcome).toBe("denied");
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      approvalIt(
        "resolving the same approval twice is 409 approval_not_pending, with no second frame",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("approval-twice");
          const thread = await createThreadWith(token, approvalAgentId, "twice");
          const socket = await authedSocket(token);
          try {
            const { toolCallId } = await raiseApproval(token, thread.id, socket);
            const first = await authFetch(
              token,
              `/threads/${thread.id}/approvals/${toolCallId}/approve`,
              { method: "POST" },
            );
            expect(first.status).toBe(202);
            await waitFor(
              socket,
              () => socket.frames.some((f) => f.type === "approval_resolved"),
              "approval_resolved",
            );

            const second = await authFetch(
              token,
              `/threads/${thread.id}/approvals/${toolCallId}/deny`,
              { method: "POST" },
            );
            expect(second.status).toBe(409);
            expect(assertValid(ErrorBodySchema, await second.json()).error.code).toBe(
              "approval_not_pending",
            );
            expect(socket.frames.filter((f) => f.type === "approval_resolved")).toHaveLength(1);
          } finally {
            socket.ws.close();
          }
        },
        TEST_TIMEOUT_MS,
      );

      approvalIt(
        "an unknown toolCallId is 404 not_found, and an unauthenticated resolve is 401",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const { token } = await pairDevice("approval-unknown");
          const thread = await createThreadWith(token, approvalAgentId, "unknown call");

          const unknown = await authFetch(
            token,
            `/threads/${thread.id}/approvals/no-such-call/approve`,
            { method: "POST" },
          );
          expect(unknown.status).toBe(404);
          expect(assertValid(ErrorBodySchema, await unknown.json()).error.code).toBe("not_found");

          const unauthed = await fetch(
            `${env.baseUrl()}/threads/${thread.id}/approvals/no-such-call/deny`,
            { method: "POST" },
          );
          expect(unauthed.status).toBe(401);
          expect(assertValid(ErrorBodySchema, await unauthed.json()).error.code).toBe("unauthorized");
        },
        TEST_TIMEOUT_MS,
      );

      approvalIt(
        "the gateway advertises the approvals capability it implements",
        async () => {
          if (approvalAgentId === undefined) throw new Error("unreachable: skipped without hook");
          const info = assertValid(
            GatewayInfoSchema,
            await (await fetch(`${env.baseUrl()}/health`)).json(),
          );
          expect(info.capabilities?.[APPROVALS_CAPABILITY_ID]).toBe(APPROVALS_CAPABILITY_VERSION);
        },
        TEST_TIMEOUT_MS,
      );
    });
  });
}

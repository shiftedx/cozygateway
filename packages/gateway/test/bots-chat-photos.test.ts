import { afterEach, describe, expect, it } from "vitest";
import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { CANONICAL_CHAT_TITLE } from "../src/hermes-bridge/canonical-chat.ts";
import { BotChatTurns, type ChatAttachmentStore } from "../src/hermes-bridge/chat-turns.ts";
import { mapChatMessage, stripImageDirectives } from "../src/hermes-bridge/chat-messages.ts";
import { createMediaLimiter } from "../src/hermes-bridge/media.ts";
import {
  PHOTO_DEFAULT_PROMPT,
  PHOTO_MAX_BYTES,
  PHOTO_TTL_MS,
  PhotoRefused,
  acceptPhoto,
  createPhotoRateLimiter,
  isPhotoFileId,
  newPhotoFileId,
  photoDisplayName,
  readCappedBody,
  sniffImageType,
} from "../src/hermes-bridge/photos.ts";
import { startFakeHermesServer, type FakeHermesBehavior, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Photos to bots, capability 9 (contract/ext-bots-v1.md).
 *
 *  Four layers, kept apart on purpose, mirroring how capability 7 split its own tests:
 *
 *  1. The INBOUND RULES are pure and are tested with no socket and no database, because they are the
 *     whole of what stands between a device's multipart body and both this gateway's disk and a
 *     model's context. A rule that only holds when a fake server cooperates is not a rule.
 *  2. TRANSCRIPT HYGIENE is tested on the decoder, because "no host path ever reaches a device" is a
 *     property of one function and deserves to be pinned there rather than inferred from a response.
 *  3. The RPC ORDER is tested on the turn loop with a stubbed hermes, because the guarantee is
 *     negative ("no submit happened") and the cleanest way to prove a call did not happen is to hold
 *     the list of calls.
 *  4. The ROUTES are tested through the real app against a fake hermes, for the status mapping, the
 *     headers, and the round trip from send to download. */

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

/** A one-pixel-ish PNG: the signature plus enough filler that nothing downstream cares. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const BMP = new Uint8Array([0x42, 0x4d, 30, 0, 0, 0, 0, 0]);
/** The HEIC box header an iPhone actually writes. Not on any list here, by design. */
const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);

describe("inbound photo rules", () => {
  it("sniffs every accepted format from its leading bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
    expect(sniffImageType(BMP)).toBe("image/bmp");
    // The formats a phone will try and this gateway will not carry.
    expect(sniffImageType(HEIC)).toBeUndefined();
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='...'></svg>"))).toBeUndefined();
  });

  it("accepts each allowed type and reports the type the BYTES are", () => {
    for (const [bytes, mime, ext] of [
      [PNG, "image/png", "png"],
      [JPEG, "image/jpeg", "jpg"],
      [GIF, "image/gif", "gif"],
      [WEBP, "image/webp", "webp"],
      [BMP, "image/bmp", "bmp"],
    ] as const) {
      expect(acceptPhoto({ declaredType: mime, declaredLength: bytes.byteLength, bytes })).toEqual({
        mime,
        ext,
        size: bytes.byteLength,
      });
    }
  });

  it("refuses the formats hermes will not take, and says what to do about it", () => {
    for (const type of ["image/heic", "image/heif", "image/avif", "image/tiff"]) {
      const err = grab(() => acceptPhoto({ declaredType: type, declaredLength: 12, bytes: HEIC }));
      expect(err).toBeInstanceOf(PhotoRefused);
      expect((err as PhotoRefused).reason).toBe("content_type");
      // The message is the whole point of listing these separately: "convert this" is actionable and
      // "these bytes are not an image" is not.
      expect((err as PhotoRefused).message).toMatch(/convert/i);
    }
  });

  it("refuses svg with its own reason, and never on an image/* prefix test", () => {
    const err = grab(() =>
      acceptPhoto({ declaredType: "image/svg+xml", declaredLength: 20, bytes: new TextEncoder().encode("<svg/>") }),
    );
    expect((err as PhotoRefused).reason).toBe("content_type");
    expect((err as PhotoRefused).message).toMatch(/script/i);
  });

  it("does not believe the declared type: bytes decide, and a disagreement is refused", () => {
    // The exact attack the sniff exists for: a HEIC (or anything else) wearing a png label.
    const lying = grab(() => acceptPhoto({ declaredType: "image/png", declaredLength: 12, bytes: HEIC }));
    expect((lying as PhotoRefused).reason).toBe("content_type");
    // And the mirror image: real png bytes claiming to be a jpeg. Refused rather than resolved in the
    // sender's favour, because a client that disagrees with itself has a bug or an intent.
    const mismatched = grab(() =>
      acceptPhoto({ declaredType: "image/jpeg", declaredLength: PNG.byteLength, bytes: PNG }),
    );
    expect((mismatched as PhotoRefused).message).toMatch(/declared image\/jpeg but its bytes are image\/png/);
    // With no declared type at all the bytes still decide, which is what makes the sniff the rule and
    // the header a courtesy.
    expect(acceptPhoto({ declaredType: undefined, declaredLength: undefined, bytes: PNG }).mime).toBe("image/png");
  });

  it("caps the size against the declared length AND against the bytes that arrive", () => {
    const declared = grab(() =>
      acceptPhoto({ declaredType: "image/png", declaredLength: PHOTO_MAX_BYTES + 1, bytes: PNG }),
    );
    expect((declared as PhotoRefused).reason).toBe("too_large");

    // A sender that under-declares still does not get past the cap: the second check reads the bytes.
    const oversize = new Uint8Array(PHOTO_MAX_BYTES + 1);
    oversize.set(PNG);
    const delivered = grab(() => acceptPhoto({ declaredType: "image/png", declaredLength: 10, bytes: oversize }));
    expect((delivered as PhotoRefused).reason).toBe("too_large");
    expect((delivered as PhotoRefused).message).toMatch(/the photo is/);
  });

  it("caps the body it will buffer even when the sender declares no size at all", async () => {
    // `Content-Length` is optional, so a chunked upload declares nothing and the declared-length
    // check has nothing to check. Without this the gateway would buffer whatever arrived.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64 * 1024));
      },
    });
    await expect(readCappedBody(stream, 256 * 1024)).rejects.toMatchObject({ reason: "too_large" });
    // And a body inside the cap comes back whole.
    const small = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PNG);
        controller.close();
      },
    });
    expect(await readCappedBody(small, 1024)).toEqual(PNG);
  });

  it("refuses an empty file part before anything else looks at it", () => {
    const err = grab(() =>
      acceptPhoto({ declaredType: "image/png", declaredLength: 0, bytes: new Uint8Array(0) }),
    );
    expect((err as PhotoRefused).reason).toBe("empty");
  });

  it("mints opaque ids and refuses anything path-shaped in their place", () => {
    const id = newPhotoFileId();
    expect(isPhotoFileId(id)).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // Two ids in a row must not be guessable from each other; the weakest useful assertion is that
    // they differ.
    expect(newPhotoFileId()).not.toBe(id);
    for (const bad of ["../../etc/passwd", "/tmp/x.png", "abc", `${id}/..`, `${id.toUpperCase()}`, ""]) {
      expect(isPhotoFileId(bad)).toBe(false);
    }
  });

  it("never lets a client filename become a name: the extension comes from the sniff", () => {
    expect(photoDisplayName("png")).toBe("photo.png");
    expect(photoDisplayName("jpg")).toBe("photo.jpg");
  });

  it("spends a per-device token bucket and refills it over time", () => {
    const limiter = createPhotoRateLimiter({ capacity: 2, refillMs: 1_000 });
    expect(limiter.take("phone", 0)).toEqual({ ok: true });
    expect(limiter.take("phone", 0)).toEqual({ ok: true });
    const refused = limiter.take("phone", 0);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBeGreaterThan(0);
    // Per DEVICE: one phone spending its budget must not touch another's.
    expect(limiter.take("tablet", 0)).toEqual({ ok: true });
    // And it refills rather than latching.
    expect(limiter.take("phone", 1_000)).toEqual({ ok: true });
  });
});

describe("transcript hygiene", () => {
  it("strips the directive lines hermes writes into its own user row", () => {
    const raw = [
      "what is this",
      "@image:/Users/operator/.hermes/profiles/scout/images/upload_20260819_014725_1.png",
      "[screenshot]",
    ].join("\n");
    expect(stripImageDirectives(raw)).toBe("what is this");
    expect(stripImageDirectives("plain words")).toBe("plain words");
    expect(stripImageDirectives("a\n[Image attached at: /var/x.png]\nb")).toBe("a\nb");
    expect(stripImageDirectives("[User attached image: upload_1.png]\nlook")).toBe("look");
  });

  it("never lets a host path reach the wire from a user row", () => {
    const mapped = mapChatMessage(
      {
        role: "user",
        content: "what is this\n@image:/Users/operator/.hermes/profiles/scout/images/upload_1.png\n[screenshot]",
        row_id: 29,
      },
      "canonical",
      0,
    );
    expect(mapped?.text).toBe("what is this");
    expect(mapped?.text).not.toContain("/Users/");
  });

  it("leaves an assistant's own words alone, path and all", () => {
    // A bot writing about a file it made is conversation, not machinery, and GET /bots/:name/media
    // already answers that case with reason "local_path". Editing it here would rewrite the chat.
    const mapped = mapChatMessage(
      { role: "assistant", content: "I saved it to /Users/operator/out.png\n[screenshot]" },
      "canonical",
      1,
    );
    expect(mapped?.text).toContain("/Users/operator/out.png");
  });

  it("drops a user row that was nothing but directives", () => {
    // Not reachable through this gateway (a photo send always submits words), but a desktop attach
    // with no caption can produce one, and a blank bubble is worse than no bubble.
    expect(mapChatMessage({ role: "user", content: "@image:/tmp/x.png\n[screenshot]" }, "canonical", 2)).toBeUndefined();
  });
});

/** A stubbed hermes for the turn loop: records every call, and lets a test decide what
 *  `image.attach_bytes` answers. */
function rpcStub(opts: { attach?: (params: Record<string, unknown>) => unknown } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    methods: (): string[] => calls.map((call) => call.method),
    request: async (method: string, params?: unknown): Promise<unknown> => {
      const record = (params ?? {}) as Record<string, unknown>;
      calls.push({ method, params: record });
      if (method === "image.attach_bytes") {
        return opts.attach === undefined ? { attached: true, count: 1 } : opts.attach(record);
      }
      if (method === "prompt.submit") return { ok: true };
      if (method === "session.resume") {
        return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function memoryAttachments(): ChatAttachmentStore & { bound: Map<string, string> } {
  const bound = new Map<string, string>();
  return {
    bound,
    bind: (fileId, messageId) => {
      if (!bound.has(fileId)) bound.set(fileId, messageId);
    },
    forMessage: (_sessionId, messageId) =>
      [...bound.entries()]
        .filter(([, id]) => id === messageId)
        .map(([fileId]) => ({ type: "attachment" as const, fileId, name: "photo.png", mimeType: "image/png", size: 3 })),
  };
}

/** A clock that advances with real time from a fake epoch, so a scaled-down turn cap expires in
 *  scaled-down wall time instead of never (a constant clock never reaches its own deadline). */
function tickingClock(): () => number {
  const started = Date.now();
  return () => NOW + (Date.now() - started);
}

const photo = (fileId = "f1") => ({
  fileId,
  contentBase64: "AAAA",
  filename: "photo.png",
  block: { type: "attachment" as const, fileId, name: "photo.png", mimeType: "image/png", size: 3 },
});

describe("BotChatTurns, the attach-then-submit pair", () => {
  it("attaches BEFORE it submits, against the runtime id, and answers with the block", async () => {
    const rpc = rpcStub();
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: tickingClock(), pollMs: 5, timeoutMs: 50 });
    const message = await turns.send("scout", "stored-1", "what is this", { photo: photo() });

    expect(rpc.methods()).toEqual(["session.resume", "image.attach_bytes", "prompt.submit"]);
    expect(rpc.calls[1]!.params).toEqual({
      session_id: "runtime-1",
      content_base64: "AAAA",
      filename: "photo.png",
    });
    // The same runtime id both times: an attach queued on one session and a prompt submitted against
    // another is a photo that never arrives.
    expect(rpc.calls[2]!.params["session_id"]).toBe("runtime-1");
    expect(message.attachments).toEqual([photo().block]);
    await turns.settled("scout");
  });

  it("fails the send BEFORE any submit when hermes rejects the attach", async () => {
    const rpc = rpcStub({
      attach: () => {
        throw new Error("4018 too large");
      },
    });
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: () => NOW, pollMs: 5, timeoutMs: 50 });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/4018/);
    // The negative half, which is the whole guarantee: a caption must never land without its photo.
    expect(rpc.methods()).not.toContain("prompt.submit");
  });

  it("treats a successful attach that did not attach as a failure", async () => {
    // A refusal can arrive as a perfectly ordinary result. Trusting the transport rather than the
    // answer is how a caption goes out alone.
    const rpc = rpcStub({ attach: () => ({ attached: false, error: "unsupported extension" }) });
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: () => NOW, pollMs: 5, timeoutMs: 50 });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/did not attach/);
    expect(rpc.methods()).not.toContain("prompt.submit");
  });

  it("serializes sends so nothing can submit between an attach and its own prompt", async () => {
    // Hermes' attached-image queue is per session and the next prompt spends it whole, so a text send
    // slipping in here would walk off with the photo.
    let releaseAttach: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    const rpc = rpcStub({
      attach: () => held.then(() => ({ attached: true })),
    });
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: tickingClock(), pollMs: 5, timeoutMs: 200 });

    const withPhoto = turns.send("scout", "stored-1", "what is this", { photo: photo() });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const plain = turns.send("scout", "stored-1", "unrelated question");
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The second send has resumed (that happens outside the lock) but has NOT submitted.
    expect(rpc.methods().filter((method) => method === "prompt.submit")).toHaveLength(0);
    releaseAttach();
    await Promise.all([withPhoto, plain]);

    const ordered = rpc.methods().filter((method) => method !== "session.resume");
    expect(ordered).toEqual(["image.attach_bytes", "prompt.submit", "prompt.submit"]);
    await turns.settled("scout");
  });

  it("binds the photo to the transcript row, so a later read still carries it", async () => {
    const attachments = memoryAttachments();
    let messages: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const rpc = {
      request: async (method: string, params?: unknown): Promise<unknown> => {
        calls.push(method);
        if (method === "image.attach_bytes") return { attached: true };
        if (method === "prompt.submit") return { ok: true };
        const omit = (params as Record<string, unknown>)["omit_messages"] === true;
        return {
          session_id: "runtime-1",
          message_count: messages.length,
          running: false,
          inflight: false,
          ...(omit ? {} : { messages }),
        };
      },
    };
    const frames: ServerFrame[] = [];
    const turns = new BotChatTurns({
      rpc,
      broadcast: (frame) => frames.push(frame),
      now: () => NOW,
      pollMs: 5,
      timeoutMs: 400,
      attachments,
    });

    await turns.send("scout", "stored-1", "what is this", { photo: photo("f9") });
    messages = [
      { row_id: 41, role: "user", content: "what is this" },
      { row_id: 42, role: "assistant", content: "a cat" },
    ];
    await turns.settled("scout");

    // The frame the app renders from carries the block...
    const chat = frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_chat" }> => frame.type === "bot_chat");
    const userRow = chat.flatMap((frame) => frame.messages).find((message) => message.role === "user");
    expect(userRow?.attachments).toEqual([
      { type: "attachment", fileId: "f9", name: "photo.png", mimeType: "image/png", size: 3 },
    ]);
    // ...and so does a history read afterwards, which is the durable half: the send-to-row match is
    // single use, so without the binding the photo would exist in exactly one frame and then vanish.
    expect(attachments.bound.get("f9")).toBe("41");
    const history = await turns.history("scout", "stored-1");
    expect(history.messages[0]?.attachments).toHaveLength(1);
    expect(history.messages[1]?.attachments).toBeUndefined();
  });
});

// --- Routes -------------------------------------------------------------------------------------

interface Harness {
  server: FakeHermesServer;
  storage: Storage;
  bridge: HermesBridge;
  client: HermesClient;
  frames: ServerFrame[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

function fakeBotMode(messages: Array<Record<string, unknown>> = []): {
  behavior: FakeHermesBehavior;
  attaches: Array<Record<string, unknown>>;
} {
  const attaches: Array<Record<string, unknown>> = [];
  const behavior: FakeHermesBehavior = {
    methods: {
      "profiles.list": () => ({
        profiles: [
          {
            name: "scout",
            description: "watches CI",
            has_avatar: false,
            last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "all green" },
            ui_meta: { "hermes-bots": { title: "Scout" } },
          },
          {
            name: "byte",
            description: "the other bot",
            has_avatar: false,
            last_session: { last_active: Math.round(NOW / 1000) - 5, preview: "" },
          },
        ],
        bot_mode_protocol: true,
      }),
      "session.list": () => ({ sessions: [{ id: "canonical", title: CANONICAL_CHAT_TITLE }] }),
      "session.create": () => ({ stored_session_id: "canonical", session_id: "runtime-1" }),
      "image.attach_bytes": (params) => {
        attaches.push(params);
        return { attached: true, count: 1, bytes: 16, width: 1, height: 1 };
      },
      "prompt.submit": (params) => {
        if (params["session_id"] !== "runtime-1") {
          throw { code: 5003, message: `prompt.submit needs the runtime session id, got ${String(params["session_id"])}` };
        }
        return { ok: true };
      },
      "session.resume": (params) => ({
        session_id: "runtime-1",
        message_count: messages.length,
        running: false,
        inflight: false,
        ...(params["omit_messages"] === true ? {} : { messages }),
      }),
      "profiles.configure": () => ({ applied: { ui_meta: true } }),
    },
  };
  return { behavior, attaches };
}

async function setup(
  behavior: FakeHermesBehavior,
  photoOptions: {
    photoLimiter?: ReturnType<typeof createMediaLimiter>;
    photoQueueWaitMs?: number;
    photoRateLimiter?: ReturnType<typeof createPhotoRateLimiter>;
  } = {},
): Promise<Harness> {
  const server = await startFakeHermesServer(behavior);
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  let clock = NOW;
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => (clock += 1),
    logSink: () => {},
    chatPollMs: 10,
    chatTurnTimeoutMs: 2_000,
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    ...photoOptions,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 9 } },
    presenceOf: () => "online",
    submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
      storage.appendMessage(threadId, { role: "user", blocks }, 500),
    interruptThread: () => "idle",
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

  bridge.start();
  await until(() => client.state() === "online", 4_000);
  return {
    server,
    storage,
    bridge,
    client,
    frames,
    authed: async (path, init) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } }),
    request: async (path, init) => app.request(path, init),
  };
}

function upload(bytes: Uint8Array, type: string, extra: { text?: string; clientId?: string; name?: string } = {}) {
  const form = new FormData();
  form.append("file", new File([bytes.slice().buffer as ArrayBuffer], extra.name ?? "IMG_0042.HEIC", { type }));
  if (extra.text !== undefined) form.append("text", extra.text);
  if (extra.clientId !== undefined) form.append("clientId", extra.clientId);
  return { method: "POST", body: form } satisfies RequestInit;
}

describe("POST /bots/:name/chat/photos", () => {
  it("attaches then submits, and answers 202 with the photo already on the message", async () => {
    const { behavior, attaches } = fakeBotMode();
    const { authed, server } = await setup(behavior);

    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "what is this", clientId: "c1" }));
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      name: string;
      sessionId: string;
      message: {
        role: string;
        text: string;
        clientId: string;
        attachments: Array<{ type: string; fileId: string; name: string; mimeType: string; size: number }>;
      };
    };
    expect(body.name).toBe("scout");
    expect(body.message.text).toBe("what is this");
    expect(body.message.clientId).toBe("c1");
    expect(body.message.attachments).toHaveLength(1);
    const block = body.message.attachments[0]!;
    expect(block.type).toBe("attachment");
    expect(block.mimeType).toBe("image/png");
    expect(block.size).toBe(PNG.byteLength);
    // The client's own filename never survives the request, and the id is not a path.
    expect(block.name).toBe("photo.png");
    expect(block.fileId).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(body)).not.toContain("IMG_0042");

    // On the wire to hermes: the attach carries base64 of exactly these bytes, and the submit follows
    // it rather than preceding it.
    expect(attaches).toHaveLength(1);
    expect(attaches[0]!["content_base64"]).toBe(Buffer.from(PNG).toString("base64"));
    expect(attaches[0]!["filename"]).toBe("photo.png");
    const order = server
      .calls()
      .map((call) => call.method)
      .filter((method) => method === "image.attach_bytes" || method === "prompt.submit");
    expect(order).toEqual(["image.attach_bytes", "prompt.submit"]);
  });

  it("submits a neutral prompt when the photo came with no caption", async () => {
    // Hermes spends an attached image on the NEXT prompt and nothing else, so a photo with no words
    // would otherwise sit queued and land on whatever the user typed afterwards.
    const { behavior } = fakeBotMode();
    const { authed, server } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(JPEG, "image/jpeg"));
    expect(res.status).toBe(202);
    expect(server.callsOf("prompt.submit")[0]!.params["text"]).toBe(PHOTO_DEFAULT_PROMPT);
  });

  it("refuses a heic with 415 and a message about converting it", async () => {
    const { behavior, attaches } = fakeBotMode();
    const { authed } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(HEIC, "image/heic"));
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string; message: string }; reason: string };
    expect(body.error.code).toBe("media_refused");
    expect(body.reason).toBe("content_type");
    expect(body.error.message).toMatch(/convert/i);
    // Nothing reached hermes, which is what makes this a gateway 415 rather than a hermes 4016
    // surfaced as a 502.
    expect(attaches).toHaveLength(0);
  });

  it("refuses bytes that are not an image, whatever the request declared", async () => {
    const { behavior } = fakeBotMode();
    const { authed } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(HEIC, "image/png"));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { reason: string }).reason).toBe("content_type");
  });

  it("refuses an oversized photo with 413", async () => {
    const { behavior } = fakeBotMode();
    const { authed } = await setup(behavior);
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    big.set(PNG);
    const res = await authed("/bots/scout/chat/photos", upload(big, "image/png"));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { reason: string }).reason).toBe("too_large");
  });

  it("refuses a body with no file part, and one with two", async () => {
    const { behavior } = fakeBotMode();
    const { authed } = await setup(behavior);

    const noFile = new FormData();
    noFile.append("text", "just words");
    expect((await authed("/bots/scout/chat/photos", { method: "POST", body: noFile })).status).toBe(400);

    const two = new FormData();
    two.append("file", new File([PNG.slice().buffer as ArrayBuffer], "a.png", { type: "image/png" }));
    two.append("file", new File([JPEG.slice().buffer as ArrayBuffer], "b.jpg", { type: "image/jpeg" }));
    const res = await authed("/bots/scout/chat/photos", { method: "POST", body: two });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(/one photo per send/);
  });

  it("404s a bot that does not exist and 401s a request with no device", async () => {
    const { behavior } = fakeBotMode();
    const { authed, request } = await setup(behavior);
    expect((await authed("/bots/nobody/chat/photos", upload(PNG, "image/png"))).status).toBe(404);
    const anon = await request("/bots/scout/chat/photos", {
      ...upload(PNG, "image/png"),
      headers: { authorization: "Bearer nope" },
    });
    expect(anon.status).toBe(401);
  });

  it("answers 502 when hermes refuses the attach, and submits nothing", async () => {
    const { behavior } = fakeBotMode();
    behavior.methods!["image.attach_bytes"] = () => {
      throw { code: 4016, message: "unsupported extension" };
    };
    const { authed, server } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "look" }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { hermesError: string }).hermesError).toMatch(/unsupported extension/);
    expect(server.callsOf("prompt.submit")).toHaveLength(0);
  });

  it("leaves no stored bytes behind when the send failed", async () => {
    const { behavior } = fakeBotMode();
    behavior.methods!["image.attach_bytes"] = () => ({ attached: false });
    const { authed, storage } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png"));
    expect(res.status).toBe(502);
    // A picture no message points at would otherwise sit in the household's database for two weeks.
    expect(storage.sweepBotChatAttachments(NOW + PHOTO_TTL_MS * 2, PHOTO_TTL_MS)).toBe(0);
  });

  it("rate limits a device that sends photos too quickly", async () => {
    const { behavior } = fakeBotMode();
    const { authed } = await setup(behavior, {
      photoRateLimiter: createPhotoRateLimiter({ capacity: 1, refillMs: 60_000 }),
    });
    expect((await authed("/bots/scout/chat/photos", upload(PNG, "image/png"))).status).toBe(202);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png"));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    const body = (await res.json()) as { error: { code: string }; retryAfterMs: number };
    expect(body.error.code).toBe("rate_limited");
    expect(body.retryAfterMs).toBeGreaterThan(0);
  });

  it("refuses with a retryable 503 when the gateway is already sending as many as it will", async () => {
    const { behavior } = fakeBotMode();
    const limiter = createMediaLimiter(1);
    const { authed } = await setup(behavior, { photoLimiter: limiter, photoQueueWaitMs: 20 });
    // Hold the only slot, so the request has nowhere to go.
    const held = await limiter.acquire(50);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png"));
    held();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { busy: boolean; waitedMs: number };
    expect(body.busy).toBe(true);
    expect(res.headers.get("retry-after")).toBe("1");
  });
});

describe("GET /bots/:name/chat/attachments/:fileId", () => {
  async function sendOne(): Promise<{ harness: Harness; fileId: string }> {
    const { behavior } = fakeBotMode();
    const harness = await setup(behavior);
    const res = await harness.authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "hi" }));
    const body = (await res.json()) as { message: { attachments: Array<{ fileId: string }> } };
    return { harness, fileId: body.message.attachments[0]!.fileId };
  }

  it("serves the gateway's own copy, with the capability-7 header posture", async () => {
    const { harness, fileId } = await sendOne();
    const res = await harness.authed(`/bots/scout/chat/attachments/${fileId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("is scoped to the bot in the URL, and to the shape of an attachment id", async () => {
    const { harness, fileId } = await sendOne();
    // Another bot's route must not serve this bot's photo.
    expect((await harness.authed(`/bots/byte/chat/attachments/${fileId}`)).status).toBe(404);
    expect((await harness.authed(`/bots/scout/chat/attachments/${"0".repeat(32)}`)).status).toBe(404);
    // A path parameter that could be anything is how an id becomes a path, so the shape is checked
    // before the lookup.
    expect((await harness.authed("/bots/scout/chat/attachments/not-an-id")).status).toBe(400);
  });

  it("requires a device token", async () => {
    const { harness, fileId } = await sendOne();
    const res = await harness.request(`/bots/scout/chat/attachments/${fileId}`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("keeps carrying the photo on the transcript row after the turn has landed", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const { behavior } = fakeBotMode(messages);
    const harness = await setup(behavior);
    const sent = await harness.authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "what is this" }));
    const body = (await sent.json()) as { message: { attachments: Array<{ fileId: string }> } };
    const fileId = body.message.attachments[0]!.fileId;

    // The row hermes persists carries its own directive lines, which is the shape a live 0.20.4
    // actually returns.
    messages.push(
      { row_id: 7, role: "user", content: "what is this\n@image:/Users/operator/.hermes/x.png\n[screenshot]" },
      { row_id: 8, role: "assistant", content: "a cat" },
    );
    await until(() => harness.frames.some((frame) => frame.type === "bot_chat"), 4_000);

    const history = (await (await harness.authed("/bots/scout/chat/messages")).json()) as {
      messages: Array<{ role: string; text: string; attachments?: Array<{ fileId: string }> }>;
    };
    const userRow = history.messages.find((message) => message.role === "user")!;
    expect(userRow.text).toBe("what is this");
    expect(userRow.attachments).toEqual([expect.objectContaining({ fileId })]);
    // The assistant row is untouched.
    expect(history.messages.find((message) => message.role === "assistant")?.attachments).toBeUndefined();
  });
});

describe("attachment storage", () => {
  function put(storage: Storage, fileId: string, at: number, bot = "scout"): void {
    storage.putBotChatAttachment(
      { fileId, bot, sessionId: "canonical", mime: "image/png", name: "photo.png", size: 3, bytes: PNG },
      at,
      PHOTO_TTL_MS,
    );
  }

  it("sweeps copies past the TTL and keeps the rest", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    // Both are young enough that the write-time sweep leaves them alone; the explicit sweep is what
    // is under test here.
    put(storage, "a".repeat(32), NOW - PHOTO_TTL_MS / 2);
    put(storage, "b".repeat(32), NOW);
    expect(storage.sweepBotChatAttachments(NOW + PHOTO_TTL_MS / 2 + 1, PHOTO_TTL_MS)).toBe(1);
    expect(storage.botChatAttachment("scout", "a".repeat(32))).toBeUndefined();
    expect(storage.botChatAttachment("scout", "b".repeat(32))).toMatchObject({ mime: "image/png", size: 3 });
  });

  it("sweeps on write, so the table is trimmed exactly when it grows", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "a".repeat(32), NOW - PHOTO_TTL_MS - 1);
    put(storage, "b".repeat(32), NOW);
    expect(storage.botChatAttachment("scout", "a".repeat(32))).toBeUndefined();
  });

  it("binds a photo to a row exactly once", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "c".repeat(32), NOW);
    storage.bindBotChatAttachment("c".repeat(32), "41");
    // A replayed row must not be able to move a photo onto a later message with the same words.
    storage.bindBotChatAttachment("c".repeat(32), "99");
    expect(storage.botChatAttachmentsFor("canonical", "41")).toHaveLength(1);
    expect(storage.botChatAttachmentsFor("canonical", "99")).toHaveLength(0);
  });

  it("drops a bot's photos when the bot is forgotten", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "d".repeat(32), NOW, "scout");
    put(storage, "e".repeat(32), NOW, "byte");
    storage.forgetBot("scout");
    expect(storage.botChatAttachment("scout", "d".repeat(32))).toBeUndefined();
    expect(storage.botChatAttachment("byte", "e".repeat(32))).toBeDefined();
  });
});

/** Runs `fn` and hands back whatever it threw. Keeps the refusal assertions readable: every one of
 *  them is about the ERROR, not about the absence of a return value. */
function grab(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal, got a value");
}

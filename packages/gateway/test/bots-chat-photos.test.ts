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
  redactHostPaths,
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
/** A real BMP header: "BM", the file size, four zero reserved bytes, the pixel offset, and a
 *  40-byte BITMAPINFOHEADER. The structure matters now: a two-letter prefix is no longer enough. */
const BMP = new Uint8Array([
  0x42, 0x4d, 58, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0,
]);
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

  it("does not take two letters as proof of a bmp (review Minor 3)", () => {
    // "BM" is the weakest magic in the table, so the sniff looks one field further: the reserved
    // bytes at offset 6 and the DIB header size at offset 14. Without that, any text beginning "BM"
    // is stored, served back, and forwarded into a model context.
    expect(sniffImageType(new TextEncoder().encode("BM this is just some text, honestly"))).toBeUndefined();
    // Truncated below a whole header.
    expect(sniffImageType(new Uint8Array([0x42, 0x4d, 1, 0, 0, 0]))).toBeUndefined();
    // Right shape, impossible DIB header size.
    const badDib = BMP.slice();
    badDib[14] = 41;
    expect(sniffImageType(badDib)).toBeUndefined();
    // Right shape, non-zero reserved field.
    const badReserved = BMP.slice();
    badReserved[7] = 9;
    expect(sniffImageType(badReserved)).toBeUndefined();
    // And a real one still passes.
    expect(sniffImageType(BMP)).toBe("image/bmp");
  });

  it("redacts host paths out of a hermes error, and keeps the rest (review Minor 4)", () => {
    // The one routine hermes failure on this path names the images directory.
    expect(redactHostPaths("5027 write failure: /Users/kyle/.hermes/profiles/scout/images/upload_1.png")).toBe(
      "5027 write failure: <path>",
    );
    expect(redactHostPaths("could not write C:\\Users\\kyle\\.hermes\\images\\a.png")).toBe(
      "could not write <path>",
    );
    expect(redactHostPaths("could not write ~/.hermes/images/a.png")).toBe("could not write <path>");
    // What a person debugging actually needs survives untouched.
    expect(redactHostPaths("unknown method: image.attach_bytes")).toBe("unknown method: image.attach_bytes");
    expect(redactHostPaths("4018 image too large")).toBe("4018 image too large");
  });

  it("evicts a bucket that would be full now, not one that was full when it was written", () => {
    // Review Minor 2. A bucket is only ever WRITTEN when it is spent, so its stored token count is
    // always below capacity; an eviction that read the stored number would find nothing to evict and
    // the map would grow past the bound the comment claims.
    const limiter = createPhotoRateLimiter({ capacity: 2, refillMs: 1 });
    // A device spends a token long ago, so its stored count is 1 (below capacity) forever after.
    limiter.take("old", 0);
    // Far later, another device sends. `old` has refilled by now and is evictable.
    expect(limiter.take("new", 10_000_000)).toEqual({ ok: true });
    // The observable consequence of eviction is indistinguishable from a full bucket, which is the
    // point, so this asserts the arithmetic the eviction relies on rather than the map's size: a
    // bucket that has had 10 million refill periods is full.
    expect(limiter.take("old", 10_000_000)).toEqual({ ok: true });
    expect(limiter.take("old", 10_000_000)).toEqual({ ok: true });
    expect(limiter.take("old", 10_000_000).ok).toBe(false);
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
    );
    expect(mapped?.text).toContain("/Users/operator/out.png");
  });

  it("drops a user row that was nothing but directives", () => {
    // Not reachable through this gateway (a photo send always submits words), but a desktop attach
    // with no caption can produce one, and a blank bubble is worse than no bubble.
    expect(mapChatMessage({ role: "user", content: "@image:/tmp/x.png\n[screenshot]" }, "canonical")).toBeUndefined();
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

/** A hermes stub that models the attached-image QUEUE the way 0.20.4 really does it, because the
 *  bug this guards against is entirely about that queue and a stub that merely records calls cannot
 *  see it. Read off `tui_gateway/methods_prompt.py` and `tui_gateway/server.py`:
 *
 *  - `image.attach_bytes` writes the bytes into the profile's images dir and pushes the resulting
 *    ABSOLUTE PATH onto `session["attached_images"]`, answering `{ attached: true, path, count }`.
 *  - `prompt.submit` takes the whole queue and clears it (`server.py:10495`), so an image is spent on
 *    exactly one turn, whichever turn comes next.
 *  - `image.detach` (`methods_prompt.py:1139`) REQUIRES `path`, rejects an empty one with
 *    `4015 path required`, and removes exactly that entry. It is not a "clear the queue" call.
 *
 *  That third rule is the one worth modelling strictly. A stub that answered any detach with success
 *  let a pathless call look like protection while hermes rejected it every time. */
function queueingHermes(opts: { failSubmit?: boolean } = {}) {
  const calls: string[] = [];
  const queue: string[] = [];
  const written: string[] = [];
  const detaches: Array<Record<string, unknown>> = [];
  const spent: Array<{ text: string; images: string[] }> = [];
  let seq = 0;
  const stub = {
    calls,
    queue,
    written,
    detaches,
    spent,
    failSubmit: opts.failSubmit ?? false,
    methods: (): string[] => calls,
    request: async (method: string, params?: unknown): Promise<unknown> => {
      calls.push(method);
      const record = (params ?? {}) as Record<string, unknown>;
      if (method === "image.attach_bytes") {
        seq += 1;
        const path = `/Users/operator/.hermes/profiles/scout/images/upload_2026_${seq}.png`;
        queue.push(path);
        written.push(path);
        return { attached: true, path, count: queue.length, bytes: 16 };
      }
      if (method === "image.detach") {
        detaches.push(record);
        const path = typeof record["path"] === "string" ? record["path"] : "";
        // Verbatim from the real method: no path, no detach.
        if (path === "") throw Object.assign(new Error("4015 path required"), { code: 4015 });
        const before = queue.length;
        const kept = queue.filter((entry) => entry !== path);
        queue.length = 0;
        queue.push(...kept);
        return { detached: queue.length !== before, count: queue.length };
      }
      if (method === "prompt.submit") {
        if (stub.failSubmit) throw new Error("5003 session went away");
        // Consume and clear, exactly as the turn start does.
        spent.push({ text: String(record["text"] ?? ""), images: [...queue] });
        queue.length = 0;
        return { ok: true };
      }
      return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
    },
  };
  return stub;
}

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

  it("unwinds the queued image when the attach landed and the submit did not (review I2)", async () => {
    // Hermes' attached-image queue is spent by the NEXT prompt, whatever it is. Leaving one behind
    // means the user's next unrelated question silently carries a picture the transcript does not
    // show, or a retry of the photo puts it in twice.
    //
    // The stub models the REAL method rather than accepting anything: `image.detach` requires a
    // `path` (methods_prompt.py:1139-1146) and removes exactly that entry. A lenient stub is what let
    // a pathless detach look green while the protection it stood for was inert.
    const hermes = queueingHermes({ failSubmit: true });
    const turns = new BotChatTurns({
      rpc: hermes,
      broadcast: () => {},
      now: tickingClock(),
      pollMs: 5,
      timeoutMs: 50,
    });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/5003/);

    expect(hermes.methods()).toEqual(["session.resume", "image.attach_bytes", "prompt.submit", "image.detach"]);
    // The detach carries the EXACT path the attach reported, which is the only handle hermes accepts.
    expect(hermes.detaches).toEqual([{ session_id: "runtime-1", path: hermes.written[0] }]);
    // And the property that actually matters: hermes is no longer holding the picture.
    expect(hermes.queue).toEqual([]);
  });

  it("leaves nothing for the user's next turn to pick up after a failed photo send (review I2, live shape)", async () => {
    // The user-visible defect, end to end: photo 502s, user shrugs and types something unrelated, and
    // that turn carries the orphaned picture into the model's context. Asserted on what the next
    // prompt actually consumes rather than on the RPC that was supposed to prevent it.
    const hermes = queueingHermes({ failSubmit: true });
    const turns = new BotChatTurns({
      rpc: hermes,
      broadcast: () => {},
      now: tickingClock(),
      pollMs: 5,
      timeoutMs: 50,
    });
    await expect(turns.send("scout", "stored-1", "what is this", { photo: photo() })).rejects.toThrow(/5003/);

    hermes.failSubmit = false;
    await turns.send("scout", "stored-1", "what is the weather");
    expect(hermes.spent).toEqual([{ text: "what is the weather", images: [] }]);
    await turns.settled("scout");
  });

  it("does not pretend to unwind when hermes reported no path", async () => {
    // An attach with no path leaves no handle to detach with, so the gateway says so rather than
    // sending a call it knows hermes will reject. The send still fails on the submit, as it must.
    const logs: string[] = [];
    const rpc = {
      request: async (method: string): Promise<unknown> => {
        if (method === "image.attach_bytes") return { attached: true, count: 1 };
        if (method === "prompt.submit") throw new Error("5003 session went away");
        if (method === "image.detach") throw new Error("4015 path required");
        return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
      },
    };
    const turns = new BotChatTurns({
      rpc,
      broadcast: () => {},
      now: tickingClock(),
      pollMs: 5,
      timeoutMs: 50,
      log: (line) => logs.push(line),
    });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/5003/);
    expect(logs.some((line) => /reported no path/.test(line))).toBe(true);
  });

  it("treats an attach result that is not an object at all as a failure", async () => {
    // The `attached === true` check has to survive a build that answers with a bare value; a truthy
    // test on a non-object would read `undefined` and stop, but a coercing one would not.
    const calls: string[] = [];
    const rpc = {
      request: async (method: string): Promise<unknown> => {
        calls.push(method);
        if (method === "image.attach_bytes") return "ok";
        if (method === "prompt.submit") return { ok: true };
        return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
      },
    };
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: tickingClock(), pollMs: 5, timeoutMs: 50 });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/did not attach/);
    expect(calls).not.toContain("prompt.submit");
  });

  it("does not detach when nothing was ever attached", async () => {
    // A plain text send that fails to submit has no queue of ours to unwind, and detaching there
    // would throw away an image somebody else legitimately queued.
    const calls: string[] = [];
    const rpc = {
      request: async (method: string): Promise<unknown> => {
        calls.push(method);
        if (method === "prompt.submit") throw new Error("5003 session went away");
        return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
      },
    };
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: tickingClock(), pollMs: 5, timeoutMs: 50 });
    await expect(turns.send("scout", "stored-1", "hello")).rejects.toThrow(/5003/);
    expect(calls).not.toContain("image.detach");
  });

  it("reports the submit failure even when the unwind fails too", async () => {
    // The detach is a cleanup: it must not be able to replace the true cause with a consequence.
    const rpc = {
      request: async (method: string): Promise<unknown> => {
        if (method === "image.attach_bytes") return { attached: true };
        if (method === "prompt.submit") throw new Error("5003 the real problem");
        if (method === "image.detach") throw new Error("4001 unknown method: image.detach");
        return { session_id: "runtime-1", message_count: 0, running: false, inflight: false, messages: [] };
      },
    };
    const turns = new BotChatTurns({ rpc, broadcast: () => {}, now: tickingClock(), pollMs: 5, timeoutMs: 50 });
    await expect(turns.send("scout", "stored-1", "look", { photo: photo() })).rejects.toThrow(/the real problem/);
  });

  it("matches a send whose own text contains a directive-shaped line (review I3)", async () => {
    // A caption may legally contain `[screenshot]` or a line starting `@image:` (pasting a hermes
    // transcript is enough). The persisted row has those lines stripped on the way out, so a pending
    // entry holding the RAW text can never equal it: the clientId never joins and, worse, the photo
    // never binds and is gone from every read after the 202.
    const attachments = memoryAttachments();
    let messages: Array<Record<string, unknown>> = [];
    const rpc = {
      request: async (method: string, params?: unknown): Promise<unknown> => {
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
      now: tickingClock(),
      pollMs: 5,
      timeoutMs: 400,
      attachments,
    });

    const caption = "look at this\n[screenshot]";
    const sent = await turns.send("scout", "stored-1", caption, { photo: photo("f7"), clientId: "c7" });
    // The model still receives what the user actually wrote; only the join key is canonicalized.
    expect(sent.text).toBe(caption);

    // What hermes persists: the caption, plus its own directives appended.
    messages = [
      { row_id: 51, role: "user", content: `${caption}\n@image:/Users/operator/.hermes/x.png\n[screenshot]` },
      { row_id: 52, role: "assistant", content: "a cat" },
    ];
    await turns.settled("scout");

    const chat = frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_chat" }> => frame.type === "bot_chat");
    const userRow = chat.flatMap((frame) => frame.messages).find((message) => message.role === "user");
    expect(userRow?.clientId).toBe("c7");
    expect(userRow?.attachments).toHaveLength(1);
    expect(attachments.bound.get("f7")).toBe("51");
  });

  it("keeps clientId dedupe on a plain text send containing a directive line (review I3, capability 2)", async () => {
    // The regression half: the strip is new, the text route is not. A send whose body pastes an
    // `@image:` line must still have its optimistic row joined, which is the cozychat#38 invariant.
    let messages: Array<Record<string, unknown>> = [];
    const rpc = {
      request: async (method: string, params?: unknown): Promise<unknown> => {
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
      now: tickingClock(),
      pollMs: 5,
      timeoutMs: 400,
    });

    const text = "why does this log say\n@image:/Users/operator/out.png\nis that normal";
    await turns.send("scout", "stored-1", text, { clientId: "c8" });
    messages = [
      { row_id: 61, role: "user", content: text },
      { row_id: 62, role: "assistant", content: "it is" },
    ];
    await turns.settled("scout");

    const chat = frames.filter((frame): frame is Extract<ServerFrame, { type: "bot_chat" }> => frame.type === "bot_chat");
    const userRow = chat.flatMap((frame) => frame.messages).find((message) => message.role === "user");
    expect(userRow?.clientId).toBe("c8");
    expect(userRow?.text).toBe("why does this log say\nis that normal");
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
  pairAnother: () => Promise<(path: string, init?: RequestInit) => Promise<Response>>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

function fakeBotMode(messages: Array<Record<string, unknown>> = []): {
  behavior: FakeHermesBehavior;
  attaches: Array<Record<string, unknown>>;
  /** The session's `attached_images` list, modelled the way hermes really keeps it, so a test can
   *  assert what the NEXT turn would pick up rather than which RPC was called. */
  queue: string[];
} {
  const attaches: Array<Record<string, unknown>> = [];
  const queue: string[] = [];
  let seq = 0;
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
        seq += 1;
        // The real response carries the absolute path it wrote, and that path is the only handle
        // `image.detach` will take.
        const path = `/Users/operator/.hermes/profiles/scout/images/upload_2026_${seq}.png`;
        queue.push(path);
        return { attached: true, path, count: queue.length, bytes: 16, width: 1, height: 1 };
      },
      // Verbatim from `tui_gateway/methods_prompt.py:1139-1156`: `path` is required, an empty one is
      // `4015`, and exactly that entry is removed.
      "image.detach": (params) => {
        const path = typeof params["path"] === "string" ? params["path"] : "";
        if (path === "") throw { code: 4015, message: "path required" };
        const before = queue.length;
        const kept = queue.filter((entry) => entry !== path);
        queue.length = 0;
        queue.push(...kept);
        return { detached: queue.length !== before, count: queue.length };
      },
      "prompt.submit": (params) => {
        if (params["session_id"] !== "runtime-1") {
          throw { code: 5003, message: `prompt.submit needs the runtime session id, got ${String(params["session_id"])}` };
        }
        // Consume and clear: an image is spent on exactly one turn, whichever comes next.
        queue.length = 0;
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
  return { behavior, attaches, queue };
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
    pairAnother: async () => {
      const nextCode = newSetupCode();
      storage.createSetupCode(nextCode, 1_000 + SETUP_CODE_TTL_MS);
      const nextPair = await app.request("/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: nextCode, deviceName: "tablet" }),
      });
      const next = (await nextPair.json()) as { deviceToken: string };
      return async (path, init) =>
        app.request(path, {
          ...init,
          headers: { ...(init?.headers ?? {}), authorization: `Bearer ${next.deviceToken}` },
        });
    },
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

  it("redacts the hermes images path out of the 502 it passes back (review Minor 4)", async () => {
    const { behavior } = fakeBotMode();
    behavior.methods!["image.attach_bytes"] = () => {
      // The real shape of a hermes 5027, which names the operator's own directory.
      throw { code: 5027, message: "write failure: /Users/operator/.hermes/profiles/scout/images/upload_3.png" };
    };
    const { authed } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png"));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { hermesError: string; hermesErrorCode: number };
    // Stripping paths out of the transcript and handing the same path back in an error body would
    // close nothing.
    expect(body.hermesError).not.toContain("/Users/");
    expect(body.hermesError).toContain("<path>");
    // What a person debugging needs is still there.
    expect(body.hermesError).toContain("write failure");
    expect(body.hermesErrorCode).toBe(5027);
  });

  it("caps a chunked upload that declares no length at all (review Minor 7)", async () => {
    // The route tests all send FormData, which carries a computed Content-Length. This one goes down
    // the other path: a streamed body with no length, read through readCappedBody as wired.
    const { behavior } = fakeBotMode();
    const { authed } = await setup(behavior);
    const boundary = "----cozytest";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`,
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(head);
      },
      pull(controller) {
        // Never ends: the cap is the only thing that can stop this.
        controller.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const res = await authed("/bots/scout/chat/photos", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      // Required by fetch for a streaming request body.
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as { reason: string }).reason).toBe("too_large");
  });

  it("leaves hermes holding nothing when the attach landed and the submit failed", async () => {
    // The whole route, against the fake hermes' real queue semantics. A 502 here promises "nothing
    // was submitted"; this asserts the half of that promise the RPC-level tests cannot see, which is
    // that hermes is not still holding the picture for whatever turn comes next.
    const { behavior, queue } = fakeBotMode();
    behavior.methods!["prompt.submit"] = () => {
      throw { code: 5003, message: "session went away" };
    };
    const { authed, server } = await setup(behavior);
    const res = await authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "look" }));
    expect(res.status).toBe(502);

    expect(queue).toEqual([]);
    // And the detach that emptied it carried the exact path the attach reported, because that is the
    // only thing hermes' `image.detach` accepts (`4015 path required` otherwise).
    const attachPath = (server.callsOf("image.attach_bytes")[0] !== undefined
      ? "/Users/operator/.hermes/profiles/scout/images/upload_2026_1.png"
      : "");
    const detach = server.callsOf("image.detach")[0];
    expect(detach).toBeDefined();
    expect(detach!.params["path"]).toBe(attachPath);
    expect(detach!.params["session_id"]).toBe("runtime-1");
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
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves bounded and suffix ranges without returning the whole stored attachment", async () => {
    const { harness, fileId } = await sendOne();
    const middle = await harness.authed(`/bots/scout/chat/attachments/${fileId}`, {
      headers: { range: "bytes=2-5" },
    });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe(`bytes 2-5/${PNG.byteLength}`);
    expect(middle.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await middle.arrayBuffer())).toEqual(PNG.slice(2, 6));

    const suffix = await harness.authed(`/bots/scout/chat/attachments/${fileId}`, {
      headers: { range: "bytes=-3" },
    });
    expect(suffix.status).toBe(206);
    expect(new Uint8Array(await suffix.arrayBuffer())).toEqual(PNG.slice(-3));
  });

  it("answers unsatisfiable or multi-ranges with 416 and the full size", async () => {
    const { harness, fileId } = await sendOne();
    for (const range of [`bytes=${PNG.byteLength}-`, "bytes=0-1,4-5", "items=0-1"]) {
      const res = await harness.authed(`/bots/scout/chat/attachments/${fileId}`, { headers: { range } });
      expect(res.status).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${PNG.byteLength}`);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
    }
  });

  it("serves the same row to another paired device", async () => {
    const { behavior } = fakeBotMode();
    const harness = await setup(behavior);
    const fileId = "a".repeat(32);
    harness.storage.putBotChatAttachment(
      {
        fileId,
        bot: "scout",
        sessionId: "canonical",
        messageId: "assistant-1",
        sourceKey: "directive-1",
        mime: "image/png",
        name: "photo.png",
        size: PNG.byteLength,
        bytes: PNG,
      },
      NOW,
      PHOTO_TTL_MS,
    );
    const tablet = await harness.pairAnother();
    const res = await tablet(`/bots/scout/chat/attachments/${fileId}`);
    expect(res.status).toBe(200);
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

  it("404s an expired photo that no sweep has reached, and drops its block (review I1)", async () => {
    // The failure this closes: a household sends photos for a week and then stops. Nothing triggers
    // a write-time sweep ever again, so an expiry that lived only in the sweep would never happen,
    // and months-old photos would go on being served with 200 and decorating history. Expiry has to
    // be a property of the read.
    const { behavior } = fakeBotMode();
    const server = await startFakeHermesServer(behavior);
    servers.push(server);
    const storage = openStorage(":memory:");
    storages.push(storage);
    const client = createHermesClient({
      url: server.url,
      auth: { mode: "token", token: "T" },
      reconnect: { minMs: 15, maxMs: 60 },
    });
    // A clock the test moves by hand, so "14 days later" costs no wall time and no sweep runs.
    let clock = NOW;
    const bridge = new HermesBridge({
      client,
      storage,
      broadcast: () => {},
      now: () => (clock += 1),
      logSink: () => {},
      chatPollMs: 10,
      chatTurnTimeoutMs: 2_000,
      // Long enough that it cannot fire during the test: the read filter is what is under test.
      attachmentSweepMs: 60 * 60 * 1000,
    });
    bridges.push(bridge);
    const app = createApp({
      storage,
      config,
      bots: bridge,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 9 } },
      presenceOf: () => "online",
      submitUserMessage: (threadId: string, blocks: RichBlock[]): Message =>
        storage.appendMessage(threadId, { role: "user", blocks }, 500),
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
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });
    bridge.start();
    await until(() => client.state() === "online", 4_000);

    const sent = await authed("/bots/scout/chat/photos", upload(PNG, "image/png", { text: "keep me" }));
    const fileId = ((await sent.json()) as { message: { attachments: Array<{ fileId: string }> } }).message
      .attachments[0]!.fileId;
    expect((await authed(`/bots/scout/chat/attachments/${fileId}`)).status).toBe(200);

    // Bind it to a row so the block path is exercised too, then walk the clock past the TTL WITHOUT
    // sweeping anything.
    storage.bindBotChatAttachment(fileId, "77");
    expect(storage.botChatAttachmentsFor("canonical", "77", clock - PHOTO_TTL_MS)).toHaveLength(1);
    clock += PHOTO_TTL_MS + 1;

    expect((await authed(`/bots/scout/chat/attachments/${fileId}`)).status).toBe(404);
    // And the block goes with it: a block naming a file the download route 404s renders as a picture
    // that never resolves, which is worse than no block at all.
    expect(storage.botChatAttachmentsFor("canonical", "77", clock - PHOTO_TTL_MS)).toHaveLength(0);
    // The row is still on disk, unswept: expiry did not depend on the sweep having run.
    expect(storage.sweepBotChatAttachments(clock, PHOTO_TTL_MS)).toBe(1);
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
    expect(storage.botChatAttachment("scout", "a".repeat(32), 0)).toBeUndefined();
    expect(storage.botChatAttachment("scout", "b".repeat(32), 0)).toMatchObject({ mime: "image/png", size: 3 });
  });

  it("sweeps on write, so the table is trimmed exactly when it grows", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "a".repeat(32), NOW - PHOTO_TTL_MS - 1);
    put(storage, "b".repeat(32), NOW);
    expect(storage.botChatAttachment("scout", "a".repeat(32), 0)).toBeUndefined();
  });

  it("binds a photo to a row exactly once", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "c".repeat(32), NOW);
    storage.bindBotChatAttachment("c".repeat(32), "41");
    // A replayed row must not be able to move a photo onto a later message with the same words.
    storage.bindBotChatAttachment("c".repeat(32), "99");
    expect(storage.botChatAttachmentsFor("canonical", "41", 0)).toHaveLength(1);
    expect(storage.botChatAttachmentsFor("canonical", "99", 0)).toHaveLength(0);
  });


  it("drops a bot's photos when the bot is forgotten", () => {
    const storage = openStorage(":memory:");
    storages.push(storage);
    put(storage, "d".repeat(32), NOW, "scout");
    put(storage, "e".repeat(32), NOW, "byte");
    storage.forgetBot("scout");
    expect(storage.botChatAttachment("scout", "d".repeat(32), 0)).toBeUndefined();
    expect(storage.botChatAttachment("byte", "e".repeat(32), 0)).toBeDefined();
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

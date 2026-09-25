import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };
const fileId = "a".repeat(32);

function fixture() {
  const app = new Hono<Env>();
  const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
    c.set("deviceId", "device-1");
    await next();
  };
  const sendChatAttachment = vi.fn(async (_name, file) => ({
    sessionId: "session-1",
    message: {
      id: file.clientId ?? "gateway-message",
      role: "user",
      text: file.text,
      at: 1,
      ...(file.clientId === undefined ? {} : { clientId: file.clientId }),
      attachments: [{ type: "attachment", fileId, name: file.name, mimeType: file.mime, size: file.bytes.byteLength, mediaKind: "file" }],
    },
  }));
  const bots = {
    sendChatAttachment,
    chatAttachmentInfo: vi.fn(() => ({ mime: "application/pdf", name: "report.pdf", size: 9 })),
    chatAttachmentSlice: vi.fn(() => new TextEncoder().encode("%PDF-1.7")),
  } as unknown as BotsSurface;
  registerBotRoutes(app, requireDevice, bots);
  return { app, sendChatAttachment };
}

function multipart(type: string, bytes: Uint8Array, name = "report.pdf", fields: Record<string, string> = {}) {
  const form = new FormData();
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  form.set("file", new Blob([body], { type }), name);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

describe("capability-24 bot attachment routes", () => {
  it("accepts a PDF and passes sanitized filename, caption, and client id to one native turn", async () => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/SAGE/chat/attachments", {
      method: "POST",
      body: multipart("application/pdf", new TextEncoder().encode("%PDF-1.7\n"), "../report.pdf", { text: "Please summarize.", clientId: "client-1" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ name: "sage", sessionId: "session-1", message: { clientId: "client-1", text: "Please summarize." } });
    expect(sendChatAttachment).toHaveBeenCalledWith("sage", expect.objectContaining({
      mime: "application/pdf", name: "report.pdf", text: "Please summarize.", clientId: "client-1",
    }), { deviceId: "device-1" });
  });

  it.each([
    ["application/octet-stream", new Uint8Array([1])],
    ["application/pdf", new TextEncoder().encode("not actually pdf")],
  ])("refuses a disallowed MIME or mismatched bytes", async (type, bytes) => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart(type, bytes) });
    expect(response.status).toBe(415);
    expect(sendChatAttachment).not.toHaveBeenCalled();
  });

  // com.cozylabs.chat-audio 1: a voice note rides the same one-file route as a document. The bytes
  // are checked with the same magic the attach media route uses, and an m4a alias is canonical.
  const ftyp = (brand: string) => Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((ch) => ch.charCodeAt(0))]);
  const id3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0]);
  const wave = Uint8Array.from([...new TextEncoder().encode("RIFF"), 4, 0, 0, 0, ...new TextEncoder().encode("WAVE")]);

  it.each([
    ["audio/mp4", "voice.m4a", "audio/mp4", ftyp("M4A ")],
    ["audio/mpeg", "voice.mp3", "audio/mpeg", id3],
    ["audio/wav", "voice.wav", "audio/wav", wave],
    ["audio/x-wav", "voice.wav", "audio/x-wav", wave],
    ["audio/m4a", "voice.m4a", "audio/mp4", ftyp("M4A ")],
    ["audio/x-m4a", "voice.m4a", "audio/mp4", ftyp("M4A ")],
    ["application/octet-stream", "voice.m4a", "audio/mp4", ftyp("M4A ")],
    ["audio/x-m4a", "Voice.M4A", "audio/mp4", ftyp("M4A ")],
  ])("accepts a '%s' voice note named %s as %s", async (type, name, mime, bytes) => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart(type, bytes, name) });
    expect(response.status).toBe(202);
    expect(sendChatAttachment).toHaveBeenCalledWith("sage", expect.objectContaining({ mime, name }), { deviceId: "device-1" });
  });

  // A file part with no Content-Type of its own is "text/plain" once parsed, which the route
  // admits, so only the raw part headers can tell "declared nothing" from "declared text".
  it("reads an untyped voice.m4a part as audio/mp4", async () => {
    const { app, sendChatAttachment } = fixture();
    const boundary = "cozy-untyped-part";
    const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice.m4a"\r\n\r\n`);
    const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const voice = ftyp("M4A ");
    const body = new Uint8Array(head.byteLength + voice.byteLength + tail.byteLength);
    body.set(head);
    body.set(voice, head.byteLength);
    body.set(tail, head.byteLength + voice.byteLength);
    const response = await app.request("/bots/sage/chat/attachments", {
      method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body,
    });
    expect(response.status).toBe(202);
    expect(sendChatAttachment).toHaveBeenCalledWith("sage", expect.objectContaining({ mime: "audio/mp4", name: "voice.m4a" }), { deviceId: "device-1" });
  });

  // Hermes classifies an attachment by its extension before its type, so the stored name must
  // carry the canonical extension of the type the gateway accepted.
  it.each([
    ["audio/mp4", "voice.mp4", ftyp("M4A "), "audio/mp4", "voice.m4a"],
    ["audio/mpeg", "memo", id3, "audio/mpeg", "memo.mp3"],
    ["text/plain", "notes.m4a", new TextEncoder().encode("plain notes"), "text/plain", "notes.txt"],
    ["application/pdf", "Report.PDF", new TextEncoder().encode("%PDF-1.7\n"), "application/pdf", "Report.PDF"],
  ])("stores a %s file named %s under the accepted type's extension", async (type, name, bytes, mime, stored) => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart(type, bytes, name) });
    expect(response.status).toBe(202);
    expect(sendChatAttachment).toHaveBeenCalledWith("sage", expect.objectContaining({ mime, name: stored }), { deviceId: "device-1" });
  });

  it.each([
    ["text/plain; charset=utf-8", "notes.txt", new TextEncoder().encode("plain notes"), "text/plain"],
    ["audio/wav; codecs=1", "voice.wav", wave, "audio/wav"],
  ])("ignores the parameters on a declared %s", async (type, name, bytes, mime) => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart(type, bytes, name) });
    expect(response.status).toBe(202);
    expect(sendChatAttachment).toHaveBeenCalledWith("sage", expect.objectContaining({ mime }), { deviceId: "device-1" });
  });

  it.each([
    ["audio/mp4", "voice.m4a", ftyp("qt  ")],
    ["audio/wav", "voice.wav", id3],
    ["audio/mpeg", "voice.mp3", wave],
    ["audio/x-m4a", "voice.m4a", new TextEncoder().encode("not audio at all")],
    ["application/octet-stream", "voice.m4a", new TextEncoder().encode("not audio at all")],
  ])("refuses a %s voice note named %s whose bytes contradict it", async (type, name, bytes) => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart(type, bytes, name) });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ reason: "content_type" });
    expect(sendChatAttachment).not.toHaveBeenCalled();
  });

  it("holds a voice note to the 20 MiB attachment cap, not the 40 MiB assistant audio cap", async () => {
    const { app, sendChatAttachment } = fixture();
    const bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    bytes.set(ftyp("M4A "));
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: multipart("audio/mp4", bytes, "voice.m4a") });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ reason: "too_large" });
    expect(sendChatAttachment).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared multipart request before parsing it", async () => {
    const { app, sendChatAttachment } = fixture();
    const response = await app.request("/bots/sage/chat/attachments", {
      method: "POST", headers: { "content-length": String(21 * 1024 * 1024) }, body: multipart("application/pdf", new TextEncoder().encode("%PDF-1.7\n")),
    });
    expect(response.status).toBe(413);
    expect(sendChatAttachment).not.toHaveBeenCalled();
  });

  it("refuses a multipart body with more than one file", async () => {
    const { app, sendChatAttachment } = fixture();
    const form = multipart("application/pdf", new TextEncoder().encode("%PDF-1.7\n"));
    form.append("file", new Blob([new TextEncoder().encode("%PDF-1.7\n")], { type: "application/pdf" }), "second.pdf");
    const response = await app.request("/bots/sage/chat/attachments", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(sendChatAttachment).not.toHaveBeenCalled();
  });

  it("serves attachment bytes as a download with the sanitized filename", async () => {
    const { app } = fixture();
    const response = await app.request(`/bots/sage/chat/attachments/${fileId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('filename="report.pdf"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  // A scheduled/proactive delivery's attachment is stored and retained like any other, but its
  // id was rejected by the fetch route's shape check before any lookup ran: the photo rendered
  // once from the delivery and then read as "no longer available" forever. The route must serve
  // every id the attach media store was willing to accept on upload.
  it("serves an attachment whose id the media store accepted, prefix and all", async () => {
    const { app } = fixture();
    const scheduledId = `scheduled_media_${"b".repeat(32)}`;
    const response = await app.request(`/bots/sage/chat/attachments/${scheduledId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain('filename="report.pdf"');
  });

  it.each(["../secret", "a/b", "with.dot", "", "x".repeat(129)])(
    "still refuses a path-shaped or oversized id before any lookup (%s)",
    async (bad) => {
      const { app } = fixture();
      const response = await app.request(
        `/bots/sage/chat/attachments/${encodeURIComponent(bad)}`,
      );
      expect(response.status).not.toBe(200);
    },
  );
});

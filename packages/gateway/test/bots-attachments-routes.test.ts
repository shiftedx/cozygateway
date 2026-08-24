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

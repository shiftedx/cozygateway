import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";

import { openStorage } from "../src/storage.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";
import { registerBotRoutes } from "../src/hermes-bridge/routes.ts";

type Env = { Variables: { deviceId: string } };
const image = { type: "attachment" as const, fileId: "a".repeat(32), name: "quarterly-chart.png", mimeType: "image/png", size: 120, mediaKind: "image" as const };
const report = { type: "attachment" as const, fileId: "b".repeat(32), name: "security-report.pdf", mimeType: "application/pdf", size: 900, mediaKind: "file" as const };

describe("capability-26 attachment history", () => {
  it("indexes only agent-sent artifacts across historical sessions with search and filters", () => {
    const storage = openStorage(":memory:");
    const oldSession = storage.nativeBotChat("sage", 1).sessionId;
    storage.appendNativeBotMessage({ bot: "sage", sessionId: oldSession, messageId: "old-report", role: "assistant", text: "Quarterly security review", at: 100, attachments: [report] });
    const currentSession = storage.resetNativeBotChat("sage", 200);
    storage.appendNativeBotMessage({ bot: "sage", sessionId: currentSession, messageId: "chart", role: "assistant", text: "Revenue chart", at: 300, attachments: [image] });
    storage.appendNativeBotMessage({ bot: "sage", sessionId: currentSession, messageId: "user-photo", role: "user", text: "my upload", at: 400, attachments: [image] });
    const foreign = storage.nativeBotChat("hidden", 1).sessionId;
    storage.appendNativeBotMessage({ bot: "hidden", sessionId: foreign, messageId: "foreign", role: "assistant", text: "not configured", at: 500, attachments: [image] });

    const all = storage.nativeBotAttachmentHistory({ bots: ["sage"], offset: 0, limit: 10 });
    expect(all.map((item) => item.messageId)).toEqual(["chart", "old-report"]);
    expect(all[1]).toMatchObject({ bot: "sage", sessionId: oldSession, caption: "Quarterly security review", attachment: report });
    expect(storage.nativeBotAttachmentHistory({ bots: ["sage"], query: "SECURITY", kind: "file", offset: 0, limit: 10 })).toHaveLength(1);
    expect(storage.nativeBotAttachmentHistory({ bots: ["sage"], kind: "image", since: 301, offset: 0, limit: 10 })).toEqual([]);
  });

  it("validates and forwards authenticated search, type, agent, date, and pagination", async () => {
    const app = new Hono<Env>();
    const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
      c.set("deviceId", "device-1");
      await next();
    };
    const attachmentHistory = vi.fn(() => ({ items: [], nextOffset: null }));
    registerBotRoutes(app, requireDevice, { attachmentHistory } as unknown as BotsSurface);

    const response = await app.request("/bots/attachments?q=report&kind=file&bot=Sage&since=100&offset=20&limit=25");
    expect(response.status).toBe(200);
    expect(attachmentHistory).toHaveBeenCalledWith({ query: "report", kind: "file", bot: "sage", since: 100, offset: 20, limit: 25 });
    expect(await response.json()).toEqual({ items: [], nextOffset: null });
    expect((await app.request("/bots/attachments?kind=archive")).status).toBe(400);
    expect((await app.request("/bots/attachments?limit=101")).status).toBe(400);
  });
});

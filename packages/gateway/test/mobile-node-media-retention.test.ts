import { describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.ts";
import { hashToken } from "../src/auth.ts";
import { createApp } from "../src/http.ts";
import { ATTACH_MEDIA_TTL_MS } from "../src/hermes-bridge/photos.ts";
import { openStorage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";

const config: GatewayConfig = {
  name: "mobile-media-retention-test",
  port: 0,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermes: testHermes(),
};

describe("mobile-node media retention", () => {
  it("assigns uploaded media the bounded attachment expiry and makes it unreadable at that deadline", async () => {
    const storage = openStorage(":memory:");
    const now = 1_000;
    const token = "device-token";
    storage.createDevice({ id: "device-1", name: "Test phone", tokenHash: hashToken(token), createdAt: now });
    let completed: unknown;
    const app = createApp({
      storage,
      config,
      gatewayInfo: { name: config.name, version: "0", contract: "v1" },
      beginMobileMediaUpload: (deviceId, requestId, lease) =>
        deviceId === "device-1" && requestId === "request-1" && lease === "x".repeat(43)
          ? { agentId: "sage", complete: (media) => { completed = media; return true; } }
          : undefined,
      presenceOf: () => "online",
      submitUserMessage: () => { throw new Error("not used by mobile media test"); },
      interruptThread: () => "idle",
      resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => {},
      now: () => now,
    });
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    try {
      const response = await app.request("/mobile-node/media/request-1", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/png",
          "x-mobile-node-lease": "x".repeat(43),
          "x-attach-filename": "camera.png",
        },
        body: bytes,
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { media: { mediaId: string; expiresAt?: number } };
      expect(body.media.expiresAt).toBe(now + ATTACH_MEDIA_TTL_MS);
      expect(completed).toMatchObject({ expiresAt: now + ATTACH_MEDIA_TTL_MS });
      expect(storage.attachMediaInfo("sage", body.media.mediaId, now)?.descriptor).toMatchObject({
        expiresAt: now + ATTACH_MEDIA_TTL_MS,
      });
      expect(storage.attachMediaSlice("sage", body.media.mediaId, 0, 1, now + ATTACH_MEDIA_TTL_MS - 1)).toBeDefined();
      expect(storage.attachMediaInfo("sage", body.media.mediaId, now + ATTACH_MEDIA_TTL_MS)).toBeUndefined();
      expect(storage.attachMediaSlice("sage", body.media.mediaId, 0, 1, now + ATTACH_MEDIA_TTL_MS)).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startGateway, type RunningGateway } from "../src/server.ts";

describe("attach-v1 authenticated media side channel", () => {
  let gateway: RunningGateway;
  const env = "ATTACH_V1_MEDIA_TOKEN";
  const token = "media-secret";
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  beforeEach(async () => {
    process.env[env] = token;
    gateway = await startGateway({
      name: "media", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
      agents: [{ id: "sage", name: "Sage", backend: "attach", options: { tokenEnv: env } }],
    });
  });
  afterEach(async () => { await gateway.close(); delete process.env[env]; });

  it("validates auth, hash, type and size then supports range download", async () => {
    const url = `${gateway.url}/attach/v1/media/media_1`;
    expect((await fetch(url, { method: "POST", body: png })).status).toBe(401);
    const bad = await fetch(url, {
      method: "POST", body: png,
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png", "x-attach-filename": "x.png", "x-attach-sha256": "0".repeat(64) },
    });
    expect(bad.status).toBe(422);
    const sha = createHash("sha256").update(png).digest("hex");
    const uploaded = await fetch(url, {
      method: "POST", body: png,
      headers: { authorization: `Bearer ${token}`, "content-type": "image/png", "x-attach-filename": "x.png", "x-attach-sha256": sha },
    });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toMatchObject({ media: { mediaId: "media_1", family: "image", byteCount: 8, sha256: sha } });

    const ranged = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: "bytes=1-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 1-3/8");
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(png.slice(1, 4));
  });
});

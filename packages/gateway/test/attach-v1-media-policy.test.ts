import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ASSISTANT_MEDIA_TYPES } from "../src/hermes-bridge/assistant-media.ts";
import { startGateway, type RunningGateway } from "../src/server.ts";

/** One sample per allowlisted MIME, each carrying the format magic the gateway checks. The map is
 *  keyed by the same strings as `ASSISTANT_MEDIA_TYPES`, and the enumeration test fails if the
 *  allowlist grows a type this file has no sample for: a new type nobody exercised end to end is
 *  exactly the accept-but-never-serve gap this suite exists to stop. */
const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
const ftyp = (brand: string): Uint8Array =>
  Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, ...[...brand].map((ch) => ch.charCodeAt(0))]);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

const SAMPLES = new Map<string, Uint8Array>([
  ["image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
  ["image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
  ["image/gif", text("GIF89a\0\0")],
  ["image/webp", Uint8Array.from([...text("RIFF"), 4, 0, 0, 0, ...text("WEBP")])],
  ["video/mp4", ftyp("isom")],
  ["video/quicktime", ftyp("qt  ")],
  ["audio/mp4", ftyp("isom")],
  ["audio/mpeg", Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0])],
  ["audio/wav", Uint8Array.from([...text("RIFF"), 4, 0, 0, 0, ...text("WAVE")])],
  ["audio/x-wav", Uint8Array.from([...text("RIFF"), 4, 0, 0, 0, ...text("WAVE")])],
  ["application/pdf", text("%PDF-1.7\n")],
  ["text/plain", text("hello")],
  ["text/markdown", text("# hello")],
  ["text/csv", text("a,b\n1,2\n")],
  ["application/json", text('{"ok":true}')],
  ["application/rtf", text("{\\rtf1 hello}")],
  ["text/rtf", text("{\\rtf1 hello}")],
  ["application/msword", ole],
  ["application/vnd.ms-excel", ole],
  ["application/vnd.ms-powerpoint", ole],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", zip],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", zip],
  ["application/vnd.oasis.opendocument.text", zip],
  ["application/vnd.oasis.opendocument.spreadsheet", zip],
  ["application/vnd.oasis.opendocument.presentation", zip],
  ["application/zip", zip],
]);

describe("attach-v1 media policy: allowlist and rejection shapes", () => {
  let gateway: RunningGateway;
  const env = "ATTACH_V1_POLICY_TOKEN";
  const controlEnv = "ATTACH_V1_POLICY_CONTROL_TOKEN";
  const token = "policy-secret";
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);

  const upload = async (
    mediaId: string,
    mime: string,
    bytes: Uint8Array,
    filename = "sample.bin",
  ): Promise<Response> =>
    fetch(`${gateway.url}/attach/v1/media/${mediaId}`, {
      method: "POST",
      body: bytes.slice().buffer as ArrayBuffer,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": mime,
        "x-attach-filename": filename,
        "x-attach-sha256": createHash("sha256").update(bytes).digest("hex"),
      },
    });

  beforeEach(async () => {
    process.env[env] = token;
    process.env[controlEnv] = "policy-control";
    gateway = await startGateway({
      name: "policy",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: {
        url: "ws://127.0.0.1:1/api/ws",
        tokenEnv: controlEnv,
        profiles: { sage: { tokenEnv: env, name: "Sage" } },
      },
    });
  });
  afterEach(async () => {
    await gateway.close();
    delete process.env[env];
    delete process.env[controlEnv];
  });

  it("accepts exactly the documented allowlist and serves every accepted type back", async () => {
    expect([...SAMPLES.keys()].sort()).toEqual([...ASSISTANT_MEDIA_TYPES.keys()].sort());
    // The baseline policy in contract/ext-bots-v1.md, spelled out so a silent removal fails here.
    for (const baseline of [
      "image/png", "image/jpeg", "image/webp", "image/gif", "video/mp4",
      "audio/mp4", "audio/mpeg", "audio/wav", "application/pdf",
    ]) {
      expect(ASSISTANT_MEDIA_TYPES.has(baseline)).toBe(true);
    }
    for (const excluded of ["image/svg+xml", "text/html"]) {
      expect(ASSISTANT_MEDIA_TYPES.has(excluded)).toBe(false);
    }

    let index = 0;
    for (const [mime, sample] of SAMPLES) {
      const mediaId = `allow_${index++}`;
      const accepted = await upload(mediaId, mime, sample);
      expect(accepted.status, `upload ${mime}`).toBe(201);
      const expected = ASSISTANT_MEDIA_TYPES.get(mime)!;
      expect(await accepted.json()).toMatchObject({
        media: { mediaId, mimeType: mime, family: expected.kind, byteCount: sample.byteLength },
      });

      const served = await fetch(`${gateway.url}/attach/v1/media/${mediaId}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(served.status, `download ${mime}`).toBe(200);
      expect(served.headers.get("content-type")).toBe(mime);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(served.headers.get("accept-ranges")).toBe("bytes");
      expect(served.headers.get("content-disposition")).toContain("attachment");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(sample);
    }
  });

  it("carries a bare zip as a file attachment under the document cap", async () => {
    const accepted = ASSISTANT_MEDIA_TYPES.get("application/zip")!;
    expect(accepted).toMatchObject({ ext: "zip", kind: "file" });
    expect(accepted.maxBytes).toBe(ASSISTANT_MEDIA_TYPES.get("application/pdf")!.maxBytes);

    const response = await upload("zip_1", "application/zip", zip, "bundle.zip");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      media: { mediaId: "zip_1", mimeType: "application/zip", family: "file" },
    });
  });

  it("answers 413 with the document cap when a zip runs past it", async () => {
    const limit = ASSISTANT_MEDIA_TYPES.get("application/zip")!.maxBytes;
    const oversized = new Uint8Array(limit + 1);
    oversized.set(zip);
    const refused = await upload("zip_big", "application/zip", oversized, "big.zip");
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ reason: "too_large", limitBytes: limit });
  });

  it("refuses a type off the allowlist with 415 naming the received content type", async () => {
    const refused = await upload("svg_1", "image/svg+xml", text("<svg/>"), "x.svg");
    expect(refused.status).toBe(415);
    const body = await refused.json();
    expect(body).toMatchObject({
      error: { code: "invalid_request" },
      reason: "content_type",
      receivedContentType: "image/svg+xml",
    });
    expect(body.error.message).toContain("image/svg+xml");
  });

  it("sanitizes the echoed content type instead of reflecting attacker text", async () => {
    const refused = await upload("html_1", 'text/html; charset="<script>x</script>"', text("<b>hi</b>"));
    expect(refused.status).toBe(415);
    const body = await refused.json();
    expect(body.receivedContentType).not.toContain("<");
    expect(body.receivedContentType).not.toContain(" ");
    expect(body.receivedContentType.length).toBeLessThanOrEqual(80);
    expect(JSON.stringify(body)).not.toContain("hi");
  });

  it("refuses bytes that contradict an allowed declaration without echoing them", async () => {
    const refused = await upload("mismatch_1", "image/png", text("NOT-A-PNG-SECRETPAYLOAD"), "x.png");
    expect(refused.status).toBe(415);
    const body = await refused.json();
    expect(body).toMatchObject({ reason: "content_type" });
    expect(JSON.stringify(body)).not.toContain("SECRETPAYLOAD");
  });

  it("answers 400 for a zero-byte upload rather than calling it oversized", async () => {
    const refused = await upload("empty_1", "image/png", new Uint8Array(0), "x.png");
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ reason: "empty" });
  });

  it("answers 413 with the byte limit for that type when the body runs past the cap", async () => {
    const limit = ASSISTANT_MEDIA_TYPES.get("image/png")!.maxBytes;
    const oversized = new Uint8Array(limit + 1);
    oversized.set(png.slice(0, 8));
    const refused = await upload("large_1", "image/png", oversized, "big.png");
    expect(refused.status).toBe(413);
    const body = await refused.json();
    expect(body).toMatchObject({ reason: "too_large", limitBytes: limit });
    expect(body.error.message).toContain(String(limit));
  });

  it("names the declared type's own cap, not the largest cap in the table", async () => {
    expect(ASSISTANT_MEDIA_TYPES.get("image/png")!.maxBytes).toBeLessThan(
      ASSISTANT_MEDIA_TYPES.get("video/mp4")!.maxBytes,
    );
  });

  it("does not rate limit this route, so a producer never sees an undocumented 429", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      statuses.push((await upload(`burst_${index}`, "image/png", png, "burst.png")).status);
    }
    expect(statuses.every((status) => status === 201)).toBe(true);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  BotAvatarGenerateResponseSchema,
  BotAvatarPetGallerySchema,
  BotAvatarSetResponseSchema,
  BotPresentationResponseSchema,
  BotSummarySchema,
  check,
} from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { decodeAvatar, rosterAvatar, sniffAvatar } from "../src/hermes-bridge/avatar.ts";
import { buildRoster, parseProfilesList } from "../src/hermes-bridge/roster.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 81: bot avatars over `profiles.get_asset` / `set_asset`, `image.generate` and the
 *  petdex `pet.gallery` / `pet.thumb` RPCs, plus the look keys on the presentation route. The fake
 *  answers in the shapes recorded live on 2026-09-23 (Mac cleo read-only; the Docker host's pixel
 *  for writes): `get_asset` -> `{found, mime, size, data}`, `image.generate {probe}` ->
 *  `{available: false}`, `pet.thumb` -> a 96x104 PNG data URI. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A 1x1 PNG, the smallest real picture. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

interface Asset { mime: string; bytes: Buffer }

interface Harness {
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
  asset: { current: Asset | null };
  blob: { current: Record<string, unknown> | null; revision: number };
}

async function setup(opts: { imageBackend?: boolean } = {}): Promise<Harness> {
  const calls: Harness["calls"] = [];
  const asset: Harness["asset"] = { current: null };
  const blob: Harness["blob"] = { current: { chat: "c" }, revision: 2 };
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [
          { name: "default", ui_meta: null, ui_meta_revisions: {}, has_avatar: false },
          {
            name: "pixel",
            ui_meta: blob.current === null ? null : { "hermes-bots": blob.current },
            ui_meta_revisions: { "hermes-bots": blob.revision },
            has_avatar: asset.current !== null,
          },
        ],
        bot_mode_protocol: true,
      }),
      "profiles.configure": (params) => {
        calls.push({ method: "profiles.configure", params });
        blob.current = (params["ui_meta"] as Record<string, Record<string, unknown>>)["hermes-bots"] ?? null;
        blob.revision += 1;
        return { ok: true, applied: { ui_meta: true, ui_meta_revisions: { "hermes-bots": blob.revision } } };
      },
      "profiles.get_asset": (params) => {
        calls.push({ method: "profiles.get_asset", params });
        if (asset.current === null) return { found: false };
        return {
          found: true,
          mime: asset.current.mime,
          size: asset.current.bytes.byteLength,
          data: `data:${asset.current.mime};base64,${asset.current.bytes.toString("base64")}`,
        };
      },
      "profiles.set_asset": (params) => {
        calls.push({ method: "profiles.set_asset", params });
        if (params["clear"] === true) {
          const removed = asset.current === null ? 0 : 1;
          asset.current = null;
          return { ok: true, asset: "avatar", size: 0, removed };
        }
        const { mime, bytes } = decodeAvatar(String(params["data"]));
        asset.current = { mime, bytes };
        return { ok: true, asset: "avatar", size: bytes.byteLength };
      },
      "image.generate": (params) => {
        calls.push({ method: "image.generate", params });
        if (params["probe"] === true) return { available: opts.imageBackend === true };
        if (opts.imageBackend !== true) {
          return { available: false, success: false, error: "No image generation backend configured (run `hermes tools` to enable one)." };
        }
        return { available: true, success: true, image: "/tmp/x.png", image_data: PNG_URL };
      },
      "pet.gallery": (params) => {
        calls.push({ method: "pet.gallery", params });
        return {
          enabled: false,
          active: "",
          pets: [
            { slug: "homelander", displayName: "Homelander", installed: false, spritesheetUrl: "https://assets.petdex.dev/pets/homelander-dbbb6a60a484/sprite.webp", curated: false, generated: false },
            { slug: "mochi", displayName: "Mochi", installed: false, spritesheetUrl: "https://assets.petdex.dev/curated/mochi/sprite.webp", curated: true, generated: false },
            { slug: "hatched", displayName: "Hatched", installed: true, spritesheetUrl: "", generated: true },
            { displayName: "no slug" },
          ],
        };
      },
      "pet.thumb": (params) => {
        calls.push({ method: "pet.thumb", params });
        return params["slug"] === "missing"
          ? { ok: false, slug: "missing" }
          : { ok: true, slug: params["slug"], dataUri: PNG_URL };
      },
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, now: () => 1_800_000_000_000, logSink: () => {} });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 81 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
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
  await until(() => client.state() === "online");
  return {
    calls,
    asset,
    blob,
    authed: async (path, init) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } }),
  };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("avatar: pure rules", () => {
  it("sniffs PNG, JPEG and WebP from the bytes, exactly as Hermes does", () => {
    expect(sniffAvatar(PNG)).toBe("image/png");
    expect(sniffAvatar(JPEG)).toBe("image/jpeg");
    expect(sniffAvatar(WEBP)).toBe("image/webp");
    expect(sniffAvatar(Buffer.from("GIF89a"))).toBeUndefined();
  });

  it("takes the sniffed type over the declared one, and refuses what Hermes would", () => {
    expect(decodeAvatar(`data:image/webp;base64,${PNG.toString("base64")}`).mime).toBe("image/png");
    expect(decodeAvatar(PNG.toString("base64")).mime).toBe("image/png");
    expect(() => decodeAvatar("data:image/gif;base64,R0lGODlhAQABAAAAACw=")).toThrow(/PNG, JPEG or WebP/);
    expect(() => decodeAvatar("data:image/png;base64,***")).toThrow(/base64/);
    const big = Buffer.concat([PNG, Buffer.alloc(2_000_001)]);
    expect(() => decodeAvatar(big.toString("base64"))).toThrow(/limit/);
  });

  it("draws the stored asset unless the blob says the look is a drawn face", () => {
    expect(rosterAvatar("pixel", true, { imageKind: "photo" }, 7)).toEqual({ kind: "image", imageUrl: "/bots/pixel/avatar?v=7" });
    expect(rosterAvatar("pixel", true, null, 0)).toEqual({ kind: "image", imageUrl: "/bots/pixel/avatar?v=0" });
    // A 160px raster of the face, pushed for inter-agent notices: the live face wins.
    expect(rosterAvatar("pixel", true, { imageKind: "shape", shape: "blobatar::cloud" }, 3)).toBeUndefined();
    // A legacy pet slug with no asset renders as the pet, not as a jelly.
    expect(rosterAvatar("pixel", false, { pet: "mochi" }, 1)).toEqual({ kind: "pet", petSlug: "mochi", imageUrl: "/bots/pixel/avatar/pets/mochi" });
    expect(rosterAvatar("pixel", false, { pet: "../x" }, 1)).toBeUndefined();
    expect(rosterAvatar("pixel", false, { shape: "circle" }, 1)).toBeUndefined();
  });

  it("puts the avatar on the roster row, versioned by the blob revision", () => {
    const { profiles } = parseProfilesList({
      profiles: [{ name: "pixel", has_avatar: true, ui_meta: { "hermes-bots": { imageKind: "photo" } }, ui_meta_revisions: { "hermes-bots": 5 } }],
    });
    const [row] = buildRoster(profiles, { routedProfile: null, gatewayState: "idle", now: 0 });
    expect(check(BotSummarySchema, row)).toBe(true);
    expect(row?.avatar).toEqual({ kind: "image", imageUrl: "/bots/pixel/avatar?v=5" });
  });
});

describe("GET/PUT/DELETE /bots/:name/avatar", () => {
  it("sets, reads back as bytes, and clears (live pixel round trip)", async () => {
    const h = await setup();
    expect((await h.authed("/bots/pixel/avatar")).status).toBe(404);

    const put = await h.authed("/bots/pixel/avatar", json("PUT", { data: PNG_URL }));
    expect(put.status).toBe(200);
    const body = await put.json();
    expect(check(BotAvatarSetResponseSchema, body)).toBe(true);
    expect(body).toEqual({ name: "pixel", hasAvatar: true, size: PNG.byteLength });
    expect(h.calls.find((c) => c.method === "profiles.set_asset")?.params)
      .toEqual({ name: "pixel", asset: "avatar", data: PNG_URL });

    const got = await h.authed("/bots/pixel/avatar");
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await got.arrayBuffer()).equals(PNG)).toBe(true);

    const cleared = await h.authed("/bots/pixel/avatar", { method: "DELETE" });
    expect(await cleared.json()).toEqual({ name: "pixel", hasAvatar: false, size: 0 });
    expect(h.calls.at(-1)?.params).toEqual({ name: "pixel", asset: "avatar", clear: true });
    expect(h.asset.current).toBeNull();
  });

  it("refuses a GIF, junk, and an unknown bot without calling set_asset", async () => {
    const h = await setup();
    expect((await h.authed("/bots/pixel/avatar", json("PUT", { data: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" }))).status).toBe(400);
    expect((await h.authed("/bots/pixel/avatar", json("PUT", { image: PNG_URL }))).status).toBe(400);
    expect((await h.authed("/bots/pixel/avatar", json("PUT", {}))).status).toBe(400);
    expect((await h.authed("/bots/nobody/avatar", json("PUT", { data: PNG_URL }))).status).toBe(404);
    expect((await h.authed("/bots/nobody/avatar")).status).toBe(404);
    expect(h.calls.filter((c) => c.method === "profiles.set_asset")).toHaveLength(0);
  });
});

describe("POST /bots/:name/avatar/generate", () => {
  it("probes first, and says unavailable on a host with no image backend (live Mac and pixel)", async () => {
    const h = await setup();
    const res = await h.authed("/bots/pixel/avatar/generate", json("POST", { probe: true }));
    const body = await res.json();
    expect(check(BotAvatarGenerateResponseSchema, body)).toBe(true);
    expect(body).toEqual({ available: false });
    expect(h.calls.at(-1)).toEqual({ method: "image.generate", params: { probe: true } });
    const gen = await (await h.authed("/bots/pixel/avatar/generate", json("POST", { prompt: "a fox" }))).json();
    expect(gen).toMatchObject({ available: false, success: false });
  });

  it("returns the portrait as a data URL for the phone to preview, and saves nothing", async () => {
    const h = await setup({ imageBackend: true });
    const res = await h.authed("/bots/pixel/avatar/generate", json("POST", { prompt: "a cheerful fox" }));
    expect(await res.json()).toEqual({ available: true, success: true, image: PNG_URL });
    const call = h.calls.at(-1);
    expect(call?.params["prompt"]).toBe("a cheerful fox. Avatar for an AI agent: centered, bold flat vector style, solid color background, no text.");
    expect(call?.params["aspect_ratio"]).toBe("square");
    expect(h.calls.filter((c) => c.method === "profiles.set_asset")).toHaveLength(0);
  });

  it("needs a prompt unless probing", async () => {
    const h = await setup();
    expect((await h.authed("/bots/pixel/avatar/generate", json("POST", {}))).status).toBe(400);
    expect((await h.authed("/bots/pixel/avatar/generate", json("POST", { prompt: "  " }))).status).toBe(400);
  });
});

describe("pets", () => {
  it("lists the gallery installed and curated first, dropping rows without a slug", async () => {
    const h = await setup();
    const res = await h.authed("/bots/pixel/avatar/pets?localOnly=1");
    const body = await res.json();
    expect(check(BotAvatarPetGallerySchema, body)).toBe(true);
    expect(body.pets.map((p: { slug: string }) => p.slug)).toEqual(["hatched", "mochi", "homelander"]);
    expect(h.calls.at(-1)).toEqual({ method: "pet.gallery", params: { localOnly: true } });
  });

  it("crops a thumbnail through pet.thumb, and serves a legacy pet slug as bytes", async () => {
    const h = await setup();
    const url = "https://assets.petdex.dev/pets/homelander-dbbb6a60a484/sprite.webp";
    const thumb = await (await h.authed("/bots/pixel/avatar/pets/thumb", json("POST", { slug: "homelander", url }))).json();
    expect(thumb).toEqual({ ok: true, image: PNG_URL });
    expect(h.calls.at(-1)).toEqual({ method: "pet.thumb", params: { slug: "homelander", url } });
    const bytes = await h.authed("/bots/pixel/avatar/pets/mochi");
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect((await h.authed("/bots/pixel/avatar/pets/missing")).status).toBe(404);
    expect((await h.authed("/bots/pixel/avatar/pets/thumb", json("POST", { slug: "../x" }))).status).toBe(400);
  });
});

describe("the look on the presentation route", () => {
  it("writes shape, color, custom, imageKind and the namespaced cozychat record, keeping other keys", async () => {
    const h = await setup();
    const res = await h.authed("/bots/pixel/presentation", json("PATCH", {
      shape: "blobatar::cloud",
      color: "#5fb8b0",
      custom: true,
      imageKind: "shape",
      cozychat: { jelly: "huddle-lagoon-teal-considering", seed: "pixel", shape: "blobatar::cloud" },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(check(BotPresentationResponseSchema, body)).toBe(true);
    expect(h.blob.current).toEqual({
      chat: "c",
      shape: "blobatar::cloud",
      color: "#5fb8b0",
      custom: true,
      imageKind: "shape",
      cozychat: { jelly: "huddle-lagoon-teal-considering", seed: "pixel", shape: "blobatar::cloud" },
    });
    // A desktop-only look clears the namespaced record with null, as the desktop clears keys.
    await h.authed("/bots/pixel/presentation", json("PATCH", { shape: "circle", cozychat: null }));
    expect(h.blob.current?.["cozychat"]).toBeNull();
    expect(h.blob.current?.["color"]).toBe("#5fb8b0");
  });

  it("refuses a malformed look", async () => {
    const h = await setup();
    expect((await h.authed("/bots/pixel/presentation", json("PATCH", { imageKind: "gif" }))).status).toBe(400);
    expect((await h.authed("/bots/pixel/presentation", json("PATCH", { cozychat: { prism: "red" } }))).status).toBe(400);
    expect((await h.authed("/bots/pixel/presentation", json("PATCH", { cozychat: { extra: 1 } }))).status).toBe(400);
  });
});

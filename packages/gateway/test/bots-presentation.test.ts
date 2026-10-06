import { afterEach, describe, expect, it } from "vitest";
import { BotPresentationResponseSchema, check } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { mergePresentation, presentationFromMeta, presentationRow } from "../src/hermes-bridge/presentation.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 80: `GET`/`PATCH /bots/:name/presentation` over `profiles.list` + `profiles.configure`
 *  with Hermes's per-key compare-and-swap. The fake below answers in the exact shapes recorded from
 *  a live Hermes (068db016fb) on 2026-09-23: a pin, a stale-revision unpin (conflict), an unpin. */

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

/** A profile.yaml's ui_meta + revisions, mutated the way `_configure_ui_meta` mutates it. */
interface Stored {
  blob: Record<string, unknown> | null;
  revision: number;
  /** Set false to model a Hermes that predates the revision map. */
  revisions?: boolean;
}

interface Harness {
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  configures: Array<Record<string, unknown>>;
  store: Stored;
}

async function setup(
  store: Stored,
  opts: { beforeConfigure?: (attempt: number, store: Stored) => void } = {},
): Promise<Harness> {
  const configures: Array<Record<string, unknown>> = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({
        profiles: [
          { name: "default", ui_meta: null, ...(store.revisions === false ? {} : { ui_meta_revisions: {} }), has_avatar: false },
          {
            name: "cleo",
            ...(store.revisions === false ? {} : { ui_meta_revisions: store.revision === 0 ? {} : { "hermes-bots": store.revision } }),
            ui_meta: store.blob === null ? null : { "hermes-bots": store.blob },
            has_avatar: false,
          },
        ],
        bot_mode_protocol: true,
      }),
      "profiles.configure": (params) => {
        configures.push(params);
        opts.beforeConfigure?.(configures.length, store);
        const expected = (params["ui_meta_expected_revisions"] as Record<string, unknown> | undefined)?.["hermes-bots"];
        if (expected !== undefined && expected !== store.revision) {
          return {
            ok: false,
            applied: {
              ui_meta: false,
              ui_meta_conflicts: { "hermes-bots": { expected, actual: store.revision } },
              ui_meta_revisions: { "hermes-bots": store.revision },
            },
          };
        }
        store.blob = (params["ui_meta"] as Record<string, Record<string, unknown>>)["hermes-bots"] ?? null;
        store.revision += 1;
        return { ok: true, applied: { ui_meta: true, ui_meta_revisions: { "hermes-bots": store.revision } } };
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
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 80 } },
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
    configures,
    store,
    authed: async (path, init) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } }),
  };
}

const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("presentation: pure rules", () => {
  it("reads only the presentation and look keys and keeps absence distinct from false", () => {
    expect(presentationFromMeta({ chat: "x", group: "g" })).toEqual({});
    expect(presentationFromMeta({ chat: "x", shape: "blobatar::cloud", color: "#8b5cf6", custom: true, imageKind: "shape", image: "data:x" }))
      .toEqual({ shape: "blobatar::cloud", color: "#8b5cf6", custom: true, imageKind: "shape" });
    expect(presentationFromMeta({ imageKind: "gif", custom: "yes", cozychat: { jelly: "ink-quill", seed: "", other: 1 } }))
      .toEqual({ cozychat: { jelly: "ink-quill" } });
    expect(presentationFromMeta({ pinned: false, hidden: true, sectionId: "sec-1", sectionName: "Clients", title: " Cleo " }))
      .toEqual({ pinned: false, hidden: true, sectionId: "sec-1", sectionName: "Clients", title: "Cleo" });
    expect(presentationFromMeta({ sectionId: null, sectionName: "" })).toEqual({});
  });

  it("merges only the patched keys and writes null to clear, as the desktop does", () => {
    const blob = { chat: "20260821_173527_8c03f56a", shape: "blob", sectionId: "sec-1", sectionName: "Clients" };
    expect(mergePresentation(blob, { pinned: true })).toEqual({ ...blob, pinned: true });
    expect(mergePresentation(blob, { sectionId: null, sectionName: null }))
      .toEqual({ chat: blob.chat, shape: "blob", sectionId: null, sectionName: null });
  });

  it("reads the revision off the recorded live row, and null when Hermes has no revision map", () => {
    const live = { profiles: [{ name: "cleo", ui_meta_revisions: {}, ui_meta: { "hermes-bots": { chat: "c" } } }] };
    expect(presentationRow(live, "cleo")).toEqual({ presentation: {}, revision: 0, blob: { chat: "c" } });
    const old = { profiles: [{ name: "cleo", ui_meta: { "hermes-bots": { pinned: true } } }] };
    expect(presentationRow(old, "cleo")?.revision).toBeNull();
    expect(presentationRow(live, "nobody")).toBeUndefined();
  });
});

describe("GET/PATCH /bots/:name/presentation", () => {
  it("reads the presentation and its revision", async () => {
    const h = await setup({ blob: { chat: "20260821_173527_8c03f56a", pinned: true, sectionId: "sec-1", sectionName: "Clients" }, revision: 1 });
    const res = await h.authed("/bots/cleo/presentation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(check(BotPresentationResponseSchema, body)).toBe(true);
    expect(body).toEqual({ name: "cleo", presentation: { pinned: true, sectionId: "sec-1", sectionName: "Clients" }, revision: 1 });
  });

  it("pins then unpins, keeping every other key verbatim and sending the revision it read (live round trip)", async () => {
    const h = await setup({ blob: { chat: "20260821_173527_8c03f56a" }, revision: 0 });
    const pinned = await h.authed("/bots/cleo/presentation", patch({ pinned: true }));
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toEqual({ name: "cleo", presentation: { pinned: true }, revision: 1 });
    expect(h.configures[0]).toEqual({
      name: "cleo",
      ui_meta: { "hermes-bots": { chat: "20260821_173527_8c03f56a", pinned: true } },
      ui_meta_expected_revisions: { "hermes-bots": 0 },
    });
    const unpinned = await h.authed("/bots/cleo/presentation", patch({ pinned: false }));
    expect(await unpinned.json()).toEqual({ name: "cleo", presentation: { pinned: false }, revision: 2 });
    expect(h.store.blob).toEqual({ chat: "20260821_173527_8c03f56a", pinned: false });
  });

  it("re-reads and re-applies only the patched key when another client wins the race", async () => {
    const h = await setup({ blob: { chat: "c", shape: "blob" }, revision: 4 }, {
      // Between our read and our write, a desktop recolours the bot.
      beforeConfigure: (attempt, store) => {
        if (attempt === 1) {
          store.blob = { ...store.blob, color: "amber" };
          store.revision += 1;
        }
      },
    });
    const res = await h.authed("/bots/cleo/presentation", patch({ sectionId: "sec-9", sectionName: "Clients" }));
    expect(res.status).toBe(200);
    expect(h.configures).toHaveLength(2);
    expect((h.configures[1]?.["ui_meta_expected_revisions"] as Record<string, unknown>)["hermes-bots"]).toBe(5);
    // The desktop's colour survives: the retry merged onto the blob it re-read.
    expect(h.store.blob).toEqual({ chat: "c", shape: "blob", color: "amber", sectionId: "sec-9", sectionName: "Clients" });
    expect(h.store.revision).toBe(6);
  });

  it("answers 409 conflict after three lost races, and writes nothing", async () => {
    const h = await setup({ blob: { chat: "c" }, revision: 0 }, {
      beforeConfigure: (_attempt, store) => { store.revision += 1; },
    });
    const res = await h.authed("/bots/cleo/presentation", patch({ hidden: true }));
    expect(res.status).toBe(409);
    expect(h.configures).toHaveLength(3);
    expect(h.store.blob).toEqual({ chat: "c" });
  });

  it("writes without a revision to a Hermes that predates the revision map", async () => {
    const h = await setup({ blob: null, revision: 0, revisions: false });
    const res = await h.authed("/bots/cleo/presentation", patch({ title: "Cleo" }));
    expect(res.status).toBe(200);
    expect(h.configures[0]).toEqual({ name: "cleo", ui_meta: { "hermes-bots": { title: "Cleo" } } });
  });

  it("refuses an empty or malformed patch and an unknown bot", async () => {
    const h = await setup({ blob: null, revision: 0 });
    expect((await h.authed("/bots/cleo/presentation", patch({}))).status).toBe(400);
    expect((await h.authed("/bots/cleo/presentation", patch({ pinned: "yes" }))).status).toBe(400);
    expect((await h.authed("/bots/cleo/presentation", patch({ sectionId: "   " }))).status).toBe(400);
    expect((await h.authed("/bots/cleo/presentation", patch({ extra: 1 }))).status).toBe(400);
    expect((await h.authed("/bots/nobody/presentation")).status).toBe(404);
    expect((await h.authed("/bots/nobody/presentation", patch({ pinned: true }))).status).toBe(404);
    expect(h.configures).toHaveLength(0);
  });
});

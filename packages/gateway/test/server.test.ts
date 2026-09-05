import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HARNESS_UPDATE_CAPABILITY_VERSION,
  HERMES_SESSION_MANAGEMENT_CAPABILITY_ID,
  MOBILE_NODE_CAPABILITY_VERSION,
  type GatewayInfo,
  type ServerFrame,
} from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { startFakeHermesServer } from "./support/fake-hermes-server.ts";
import { maintenanceRuntimeHealth, startGateway, type RunningGateway } from "../src/server.ts";
import { HERMES_GLOBAL_SKILLS_CAPABILITY_ID } from "../src/hermes-bridge/global-skills.ts";
import { openStorage } from "../src/storage.ts";
import { PHOTO_SWEEP_MS } from "../src/hermes-bridge/photos.ts";

let gateway: RunningGateway;

describe("gateway maintenance runtime health wiring", () => {
  it("projects only the co-located CozyAgents runner", () => {
    expect(maintenanceRuntimeHealth({
      harness: "cozyagents",
      coLocatedRunnerId: "local",
      connectedRunners: ["local", "secondary"],
    })).toEqual({ harness: "cozyagents", localRunnerAttached: true });
  });

  it("ignores an offline secondary runner", () => {
    expect(maintenanceRuntimeHealth({
      harness: "cozyagents",
      coLocatedRunnerId: "local",
      connectedRunners: ["secondary"],
    })).toEqual({ harness: "cozyagents", localRunnerAttached: false });
  });
});

beforeEach(async () => {
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  gateway = await startGateway({
    name: "e2e",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermesEndpoints: [{ id: "default", ...testHermes() }],
  });
});

afterEach(async () => {
  await gateway.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

describe("startGateway end to end", () => {
  it.skipIf(process.platform === "win32")(
    "returns an actionable error when settings persistence is lost after startup",
    async () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-settings-unwritable-"));
    const configPath = join(dir, "cozygateway.config.json");
    const source = JSON.stringify({
      name: "Before",
      port: 8787,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
      capabilities: { "com.example.preserved": 1 },
    });
    writeFileSync(configPath, source, { mode: 0o640 });
    const diagnostics: string[] = [];
    const gw = await startGateway({
      name: "Before",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    }, { configPath, traceLog: (line) => diagnostics.push(line) });

    try {
      const pair = await fetch(`${gw.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: gw.issueSetupCode(), deviceName: "settings phone" }),
      });
      const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
      const currentSettings = await fetch(`${gw.url}/gateway/settings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const settings = (await currentSettings.json()) as { name: string; hermesEndpoints: unknown[] };
      chmodSync(dir, 0o555);

      const response = await fetch(`${gw.url}/gateway/settings`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...settings,
          name: "After",
        }),
      });
      const responseText = await response.text();

      expect(response.status, responseText).toBe(409);
      expect(JSON.parse(responseText)).toEqual({
        error: {
          code: "invalid_request",
          message: "Gateway settings cannot be saved because the source configuration is not writable. Check the CozyGateway config mount or file permissions.",
        },
      });
      expect(responseText).not.toContain(configPath);
      expect(responseText).not.toContain(token);
      expect(responseText).not.toContain("TEST_HERMES_CONTROL_TOKEN");
      expect(responseText).not.toMatch(/EACCES|EPERM|EROFS|EBUSY/);
      expect(readFileSync(configPath, "utf8")).toBe(source);
      expect(diagnostics.some((line) =>
        line.includes(configPath) && line.includes("persistence-failed") && line.includes("EACCES"))).toBe(true);
    } finally {
      chmodSync(dir, 0o755);
      await gw.close();
    }
    },
  );

  it("prunes explicitly expired attachment bytes at startup while preserving NULL-expiry plugin media", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cozygateway-attachment-prune-")), "gateway.sqlite");
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor = (mediaId: string, expiresAt?: number) => ({
      mediaId, mimeType: "image/png", byteCount: bytes.byteLength, sha256, filename: `${mediaId}.png`, family: "image" as const,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    const beforeStart = openStorage(dbPath);
    beforeStart.saveAttachMedia("sage", descriptor("expired", 0), bytes, 0);
    beforeStart.saveAttachMedia("sage", descriptor("plugin"), bytes, 0);
    beforeStart.close();

    const gw = await startGateway({
      name: "attachment-prune", port: 0, dbPath, turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    try {
      expect(gw.storage.saveAttachMedia("sage", { ...descriptor("expired"), filename: "replacement.png" }, bytes, Date.now())).toBe(true);
      expect(gw.storage.attachMediaInfo("sage", "plugin", Date.now())?.size).toBe(4);
    } finally {
      await gw.close();
    }
  });

  it("unrefs the attachment sweep and clears it before its storage closes", async () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");
    let gw: RunningGateway | undefined;
    try {
      gw = await startGateway({
        name: "attachment-sweep", port: 0, dbPath: ":memory:", turnTimeoutSeconds: 0,
        hermesEndpoints: [{ id: "default", ...testHermes() }],
      });
      const index = setIntervalSpy.mock.calls.findIndex(([, interval]) => interval === PHOTO_SWEEP_MS);
      expect(index).toBeGreaterThanOrEqual(0);
      const timer = setIntervalSpy.mock.results[index]?.value as NodeJS.Timeout;
      expect(timer.hasRef()).toBe(false);

      await gw.close();
      gw = undefined;
      expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    } finally {
      await gw?.close();
      clearIntervalSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("keeps settings authenticated but non-editable without a source config path", async () => {
    expect((await fetch(`${gateway.url}/gateway/settings`)).status).toBe(401);
    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "settings phone" }),
    });
    const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
    const response = await fetch(`${gateway.url}/gateway/settings`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("pairs and authenticates a client over WebSocket", async () => {
    const code = gateway.issueSetupCode();
    const pairRes = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "e2e phone" }),
    });
    expect(pairRes.status).toBe(200);
    const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

    const seen: ServerFrame[] = [];
    const ws = new WebSocket(`${gateway.url.replace("http", "ws")}/ws`);
    ws.on("message", (d) => seen.push(JSON.parse(String(d)) as ServerFrame));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: deviceToken }));

    const start = Date.now();
    while (!seen.some((f) => f.type === "ready")) {
      if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(seen)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(seen.some((f) => f.type === "ready")).toBe(true);
    ws.close();
  });
});

describe("public deployment startup posture", () => {
  it("rejects an invalid public posture before creating the SQLite database", async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "cozygateway-public-start-")), "gateway.sqlite");
    await expect(startGateway({
      name: "unsafe-public",
      host: "0.0.0.0",
      publicUrl: "https://gateway.example",
      port: 0,
      dbPath,
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    })).rejects.toThrow(/publicUrl.*loopback/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  it("starts a loopback origin with a valid advertised HTTPS origin", async () => {
    const gw = await startGateway({
      name: "safe-public",
      host: "127.0.0.1",
      publicUrl: "https://gateway.example",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    try {
      expect(gw.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect((await fetch(`${gw.url}/health`)).status).toBe(200);
    } finally {
      await gw.close();
    }
  });
});

// Issue #16: GatewayInfo.capabilities travels through GET /health, the pair response, and the
// ready frame -- one shared object, so wiring it once in startGateway covers all three.
describe("GatewayInfo.capabilities wiring", () => {
  it.skipIf(process.platform === "win32")(
    "omits gateway management everywhere when the source config cannot be replaced",
    async () => {
    const dir = mkdtempSync(join(tmpdir(), "cozygateway-settings-unavailable-"));
    const configPath = join(dir, "cozygateway.config.json");
    writeFileSync(configPath, JSON.stringify({
      name: "Unavailable",
      port: 8787,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    }), { mode: 0o640 });
    chmodSync(dir, 0o555);
    const diagnostics: string[] = [];
    let gw: RunningGateway | undefined;

    try {
      gw = await startGateway({
        name: "Unavailable",
        port: 0,
        dbPath: ":memory:",
        turnTimeoutSeconds: 0,
        hermesEndpoints: [{ id: "default", ...testHermes() }],
        capabilities: { "com.cozylabs.gateway-management": 99 },
      }, { configPath, traceLog: (line) => diagnostics.push(line) });
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.["com.cozylabs.gateway-management"]).toBeUndefined();

      const pairRes = await fetch(`${gw.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: gw.issueSetupCode(), deviceName: "unavailable phone" }),
      });
      const paired = (await pairRes.json()) as { deviceToken: string; gateway: GatewayInfo };
      expect(paired.gateway.capabilities?.["com.cozylabs.gateway-management"]).toBeUndefined();

      const frames: ServerFrame[] = [];
      const ws = new WebSocket(`${gw.url.replace("http", "ws")}/ws`);
      ws.on("message", (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token: paired.deviceToken }));
      const readyDeadline = Date.now() + 5_000;
      while (!frames.some((frame) => frame.type === "ready")) {
        if (Date.now() >= readyDeadline) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      ws.close();
      const ready = frames.find((frame) => frame.type === "ready");
      expect(ready?.type === "ready"
        ? ready.gateway.capabilities?.["com.cozylabs.gateway-management"]
        : undefined).toBeUndefined();

      const response = await fetch(`${gw.url}/gateway/settings`, {
        method: "PUT",
        headers: { authorization: `Bearer ${paired.deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "After", hermesEndpoints: [] }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect(diagnostics.some((line) =>
        line.includes(configPath) && line.includes("persistence-unavailable") && line.includes("EACCES"))).toBe(true);
    } finally {
      await gw?.close();
      chmodSync(dir, 0o755);
    }
    },
  );

  // Issue #19 moved the floor: the approval surface is a CORE capability this gateway always
  // implements, so the baseline map is no longer empty. Everything else about the wiring (one
  // shared object across all three positions, config-supplied ids passed through untouched) is
  // unchanged, which is what these two cases actually pin.
  it("carries the always-on core capabilities when the config sets none of its own", async () => {
    const gw = await startGateway({
      name: "no-caps",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toMatchObject({ approvals: 1, "com.cozylabs.bots": expect.any(Number) });
    } finally {
      await gw.close();
    }
  });

  it("does not let config bypass Hermes session-management discovery", async () => {
    const gw = await startGateway({
      name: "unproven-session-cap",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
      capabilities: { [HERMES_SESSION_MANAGEMENT_CAPABILITY_ID]: 1 },
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.[HERMES_SESSION_MANAGEMENT_CAPABILITY_ID]).toBeUndefined();
    } finally {
      await gw.close();
    }
  });

  it("surfaces a configured com.cozylabs.* vendor capability identically in health, pair, and ready", async () => {
    const gw = await startGateway({
      name: "with-caps",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes() }],
      capabilities: {
        "com.cozylabs.test": 1,
        "com.cozylabs.some-unrecognized-thing": 7,
        // Built-in evidence-gated capabilities cannot be forced on through free-form config.
        "com.cozylabs.harness-update": 99,
        [HERMES_GLOBAL_SKILLS_CAPABILITY_ID]: 99,
      },
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities).toEqual({
        "com.cozylabs.test": 1,
        "com.cozylabs.some-unrecognized-thing": 7,
        approvals: 1,
        "com.cozylabs.cozyapps": 1,
        "com.cozylabs.bots": expect.any(Number),
        "com.cozylabs.hermes-desktop-sessions": 4,
        "com.cozylabs.harness-settings": 1,
        "com.cozylabs.chat-configuration": 1,
        "com.cozylabs.provider-connections": 1,
        "com.cozylabs.mobile-node": MOBILE_NODE_CAPABILITY_VERSION,
      });

      const code = gw.issueSetupCode();
      const pairRes = await fetch(`${gw.url}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ setupCode: code, deviceName: "caps phone" }),
      });
      const paired = (await pairRes.json()) as { deviceToken: string; gateway: GatewayInfo };
      expect(paired.gateway.capabilities).toEqual(health.capabilities);

      const frames: ServerFrame[] = [];
      const ws = new WebSocket(`${gw.url.replace("http", "ws")}/ws`);
      ws.on("message", (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
      await once(ws, "open");
      ws.send(JSON.stringify({ type: "auth", token: paired.deviceToken }));
      const start = Date.now();
      while (!frames.some((f) => f.type === "ready")) {
        if (Date.now() - start > 5_000) throw new Error(`timeout; saw ${JSON.stringify(frames)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      ws.close();
      const ready = frames.find((f) => f.type === "ready");
      expect(ready?.type === "ready" ? ready.gateway.capabilities : undefined).toEqual(health.capabilities);
    } finally {
      await gw.close();
    }
  });

  it("advertises global skills only after Dashboard config and the profile catalog both prove usable", async () => {
    const configs = new Map<string, Record<string, unknown>>([["mock", { skills: { disabled: [] } }]]);
    const upstream = await startFakeHermesServer({
      methods: {
        "profiles.describe": ({ name }) => ({
          skills: name === "mock" ? [{ name: "1password" }] : [],
        }),
      },
      dashboard: ({ method, path, query, body }) => {
        if (path !== "/api/config") return { status: 404, body: { detail: "Not Found" } };
        const profile = query.get("profile") ?? "";
        const current = configs.get(profile);
        if (current === undefined) return { status: 404, body: { detail: "Not Found" } };
        if (method === "GET") return { body: current };
        const patch = body as { config?: Record<string, unknown> };
        const skills = patch.config?.["skills"];
        configs.set(profile, {
          ...current,
          ...(skills === undefined ? {} : { skills: { ...(current["skills"] as Record<string, unknown>), ...(skills as Record<string, unknown>) } }),
        });
        return { body: { ok: true } };
      },
    });
    const gw = await startGateway({
      name: "global-skills-capability",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes(upstream.url) }],
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.[HERMES_GLOBAL_SKILLS_CAPABILITY_ID]).toBe(1);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it("withholds global skills when Hermes returns a malformed profile catalog", async () => {
    const upstream = await startFakeHermesServer({
      methods: { "profiles.describe": () => ({}) },
      dashboard: ({ path }) => path === "/api/config"
        ? { body: { skills: { disabled: [] } } }
        : { status: 404, body: { detail: "Not Found" } },
    });
    const gw = await startGateway({
      name: "malformed-global-skills-catalog",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes(upstream.url) }],
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.[HERMES_GLOBAL_SKILLS_CAPABILITY_ID]).toBeUndefined();
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it("advertises harness update only after the pinned Hermes read APIs pass discovery", async () => {
    const upstream = await startFakeHermesServer({
      dashboard: ({ method, path }) => {
        if (path === "/api/hermes/update/check") return { body: {
          install_method: "git",
          current_version: "0.20.3",
          behind: 1,
          update_available: true,
          can_apply: true,
          update_command: "hermes update",
          message: null,
        } };
        if (path === "/api/actions/hermes-update/status") return { body: {
          name: "hermes-update", running: false, exit_code: null, pid: null, lines: [],
        } };
        if (path === "/api/hermes/update/receipt") return {
          status: 404,
          body: { detail: "No update receipt found (no `hermes update` run recorded)." },
        };
        if (path === "/api/hermes/update" && method === "OPTIONS") return {
          status: 405,
          body: { detail: "Method Not Allowed" },
          headers: { allow: "POST" },
        };
        return { status: 404, body: { detail: "Not Found" } };
      },
    });
    const gw = await startGateway({
      name: "update-capability",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermesEndpoints: [{ id: "default", ...testHermes(upstream.url) }],
    });
    try {
      const health = (await (await fetch(`${gw.url}/health`)).json()) as GatewayInfo;
      expect(health.capabilities?.["com.cozylabs.harness-update"])
        .toBe(HARNESS_UPDATE_CAPABILITY_VERSION);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

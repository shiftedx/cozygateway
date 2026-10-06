import { describe, expect, it } from "vitest";
import type { GatewayHarness, Message, RichBlock } from "cozygateway-contract";

import { hashToken } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import {
  GatewayHarnessUpdates,
  HermesHarnessUpdateAdapter,
  UPDATE_JSON_MAX_BYTES,
  discoverHermesUpdates,
} from "../src/hermes-bridge/update.ts";
import { openStorage } from "../src/storage.ts";
import { startFakeHermesServer } from "./support/fake-hermes-server.ts";

const TOKEN = "paired-device-token";
const ACTION_ID = "0123456789abcdef0123456789abcdef";
const NO_RECEIPT_DETAIL = "No update receipt found (no `hermes update` run recorded).";
const HARNESS: GatewayHarness = {
  id: "home",
  vendor: { id: "hermes-agent", name: "Hermes Agent", logoAsset: "hermes-agent" },
  scopes: [{ id: "sage", name: "Sage" }],
};
const CONFIG: GatewayConfig = {
  name: "update-test",
  port: 0,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default",
    url: "ws://127.0.0.1:1/api/ws",
    tokenEnv: "TEST_HERMES_CONTROL_TOKEN",
    profiles: { sage: { tokenEnv: "TEST_ATTACH_TOKEN" } },
  }],
};

type DashboardInit = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  timeoutMs?: number;
};
type DashboardHandler = (path: string, init?: DashboardInit) => unknown | Promise<unknown>;

function client(handler: DashboardHandler): HermesClient {
  return {
    dashboardJson: handler,
    dashboardResponse: async (path, init) => {
      const value = await handler(path, init);
      if (value instanceof Response) return value;
      const body = JSON.stringify(value);
      return new Response(body, {
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      });
    },
  } as HermesClient;
}

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    install_method: "git",
    current_version: "0.20.3",
    behind: 2,
    update_available: true,
    can_apply: true,
    update_command: "/private/bin/hermes update --token secret",
    message: "raw upstream guidance /Users/operator/.hermes",
    commits: [{ author: "Private Person", summary: "secret", sha: "abcdef0" }],
    ...overrides,
  };
}

function receipt(outcome: string = "success"): Record<string, unknown> {
  return {
    outcome,
    started_at: "2026-08-30T12:00:00.000Z",
    finished_at: "2026-08-30T12:01:00.000Z",
    pre_sha: "private-pre-sha",
    post_sha: "private-post-sha",
    post_version: "0.20.4",
    fleet_states: ["current"],
  };
}

function upstreamStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "hermes-update",
    running: false,
    exit_code: null,
    pid: null,
    lines: [],
    ...overrides,
  };
}

function surface(handler: DashboardHandler, now: () => number = () => 1_700_000_000_000) {
  return new GatewayHarnessUpdates([
    new HermesHarnessUpdateAdapter(client(handler), HARNESS, now),
  ]);
}

function appFor(updates: GatewayHarnessUpdates) {
  const storage = openStorage(":memory:");
  storage.createDevice({ id: "device", name: "Phone", tokenHash: hashToken(TOKEN), createdAt: 1 });
  const app = createApp({
    storage,
    config: CONFIG,
    gatewayInfo: { name: "g", version: "test", contract: "v1" },
    harnessUpdates: updates,
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, blocks: RichBlock[]): Message => ({
      threadId: "t", seq: 1, role: "user", blocks, createdAt: 1,
    }),
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { app, request };
}

describe("Hermes harness update adapter", () => {
  it("uses Hermes' authenticated check, action, and durable-status APIs exactly", async () => {
    const calls: Array<{ method: string; path: string; query: string; token: string | undefined }> = [];
    let started = false;
    const upstream = await startFakeHermesServer({
      dashboard: (request) => {
        calls.push({
          method: request.method,
          path: request.path,
          query: request.query.toString(),
          token: request.headers["x-hermes-session-token"] as string | undefined,
        });
        if (request.headers["x-hermes-session-token"] !== "control-secret")
          return { status: 401, body: { detail: "Unauthorized /private/auth/path" } };
        if (request.path === "/api/hermes/update/check") return { body: check() };
        if (request.path === "/api/hermes/update") {
          started = true;
          return { body: { ok: true, name: "hermes-update", action_id: ACTION_ID } };
        }
        if (request.path === "/api/actions/hermes-update/status") return { body: upstreamStatus(started
          ? { action_id: ACTION_ID, receipt: receipt() }
          : {}) };
        return { status: 404, body: { detail: "Not Found" } };
      },
    });
    const upstreamClient = createHermesClient({
      url: upstream.url,
      auth: { mode: "token", token: "control-secret" },
    });
    try {
      const adapter = new HermesHarnessUpdateAdapter(upstreamClient, HARNESS);
      await expect(adapter.check()).resolves.toMatchObject({ currentVersion: "0.20.3" });
      await expect(adapter.start("0.20.3")).resolves.toMatchObject({ actionId: ACTION_ID });
      await expect(adapter.status()).resolves.toMatchObject({ state: "success", actionId: ACTION_ID });
      expect(calls).toEqual([
        { method: "GET", path: "/api/hermes/update/check", query: "force=true", token: "control-secret" },
        { method: "GET", path: "/api/hermes/update/check", query: "force=true", token: "control-secret" },
        { method: "GET", path: "/api/actions/hermes-update/status", query: "lines=1", token: "control-secret" },
        { method: "POST", path: "/api/hermes/update", query: "", token: "control-secret" },
        { method: "GET", path: "/api/actions/hermes-update/status", query: "lines=1", token: "control-secret" },
      ]);
    } finally {
      await upstreamClient.close();
      await upstream.close();
    }
  });

  it.each([
    ["docker", "container image"],
    ["nixos", "Nix"],
    ["apt", "APT"],
    ["managed-runtime", "platform"],
  ])("gates managed %s installs with bounded guidance", async (method, guidance) => {
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check({ install_method: method, can_apply: false });
      starts += 1;
      return { ok: true };
    });
    const status = await updates.adapter("home").check();
    expect(status).toMatchObject({ canApply: false, installMethod: method === "nixos" ? "nix" : method === "managed-runtime" ? "managed" : method });
    expect(status.guidance).toContain(guidance);
    await expect(updates.adapter("home").start("0.20.3")).rejects.toMatchObject({ name: "HarnessUpdateBlocked" });
    expect(starts).toBe(0);
  });

  it("rejects a stale confirmation before starting upstream", async () => {
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check({ current_version: "0.20.4" });
      starts += 1;
      return { ok: true };
    });
    await expect(updates.adapter("home").start("0.20.3")).rejects.toMatchObject({
      name: "HarnessUpdateStale",
      currentVersion: "0.20.4",
    });
    expect(starts).toBe(0);
  });

  it("serializes concurrent starts and coalesces them onto one action", async () => {
    let starts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const updates = surface(async (path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus({ running: starts > 0 });
      starts += 1;
      await gate;
      return { ok: true, name: "hermes-update", action_id: ACTION_ID };
    });
    const first = updates.adapter("home").start("0.20.3");
    const second = updates.adapter("home").start("0.20.3");
    await Promise.resolve();
    expect(starts).toBe(0);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(a).toMatchObject({ actionId: ACTION_ID, coalesced: false });
    expect(b).toMatchObject({ actionId: ACTION_ID, coalesced: true });
  });

  it("coalesces simultaneous confirmations to the arrival generation even when its action is already terminal", async () => {
    const oldReceipt = receipt("success");
    const newReceipt = receipt("success");
    newReceipt["finished_at"] = "2026-08-30T12:02:00.000Z";
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus(starts === 0
        ? { action_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", receipt: oldReceipt }
        : { action_id: ACTION_ID, receipt: newReceipt });
      starts += 1;
      return {
        ok: true,
        name: "hermes-update",
        action_id: starts === 1 ? ACTION_ID : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      };
    });

    const [first, queued] = await Promise.all([
      updates.adapter("home").start("0.20.3"),
      updates.adapter("home").start("0.20.3"),
    ]);

    expect(starts).toBe(1);
    expect(first).toMatchObject({ actionId: ACTION_ID, coalesced: false });
    expect(queued).toMatchObject({ actionId: ACTION_ID, coalesced: true });
  });

  it("treats a timed-out start as ambiguous and only polls status", async () => {
    let starts = 0;
    let statusCalls = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) {
        statusCalls += 1;
        return upstreamStatus({ running: statusCalls > 1, pid: statusCalls > 1 ? 99 : null, lines: ["TOKEN=secret"] });
      }
      starts += 1;
      throw new DOMException("request timed out /private/path", "TimeoutError");
    });
    await expect(updates.adapter("home").start("0.20.3")).resolves.toMatchObject({ state: "ambiguous" });
    await expect(updates.adapter("home").status()).resolves.toMatchObject({ state: "running" });
    expect(starts).toBe(1);
    expect(statusCalls).toBe(2);
  });

  it("recovers success and real partial outcomes from the durable receipt after restart", async () => {
    const handler: DashboardHandler = () => ({
      name: "hermes-update",
      running: false,
      exit_code: null,
      pid: 4242,
      lines: ["/Users/operator/.hermes", "TOKEN=secret"],
      action_id: ACTION_ID,
      receipt: receipt("success"),
      env: { TOKEN: "secret" },
    });
    const restarted = surface(handler);
    await expect(restarted.adapter("home").status()).resolves.toEqual({
      harnessId: "home",
      state: "success",
      actionId: ACTION_ID,
      receipt: {
        outcome: "success",
        startedAt: 1_788_091_200_000,
        finishedAt: 1_788_091_260_000,
        postVersion: "0.20.4",
      },
    });

    const partial = surface(() => ({
      name: "hermes-update", running: false, exit_code: 1,
      lines: [], receipt: receipt("partial"),
    }));
    await expect(partial.adapter("home").status()).resolves.toEqual({
      harnessId: "home",
      state: "partial",
      receipt: {
        outcome: "partial",
        startedAt: 1_788_091_200_000,
        finishedAt: 1_788_091_260_000,
        postVersion: "0.20.4",
      },
      guidance: "Hermes updated only partially. Review Hermes locally before trying another update.",
    });
  });

  it.each(["partial", "failed"] as const)(
    "terminates an active %s update from a changed receipt even though Hermes exposes only an older success action id",
    async (outcome) => {
      const oldReceipt = receipt("success");
      const newReceipt = receipt(outcome);
      newReceipt["started_at"] = "2026-08-30T12:02:00.000Z";
      newReceipt["finished_at"] = "2026-08-30T12:03:00.000Z";
      let statusCalls = 0;
      const updates = surface((path) => {
        if (path.includes("/check")) return check();
        if (path.includes("/status")) {
          statusCalls += 1;
          return upstreamStatus({
            exit_code: statusCalls === 1 ? null : outcome === "partial" ? 1 : null,
            // Hermes' durable action id comes from a success-only log marker, so a failed
            // run can leave the prior success id beside the new non-success receipt.
            action_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            receipt: statusCalls === 1 ? oldReceipt : newReceipt,
          });
        }
        return { ok: true, name: "hermes-update", action_id: ACTION_ID };
      });

      await updates.adapter("home").start("0.20.3");
      const terminal = await updates.adapter("home").status();
      expect(terminal).toMatchObject({
        state: outcome === "partial" ? "partial" : "failed",
        receipt: { outcome },
      });
      expect(terminal).not.toHaveProperty("actionId");
    },
  );

  it("requires a changed durable receipt after an ambiguous POST instead of accepting a recent old success", async () => {
    const oldReceipt = receipt("success");
    const newReceipt = receipt("success");
    newReceipt["finished_at"] = "2026-08-30T12:02:00.000Z";
    let statusCalls = 0;
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) {
        statusCalls += 1;
        return upstreamStatus({
          action_id: statusCalls < 3 ? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : ACTION_ID,
          receipt: statusCalls < 3 ? oldReceipt : newReceipt,
        });
      }
      starts += 1;
      throw new DOMException("request timed out", "TimeoutError");
    }, () => Date.parse("2026-08-30T12:00:30.000Z"));

    await expect(updates.adapter("home").start("0.20.3")).resolves.toMatchObject({ state: "ambiguous" });
    await expect(updates.adapter("home").status()).resolves.toMatchObject({ state: "unknown" });
    await expect(updates.adapter("home").status()).resolves.toMatchObject({ state: "success" });
    expect(starts).toBe(1);
  });

  it("reports an uncorrelated success candidly before refreshing to latest durable harness state", async () => {
    const oldReceipt = receipt("success");
    const newReceipt = receipt("success");
    newReceipt["finished_at"] = "2026-08-30T12:02:00.000Z";
    let statusCalls = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) {
        statusCalls += 1;
        return upstreamStatus({ receipt: statusCalls === 1 ? oldReceipt : newReceipt });
      }
      return { ok: true, name: "hermes-update", action_id: ACTION_ID };
    });

    await updates.adapter("home").start("0.20.3");
    await expect(updates.adapter("home").status()).resolves.toMatchObject({
      state: "unknown",
      guidance: expect.stringContaining("without matching action identity"),
    });
    await expect(updates.adapter("home").status()).resolves.toMatchObject({
      state: "success",
      receipt: { outcome: "success" },
    });
  });

  it("performs a fresh version check before considering an active start for coalescing", async () => {
    let checks = 0;
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) {
        checks += 1;
        return check({ current_version: checks === 1 ? "0.20.3" : "0.20.4" });
      }
      if (path.includes("/status")) return upstreamStatus({ running: starts > 0 });
      starts += 1;
      return { ok: true, name: "hermes-update", action_id: ACTION_ID };
    });

    await updates.adapter("home").start("0.20.3");
    await expect(updates.adapter("home").start("0.20.3")).rejects.toMatchObject({
      name: "HarnessUpdateStale",
      currentVersion: "0.20.4",
    });
    expect(starts).toBe(1);
  });

  it("does not coalesce onto an active record after Hermes reports its changed terminal receipt", async () => {
    const oldReceipt = receipt("success");
    const partialReceipt = receipt("partial");
    partialReceipt["finished_at"] = "2026-08-30T12:02:00.000Z";
    let starts = 0;
    let statusCalls = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) {
        statusCalls += 1;
        if (statusCalls === 1) return upstreamStatus({ receipt: oldReceipt });
        return upstreamStatus({ exit_code: 1, receipt: partialReceipt });
      }
      starts += 1;
      return { ok: true, name: "hermes-update", action_id: starts === 1 ? ACTION_ID : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    });

    await updates.adapter("home").start("0.20.3");
    await expect(updates.adapter("home").start("0.20.3")).resolves.toMatchObject({ coalesced: false });
    expect(starts).toBe(2);
  });

  it("omits discovery when any pinned read API or shape is unavailable", async () => {
    const supported = client((path, init) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      if (path === "/api/hermes/update" && init?.method === "OPTIONS")
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, pOsT" } });
      return new Response(JSON.stringify({
        detail: "No update receipt found (no `hermes update` run recorded).",
      }), { status: 404, headers: { "content-type": "application/json" } });
    });
    await expect(discoverHermesUpdates(supported, HARNESS)).resolves.toBeInstanceOf(HermesHarnessUpdateAdapter);

    const missingReceipt = client((path, init) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      if (path === "/api/hermes/update" && init?.method === "OPTIONS")
        return new Response("Method Not Allowed", { status: 405 });
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    });
    await expect(discoverHermesUpdates(missingReceipt, HARNESS)).resolves.toBeUndefined();

    const malformedStatus = client((path) => path.includes("/check") ? check() : { running: false });
    await expect(discoverHermesUpdates(malformedStatus, HARNESS)).resolves.toBeUndefined();

    const missingAction = client((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      if (path.includes("/receipt")) return new Response(JSON.stringify({ detail: NO_RECEIPT_DETAIL }), { status: 404 });
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    });
    await expect(discoverHermesUpdates(missingAction, HARNESS)).resolves.toBeUndefined();

    const getOnlyAction = client((path, init) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      if (path.includes("/receipt")) return new Response(JSON.stringify({ detail: NO_RECEIPT_DETAIL }), { status: 404 });
      if (path === "/api/hermes/update" && init?.method === "OPTIONS")
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
      return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    });
    await expect(discoverHermesUpdates(getOnlyAction, HARNESS)).resolves.toBeUndefined();
  });

  it("bounds check, status, and discovery receipt JSON before parsing", async () => {
    const oversized = (declared: boolean) => new Response("x".repeat(UPDATE_JSON_MAX_BYTES + 1), {
      headers: declared ? { "content-length": String(UPDATE_JSON_MAX_BYTES + 1) } : {},
    });
    await expect(new HermesHarnessUpdateAdapter(client(() => oversized(true)), HARNESS).check())
      .rejects.toMatchObject({ name: "HarnessUpdateUnavailable" });

    await expect(new HermesHarnessUpdateAdapter(client(() => oversized(false)), HARNESS).status())
      .rejects.toMatchObject({ name: "HarnessUpdateUnavailable" });

    const discoveryClient = client((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      return oversized(true);
    });
    await expect(discoverHermesUpdates(discoveryClient, HARNESS)).resolves.toBeUndefined();
  });

  it.each([
    ["declared oversize", () => new Response("x", {
      headers: { "content-length": String(UPDATE_JSON_MAX_BYTES + 1) },
    })],
    ["malformed JSON", () => new Response("{")],
    ["invalid UTF-8", () => new Response(new Uint8Array([0xff]))],
    ["HTTP failure", () => new Response(JSON.stringify({ detail: "failed" }), { status: 500 })],
    ["transport disconnect", () => { throw new TypeError("connection terminated"); }],
    ["malformed success", () => ({ ok: true, name: "hermes-update", action_id: "invalid" })],
    ["unvalidated refusal", () => ({ ok: false, name: "hermes-update", error: "unknown_refusal" })],
  ] as const)("treats a %s after POST begins as ambiguous and pollable", async (_name, postResult) => {
    let statusCalls = 0;
    let starts = 0;
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) {
        statusCalls += 1;
        return upstreamStatus({ running: statusCalls > 1 });
      }
      starts += 1;
      return postResult();
    });

    await expect(updates.adapter("home").start("0.20.3")).resolves.toMatchObject({
      state: "ambiguous",
      coalesced: false,
    });
    await expect(updates.adapter("home").status()).resolves.toMatchObject({ state: "running" });
    expect(starts).toBe(1);
  });

  it("treats only Hermes' pinned refusal shape as a definite blocked start", async () => {
    const updates = surface((path) => {
      if (path.includes("/check")) return check();
      if (path.includes("/status")) return upstreamStatus();
      return {
        ok: false,
        pid: null,
        name: "hermes-update",
        error: "apt_update_required",
        message: "private upstream guidance",
        update_command: "private command",
      };
    });

    await expect(updates.adapter("home").start("0.20.3"))
      .rejects.toMatchObject({ name: "HarnessUpdateBlocked" });
  });

  it("never calls process exit or liveness a success without a durable receipt", async () => {
    const updates = surface(() => ({
      name: "hermes-update", running: false, exit_code: 0, pid: 42, lines: ["completed"],
    }));
    await expect(updates.adapter("home").status()).resolves.toMatchObject({ state: "failed" });
  });
});

describe("paired harness update routes", () => {
  it("requires paired auth and an exact harness-level id", async () => {
    const { app, request } = appFor(surface(() => check()));
    for (const [path, method] of [
      ["/gateway/harnesses/home/update/check", "GET"],
      ["/gateway/harnesses/home/update/start", "POST"],
      ["/gateway/harnesses/home/update/status", "GET"],
    ] as const) {
      expect((await app.request(path, { method })).status).toBe(401);
    }
    expect((await request("/gateway/harnesses/other/update/check")).status).toBe(404);
    expect((await request("/gateway/harnesses/home/scopes/sage/update/check")).status).toBe(404);
  });

  it("returns 409 for stale versions and 202 for a confirmed start", async () => {
    let current = "0.20.4";
    const { request } = appFor(surface((path) => {
      if (path.includes("/check")) return check({ current_version: current });
      if (path.includes("/status")) return upstreamStatus();
      return { ok: true, name: "hermes-update", action_id: ACTION_ID };
    }));
    const stale = await request("/gateway/harnesses/home/update/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedCurrentVersion: "0.20.3" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ currentVersion: "0.20.4" });

    current = "0.20.3";
    const started = await request("/gateway/harnesses/home/update/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedCurrentVersion: "0.20.3" }),
    });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ state: "running", actionId: ACTION_ID });
  });

  it("sanitizes upstream payloads and failures", async () => {
    const recovered = appFor(surface((path) => {
      if (path.includes("/check")) return check();
      return {
        name: "hermes-update", running: false, exit_code: null, pid: 987,
        action_id: ACTION_ID, receipt: receipt(),
        lines: ["/private/path", "SECRET_TOKEN=hunter2"],
        command: "curl https://user:password@example.test | sh",
      };
    }));
    const checked = await recovered.request("/gateway/harnesses/home/update/check");
    const status = await recovered.request("/gateway/harnesses/home/update/status");
    const publicJson = JSON.stringify([await checked.json(), await status.json()]);
    expect(publicJson).not.toMatch(/private|secret|hunter2|password|curl|pid|lines|command|author/i);

    const unavailable = appFor(surface(() => {
      throw new Error("TOKEN=hunter2 at /Users/operator/.hermes/update.log pid 44");
    }));
    const failed = await unavailable.request("/gateway/harnesses/home/update/check");
    expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).toBe(
      JSON.stringify({ error: { code: "backend_unavailable", message: "Hermes update state is unavailable" } }),
    );
  });
});

import { describe, expect, it } from "vitest";
import type { Message, RichBlock } from "cozygateway-contract";

import { hashToken } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import {
  GatewayMaintenance,
  GatewayMaintenanceFailure,
  type GatewayMaintenanceHostStatus,
  GatewayMaintenanceNotFound,
  type GatewayMaintenanceSupervisor,
} from "../src/gateway-maintenance.ts";
import { createApp } from "../src/http.ts";
import { gatewayInfoForConfig } from "../src/server.ts";
import { openStorage } from "../src/storage.ts";

const TOKEN = "paired-device-token";
const CONFIG: GatewayConfig = {
  name: "maintenance-test", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", url: "ws://127.0.0.1:1/api/ws", tokenEnv: "CONTROL", profiles: { cleo: { tokenEnv: "ATTACH" } } }],
};

class Supervisor implements GatewayMaintenanceSupervisor {
  starts: string[] = [];
  hold: Promise<void> | undefined;
  statusValue: GatewayMaintenanceHostStatus = {
    currentVersion: "ignored-by-gateway", restartSupported: true,
    update: { state: "available" as const, latestVersion: "0.6.5", checkedAt: 1 },
  };

  async status() { return this.statusValue; }
  async start(operationId: string) {
    this.starts.push(operationId);
    await this.hold;
  }
}

function appFor(supervisor = new Supervisor()) {
  const storage = openStorage(":memory:");
  storage.createDevice({ id: "device", name: "Phone", tokenHash: hashToken(TOKEN), createdAt: 1 });
  const maintenance = new GatewayMaintenance(
    storage,
    supervisor,
    supervisor.statusValue,
    "0.6.4",
    () => 100,
    () => ({ harness: "hermes", attach: { configured: 1, online: 1, deadLetters: 0 } }),
  );
  const app = createApp({
    storage, config: CONFIG, gatewayInfo: { name: "g", version: "0.6.4", contract: "v1" }, maintenance,
    presenceOf: () => "online",
    submitUserMessage: (_threadId: string, blocks: RichBlock[]): Message => ({ threadId: "t", seq: 1, role: "user", blocks, createdAt: 1 }),
    interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const), onDeviceRevoked: () => {}, now: () => 100,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, {
    ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  return { app, request, supervisor };
}

describe("gateway maintenance paired routes", () => {
  it("advertises the capability only when the host supervisor was proven usable", () => {
    expect(gatewayInfoForConfig(CONFIG).capabilities?.["com.cozylabs.gateway-maintenance"]).toBeUndefined();
    expect(gatewayInfoForConfig(CONFIG, false, false, false, undefined, false, true)
      .capabilities?.["com.cozylabs.gateway-maintenance"]).toBe(2);
  });

  it("is absent without a live supervisor and rejects unauthenticated maintenance access", async () => {
    const storage = openStorage(":memory:");
    const app = createApp({
      storage, config: CONFIG, gatewayInfo: { name: "g", version: "0.6.4", contract: "v1" },
      presenceOf: () => "online",
      submitUserMessage: (_threadId: string, blocks: RichBlock[]): Message => ({ threadId: "t", seq: 1, role: "user", blocks, createdAt: 1 }),
      interruptThread: () => "idle", resolveApproval: () => Promise.resolve("unknown" as const), onDeviceRevoked: () => {}, now: () => 1,
    });
    expect((await app.request("/gateway/maintenance")).status).toBe(404);
    const configured = appFor();
    expect((await configured.app.request("/gateway/maintenance")).status).toBe(401);
    expect((await configured.app.request("/gateway/maintenance/restart", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "nope" }),
    })).status).toBe(401);
    expect((await configured.app.request("/gateway/maintenance/update", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "nope", expectedCurrentVersion: "0.6.4", expectedTargetVersion: "0.6.5" }),
    })).status).toBe(401);
  });

  it.each([
    ["upToDate", { state: "upToDate" as const }],
    ["unavailable", { state: "unavailable" as const }],
  ])("returns contract-valid %s update status", async (_label, update) => {
    const supervisor = new Supervisor();
    supervisor.statusValue = { currentVersion: "ignored", restartSupported: true, update };
    const { request } = appFor(supervisor);
    const response = await request("/gateway/maintenance");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      currentVersion: "0.6.4", restartSupported: true, update,
      health: {
        state: "working",
        gateway: { state: "working", version: "0.6.4" },
        harness: { product: "hermes", state: "attached" },
      },
    });
  });

  it("returns cached contract-safe status and accepts a restart once with a durable receipt", async () => {
    const { request, supervisor } = appFor();
    const status = await request("/gateway/maintenance");
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      currentVersion: "0.6.4", restartSupported: true,
      update: { state: "available", latestVersion: "0.6.5", checkedAt: 1 },
      health: {
        state: "working",
        gateway: { state: "working", version: "0.6.4" },
        harness: { product: "hermes", state: "attached" },
      },
    });
    const input = { requestId: "restart-once" };
    const first = await request("/gateway/maintenance/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    const second = await request("/gateway/maintenance/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    expect(first.status).toBe(202);
    expect(await second.json()).toEqual(await first.clone().json());
    expect(supervisor.starts).toHaveLength(1);
  });

  it("guards stale versions and blocks a second operation while supervisor handoff is active", async () => {
    let release: (() => void) | undefined;
    const { request, supervisor } = appFor();
    supervisor.hold = new Promise<void>((resolve) => { release = resolve; });
    const first = request("/gateway/maintenance/restart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "slow" }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await request("/gateway/maintenance/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "other", expectedCurrentVersion: "0.6.4", expectedTargetVersion: "0.6.5" }) });
    expect(second.status).toBe(409);
    expect((await second.json())).toMatchObject({ error: { code: "operation_in_progress" } });
    release!();
    expect((await first).status).toBe(202);
    const fresh = appFor();
    const stale = await fresh.request("/gateway/maintenance/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "stale", expectedCurrentVersion: "0.6.3", expectedTargetVersion: "0.6.5" }) });
    expect(stale.status).toBe(409);
    expect((await stale.json())).toMatchObject({ error: { code: "stale_version" } });
    expect(fresh.supervisor.starts).toHaveLength(0);
  });

  it("settles a pre-ACK failure and returns the same authoritative receipt on retry", async () => {
    const storage = openStorage(":memory:");
    const operationIds: string[] = [];
    const supervisor: GatewayMaintenanceSupervisor = {
      status: async () => ({ currentVersion: "0.6.4", restartSupported: true, update: { state: "unavailable" } }),
      start: async (operationId) => {
        operationIds.push(operationId);
        throw new Error("simulated process loss before supervisor ACK fixture-secret");
      },
    };
    const maintenance = new GatewayMaintenance(storage, supervisor, await supervisor.status(), "0.6.4", () => 100);
    await expect(maintenance.restart("crash-window")).rejects.toMatchObject({ code: "maintenance_failed" });
    const failed = storage.gatewayMaintenanceOperationByKey("crash-window")!;
    expect(failed).toMatchObject({
      status: "failed",
      failureCode: "maintenance_handoff_failed",
      message: "Gateway maintenance could not start.",
      nextAction: "retry_update",
    });
    expect(JSON.stringify(failed)).not.toContain("fixture-secret");
    const receipt = await maintenance.restart("crash-window");
    expect(receipt.operationId).toBe(failed.operationId);
    expect(operationIds).toEqual([receipt.operationId]);
  });

  it("finds a durable operation and reports a missing one", async () => {
    const storage = openStorage(":memory:");
    const supervisor = new Supervisor();
    const maintenance = new GatewayMaintenance(storage, supervisor, supervisor.statusValue, "0.6.4", () => 100);
    const receipt = await maintenance.restart("poll-me");
    expect(maintenance.operation(receipt.operationId)).toMatchObject({ operationId: receipt.operationId });
    expect(() => maintenance.operation("maintenance_ffffffffffffffffffffffffffffffff"))
      .toThrow(GatewayMaintenanceNotFound);
  });

  it("fails closed when its previously-live host supervisor stops answering", async () => {
    const storage = openStorage(":memory:");
    const supervisor: GatewayMaintenanceSupervisor = {
      status: async () => { throw new Error("host socket gone"); }, start: async () => {},
    };
    const maintenance = new GatewayMaintenance(storage, supervisor, {
      currentVersion: "0.6.4", restartSupported: true, update: { state: "upToDate" },
    }, "0.6.4", () => 100);
    expect(maintenance.status().restartSupported).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(maintenance.status()).toEqual({
      currentVersion: "0.6.4", restartSupported: false, update: { state: "unavailable" },
      health: {
        state: "working",
        gateway: { state: "working", version: "0.6.4" },
        harness: { product: "hermes", state: "attached" },
      },
    });
  });
});

import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOTS_CAPABILITY_VERSION, type BotMemoryItem } from "cozygateway-contract";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import type { AttachV1MemoryRequest, AttachV1ServerFrame } from "../src/adapters/attach/protocol-v1.ts";
import { AttachMemorySurface } from "../src/hermes-bridge/memory.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";
import type { GatewayConfig } from "../src/config.ts";
import type { BotsSurface } from "../src/hermes-bridge/bridge.ts";

/** Capability 30 and 42 for a `runtime: "cozyagents"` bot, against a fake peer that speaks the real
 *  attach-v1 wire through the real ingress and the real app.
 *
 *  The lane was reported 404 during the wave-3 live checks while the item routes on the same
 *  prefix answered, so the point of this file is that the whole path is exercised as one thing:
 *  the registered route, the device auth, the memory surface, the ingress capability gate, and the
 *  peer's reply. A registration or plane-routing regression fails here rather than in a live check.
 */

const config: GatewayConfig = {
  name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

const source = {
  id: "files", displayName: "Files", kind: "memory", status: "available" as const,
  capabilities: { create: true, edit: true, delete: true, relationships: true, capacity: false, effectiveNextSession: false },
};
const item: BotMemoryItem = {
  id: "memory:coffee-order", sourceId: "files", kind: "memory", title: "Coffee",
  snippet: "flat white with oat milk", timestampKind: "created", revision: "r1",
};

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("capability-42 memory setup for a runtime bot", () => {
  let server: Server;
  let port: number;
  let storage: Storage;
  let ingress: AttachV1Ingress;
  let memory: AttachMemorySurface;
  let authed: (path: string, init?: RequestInit) => Promise<Response>;

  beforeEach(async () => {
    storage = openStorage(":memory:");
    ingress = new AttachV1Ingress({
      tokens: new Map([["secret", "sage"]]),
      storage,
      events: {
        onEvent: () => true,
        onPresence: () => undefined,
        onMemoryResult: (agentId, frame) => { memory.handle(agentId, frame); },
      },
    });
    memory = new AttachMemorySurface(ingress);
    server = createServer();
    server.on("upgrade", (req, socket, head) => ingress.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;

    const app = createApp({
      storage, config, memory,
      // A runtime bot has no Hermes profile behind it; the roster is the only thing the app asks
      // this surface for on the memory screen.
      bots: { roster: () => ({ bots: [], updatedAt: 0, stale: false }), refreshSoon: () => undefined } as unknown as BotsSurface,
      gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": BOTS_CAPABILITY_VERSION } },
      presenceOf: () => "online",
      submitUserMessage: () => { throw new Error("unused"); },
      interruptThread: () => "idle",
      resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => undefined,
      now: () => 1_000,
    });
    const code = newSetupCode();
    storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
    const paired = await app.request("/pair", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
    });
    const { deviceToken } = (await paired.json()) as { deviceToken: string };
    authed = async (path, init) => await app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` },
    });
  });

  afterEach(async () => {
    memory.close();
    ingress.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    storage.close();
  });

  /** A peer that answers `overview`, `items` and `setup` the way the CozyAgents peer does. */
  async function dial(capabilities: string[]): Promise<{ ws: WebSocket; requests: AttachV1MemoryRequest[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/attach/v1`, { headers: { authorization: "Bearer secret" } });
    const requests: AttachV1MemoryRequest[] = [];
    let acked = false;
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data)) as AttachV1ServerFrame;
      if (frame.kind === "hello_ack") { acked = true; return; }
      if (frame.kind !== "memory_request") return;
      requests.push(frame);
      const result = frame.operation === "items" ? { items: [item], sources: [source] } : { sources: [source] };
      ws.send(JSON.stringify({ kind: "memory_result", requestId: frame.requestId, status: "ok", result }));
    });
    await once(ws, "open");
    ws.send(JSON.stringify({
      kind: "hello", version: 2, instanceId: "peer", capabilities,
      resume: { eventSequence: 0, commandSequence: 0 },
    }));
    await until(() => acked);
    return { ws, requests };
  }

  const setupBody = { memoryEnabled: true, userProfileEnabled: true, holographicEnabled: false };
  const patchSetup = () => authed("/bots/sage/memory/setup", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(setupBody),
  });

  it("applies setup end to end over the attach lane", async () => {
    const peer = await dial(["memory_management", "memory_setup"]);
    const response = await patchSetup();
    // The route is registered on the same app the item routes are; a 404 here is the live symptom.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sources: [source], setupAvailable: true });
    expect(peer.requests.map((request) => request.operation)).toEqual(["setup"]);
    expect(peer.requests[0]?.input).toEqual(setupBody);
    peer.ws.close();
  });

  // The switches are a fact about the peer, not about how much it has remembered. A bot with one
  // available source still has three settings to offer, so the answer cannot be inferred from an
  // empty listing.
  it("reports the setup lane on a listing that already carries sources", async () => {
    const peer = await dial(["memory_management", "memory_setup"]);
    const items = await authed("/bots/sage/memory/items");
    expect(items.status).toBe(200);
    expect(await items.json()).toEqual({ items: [item], sources: [source], setupAvailable: true });
    const overview = await authed("/bots/sage/memory");
    expect(await overview.json()).toEqual({ sources: [source], setupAvailable: true });
    peer.ws.close();
  });

  it("says the lane is absent for an old plugin, and refuses setup without hiding the routes", async () => {
    const peer = await dial(["memory_management"]);
    const items = await authed("/bots/sage/memory/items");
    expect(await items.json()).toMatchObject({ setupAvailable: false });
    const refused = await patchSetup();
    // 503, not 404: the route exists and the bot is known; its plugin is the thing that is old.
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { code: "backend_unavailable", message: expect.stringContaining("memory_setup") },
    });
    expect(peer.requests.map((request) => request.operation)).not.toContain("setup");
    peer.ws.close();
  });

  // A deployment that cannot observe the negotiation must not answer `false` on no evidence: a
  // client reads an absent field as "unknown" and keeps whatever it already decided.
  it("omits the field rather than guessing when no capability observation exists", async () => {
    const sent: AttachV1MemoryRequest[] = [];
    const blind = new AttachMemorySurface({
      sendMemoryRequest: (_agent, request) => { sent.push(request); return "sent" as const; },
    });
    const pending = blind.overview("sage");
    blind.handle("sage", { kind: "memory_result", requestId: sent[0]!.requestId, status: "ok", result: { sources: [source] } });
    await expect(pending).resolves.toEqual({ sources: [source] });
    blind.close();
  });
});

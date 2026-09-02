import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { LEGACY_RUNNER_ID, RunnerRoster } from "../src/runner/roster.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";

/** Capability 52, the roster half. `GET /runners` is the screen a person uses to see which of their
 *  computers is here, pick which one gets an unaddressed bot, and take one away. It mirrors the
 *  devices routes deliberately, 404 included, so there is one shape to learn. */

const NOW = 1_800_000_000_000;

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

interface Runner {
  id: string;
  name: string;
  platform: string | null;
  version: string | null;
  backends: string[];
  default: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  storage: Storage;
  roster: RunnerRoster;
  online: Set<string>;
  contact: Map<string, number>;
  revoked: string[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  runners: () => Promise<Runner[]>;
  close: () => void;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

async function harness(opts: { legacy?: boolean } = {}): Promise<Harness> {
  const storage = openStorage(":memory:");
  const now = () => NOW;
  const roster = new RunnerRoster({ storage, now });
  const online = new Set<string>();
  const contact = new Map<string, number>();
  const revoked: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    runners: roster,
    runnerPresence: {
      online: (id) => online.has(id),
      lastContactAt: (id) => contact.get(id) ?? null,
    },
    ...(opts.legacy === true ? { legacyRunnerConfigured: true } : {}),
    onRunnerRevoked: (id) => revoked.push(id),
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not under test");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS);
  const paired = (await (
    await app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
    })
  ).json()) as { deviceToken: string };
  const authed = async (path: string, init?: RequestInit) =>
    app.request(path, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${paired.deviceToken}` },
    });
  const built: Harness = {
    app,
    storage,
    roster,
    online,
    contact,
    revoked,
    authed,
    runners: async () => ((await (await authed("/runners")).json()) as { runners: Runner[] }).runners,
    close: () => storage.close(),
  };
  harnesses.push(built);
  return built;
}

describe("GET /runners", () => {
  it("requires a device token", async () => {
    const h = await harness();
    expect((await h.app.request("/runners")).status).toBe(401);
    expect((await h.app.request("/runners", { headers: { authorization: "Bearer nonsense" } })).status).toBe(401);
    // A runner token is not a device token: it opens the lane and nothing else.
    const runnerToken = h.roster.pair({ name: "box" }).token;
    expect((await h.app.request("/runners", { headers: { authorization: `Bearer ${runnerToken}` } })).status).toBe(401);
    expect((await h.app.request("/devices", { headers: { authorization: `Bearer ${runnerToken}` } })).status).toBe(401);
  });

  it("lists a paired runner with every field a roster screen renders", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    h.roster.observe(paired.runner.id, {
      platform: "darwin/arm64/24.5.0",
      version: "0.1.0",
      backends: ["process"],
    });
    h.roster.touch(paired.runner.id, NOW + 5_000);

    const [runner] = await h.runners();
    expect(Object.keys(runner!).sort()).toEqual([
      "backends", "createdAt", "default", "id", "lastSeenAt", "name", "online", "platform", "version",
    ]);
    expect(runner).toMatchObject({
      id: paired.runner.id,
      name: "kyle-mbp",
      platform: "darwin/arm64/24.5.0",
      version: "0.1.0",
      backends: ["process"],
      default: true,
      createdAt: NOW,
      lastSeenAt: NOW + 5_000,
      online: false,
    });
  });

  it("reports liveness and the freshest contact from the lane, not from the row", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "box" });
    h.online.add(paired.runner.id);
    h.contact.set(paired.runner.id, NOW + 90_000);
    const [runner] = await h.runners();
    expect(runner).toMatchObject({ online: true, lastSeenAt: NOW + 90_000 });
  });

  it("leaves a runner that has never connected with nulls rather than invented values", async () => {
    const h = await harness();
    h.roster.pair({ name: "fresh" });
    const [runner] = await h.runners();
    expect(runner).toMatchObject({ platform: null, version: null, backends: [], lastSeenAt: null, online: false });
  });

  it("shows the legacy shared credential as one row that cannot be changed here", async () => {
    const h = await harness({ legacy: true });
    h.roster.pair({ name: "paired" });
    const rows = await h.runners();
    expect(rows.map((row) => row.id)).toContain(LEGACY_RUNNER_ID);
    const legacy = rows.find((row) => row.id === LEGACY_RUNNER_ID)!;
    expect(legacy).toMatchObject({ name: "legacy runner", default: false });

    const renamed = await h.authed(`/runners/${LEGACY_RUNNER_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: true }),
    });
    expect(renamed.status).toBe(400);
    expect((await h.authed(`/runners/${LEGACY_RUNNER_ID}`, { method: "DELETE" })).status).toBe(400);
    expect(h.revoked).toEqual([]);
  });

  it("omits the legacy row on a gateway with no shared credential", async () => {
    const h = await harness();
    h.roster.pair({ name: "paired" });
    expect((await h.runners()).map((row) => row.id)).not.toContain(LEGACY_RUNNER_ID);
  });
});

describe("PATCH /runners/:id", () => {
  it("moves the default and clears the previous holder", async () => {
    const h = await harness();
    const first = h.roster.pair({ name: "first" }).runner;
    const second = h.roster.pair({ name: "second" }).runner;
    expect(h.roster.defaultRunner()?.id).toBe(first.id);

    const response = await h.authed(`/runners/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: true }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({ runner: { id: second.id, default: true } });

    const rows = await h.runners();
    expect(rows.filter((row) => row.default).map((row) => row.id)).toEqual([second.id]);
    expect(h.roster.defaultRunner()?.id).toBe(second.id);
  });

  it("refuses to clear a default rather than leaving the account with none", async () => {
    const h = await harness();
    const only = h.roster.pair({ name: "only" }).runner;
    const response = await h.authed(`/runners/${only.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: false }),
    });
    expect(response.status).toBe(400);
    expect(h.roster.defaultRunner()?.id).toBe(only.id);
  });

  it("answers 404 for a runner nobody paired, and 400 for a body that is not the patch", async () => {
    const h = await harness();
    const missing = await h.authed("/runners/does-not-exist", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: true }),
    });
    expect(missing.status).toBe(404);
    const paired = h.roster.pair({ name: "one" }).runner;
    const wrong = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(wrong.status).toBe(400);
  });
});

describe("DELETE /runners/:id", () => {
  it("revokes the row and asks the lane to close that runner's socket", async () => {
    const h = await harness();
    const runner = h.roster.pair({ name: "gone" }).runner;
    const response = await h.authed(`/runners/${runner.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.revoked).toEqual([runner.id]);
    expect(await h.runners()).toEqual([]);
    expect(h.roster.resolve("Bearer anything")).toBeUndefined();
  });

  it("answers 404 for an unknown id, exactly as DELETE /devices/:id does", async () => {
    const h = await harness();
    expect((await h.authed("/runners/does-not-exist", { method: "DELETE" })).status).toBe(404);
    expect(h.revoked).toEqual([]);
  });
});

describe("the account default", () => {
  it("falls back to the only row, and to nothing at all with none", async () => {
    const h = await harness();
    expect(h.roster.defaultRunner()).toBeUndefined();
    // A row with no flag at all, which is what a database written before the flag existed holds.
    // One row is unambiguous, so it is the default without anything having been chosen.
    h.storage.createRunner({ id: "unflagged", name: "only", tokenHash: "hash-1", createdAt: NOW, isDefault: false });
    expect(h.roster.defaultRunner()?.id).toBe("unflagged");
    // Two rows and no flag is genuinely ambiguous, and the roster says so rather than guessing.
    h.storage.createRunner({ id: "second", name: "second", tokenHash: "hash-2", createdAt: NOW, isDefault: false });
    expect(h.roster.defaultRunner()).toBeUndefined();
    expect(h.roster.setDefault("second")?.id).toBe("second");
    expect(h.roster.defaultRunner()?.id).toBe("second");
  });
});

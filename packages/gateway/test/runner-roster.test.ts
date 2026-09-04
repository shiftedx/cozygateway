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
  botCount?: number;
  renamed: boolean;
}

interface Harness {
  app: ReturnType<typeof createApp>;
  storage: Storage;
  roster: RunnerRoster;
  online: Set<string>;
  contact: Map<string, number>;
  liveVersions: Map<string, string>;
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
  const liveVersions = new Map<string, string>();
  const revoked: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    runners: roster,
    runnerPresence: {
      online: (id) => online.has(id),
      lastContactAt: (id) => contact.get(id) ?? null,
      agentVersion: (id) => (online.has(id) ? liveVersions.get(id) : undefined),
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
    liveVersions,
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
      // `botCount` is capability 54's addition to this same row; `renamed` is capability 55's.
      "backends", "botCount", "createdAt", "default", "id", "lastSeenAt", "name", "online",
      "platform", "renamed", "version",
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
    // An unknown key is rejected by the closed schema, not merely ignored.
    const wrong = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "renamed" }),
    });
    expect(wrong.status).toBe(400);
    // A body naming neither field has nothing to do.
    const empty = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);
  });
});

describe("renaming a runner (capability 55)", () => {
  it("sets the display name and marks the row renamed", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({
      runner: { id: paired.id, name: "Kyle's Laptop", renamed: true },
    });
    const [runner] = await h.runners();
    expect(runner).toMatchObject({ name: "Kyle's Laptop", renamed: true });
  });

  it("trims surrounding whitespace", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "  Kyle's Laptop  " }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({
      runner: { name: "Kyle's Laptop" },
    });
  });

  it("keeps the display name across a hello that reports a different name, and hello keeps updating the reported name underneath", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    // The reported name changes underneath, exactly as a hello does, but the display name wins.
    h.roster.observe(paired.id, { name: "MacBook-Pro.local" });
    const [runner] = await h.runners();
    expect(runner).toMatchObject({ name: "Kyle's Laptop", renamed: true });
    expect(h.roster.get(paired.id)?.name).toBe("MacBook-Pro.local");
  });

  it("clears the display name on an empty string, returning to the reported name", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    h.roster.observe(paired.id, { name: "MacBook-Pro.local" });
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({
      runner: { name: "MacBook-Pro.local", renamed: false },
    });
  });

  it("clears the display name on null", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: null }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({
      runner: { name: "kyle-mbp", renamed: false },
    });
  });

  it("refuses a whitespace-only name rather than treating it as a clear", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: { message: string } }).toMatchObject({
      error: { code: "invalid_request" },
    });
    // Only the literal "" or null clears; a mistake like this one leaves the display name standing.
    expect(h.roster.get(paired.id)?.displayName).toBe("Kyle's Laptop");
  });

  it("counts the 1 to 64 limit in code points, not UTF-16 units, so 64 emoji fit and 65 do not", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    const emoji = String.fromCodePoint(0x1f600); // one astral code point, two UTF-16 units
    const sixtyFour = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: emoji.repeat(64) }),
    });
    expect(sixtyFour.status).toBe(200);
    expect((await sixtyFour.json()) as { runner: Runner }).toMatchObject({
      runner: { name: emoji.repeat(64) },
    });

    const sixtyFive = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: emoji.repeat(65) }),
    });
    expect(sixtyFive.status).toBe(400);
  });

  it("rejects a name built entirely from zero-width Unicode format characters", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    // U+200B ZERO WIDTH SPACE, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM: all category Cf, all invisible.
    const invisible = [0x200b, 0x200c, 0x200d, 0xfeff].map((code) => String.fromCharCode(code)).join("");
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: invisible }),
    });
    expect(response.status).toBe(400);
    expect(h.roster.get(paired.id)?.displayName).toBeNull();
  });

  it("rejects a name carrying a bidi override control (RLO)", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    // U+202E RIGHT-TO-LEFT OVERRIDE, category Cf: reorders every character after it on render.
    const rlo = String.fromCharCode(0x202e) + "evil.exe";
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: rlo }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a name over 64 characters after trimming", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `  ${"a".repeat(65)}  ` }),
    });
    expect(response.status).toBe(400);
    expect(h.roster.get(paired.id)?.displayName).toBeNull();
  });

  it("rejects a name with control characters", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    // Built from a character code rather than a literal escape, so this source file never carries
    // a raw control byte itself.
    const hostile = "bad" + String.fromCharCode(1) + "name";
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: hostile }),
    });
    expect(response.status).toBe(400);
  });

  it("accepts exactly 64 trimmed characters", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" }).runner;
    const response = await h.authed(`/runners/${paired.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a".repeat(64) }),
    });
    expect(response.status).toBe(200);
  });

  it("can rename and move the default in the same request", async () => {
    const h = await harness();
    h.roster.pair({ name: "first" });
    const second = h.roster.pair({ name: "second" }).runner;
    const response = await h.authed(`/runners/${second.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ default: true, name: "Second Computer" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { runner: Runner }).toMatchObject({
      runner: { id: second.id, default: true, name: "Second Computer", renamed: true },
    });
    expect(h.roster.defaultRunner()?.id).toBe(second.id);
  });

  it("refuses the legacy runner exactly as the default patch does", async () => {
    const h = await harness({ legacy: true });
    const response = await h.authed(`/runners/${LEGACY_RUNNER_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(response.status).toBe(400);
  });
});

describe("the bot count on a runner (capability 54)", () => {
  it("counts the runtime bots placed on that computer and nobody else's", async () => {
    const h = await harness();
    const mine = h.roster.pair({ name: "kyle-mbp" }).runner;
    const theirs = h.roster.pair({ name: "studio" }).runner;
    // Zero is measured, not assumed: a paired computer with nothing on it says so.
    expect((await h.runners()).map((runner) => runner.botCount)).toEqual([0, 0]);

    for (const [id, runnerId] of [["sage", mine.id], ["luna", mine.id], ["pip", theirs.id]] as const) {
      h.storage.insertRuntimeBot({
        id, name: id, avatar: null, token: `token-${id}`,
        runtime: "cozyagents", specGeneration: 1, createdAt: NOW, runnerId,
      });
    }
    const counted = await h.runners();
    expect(counted.find((runner) => runner.id === mine.id)?.botCount).toBe(2);
    expect(counted.find((runner) => runner.id === theirs.id)?.botCount).toBe(1);
  });
});

describe("DELETE /runners/:id", () => {
  it("revokes the row and asks the lane to close that runner's socket", async () => {
    const h = await harness();
    const runner = h.roster.pair({ name: "gone" }).runner;
    const response = await h.authed(`/runners/${runner.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, botCount: 0, reassignedOperations: 0 });
    expect(h.revoked).toEqual([runner.id]);
    expect(await h.runners()).toEqual([]);
    expect(h.roster.resolve("Bearer anything")).toBeUndefined();
  });

  it("reports how many bots it stranded, and leaves their rows standing", async () => {
    const h = await harness();
    const runner = h.roster.pair({ name: "gone" }).runner;
    for (const id of ["sage", "luna"]) {
      h.storage.insertRuntimeBot({
        id, name: id, avatar: null, token: `token-${id}`,
        runtime: "cozyagents", specGeneration: 1, createdAt: NOW, runnerId: runner.id,
      });
    }
    const response = await h.authed(`/runners/${runner.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, botCount: 2, reassignedOperations: 0 });
    // Revoking a computer is not deleting the bots that ran on it: their rows, their credentials
    // and the runner they name are all exactly as they were, so they can be moved rather than lost.
    expect(h.storage.runtimeBot("sage")?.runnerId).toBe(runner.id);
    expect(h.storage.runtimeBot("luna")?.runnerId).toBe(runner.id);
  });

  it("re-addresses the work that computer had not been handed yet to the account default", async () => {
    const h = await harness();
    const gone = h.roster.pair({ name: "gone" }).runner;
    const survivor = h.roster.pair({ name: "kyle-mbp" }).runner;
    h.roster.setDefault(survivor.id);
    h.storage.enqueueRunnerOperation({
      operationId: "op_unsent", bot: "sage", kind: "create_runtime",
      specGeneration: 1, payload: {}, at: NOW, runnerId: gone.id,
    });
    // Already handed over before the revoke: that machine may well have applied it, so handing the
    // same mutation to a second computer is exactly what must not happen.
    h.storage.enqueueRunnerOperation({
      operationId: "op_sent", bot: "luna", kind: "create_runtime",
      specGeneration: 1, payload: {}, at: NOW, runnerId: gone.id,
    });
    h.storage.markRunnerOperationSent("op_sent", NOW);

    const response = await h.authed(`/runners/${gone.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, botCount: 0, reassignedOperations: 1, reassignedTo: survivor.id,
    });
    expect(h.storage.runnerOperation("op_unsent")?.runnerId).toBe(survivor.id);
    expect(h.storage.runnerOperation("op_sent")?.runnerId).toBe(gone.id);
    // The survivor's queue really does carry it now, which is the whole point of moving it.
    expect(
      h.storage.unsentRunnerOperations({ runnerId: survivor.id }).map((operation) => operation.operationId),
    ).toEqual(["op_unsent"]);
  });

  it("addresses that work to nobody when there is no default, so a later default picks it up", async () => {
    const h = await harness();
    const gone = h.roster.pair({ name: "gone" }).runner;
    h.storage.enqueueRunnerOperation({
      operationId: "op_unsent", bot: "sage", kind: "create_runtime",
      specGeneration: 1, payload: {}, at: NOW, runnerId: gone.id,
    });

    const response = await h.authed(`/runners/${gone.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    // No `reassignedTo`: there was nowhere to send it, and naming a runner would be a lie.
    expect(await response.json()).toEqual({ ok: true, botCount: 0, reassignedOperations: 1 });
    expect(h.storage.runnerOperation("op_unsent")?.runnerId).toBeNull();

    // Unaddressed is not lost: it is the pre-54 state, which the next default collects.
    const next = h.roster.pair({ name: "kyle-mbp" }).runner;
    expect(h.storage.unsentRunnerOperations({ runnerId: next.id })).toEqual([]);
    expect(
      h.storage
        .unsentRunnerOperations({ runnerId: next.id, includeUnassigned: true })
        .map((operation) => operation.operationId),
    ).toEqual(["op_unsent"]);
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

describe("GET /runners/self", () => {
  it("answers that one runner's row under the runner's own bearer", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    h.roster.observe(paired.runner.id, { platform: "darwin/arm64/24.5.0", version: "0.1.0" });
    h.roster.touch(paired.runner.id, NOW + 3_000);

    const response = await h.app.request("/runners/self", {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Installer fields and the legacy online alias: no token, no backends, no other runner.
    // `renamed` is capability 55's addition to this same row.
    expect(Object.keys(body).sort()).toEqual([
      "attached", "default", "id", "lastSeenAt", "name", "online", "platform", "renamed",
    ]);
    expect(body).toEqual({
      id: paired.runner.id,
      name: "kyle-mbp",
      platform: "darwin/arm64/24.5.0",
      default: true,
      lastSeenAt: NOW + 3_000,
      attached: false,
      online: false,
      renamed: false,
    });
  });

  it("renders the display name and renamed, exactly as GET /runners does (capability 55)", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "kyle-mbp" });
    await h.authed(`/runners/${paired.runner.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Kyle's Laptop" }),
    });
    // The reported name changes underneath, but the display name still wins here too.
    h.roster.observe(paired.runner.id, { name: "MacBook-Pro.local" });

    const response = await h.app.request("/runners/self", {
      headers: { authorization: `Bearer ${paired.token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Kyle's Laptop", renamed: true });
  });

  it("separates existing from attached, which is the whole point of the health check", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "box" });
    const self = async () =>
      (await (
        await h.app.request("/runners/self", { headers: { authorization: `Bearer ${paired.token}` } })
      ).json()) as { attached: boolean };
    // Paired, service not yet dialed in: the row exists and the answer says so honestly.
    expect(await self()).toMatchObject({ attached: false, online: false });
    h.online.add(paired.runner.id);
    expect(await self()).toMatchObject({ attached: true, online: true });
  });

  it("reports a version only from the current attached hello, never an offline roster observation", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "box" });
    // This is deliberately durable but stale: it cannot prove a newly installed process started.
    h.roster.observe(paired.runner.id, { version: "0.1.0" });
    const read = async () =>
      (await (await h.app.request("/runners/self", {
        headers: { authorization: `Bearer ${paired.token}` },
      })).json()) as { attached: boolean; agentVersion?: string };
    expect(await read()).toEqual(expect.objectContaining({ attached: false }));
    expect((await read()).agentVersion).toBeUndefined();
    h.online.add(paired.runner.id);
    h.liveVersions.set(paired.runner.id, "0.2.0");
    expect(await read()).toEqual(expect.objectContaining({ attached: true, agentVersion: "0.2.0" }));
    h.online.delete(paired.runner.id);
    // Retaining the live map entry makes this an explicit no-stale-version assertion.
    expect((await read()).agentVersion).toBeUndefined();
  });

  it("refuses a device token, an unknown token, and a revoked one", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "gone" });
    expect((await h.app.request("/runners/self")).status).toBe(401);
    expect((await h.app.request("/runners/self", { headers: { authorization: "Bearer nonsense" } })).status).toBe(401);
    // A device token opens the roster but not this route: the two credentials are not interchangeable.
    expect((await h.authed("/runners/self")).status).toBe(401);
    expect((await h.app.request("/runners/self", { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(200);
    h.roster.remove(paired.runner.id);
    expect((await h.app.request("/runners/self", { headers: { authorization: `Bearer ${paired.token}` } })).status).toBe(401);
  });

  it("opens nothing else with a runner token", async () => {
    const h = await harness();
    const paired = h.roster.pair({ name: "box" });
    const asRunner = (path: string, init?: RequestInit) =>
      h.app.request(path, { ...init, headers: { authorization: `Bearer ${paired.token}` } });
    expect((await asRunner("/runners")).status).toBe(401);
    expect((await asRunner("/devices")).status).toBe(401);
    expect((await asRunner("/runners/pair-code", { method: "POST" })).status).toBe(401);
    expect((await asRunner(`/runners/${paired.runner.id}`, { method: "DELETE" })).status).toBe(401);
  });
});

describe("POST /runners/pair-code", () => {
  it("mints a runner code no device pair can spend, with the TTL and the origin to dial", async () => {
    const h = await harness();
    const response = await h.authed("/runners/pair-code", { method: "POST" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { setupCode: string; expiresAt: number; gatewayUrl: string };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "gatewayUrl", "setupCode"]);
    expect(body.setupCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.expiresAt).toBe(NOW + SETUP_CODE_TTL_MS);
    expect(body.gatewayUrl).toMatch(/^https?:\/\//);

    // It is a RUNNER code: a device pair cannot spend it, and a runner pair can.
    expect(h.storage.consumeSetupCode(body.setupCode, NOW)).toBe("invalid");
    expect(h.storage.consumeSetupCode(body.setupCode, NOW, "runner")).toBe("ok");
  });

  it("expires with the same 10 minute TTL a CLI-minted code has", async () => {
    const h = await harness();
    const body = (await (await h.authed("/runners/pair-code", { method: "POST" })).json()) as {
      setupCode: string;
      expiresAt: number;
    };
    expect(h.storage.consumeSetupCode(body.setupCode, body.expiresAt + 1, "runner")).toBe("invalid");
  });

  it("requires a device token", async () => {
    const h = await harness();
    expect((await h.app.request("/runners/pair-code", { method: "POST" })).status).toBe(401);
  });

  it("spends the same gateway-wide bucket the unauthenticated pairing route spends", async () => {
    const h = await harness();
    // The harness already paired a phone through `/pair`, which spent one of the ten.
    for (let attempt = 0; attempt < 9; attempt++) {
      expect((await h.authed("/runners/pair-code", { method: "POST" })).status).toBe(200);
    }
    const throttled = await h.authed("/runners/pair-code", { method: "POST" });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
    // The bucket is one bucket: /pair is throttled by the same exhaustion.
    const pairing = await h.app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: "WRONG-CODE", deviceName: "phone" }),
    });
    expect(pairing.status).toBe(429);
  });

  it("pairs a runner end to end with the code it minted", async () => {
    const h = await harness();
    const minted = (await (await h.authed("/runners/pair-code", { method: "POST" })).json()) as {
      setupCode: string;
    };
    const paired = await h.app.request("/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: minted.setupCode, deviceName: "kyle-mbp", kind: "runner" }),
    });
    expect(paired.status).toBe(200);
    const body = (await paired.json()) as { runnerToken: string; runner: { id: string } };
    const self = await h.app.request("/runners/self", {
      headers: { authorization: `Bearer ${body.runnerToken}` },
    });
    expect(self.status).toBe(200);
    expect((await self.json()) as { id: string }).toMatchObject({ id: body.runner.id, name: "kyle-mbp" });
  });
});

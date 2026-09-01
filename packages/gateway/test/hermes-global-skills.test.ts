import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import {
  GatewayHermesGlobalSkills,
  HERMES_GLOBAL_SKILLS_CAPABILITY_ID,
} from "../src/hermes-bridge/global-skills.ts";
import type { HermesClient } from "../src/hermes-bridge/client.ts";
import { createApp } from "../src/http.ts";
import { openStorage, type Storage } from "../src/storage.ts";

type Config = Record<string, unknown>;
type FakeHermes = {
  client: HermesClient;
  config(profile: string): Config;
  writes: Array<{ profile: string; disabled: string[] }>;
  reads: number;
  failProfile?: string;
  failAfterWriteProfile?: string;
  mutateOnRead?: { at: number; profile: string; disabled: string[] };
  freshSession(profile: string): { canLoad(skill: string): boolean };
};

const storages: Storage[] = [];
afterEach(() => { for (const storage of storages.splice(0)) storage.close(); });

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function fakeHermes(initial: Record<string, Config>, catalog = ["1password", "agentmail", "adversarial-ux-test"]): FakeHermes {
  const configs = new Map(Object.entries(initial).map(([profile, config]) => [profile, clone(config)]));
  const writes: Array<{ profile: string; disabled: string[] }> = [];
  let reads = 0;
  const client = {
    state: () => "online",
    liveness: () => ({ state: "online", since: 0, reconnectAttempt: 0 }),
    start: () => {}, close: async () => {}, onEvent: () => {}, onStateChange: () => {},
    request: async (method: string, params: unknown) => {
      if (method !== "profiles.describe") throw new Error(`unexpected ${method}`);
      const profile = (params as { name: string }).name;
      if (!configs.has(profile)) throw new Error("profile missing");
      return { skills: catalog.map((name) => ({ name })) };
    },
    dashboardJson: async <T>(path: string, init?: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown }): Promise<T> => {
      const profile = new URL(path, "http://hermes.invalid").searchParams.get("profile") ?? "";
      const current = configs.get(profile);
      if (current === undefined) throw new Error("profile missing");
      if ((init?.method ?? "GET") === "GET") {
        reads += 1;
        if (fake.mutateOnRead?.at === reads) {
          const change = fake.mutateOnRead;
          fake.mutateOnRead = undefined;
          const changed = configs.get(change.profile)!;
          configs.set(change.profile, {
            ...changed,
            skills: { ...(changed.skills as Config), disabled: change.disabled },
          });
        }
        return clone(configs.get(profile)!) as T;
      }
      if (init?.method !== "PUT") throw new Error("unexpected write");
      if (profile === fake.failProfile) throw new Error("disk full");
      const patch = (init.body as { config?: { skills?: { disabled?: unknown } } }).config?.skills ?? {};
      const skills = { ...(typeof current.skills === "object" && current.skills !== null ? current.skills as Config : {}), ...patch };
      const next = { ...current, skills };
      configs.set(profile, next);
      writes.push({ profile, disabled: Array.isArray(skills.disabled) ? skills.disabled as string[] : [] });
      if (profile === fake.failAfterWriteProfile) {
        fake.failAfterWriteProfile = undefined;
        throw new Error("connection closed after persistence");
      }
      return { ok: true } as T;
    },
    dashboardResponse: async () => new Response(null, { status: 404 }),
  } satisfies HermesClient;
  const fake: FakeHermes = {
    client, writes,
    get reads() { return reads; },
    config: (profile) => clone(configs.get(profile)!),
    freshSession: (profile) => {
      const disabled = [
        ...(((configs.get(profile)?.skills as Config | undefined)?.disabled as string[] | undefined) ?? []),
      ];
      return { canLoad: (skill) => !disabled.includes(skill) };
    },
  };
  return fake;
}

async function setup(input: Record<string, Config> = {
  default: { agent: { model: "keep" }, skills: { disabled: ["1password", " agentmail "], platform_disabled: { cli: ["terminal"] } } },
  ops: { plugins: { enabled: ["cozygateway"] }, skills: { disabled: ["1password"], platform_disabled: { cli: ["web"] } } },
}): Promise<{ app: ReturnType<typeof createApp>; authed(path: string, init?: RequestInit): Promise<Response>; fake: FakeHermes }> {
  const storage = openStorage(":memory:");
  storages.push(storage);
  const fake = fakeHermes(input);
  const surface = new GatewayHermesGlobalSkills(
    Object.keys(input).map((profile) => ({ id: profile, profile, client: fake.client })), storage, () => 1_788_238_800_000,
  );
  const app = createApp({
    storage,
    config: { name: "g", port: 8787, dbPath: ":memory:", turnTimeoutSeconds: 0, hermesEndpoints: [{ id: "default", url: "ws://unused", tokenEnv: "TOKEN", profiles: { default: { tokenEnv: "DEFAULT" } } }] },
    gatewayInfo: { name: "g", version: "0.5.6", contract: "v1", capabilities: { [HERMES_GLOBAL_SKILLS_CAPABILITY_ID]: 1 } },
    hermesGlobalSkills: surface,
    presenceOf: () => "online",
    submitUserMessage: () => { throw new Error("unused"); },
    interruptThread: () => "idle",
    resolveApproval: async () => "unknown",
    onDeviceRevoked: () => {},
    now: () => 1_788_238_800_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_788_238_800_000 + SETUP_CODE_TTL_MS);
  const pair = await app.request("/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ setupCode: code, deviceName: "phone" }) });
  const token = ((await pair.json()) as { deviceToken: string }).deviceToken;
  return { app, fake, authed: async (path, init) => await app.request(path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }) };
}

async function snapshot(authed: Awaited<ReturnType<typeof setup>>["authed"]) {
  const response = await authed("/hermes/skills");
  expect(response.status).toBe(200);
  return await response.json() as { disabled: string[]; mixed: string[]; revision: string; targetCount: number };
}

function patch(revision: string, enabled: boolean, requestId = randomUUID()): RequestInit {
  return { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled, expectedRevision: revision, requestId }) };
}

describe("Hermes global skills", () => {
  it("reports every-disabled, mixed, and every-enabled names deterministically", async () => {
    const { authed } = await setup();
    const result = await snapshot(authed);
    expect(result).toMatchObject({ disabled: ["1password"], mixed: ["agentmail"], targetCount: 2 });
    expect(result.disabled).not.toContain("adversarial-ux-test");
    expect((await snapshot(authed)).revision).toBe(result.revision);
  });

  it("disables one skill on every profile without disturbing unrelated or platform-scoped YAML", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    const response = await authed("/hermes/skills/adversarial-ux-test", patch(before.revision, false));
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toMatchObject({ disabled: ["1password", "adversarial-ux-test"], mixed: ["agentmail"] });
    for (const profile of ["default", "ops"]) expect((fake.config(profile).skills as Config).disabled).toContain("adversarial-ux-test");
    expect(fake.config("default").agent).toEqual({ model: "keep" });
    expect((fake.config("default").skills as Config).platform_disabled).toEqual({ cli: ["terminal"] });
    expect((fake.config("ops").skills as Config).platform_disabled).toEqual({ cli: ["web"] });
  });

  it("enables one skill on every profile, resolves mixed state, and new Hermes sessions cannot load a disabled skill", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    const disabled = await authed("/hermes/skills/agentmail", patch(before.revision, false));
    expect(disabled.status).toBe(200);
    expect(fake.freshSession("default").canLoad("agentmail")).toBe(false);
    expect(fake.freshSession("ops").canLoad("agentmail")).toBe(false);
    const afterDisable = await disabled.json() as { revision: string; mixed: string[]; disabled: string[] };
    expect(afterDisable.mixed).not.toContain("agentmail");
    expect(afterDisable.disabled).toContain("agentmail");
    const enabled = await authed("/hermes/skills/agentmail", patch(afterDisable.revision, true));
    expect(enabled.status).toBe(200);
    expect(fake.freshSession("default").canLoad("agentmail")).toBe(true);
    expect(fake.freshSession("ops").canLoad("agentmail")).toBe(true);
  });

  it("rejects a stale revision without writing and returns the current snapshot", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    const response = await authed("/hermes/skills/agentmail", patch("stale", false));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "stale_revision" }, current: { revision: before.revision } });
    expect(fake.writes).toEqual([]);
  });

  it("rolls earlier profiles back when the final profile write fails", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    fake.failProfile = "ops";
    const response = await authed("/hermes/skills/adversarial-ux-test", patch(before.revision, false));
    expect(response.status).toBe(500);
    expect((fake.config("default").skills as Config).disabled).toEqual(["1password", "agentmail"]);
    expect((fake.config("ops").skills as Config).disabled).toEqual(["1password"]);
  });

  it("restores every profile when the final Dashboard write persisted before its response failed", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    fake.failAfterWriteProfile = "ops";
    const response = await authed("/hermes/skills/adversarial-ux-test", patch(before.revision, false));
    expect(response.status).toBe(500);
    expect((fake.config("default").skills as Config).disabled).toEqual(["1password", "agentmail"]);
    expect((fake.config("ops").skills as Config).disabled).toEqual(["1password"]);
  });

  it("detects a profile change between staging and commit without writing", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    // The mutation performs its initial two reads, then an aggregate CAS revalidation. Change the
    // second profile just before that revalidation reads it, simulating a concurrent editor.
    fake.mutateOnRead = { at: fake.reads + 3, profile: "ops", disabled: ["1password", "agentmail"] };
    const response = await authed("/hermes/skills/adversarial-ux-test", patch(before.revision, false));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "stale_revision" } });
    expect(fake.writes).toEqual([]);
  });

  it("returns the original result for a retried request id without writing twice", async () => {
    const { authed, fake } = await setup();
    const before = await snapshot(authed);
    const requestId = randomUUID();
    const first = await authed("/hermes/skills/adversarial-ux-test", patch(before.revision, false, requestId));
    const second = await authed("/hermes/skills/adversarial-ux-test", patch("wrong-now", false, requestId));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(fake.writes).toHaveLength(2);
  });

  it("does not read Hermes for an unpaired caller", async () => {
    const { app, fake } = await setup();
    const response = await app.request("/hermes/skills");
    expect(response.status).toBe(401);
    expect(fake.reads).toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { PAIR_REQUEST_MAX_BYTES } from "../src/pairing-admission.ts";
import { RunnerRoster } from "../src/runner/roster.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { testHermes } from "./support/test-config.ts";

/** Capability 52, the pairing half. A computer that runs bots is paired with a code exactly as a
 *  phone is, and the guards that make a pairing code safe are the SAME guards: the byte cap, the
 *  bucket, the TTL, and single use. The promise under test is that a runner pair is one more kind
 *  on that route rather than a second, weaker door beside it. */

const NOW = 1_800_000_000_000;

const config: GatewayConfig = {
  name: "test-gateway",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

interface Harness {
  app: ReturnType<typeof createApp>;
  storage: Storage;
  roster: RunnerRoster;
  revokedRunners: string[];
  close: () => void;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.close();
});

function harness(opts: { now?: () => number } = {}): Harness {
  const storage = openStorage(":memory:");
  const now = opts.now ?? (() => NOW);
  const roster = new RunnerRoster({ storage, now });
  const revokedRunners: string[] = [];
  const app = createApp({
    storage,
    config,
    gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
    runners: roster,
    onRunnerRevoked: (id) => revokedRunners.push(id),
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("not under test");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now,
  });
  const built: Harness = { app, storage, roster, revokedRunners, close: () => storage.close() };
  harnesses.push(built);
  return built;
}

function pairBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("POST /pair {kind: \"runner\"}", () => {
  it("mints a per-runner token and a roster row from a runner-kind code", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");

    const response = await h.app.request(
      "/pair",
      pairBody({ setupCode: code, deviceName: "kyle-mbp", kind: "runner" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      runnerToken: string;
      runner: { id: string; name: string; default: boolean; online: boolean; lastSeenAt: number | null };
      gateway: { name: string };
    };
    // A device token and a runner token are the same 32 random bytes, so nothing downstream can
    // tell them apart by looking at one.
    expect(body.runnerToken.length).toBeGreaterThanOrEqual(43);
    expect(body.runner).toMatchObject({ name: "kyle-mbp", default: true, online: false, lastSeenAt: null });
    expect(body.gateway.name).toBe("test-gateway");
    // Only the hash is stored: a database read never yields a usable credential.
    expect(JSON.stringify(h.roster.list())).not.toContain(body.runnerToken);
    expect(h.roster.list().map((row) => row.id)).toEqual([body.runner.id]);
  });

  it("mints no device row and answers nothing device-shaped", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    const body = (await (
      await h.app.request("/pair", pairBody({ setupCode: code, deviceName: "box", kind: "runner" }))
    ).json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["gateway", "runner", "runnerToken"]);
    expect(h.storage.listDevices()).toEqual([]);
  });

  it("names the machine 'runner' when the pair carries no name", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    const body = (await (
      await h.app.request("/pair", pairBody({ setupCode: code, kind: "runner" }))
    ).json()) as { runner: { name: string } };
    expect(body.runner.name).toBe("runner");
  });

  it("makes only the FIRST paired runner the default", async () => {
    const h = harness();
    const ids: string[] = [];
    for (const name of ["first", "second"]) {
      const code = newSetupCode();
      h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
      const body = (await (
        await h.app.request("/pair", pairBody({ setupCode: code, deviceName: name, kind: "runner" }))
      ).json()) as { runner: { id: string; default: boolean } };
      ids.push(body.runner.id);
      expect(body.runner.default).toBe(name === "first");
    }
    expect(h.roster.defaultRunner()?.id).toBe(ids[0]);
  });
});

describe("the wrong kind of code is indistinguishable from an expired one", () => {
  it("refuses a runner code presented as a device pair", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    const response = await h.app.request("/pair", pairBody({ setupCode: code, deviceName: "phone" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "setup_code_invalid", message: "setup code is unknown, used, or expired" },
    });
  });

  it("refuses a device code presented as a runner pair, with the same body", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS);
    const response = await h.app.request(
      "/pair",
      pairBody({ setupCode: code, deviceName: "box", kind: "runner" }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "setup_code_invalid", message: "setup code is unknown, used, or expired" },
    });
  });

  it("leaves a refused code spendable by the kind it was minted for", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    await h.app.request("/pair", pairBody({ setupCode: code, deviceName: "phone" }));
    const second = await h.app.request(
      "/pair",
      pairBody({ setupCode: code, deviceName: "box", kind: "runner" }),
    );
    expect(second.status).toBe(200);
  });
});

describe("every pairing guard still holds for a runner pair", () => {
  it("keeps the 4 KiB body cap", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    const response = await h.app.request(
      "/pair",
      pairBody({ setupCode: code, kind: "runner", deviceName: "x".repeat(PAIR_REQUEST_MAX_BYTES) }),
    );
    expect(response.status).toBe(413);
    expect(h.roster.count()).toBe(0);
  });

  it("keeps the 10-attempts-per-60-seconds bucket", async () => {
    const h = harness();
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await h.app.request("/pair", pairBody({ setupCode: "WRONG-CODE", kind: "runner" }));
      expect(response.status).toBe(401);
    }
    const throttled = await h.app.request("/pair", pairBody({ setupCode: "WRONG-CODE", kind: "runner" }));
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
  });

  it("keeps the 10-minute TTL", async () => {
    let clock = NOW;
    const h = harness({ now: () => clock });
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    clock = NOW + SETUP_CODE_TTL_MS + 1;
    const response = await h.app.request("/pair", pairBody({ setupCode: code, kind: "runner" }));
    expect(response.status).toBe(401);
    expect(h.roster.count()).toBe(0);
  });

  it("keeps single use", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    expect((await h.app.request("/pair", pairBody({ setupCode: code, kind: "runner" }))).status).toBe(200);
    expect((await h.app.request("/pair", pairBody({ setupCode: code, kind: "runner" }))).status).toBe(401);
    expect(h.roster.count()).toBe(1);
  });
});

describe("a device pair is untouched by capability 52", () => {
  it("answers exactly the shape it always answered", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS);
    const response = await h.app.request("/pair", pairBody({ setupCode: code, deviceName: "Test phone" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      deviceToken: string;
      device: { id: string; name: string; createdAt: number; lastSeenAt: number | null };
      gateway: unknown;
    };
    expect(Object.keys(body).sort()).toEqual(["device", "deviceToken", "gateway"]);
    expect(Object.keys(body.device).sort()).toEqual(["createdAt", "id", "lastSeenAt", "name"]);
    expect(body.device).toMatchObject({ name: "Test phone", createdAt: NOW, lastSeenAt: null });
    expect(h.roster.count()).toBe(0);
  });

  it("refuses a device pair with no deviceName by naming the field", async () => {
    const h = harness();
    const code = newSetupCode();
    h.storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS);
    const response = await h.app.request("/pair", pairBody({ setupCode: code }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("deviceName");
    // The code was NOT consumed: a client that forgot a field gets to try again.
    expect((await h.app.request("/pair", pairBody({ setupCode: code, deviceName: "phone" }))).status).toBe(200);
  });
});

describe("a gateway that pairs no runners", () => {
  it("refuses a runner pair rather than half-answering it", async () => {
    const storage = openStorage(":memory:");
    const app = createApp({
      storage,
      config,
      gatewayInfo: { name: "test-gateway", version: "0.1.0", contract: "v1" },
      presenceOf: () => "online",
      submitUserMessage: () => {
        throw new Error("not under test");
      },
      interruptThread: () => "idle",
      resolveApproval: () => Promise.resolve("unknown" as const),
      onDeviceRevoked: () => {},
      now: () => NOW,
    });
    const code = newSetupCode();
    storage.createSetupCode(code, NOW + SETUP_CODE_TTL_MS, "runner");
    const response = await app.request("/pair", pairBody({ setupCode: code, kind: "runner" }));
    expect(response.status).toBe(400);
    // The code survives: nothing was minted, so nothing was spent.
    expect(storage.consumeSetupCode(code, NOW, "runner")).toBe("ok");
    storage.close();
  });
});

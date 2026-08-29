import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  openStorage,
  type CapabilityTransition,
  type FinalizeInput,
  type GatewayBoot,
  type SetupSessionInput,
  type VerificationChallengeInput,
} from "../src/storage.ts";

const directories: string[] = [];
const makeDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-onboarding-"));
  directories.push(directory);
  return join(directory, "gateway.sqlite");
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const boot = (generation = "boot-1", epoch = "epoch-1"): GatewayBoot => ({
  bootGeneration: generation,
  verificationEpoch: epoch,
  canonicalOrigin: "https://cozy.example.ts.net",
  durableFingerprint: "posture-a",
  startedAt: 100,
});

const session = (overrides: Partial<SetupSessionInput> = {}): SetupSessionInput => ({
  sessionId: "session-1",
  mode: "tailscale",
  canonicalOrigin: "https://cozy.example.ts.net",
  durableFingerprint: "posture-a",
  verificationEpoch: "epoch-1",
  bootGeneration: "boot-1",
  createdAt: 110,
  ...overrides,
});

const challenge = (overrides: Partial<VerificationChallengeInput> = {}): VerificationChallengeInput => ({
  challengeId: "challenge-1",
  sessionId: "session-1",
  capabilityHash: "a".repeat(64),
  phrase: "cozy ember",
  canonicalOrigin: "https://cozy.example.ts.net",
  durableFingerprint: "posture-a",
  verificationEpoch: "epoch-1",
  bootGeneration: "boot-1",
  createdAt: 120,
  expiresAt: 720,
  ...overrides,
});

const transition = (overrides: Partial<CapabilityTransition> = {}): CapabilityTransition => ({
  capabilityHash: "a".repeat(64),
  canonicalOrigin: "https://cozy.example.ts.net",
  durableFingerprint: "posture-a",
  verificationEpoch: "epoch-1",
  bootGeneration: "boot-1",
  now: 200,
  ...overrides,
});

const finalize = (overrides: Partial<FinalizeInput> = {}): FinalizeInput => ({
  sessionId: "session-1",
  challengeId: "challenge-1",
  setupCode: "COZY-1234",
  setupCodeExpiresAt: 600_200,
  canonicalOrigin: "https://cozy.example.ts.net",
  durableFingerprint: "posture-a",
  verificationEpoch: "epoch-1",
  bootGeneration: "boot-1",
  now: 200,
  ...overrides,
});

function readyChallenge(path: string): void {
  const storage = openStorage(path);
  storage.beginGatewayBoot(boot());
  expect(storage.beginSetupSession(session()).outcome).toBe("created");
  expect(storage.createVerificationChallenge(challenge()).outcome).toBe("created");
  expect(storage.recordVerificationProbe(transition())).toEqual({
    outcome: "advanced",
    state: "ws_probed",
  });
  expect(storage.recordPhoneConfirmation(transition())).toEqual({
    outcome: "advanced",
    state: "phone_confirmed",
  });
  storage.close();
}

function setupCodeRows(path: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(
      "SELECT code, expires_at, used_at, challenge_id, output_state FROM setup_codes ORDER BY code",
    ).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

describe("onboarding storage schema and migration", () => {
  it("creates strict authority tables and the setup-code publication columns", () => {
    const path = makeDatabase();
    openStorage(path).close();
    const db = new DatabaseSync(path, { readOnly: true });
    const tables = db.prepare(
      `SELECT name, sql FROM sqlite_master
       WHERE type = 'table' AND name IN (
         'onboarding_runtime', 'onboarding_sessions', 'onboarding_challenges',
         'onboarding_ownership', 'setup_codes'
       ) ORDER BY name`,
    ).all() as Array<{ name: string; sql: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "onboarding_challenges",
      "onboarding_ownership",
      "onboarding_runtime",
      "onboarding_sessions",
      "setup_codes",
    ]);
    expect(tables.every(({ sql }) => /\bSTRICT\b/.test(sql))).toBe(true);
    expect(tables.find(({ name }) => name === "setup_codes")?.sql).toContain("pending_output");
    expect(db.prepare("SELECT name FROM pragma_table_info('setup_codes')").all()).toMatchObject([
      { name: "code" },
      { name: "expires_at" },
      { name: "used_at" },
      { name: "challenge_id" },
      { name: "output_state" },
    ]);
    db.close();
  });

  it("additively migrates a hand-built legacy setup-code table and keeps its codes active", () => {
    const path = makeDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE setup_codes (
        code TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      INSERT INTO setup_codes (code, expires_at) VALUES ('LEGACY', 500);
    `);
    legacy.close();

    const storage = openStorage(path);
    expect(storage.consumeSetupCode("LEGACY", 500)).toBe("ok");
    expect(storage.consumeSetupCode("LEGACY", 500)).toBe("invalid");
    storage.close();
    expect(setupCodeRows(path)).toEqual([
      {
        code: "LEGACY",
        expires_at: 500,
        used_at: 500,
        challenge_id: null,
        output_state: "active",
      },
    ]);
  });

  it("serializes two barrier-released processes migrating the same legacy database", async () => {
    const path = makeDatabase();
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE setup_codes (
        code TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        used_at INTEGER
      ) STRICT;
      INSERT INTO setup_codes (code, expires_at) VALUES ('LEGACY', 500);
    `);
    legacy.close();
    const workerPath = fileURLToPath(new URL("./support/onboarding-race-worker.ts", import.meta.url));
    const workers = [
      fork(workerPath, ["migrate", path], {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
      fork(workerPath, ["migrate", path], {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    ];
    try {
      await Promise.all(workers.map(waitUntilReady));
      const results = await Promise.all(workers.map(releaseAndCollect));
      expect(results).toEqual([{ outcome: "opened" }, { outcome: "opened" }]);
      const storage = openStorage(path);
      expect(storage.consumeSetupCode("LEGACY", 500)).toBe("ok");
      storage.close();
    } finally {
      for (const worker of workers) if (worker.exitCode === null) worker.kill();
    }
  }, 15_000);
});

describe("onboarding state transitions", () => {
  it("allows only one active setup session and one live challenge per session", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot(boot());
    expect(storage.beginSetupSession(session())).toEqual({
      outcome: "created",
      sessionId: "session-1",
    });
    expect(storage.beginSetupSession(session())).toEqual({
      outcome: "existing",
      sessionId: "session-1",
    });
    expect(storage.beginSetupSession(session({ sessionId: "session-2" }))).toEqual({
      outcome: "conflict",
      sessionId: "session-1",
    });
    expect(storage.createVerificationChallenge(challenge())).toEqual({
      outcome: "created",
      challengeId: "challenge-1",
    });
    expect(storage.createVerificationChallenge(challenge({
      challengeId: "challenge-2",
      capabilityHash: "b".repeat(64),
    }))).toEqual({
      outcome: "conflict",
      challengeId: "challenge-1",
    });
    storage.close();
  });

  it("stores only the hashed capability and enforces the ten-minute challenge ceiling", () => {
    const path = makeDatabase();
    const storage = openStorage(path);
    storage.beginGatewayBoot(boot());
    storage.beginSetupSession(session());
    const rawCapability = "raw-capability-must-never-be-durable";
    const capabilityHash = createHash("sha256").update(rawCapability).digest("hex");
    expect(storage.createVerificationChallenge(challenge({
      capabilityHash: rawCapability,
    })).outcome).toBe("invalid_capability");
    expect(storage.createVerificationChallenge(challenge({
      capabilityHash,
      expiresAt: 120 + 600_001,
    })).outcome).toBe("invalid_expiry");
    expect(storage.createVerificationChallenge(challenge({
      capabilityHash,
      expiresAt: 120 + 600_000,
    })).outcome).toBe("created");
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare("SELECT * FROM onboarding_challenges").get() as Record<string, unknown>;
    expect(Object.values(row)).toContain(capabilityHash);
    expect(Object.values(row)).not.toContain(rawCapability);
    expect(Object.keys(row).some((name) => name === "capability" || name === "capability_raw")).toBe(false);
    db.close();
    expect(readFileSync(path).includes(Buffer.from(rawCapability))).toBe(false);
  });

  it("requires WSS before POST, accepts the exact expiry instant, and permits only legal transitions", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot(boot());
    storage.beginSetupSession(session());
    storage.createVerificationChallenge(challenge());

    expect(storage.recordPhoneConfirmation(transition())).toEqual({
      outcome: "invalid_state",
      state: "active",
    });
    expect(storage.recordVerificationProbe(transition({ now: 720 }))).toEqual({
      outcome: "advanced",
      state: "ws_probed",
    });
    expect(storage.recordVerificationProbe(transition({ now: 720 }))).toEqual({
      outcome: "already",
      state: "ws_probed",
    });
    expect(storage.recordPhoneConfirmation(transition({ now: 720 }))).toEqual({
      outcome: "advanced",
      state: "phone_confirmed",
    });
    expect(storage.recordPhoneConfirmation(transition({ now: 720 }))).toEqual({
      outcome: "already",
      state: "phone_confirmed",
    });
    expect(storage.recordVerificationProbe(transition({ now: 720 }))).toEqual({
      outcome: "invalid_state",
      state: "phone_confirmed",
    });
    expect(storage.finalizeVerifiedSetupCode(finalize({ now: 720, setupCodeExpiresAt: 600_720 }))).toEqual({
      outcome: "published",
      setupCode: "COZY-1234",
    });
    expect(storage.consumeSetupCode("COZY-1234", 720)).toBe("invalid");
    expect(storage.activatePendingSetupCode({
      challengeId: "challenge-1",
      setupCode: "COZY-1234",
      now: 721,
    })).toEqual({ outcome: "advanced", state: "active" });
    expect(storage.consumeSetupCode("COZY-1234", 1_320)).toBe("ok");
    storage.close();
  });

  it("rejects expired or context-mismatched proof without advancing it", () => {
    const storage = openStorage(":memory:");
    storage.beginGatewayBoot(boot());
    storage.beginSetupSession(session());
    storage.createVerificationChallenge(challenge());
    expect(storage.recordVerificationProbe(transition({ now: 721 }))).toEqual({
      outcome: "expired",
      state: "active",
    });
    expect(storage.recordVerificationProbe(transition({ durableFingerprint: "posture-b" }))).toEqual({
      outcome: "invalid_context",
      state: "active",
    });
    storage.close();
  });

  it("finalization rechecks phone state, origin, posture, epoch, generation, and expiry", () => {
    const path = makeDatabase();
    const storage = openStorage(path);
    storage.beginGatewayBoot(boot());
    storage.beginSetupSession(session());
    storage.createVerificationChallenge(challenge());
    storage.recordVerificationProbe(transition());

    expect(storage.finalizeVerifiedSetupCode(finalize())).toEqual({ outcome: "invalid_state" });
    storage.recordPhoneConfirmation(transition());
    for (const changed of [
      { sessionId: "session-2" },
      { canonicalOrigin: "https://other.example.ts.net" },
      { durableFingerprint: "posture-b" },
      { verificationEpoch: "epoch-2" },
      { bootGeneration: "boot-2" },
    ] satisfies Array<Partial<FinalizeInput>>) {
      expect(storage.finalizeVerifiedSetupCode(finalize(changed))).toEqual({
        outcome: "invalid_context",
      });
    }
    expect(storage.finalizeVerifiedSetupCode(finalize({
      now: 721,
      setupCodeExpiresAt: 600_721,
    }))).toEqual({ outcome: "expired" });
    storage.close();
    expect(setupCodeRows(path)).toHaveLength(0);
    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT state FROM onboarding_challenges").get()).toEqual({
      state: "phone_confirmed",
    });
    expect(db.prepare("SELECT state FROM onboarding_sessions").get()).toEqual({ state: "active" });
    db.close();
  });

  it("accepts only the exact ten-minute onboarding setup-code lifetime", () => {
    for (const offset of [599_999, 600_001]) {
      const path = makeDatabase();
      readyChallenge(path);
      const storage = openStorage(path);
      expect(storage.finalizeVerifiedSetupCode(finalize({
        setupCodeExpiresAt: 200 + offset,
      }))).toEqual({ outcome: "invalid_expiry" });
      storage.close();
      expect(setupCodeRows(path)).toHaveLength(0);
    }
  });

  it("lets activation or revocation move only the matching pending publication", () => {
    const path = makeDatabase();
    readyChallenge(path);
    const storage = openStorage(path);
    expect(storage.finalizeVerifiedSetupCode(finalize())).toMatchObject({ outcome: "published" });
    expect(storage.activatePendingSetupCode({
      challengeId: "other",
      setupCode: "COZY-1234",
      now: 201,
    })).toEqual({ outcome: "not_found" });
    expect(storage.revokePendingSetupCode({
      challengeId: "challenge-1",
      setupCode: "COZY-1234",
      now: 202,
    })).toEqual({ outcome: "advanced", state: "revoked" });
    expect(storage.activatePendingSetupCode({
      challengeId: "challenge-1",
      setupCode: "COZY-1234",
      now: 203,
    })).toEqual({ outcome: "invalid_state", state: "revoked" });
    expect(storage.consumeSetupCode("COZY-1234", 203)).toBe("invalid");
    storage.close();
  });
});

describe("onboarding publication concurrency and restart cleanup", () => {
  it("publishes one code when two independent connections finalize together", async () => {
    const path = makeDatabase();
    readyChallenge(path);
    expect(setupCodeRows(path)).toHaveLength(0);
    const first = openStorage(path);
    const second = openStorage(path);
    const results = await Promise.all([
      new Promise((resolve) => setImmediate(() => resolve(first.finalizeVerifiedSetupCode(finalize())))),
      new Promise((resolve) => setImmediate(() => resolve(second.finalizeVerifiedSetupCode(finalize({
        setupCode: "COZY-5678",
      }))))),
    ]);
    expect(results.map((result) => (result as { outcome: string }).outcome).sort()).toEqual([
      "already_published",
      "published",
    ]);
    first.close();
    second.close();
    expect(setupCodeRows(path)).toHaveLength(1);
  });

  it("publishes one code when two barrier-released processes finalize together", async () => {
    const path = makeDatabase();
    readyChallenge(path);
    expect(setupCodeRows(path)).toHaveLength(0);
    const workerPath = fileURLToPath(new URL("./support/onboarding-race-worker.ts", import.meta.url));
    const workers = [
      fork(workerPath, ["finalize", path, JSON.stringify(finalize())], {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
      fork(workerPath, ["finalize", path, JSON.stringify(finalize({ setupCode: "COZY-5678" }))], {
        execArgv: ["--experimental-strip-types"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    ];
    try {
      await Promise.all(workers.map(waitUntilReady));
      const results = await Promise.all(workers.map(releaseAndCollect));
      expect(results.map(({ outcome }) => outcome).sort()).toEqual([
        "already_published",
        "published",
      ]);
      expect(setupCodeRows(path)).toHaveLength(1);
    } finally {
      for (const worker of workers) if (worker.exitCode === null) worker.kill();
    }
  }, 15_000);

  it("a new boot revokes abandoned output and incomplete challenges but preserves completed posture", () => {
    const path = makeDatabase();
    readyChallenge(path);
    let storage = openStorage(path);
    expect(storage.finalizeVerifiedSetupCode(finalize()).outcome).toBe("published");
    storage.close();

    storage = openStorage(path);
    expect(setupCodeRows(path)[0]?.["output_state"]).toBe("pending_output");
    storage.beginGatewayBoot(boot("boot-2", "epoch-2"));
    storage.close();

    const db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT output_state FROM setup_codes").get()).toEqual({
      output_state: "revoked",
    });
    expect(db.prepare(
      "SELECT state, invalidated_at FROM onboarding_challenges WHERE challenge_id = 'challenge-1'",
    ).get()).toMatchObject({ state: "consumed", invalidated_at: null });
    expect(db.prepare(
      "SELECT state, durable_fingerprint FROM onboarding_sessions WHERE session_id = 'session-1'",
    ).get()).toEqual({ state: "complete", durable_fingerprint: "posture-a" });
    db.close();
  });

  it("invalidates an incomplete challenge on a new boot while opening storage remains inert", () => {
    const path = makeDatabase();
    let storage = openStorage(path);
    storage.beginGatewayBoot(boot());
    storage.beginSetupSession(session());
    storage.createVerificationChallenge(challenge());
    storage.close();

    openStorage(path).close();
    let db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT state, invalidated_at FROM onboarding_challenges").get()).toEqual({
      state: "active",
      invalidated_at: null,
    });
    db.close();

    storage = openStorage(path);
    storage.beginGatewayBoot(boot("boot-2", "epoch-2"));
    storage.close();
    db = new DatabaseSync(path, { readOnly: true });
    expect(db.prepare("SELECT state, invalidated_at FROM onboarding_challenges").get()).toMatchObject({
      state: "consumed",
      invalidated_at: 100,
    });
    expect(db.prepare("SELECT state FROM onboarding_sessions").get()).toEqual({ state: "abandoned" });
    db.close();
  });
});

function waitUntilReady(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`race worker exited before barrier: ${code}`)));
    worker.once("message", (message) => {
      if (message === "ready") resolve();
      else reject(new Error(`unexpected race worker message: ${JSON.stringify(message)}`));
    });
  });
}

function releaseAndCollect(worker: ChildProcess): Promise<{ outcome: string }> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", (message: unknown) => {
      if (typeof message === "object" && message !== null && "result" in message)
        resolve((message as { result: { outcome: string } }).result);
      else reject(new Error(`race worker failed: ${JSON.stringify(message)}`));
    });
    worker.once("exit", (code) => {
      if (code !== 0 && code !== null) reject(new Error(`race worker exited ${code}`));
    });
    worker.send("go");
  });
}

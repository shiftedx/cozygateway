import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NetworkOnboarding,
  samePreparedEndpoint,
  type AuthoritativeOnboardingStatus,
  type NetworkModeAdapter,
  type NetworkOnboardingDependencies,
  type OnboardingIo,
  type PreparedEndpoint,
} from "../src/network-onboarding.ts";
import { openStorage } from "../src/storage.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const endpoint: PreparedEndpoint = {
  mode: "tailscale",
  canonicalOrigin: "https://cozy.example.ts.net",
  bindHost: "127.0.0.1",
  port: 18787,
  durableFingerprint: "posture-a",
  accountTailnetHash: "account-hash-a",
  serveMappingFingerprint: "serve-a",
  ready: true,
};

function harness(options: {
  choice?: Awaited<ReturnType<OnboardingIo["chooseNetworkMode"]>>;
  answer?: string;
  proofPhrase?: string | undefined;
  inspected?: PreparedEndpoint;
  authority?: AuthoritativeOnboardingStatus;
  publishResult?: "published" | "not_published";
  rollbackError?: Error;
  now?: () => number;
} = {}) {
  const calls: string[] = [];
  const projections: unknown[] = [];
  const adapter: NetworkModeAdapter = {
    mode: "tailscale",
    prepare: vi.fn(async () => (calls.push("prepare"), endpoint)),
    inspect: vi.fn(async () => (calls.push("inspect"), options.inspected ?? endpoint)),
    rollbackOwned: vi.fn(async () => {
      calls.push("rollback");
      if (options.rollbackError !== undefined) throw options.rollbackError;
    }),
  };
  const io: OnboardingIo = {
    chooseNetworkMode: vi.fn(async () => (calls.push("choice"), options.choice ?? "tailscale")),
    showPhoneConnectionCheck: vi.fn(async (verificationUrl) => {
      calls.push(`phone-qr:${verificationUrl}`);
    }),
    showAuthoritativePhrase: vi.fn(async (phrase) => {
      calls.push(`phrase:${phrase}`);
    }),
    confirmPhone: vi.fn(async () => (calls.push("desktop-answer"), options.answer)),
  };
  const dependencies: NetworkOnboardingDependencies = {
    adapters: [adapter],
    state: {
      read: vi.fn(async () => undefined),
      write: vi.fn(async (projection) => {
        projections.push(projection);
        calls.push(`state:${projection.stage}`);
      }),
    },
    authority: {
      status: vi.fn(async () => options.authority ?? ({ state: "none" } as const)),
      finalizeVerifiedSetupCode: vi.fn(() => ({ outcome: "published" as const, setupCode: "COZY-1234" })),
      activatePendingSetupCode: vi.fn(() => ({ outcome: "advanced" as const, state: "active" as const })),
      revokePendingSetupCode: vi.fn(() => ({ outcome: "advanced" as const, state: "revoked" as const })),
    },
    phoneVerification: {
      begin: vi.fn(() => ({
        challengeId: "challenge-1",
        sessionId: "session-1",
        verificationUrl: "https://cozy.example.ts.net/cozy/onboarding/readiness-only",
        phrase: "amber otter",
        expiresAt: 600_000,
      })),
      waitForConfirmation: vi.fn(async () => options.proofPhrase),
    },
    runtimeContext: vi.fn(() => ({ verificationEpoch: "epoch-1", bootGeneration: "boot-1" })),
    createSetupCode: vi.fn(() => (calls.push("create-code"), "COZY-1234")),
    renderPairingOutput: vi.fn((input) => {
      calls.push("render-pairing");
      return { setupCode: input.setupCode, payloadJson: "payload", terminalOutput: "pairing-output\n" };
    }),
    writePairingOutput: vi.fn(async () => {
      calls.push("write-pairing");
    }),
    publishPairing: vi.fn(async (_request, publicationDependencies) => {
      calls.push("publish-start");
      publicationDependencies.createSetupCode();
      publicationDependencies.render({
        gatewayUrl: endpoint.canonicalOrigin,
        setupCode: "COZY-1234",
        ttlMs: 600_000,
        color: false,
        strictQr: true,
      });
      await publicationDependencies.beforeFinalize?.();
      const finalizationNow = publicationDependencies.finalizationNow?.() ?? 100;
      calls.push("finalize");
      const finalized = publicationDependencies.finalize({
        sessionId: "session-1", challengeId: "challenge-1", setupCode: "COZY-1234",
        setupCodeExpiresAt: finalizationNow + 600_000, canonicalOrigin: endpoint.canonicalOrigin,
        durableFingerprint: endpoint.durableFingerprint, verificationEpoch: "epoch-1",
        bootGeneration: "boot-1", now: finalizationNow,
      });
      if (finalized.outcome !== "published") return "not_published";
      return options.publishResult ?? "published";
    }),
    now: options.now ?? (() => 100),
    color: false,
  };
  return { onboarding: new NetworkOnboarding(dependencies), dependencies, adapter, io, calls, projections };
}

describe("NetworkOnboarding", () => {
  it("chooses a network before creating a readiness challenge and gives the QR only its URL", async () => {
    const { onboarding, dependencies, io, calls } = harness({ proofPhrase: undefined });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(calls.indexOf("choice")).toBeLessThan(calls.indexOf("prepare"));
    expect(calls.indexOf("prepare")).toBeLessThan(calls.findIndex((entry) => entry.startsWith("phone-qr:")));
    expect(dependencies.phoneVerification.begin).toHaveBeenCalledWith("tailscale");
    expect(io.showPhoneConnectionCheck).toHaveBeenCalledWith(
      "https://cozy.example.ts.net/cozy/onboarding/readiness-only",
      undefined,
    );
    expect(JSON.stringify((io.showPhoneConnectionCheck as ReturnType<typeof vi.fn>).mock.calls))
      .not.toMatch(/amber otter|COZY-1234|account-hash-a/);
    expect(dependencies.createSetupCode).not.toHaveBeenCalled();
  });

  it.each(["later", "cancel"] as const)("emits no challenge or pairing material for %s", async (choice) => {
    const { onboarding, dependencies, io } = harness({ choice });
    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: choice === "later" ? "deferred" : "cancelled" });
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    expect(dependencies.createSetupCode).not.toHaveBeenCalled();
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("automatic phone confirmation displays the authoritative phrase but mints nothing on default No", async () => {
    const { onboarding, dependencies, io } = harness({ proofPhrase: "amber otter", answer: undefined });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed", reason: "desktop" });

    expect(io.showAuthoritativePhrase).toHaveBeenCalledWith("amber otter", undefined);
    expect(io.confirmPhone).toHaveBeenCalledWith("amber otter", undefined);
    expect(dependencies.createSetupCode).not.toHaveBeenCalled();
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it.each(["Y", "YES", " y", "yes ", "n", "no", ""])("rejects non-exact desktop answer %j", async (answer) => {
    const { onboarding, dependencies, io } = harness({ proofPhrase: "amber otter", answer });
    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed", reason: "desktop" });
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("renders before SQLite finalization, writes once, activates, and persists complete posture", async () => {
    const { onboarding, dependencies, io, calls, projections } = harness({ proofPhrase: "amber otter", answer: "yes" });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "complete", mode: "tailscale" });

    expect(calls.indexOf("render-pairing")).toBeLessThan(calls.indexOf("inspect"));
    expect(calls.indexOf("inspect")).toBeLessThan(calls.indexOf("finalize"));
    expect(dependencies.publishPairing).toHaveBeenCalledOnce();
    expect(projections.at(-1)).toEqual({
      version: 1,
      stage: "complete",
      mode: "tailscale",
      deploymentFingerprint: "posture-a",
      verifiedAt: 100,
      updatedAt: 100,
    });
  });

  it.each([
    ["origin", { canonicalOrigin: "https://changed.example.ts.net" }],
    ["binding", { bindHost: "0.0.0.0" }],
    ["account", { accountTailnetHash: "account-hash-b" }],
    ["physical adapter", { physicalAdapterId: "ethernet-b" }],
    ["DHCP", { dhcpAddress: "192.168.1.44" }],
    ["Serve mapping", { serveMappingFingerprint: "serve-b" }],
  ] as const)("invalidates proof when the %s changes before finalization", async (_label, change) => {
    const { onboarding, dependencies, io, adapter } = harness({
      proofPhrase: "amber otter",
      answer: "y",
      inspected: { ...endpoint, ...change },
    });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "invalidated" });
    expect(adapter.inspect).toHaveBeenCalledOnce();
    expect(dependencies.publishPairing).toHaveBeenCalledOnce();
    expect(dependencies.authority.finalizeVerifiedSetupCode).not.toHaveBeenCalled();
    expect(dependencies.writePairingOutput).not.toHaveBeenCalled();
  });

  it("invalidates proof when the verification epoch changes immediately before finalization", async () => {
    const { onboarding, dependencies, io } = harness({ proofPhrase: "amber otter", answer: "y" });
    (dependencies.runtimeContext as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce({ verificationEpoch: "epoch-1", bootGeneration: "boot-1" })
      .mockReturnValueOnce({ verificationEpoch: "epoch-2", bootGeneration: "boot-1" });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "invalidated", reason: "verification_epoch" });
    expect(dependencies.publishPairing).toHaveBeenCalledOnce();
    expect(dependencies.authority.finalizeVerifiedSetupCode).not.toHaveBeenCalled();
    expect(dependencies.writePairingOutput).not.toHaveBeenCalled();
  });

  it("uses post-inspection time so a challenge expiring during inspection cannot finalize", async () => {
    let clock = 100;
    const { onboarding, dependencies, adapter, io } = harness({
      proofPhrase: "amber otter",
      answer: "y",
      now: () => clock,
    });
    (adapter.inspect as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      clock = 600_001;
      return endpoint;
    });
    (dependencies.authority.finalizeVerifiedSetupCode as ReturnType<typeof vi.fn>)
      .mockImplementation((input: { now: number }) => input.now > 600_000
        ? { outcome: "expired" as const }
        : { outcome: "published" as const, setupCode: "COZY-1234" });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "lost_race" });

    expect(dependencies.authority.finalizeVerifiedSetupCode).toHaveBeenCalledWith(
      expect.objectContaining({ now: 600_001, setupCodeExpiresAt: 1_200_001 }),
    );
    expect(dependencies.writePairingOutput).not.toHaveBeenCalled();
  });

  it("readiness and rollback failures emit no challenge or pairing material", async () => {
    const { onboarding, dependencies, adapter, io } = harness({ rollbackError: new Error("conditional rollback refused") });
    (adapter.prepare as ReturnType<typeof vi.fn>).mockResolvedValue({ ...endpoint, ready: false });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "failed", reason: "rollback_failed" });
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
    expect(dependencies.createSetupCode).not.toHaveBeenCalled();
  });

  it("preserves a typed retryable adapter pause for the setup flow", async () => {
    const { onboarding, dependencies, adapter, io } = harness();
    (adapter.prepare as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(
      new Error("Personal Tailscale onboarding paused"),
      { retryable: true as const, reason: "install_reboot_required", detail: "installer_reboot_required" },
    ));

    await expect(onboarding.run(io)).resolves.toEqual({
      outcome: "paused",
      mode: "tailscale",
      reason: "install_reboot_required",
      detail: "installer_reboot_required",
    });
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("rolls back a prepared endpoint when challenge startup fails", async () => {
    const { onboarding, dependencies, adapter, io } = harness();
    (dependencies.phoneVerification.begin as ReturnType<typeof vi.fn>)
      .mockImplementation(() => { throw new Error("verification unavailable"); });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "failed", reason: "readiness" });

    expect(adapter.rollbackOwned).toHaveBeenCalledWith(endpoint, undefined);
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("rolls back a prepared endpoint when automatic phone proof throws", async () => {
    const { onboarding, dependencies, adapter, io } = harness();
    (dependencies.phoneVerification.waitForConfirmation as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("proof socket closed"));

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed", reason: "phone" });

    expect(adapter.rollbackOwned).toHaveBeenCalledWith(endpoint, undefined);
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("rolls back when the connection-check display cannot be written", async () => {
    const { onboarding, dependencies, adapter, io } = harness();
    (io.showPhoneConnectionCheck as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("terminal closed"));

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed", reason: "phone" });

    expect(adapter.rollbackOwned).toHaveBeenCalledWith(endpoint, undefined);
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("treats SQLite as authoritative over a contradictory complete sidecar and re-inspects live state", async () => {
    const authoritative: AuthoritativeOnboardingStatus = {
      state: "complete", mode: "tailscale", canonicalOrigin: endpoint.canonicalOrigin,
      durableFingerprint: endpoint.durableFingerprint, completedAt: 99,
    };
    const { onboarding, dependencies, adapter, io } = harness({ authority: authoritative });
    (dependencies.state.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 1, stage: "pending_choice", updatedAt: 1,
    });

    await expect(onboarding.resume(io)).resolves.toMatchObject({ outcome: "already_complete" });
    expect(adapter.inspect).toHaveBeenCalledOnce();
    expect(io.chooseNetworkMode).not.toHaveBeenCalled();
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
  });

  it("does not repeat a matching SQLite-complete posture when run is invoked again", async () => {
    const authoritative: AuthoritativeOnboardingStatus = {
      state: "complete", mode: "tailscale", canonicalOrigin: endpoint.canonicalOrigin,
      durableFingerprint: endpoint.durableFingerprint, completedAt: 99,
    };
    const { onboarding, dependencies, io } = harness({ authority: authoritative });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "already_complete" });

    expect(io.chooseNetworkMode).not.toHaveBeenCalled();
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
  });

  it.each(["active", "abandoned"] as const)(
    "rejects a sidecar-matching live endpoint that contradicts SQLite %s posture",
    async (state) => {
      const authoritative: AuthoritativeOnboardingStatus = {
        state,
        mode: "tailscale",
        canonicalOrigin: "https://authoritative.example.ts.net",
        durableFingerprint: "posture-authoritative",
      };
      const { onboarding, dependencies, adapter, io } = harness({
        authority: authoritative,
        proofPhrase: undefined,
      });
      (dependencies.state.read as ReturnType<typeof vi.fn>).mockResolvedValue({
        version: 1,
        stage: "complete",
        mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint,
        verifiedAt: 50,
        updatedAt: 50,
      });

      await expect(onboarding.status()).resolves.toMatchObject({
        stage: "changed",
        authority: state,
        healthy: false,
      });
      expect(dependencies.state.read).not.toHaveBeenCalled();
      expect(dependencies.state.write).not.toHaveBeenCalled();

      await onboarding.resume(io);
      expect(adapter.prepare).toHaveBeenCalledOnce();
    },
  );

  it("does not consult a matching sidecar when live state contradicts SQLite complete posture", async () => {
    const authoritative: AuthoritativeOnboardingStatus = {
      state: "complete",
      mode: "tailscale",
      canonicalOrigin: "https://authoritative.example.ts.net",
      durableFingerprint: "posture-authoritative",
      completedAt: 75,
    };
    const { onboarding, dependencies } = harness({ authority: authoritative });
    (dependencies.state.read as ReturnType<typeof vi.fn>).mockResolvedValue({
      version: 1,
      stage: "complete",
      mode: "tailscale",
      deploymentFingerprint: endpoint.durableFingerprint,
      verifiedAt: 50,
      updatedAt: 50,
    });

    await expect(onboarding.status()).resolves.toMatchObject({
      stage: "changed",
      authority: "complete",
      healthy: false,
    });
    expect(dependencies.state.read).not.toHaveBeenCalled();
    expect(dependencies.state.write).not.toHaveBeenCalled();
  });

  it("allows only one publisher when two orchestrators reach the same authoritative finalization", async () => {
    let won = false;
    const first = harness({ proofPhrase: "amber otter", answer: "y" });
    const second = harness({ proofPhrase: "amber otter", answer: "y" });
    const compete = async () => {
      await Promise.resolve();
      if (won) return "not_published" as const;
      won = true;
      return "published" as const;
    };
    first.dependencies.publishPairing = vi.fn(compete);
    second.dependencies.publishPairing = vi.fn(compete);
    first.onboarding = new NetworkOnboarding(first.dependencies);
    second.onboarding = new NetworkOnboarding(second.dependencies);

    const outcomes = await Promise.all([first.onboarding.run(first.io), second.onboarding.run(second.io)]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["complete", "lost_race"]);
  });

  it("lets SQLite choose one winner when two real publication sequences finalize the same proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "cozy-network-race-"));
    temporaryRoots.push(root);
    const dbPath = join(root, "gateway.db");
    const storage = openStorage(dbPath);
    storage.beginGatewayBoot({
      bootGeneration: "boot-1", verificationEpoch: "epoch-1",
      canonicalOrigin: endpoint.canonicalOrigin, durableFingerprint: endpoint.durableFingerprint,
      startedAt: 0,
    });
    expect(storage.beginSetupSession({
      sessionId: "session-1", mode: "tailscale", canonicalOrigin: endpoint.canonicalOrigin,
      durableFingerprint: endpoint.durableFingerprint, verificationEpoch: "epoch-1",
      bootGeneration: "boot-1", createdAt: 0,
    }).outcome).toBe("created");
    expect(storage.createVerificationChallenge({
      challengeId: "challenge-1", sessionId: "session-1", capabilityHash: "a".repeat(64),
      phrase: "amber otter", canonicalOrigin: endpoint.canonicalOrigin,
      durableFingerprint: endpoint.durableFingerprint, verificationEpoch: "epoch-1",
      bootGeneration: "boot-1", createdAt: 0, expiresAt: 600_000,
    }).outcome).toBe("created");
    const transition = {
      capabilityHash: "a".repeat(64), canonicalOrigin: endpoint.canonicalOrigin,
      durableFingerprint: endpoint.durableFingerprint, verificationEpoch: "epoch-1",
      bootGeneration: "boot-1", now: 10,
    };
    expect(storage.recordVerificationProbe(transition).outcome).toBe("advanced");
    expect(storage.recordPhoneConfirmation(transition).outcome).toBe("advanced");

    const written: string[] = [];
    let code = 0;
    const adapter: NetworkModeAdapter = {
      mode: "tailscale",
      prepare: async () => endpoint,
      inspect: async () => endpoint,
      rollbackOwned: async () => undefined,
    };
    const make = () => new NetworkOnboarding({
      adapters: [adapter],
      state: { read: async () => undefined, write: async () => undefined },
      authority: {
        status: () => ({ state: "none" }),
        finalizeVerifiedSetupCode: (input) => storage.finalizeVerifiedSetupCode(input),
        activatePendingSetupCode: (input) => storage.activatePendingSetupCode(input),
        revokePendingSetupCode: (input) => storage.revokePendingSetupCode(input),
      },
      phoneVerification: {
        begin: () => ({
          challengeId: "challenge-1", sessionId: "session-1",
          verificationUrl: "https://cozy.example.ts.net/cozy/onboarding/readiness-only",
          phrase: "amber otter", expiresAt: 600_000,
        }),
        waitForConfirmation: async () => "amber otter",
      },
      runtimeContext: () => ({ verificationEpoch: "epoch-1", bootGeneration: "boot-1" }),
      createSetupCode: () => `COZY-${++code}`,
      renderPairingOutput: (input) => ({
        setupCode: input.setupCode, payloadJson: "payload", terminalOutput: `${input.setupCode}\n`,
      }),
      writePairingOutput: async (output) => { written.push(output); },
      now: () => 100,
    });
    const io: OnboardingIo = {
      chooseNetworkMode: async () => "tailscale",
      showPhoneConnectionCheck: async () => undefined,
      showAuthoritativePhrase: async () => undefined,
      confirmPhone: async () => "y",
    };

    const outcomes = await Promise.all([make().run(io), make().run(io)]);

    expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["complete", "lost_race"]);
    expect(written).toHaveLength(1);
    const db = new DatabaseSync(dbPath);
    expect(db.prepare("SELECT count(*) AS count, min(output_state) AS state FROM setup_codes").get())
      .toEqual({ count: 1, state: "active" });
    db.close();
    storage.close();
  });
});

describe("samePreparedEndpoint", () => {
  it("includes every origin, binding, account, LAN, and Serve coordinate", () => {
    expect(samePreparedEndpoint(endpoint, { ...endpoint })).toBe(true);
    expect(samePreparedEndpoint(endpoint, { ...endpoint, port: 18788 })).toBe(false);
    expect(samePreparedEndpoint(endpoint, { ...endpoint, physicalAdapterId: "adapter" })).toBe(false);
  });
});

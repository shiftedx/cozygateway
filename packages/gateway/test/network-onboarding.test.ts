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
import { LanModeReadinessError } from "../src/lan-mode.ts";
import { openStorage } from "../src/storage.ts";
import { TailscaleModeReadinessError } from "../src/tailscale-mode.ts";
import type { NetworkOnboardingState } from "../src/onboarding-state.ts";

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
  projection?: NetworkOnboardingState;
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
    reconcileOwned: vi.fn(async () => {
      calls.push("reconcile");
      if (options.rollbackError !== undefined) throw options.rollbackError;
    }),
  };
  const io: OnboardingIo = {
    chooseNetworkMode: vi.fn(async () => (calls.push("choice"), options.choice ?? "tailscale")),
    showNetworkDisclosure: vi.fn(async (mode) => {
      calls.push(`disclosure:${mode}`);
    }),
    showPreparedEndpointDisclosure: vi.fn(async (prepared) => {
      calls.push(`endpoint-disclosure:${prepared.mode}`);
    }),
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
      read: vi.fn(async () => options.projection),
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
  it("preserves legacy_unreviewed as a compatibility stage even while its old endpoint is offline", async () => {
    const inspected = { ...endpoint, ready: false };
    const { onboarding } = harness({
      inspected,
      projection: {
        version: 1, stage: "legacy_unreviewed", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });

    await expect(onboarding.status()).resolves.toEqual({
      stage: "legacy_unreviewed", authority: "none", mode: "tailscale", healthy: false, endpoint: inspected,
      issue: { type: "inspection", reason: "endpoint_not_ready" },
    });
  });

  it("chooses a network before creating a readiness challenge and gives the QR only its URL", async () => {
    const { onboarding, dependencies, io, calls } = harness({ proofPhrase: undefined });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(calls.indexOf("state:pending_choice")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("state:pending_choice")).toBeLessThan(calls.indexOf("choice"));
    expect(calls.indexOf("choice")).toBeLessThan(calls.indexOf("prepare"));
    expect(calls.indexOf("disclosure:tailscale")).toBeLessThan(calls.indexOf("prepare"));
    expect(calls.indexOf("prepare")).toBeLessThan(calls.findIndex((entry) => entry.startsWith("phone-qr:")));
    expect(calls.indexOf("prepare")).toBeLessThan(calls.indexOf("endpoint-disclosure:tailscale"));
    expect(calls.indexOf("endpoint-disclosure:tailscale")).toBeLessThan(calls.findIndex((entry) => entry.startsWith("phone-qr:")));
    expect(dependencies.phoneVerification.begin).toHaveBeenCalledWith("tailscale", endpoint);
    expect(io.showPhoneConnectionCheck).toHaveBeenCalledWith(
      "https://cozy.example.ts.net/cozy/onboarding/readiness-only",
      undefined,
    );
    expect(JSON.stringify((io.showPhoneConnectionCheck as ReturnType<typeof vi.fn>).mock.calls))
      .not.toMatch(/amber otter|COZY-1234|account-hash-a/);
    expect(dependencies.createSetupCode).not.toHaveBeenCalled();
  });

  it("lets a resumed prepared route be replaced after disclosure and conditionally rolls it back first", async () => {
    const lanEndpoint: PreparedEndpoint = {
      mode: "lan", canonicalOrigin: "http://192.168.1.20:18787", bindHost: "0.0.0.0",
      port: 18787, durableFingerprint: "lan-posture", physicalAdapterId: "wifi-a",
      dhcpAddress: "192.168.1.20", ready: true,
    };
    const resumed = harness({
      choice: "lan",
      projection: {
        version: 1, stage: "endpoint_ready", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });
    const lanAdapter: NetworkModeAdapter = {
      mode: "lan",
      prepare: vi.fn(async () => (resumed.calls.push("prepare-lan"), lanEndpoint)),
      inspect: vi.fn(async () => lanEndpoint),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    resumed.dependencies.adapters = [resumed.adapter, lanAdapter];
    resumed.onboarding = new NetworkOnboarding(resumed.dependencies);

    await expect(resumed.onboarding.resume(resumed.io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(resumed.io.chooseNetworkMode).toHaveBeenCalledOnce();
    expect(resumed.io.showNetworkDisclosure).toHaveBeenCalledWith("lan", undefined);
    expect(resumed.adapter.rollbackOwned).toHaveBeenCalledWith(endpoint, undefined);
    expect(resumed.calls.indexOf("disclosure:lan")).toBeLessThan(resumed.calls.indexOf("rollback"));
    expect(resumed.calls.indexOf("rollback")).toBeLessThan(resumed.calls.indexOf("prepare-lan"));
  });

  it.each(["later", "cancel"] as const)(
    "rolls back a resumable prepared route when the user chooses %s",
    async (choice) => {
      const { onboarding, dependencies, adapter, io } = harness({
        choice,
        projection: {
          version: 1, stage: "endpoint_ready", mode: "tailscale",
          deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
        },
      });

      await expect(onboarding.resume(io)).resolves.toMatchObject({
        outcome: choice === "later" ? "deferred" : "cancelled",
      });

      expect(io.chooseNetworkMode).toHaveBeenCalledOnce();
      expect(adapter.rollbackOwned).toHaveBeenCalledWith(endpoint, undefined);
      expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
      expect(dependencies.publishPairing).not.toHaveBeenCalled();
    },
  );

  it.each(["later", "cancel"] as const)(
    "reconciles durable ownership instead of trusting a changed live endpoint when choosing %s",
    async (choice) => {
      const changed = { ...endpoint, durableFingerprint: "posture-external" };
      const { onboarding, adapter, io } = harness({
        choice,
        inspected: changed,
        projection: {
          version: 1, stage: "endpoint_ready", mode: "tailscale",
          deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
        },
      });

      await expect(onboarding.resume(io)).resolves.toEqual({
        outcome: choice === "later" ? "deferred" : "cancelled",
      });

      expect(adapter.reconcileOwned).toHaveBeenCalledWith(undefined);
      expect(adapter.rollbackOwned).not.toHaveBeenCalled();
    },
  );

  it("reviews a healthy legacy route through the four-choice prompt before any phone check", async () => {
    const { onboarding, dependencies, io, calls } = harness({
      choice: "later",
      projection: {
        version: 1, stage: "legacy_unreviewed", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });

    await expect(onboarding.resume(io)).resolves.toEqual({ outcome: "deferred" });

    expect(io.chooseNetworkMode).toHaveBeenCalledOnce();
    expect(calls).not.toEqual(expect.arrayContaining([expect.stringMatching(/^phone-qr:/)]));
    expect(dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    expect(dependencies.publishPairing).not.toHaveBeenCalled();
  });

  it("prepares the selected route after legacy review instead of reusing the legacy endpoint", async () => {
    const { onboarding, adapter, io } = harness({
      choice: "tailscale",
      projection: {
        version: 1, stage: "legacy_unreviewed", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });

    await expect(onboarding.resume(io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(io.chooseNetworkMode).toHaveBeenCalledOnce();
    expect(adapter.prepare).toHaveBeenCalledOnce();
  });

  it("preserves a typed retryable inspection pause in status", async () => {
    const { onboarding, adapter } = harness({
      projection: {
        version: 1, stage: "network_selected", mode: "tailscale", updatedAt: 50,
      },
    });
    (adapter.inspect as ReturnType<typeof vi.fn>).mockRejectedValue(Object.assign(
      new Error("Tailscale is waiting for machine approval"),
      { retryable: true as const, reason: "machine_auth_required", detail: "needs_admin" },
    ));

    await expect(onboarding.status()).resolves.toMatchObject({
      stage: "changed",
      healthy: false,
      issue: { type: "pause", reason: "machine_auth_required", detail: "needs_admin" },
    });
  });

  it.each([
    ...(["status", "account_changed", "loopback", "mapping", "tls", "certificate", "redirect", "health", "alpn", "websocket", "ownership"] as const)
      .map((reason) => ["tailscale", new TailscaleModeReadinessError(reason), reason] as const),
    ...(["health", "websocket", "attach", "posture"] as const)
      .map((reason) => ["lan", new LanModeReadinessError(reason), reason] as const),
  ] as const)("preserves a real %s readiness error and its exact reason", async (mode, error, reason) => {
    const current = harness({
      projection: {
        version: 1, stage: "network_selected", mode, updatedAt: 50,
      },
    });
    const adapter: NetworkModeAdapter = {
      mode,
      prepare: vi.fn(async () => ({ ...endpoint, mode })),
      inspect: vi.fn(async () => { throw error; }),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    current.dependencies.adapters = [adapter];
    current.onboarding = new NetworkOnboarding(current.dependencies);

    await expect(current.onboarding.status()).resolves.toMatchObject({
      stage: "changed",
      mode,
      healthy: false,
      issue: { type: "readiness", mode, reason },
    });
  });

  it.each(["later", "cancel"] as const)(
    "reconciles durable LAN ownership after process recreation and failed inspection before %s",
    async (choice) => {
      const current = harness({
        choice,
        projection: {
          version: 1, stage: "endpoint_ready", mode: "lan",
          deploymentFingerprint: "durable-lan-posture", updatedAt: 50,
        },
      });
      const recreatedLan: NetworkModeAdapter = {
        mode: "lan",
        prepare: vi.fn(async () => { throw new Error("not selected"); }),
        inspect: vi.fn(async () => { throw new LanModeReadinessError("posture"); }),
        rollbackOwned: vi.fn(async () => { throw new Error("no endpoint is available"); }),
        reconcileOwned: vi.fn(async () => undefined),
      };
      current.dependencies.adapters = [recreatedLan];
      current.onboarding = new NetworkOnboarding(current.dependencies);

      await expect(current.onboarding.resume(current.io)).resolves.toEqual({
        outcome: choice === "later" ? "deferred" : "cancelled",
      });

      expect(recreatedLan.reconcileOwned).toHaveBeenCalledWith(undefined);
      expect(recreatedLan.rollbackOwned).not.toHaveBeenCalled();
      expect(current.dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    },
  );

  it("fails closed when endpoint-independent reconciliation cannot prove rollback safety", async () => {
    const current = harness({
      choice: "later",
      projection: {
        version: 1, stage: "endpoint_ready", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });
    (current.adapter.inspect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TailscaleModeReadinessError("ownership"),
    );
    (current.adapter.reconcileOwned as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ownership changed concurrently"),
    );

    await expect(current.onboarding.resume(current.io)).resolves.toEqual({
      outcome: "failed", reason: "rollback_failed",
    });

    expect(current.dependencies.phoneVerification.begin).not.toHaveBeenCalled();
    expect(current.projections).not.toContainEqual(expect.objectContaining({ stage: "pending_choice" }));
  });

  it("reconciles an uninspectable saved route before switching modes", async () => {
    const current = harness({
      choice: "lan",
      projection: {
        version: 1, stage: "endpoint_ready", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });
    (current.adapter.inspect as ReturnType<typeof vi.fn>).mockRejectedValue(
      new TailscaleModeReadinessError("status"),
    );
    const lanEndpoint: PreparedEndpoint = {
      mode: "lan", canonicalOrigin: "http://192.168.1.20:18787", bindHost: "0.0.0.0",
      port: 18_787, durableFingerprint: "lan-posture", ready: true,
    };
    const lanAdapter: NetworkModeAdapter = {
      mode: "lan",
      prepare: vi.fn(async () => (current.calls.push("prepare-lan"), lanEndpoint)),
      inspect: vi.fn(async () => lanEndpoint),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    current.dependencies.adapters = [current.adapter, lanAdapter];
    current.onboarding = new NetworkOnboarding(current.dependencies);

    await expect(current.onboarding.resume(current.io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(current.adapter.reconcileOwned).toHaveBeenCalledWith(undefined);
    expect(current.calls.indexOf("reconcile")).toBeLessThan(current.calls.indexOf("prepare-lan"));
  });

  it("reconciles a live route changed outside CozyGateway before switching modes", async () => {
    const current = harness({
      choice: "lan",
      inspected: { ...endpoint, durableFingerprint: "posture-external", serveMappingFingerprint: "serve-external" },
      projection: {
        version: 1, stage: "endpoint_ready", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });
    const lanEndpoint: PreparedEndpoint = {
      mode: "lan", canonicalOrigin: "http://192.168.1.20:18787", bindHost: "0.0.0.0",
      port: 18_787, durableFingerprint: "lan-posture", ready: true,
    };
    const lanAdapter: NetworkModeAdapter = {
      mode: "lan",
      prepare: vi.fn(async () => lanEndpoint),
      inspect: vi.fn(async () => lanEndpoint),
      rollbackOwned: vi.fn(async () => undefined),
      reconcileOwned: vi.fn(async () => undefined),
    };
    current.dependencies.adapters = [current.adapter, lanAdapter];
    current.onboarding = new NetworkOnboarding(current.dependencies);

    await expect(current.onboarding.resume(current.io)).resolves.toMatchObject({ outcome: "not_confirmed" });

    expect(current.adapter.reconcileOwned).toHaveBeenCalledWith(undefined);
    expect(current.adapter.rollbackOwned).not.toHaveBeenCalled();
  });

  it("fails closed when reconciliation cannot prove a changed endpoint is safe to remove", async () => {
    const { onboarding, adapter, io } = harness({
      choice: "later",
      inspected: { ...endpoint, durableFingerprint: "posture-external" },
      rollbackError: new Error("sensitive internal cleanup failure"),
      projection: {
        version: 1, stage: "endpoint_ready", mode: "tailscale",
        deploymentFingerprint: endpoint.durableFingerprint, updatedAt: 50,
      },
    });

    await expect(onboarding.resume(io)).resolves.toEqual({ outcome: "failed", reason: "rollback_failed" });
    expect(adapter.reconcileOwned).toHaveBeenCalledWith(undefined);
    expect(adapter.rollbackOwned).not.toHaveBeenCalled();
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

  it("accepts an asynchronous cross-process challenge whose phrase arrives only after phone proof", async () => {
    const { onboarding, dependencies, io } = harness({ proofPhrase: "silver maple", answer: "y" });
    (dependencies.phoneVerification.begin as ReturnType<typeof vi.fn>).mockResolvedValue({
      challengeId: "challenge-1",
      sessionId: "session-1",
      verificationUrl: "https://cozy.example.ts.net/cozy/onboarding/readiness-only",
      expiresAt: 600_000,
    });

    await expect(onboarding.run(io)).resolves.toMatchObject({ outcome: "complete" });
    expect(io.showAuthoritativePhrase).toHaveBeenCalledWith("silver maple", undefined);
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

  it.each(["begin", "poll"] as const)(
    "pauses without rolling back or creating pairing material while the Gateway restarts during %s",
    async (boundary) => {
      const { onboarding, dependencies, adapter, io, projections } = harness();
      const unavailable = Object.assign(new Error("local onboarding control is unavailable"), {
        retryable: true as const,
        reason: "gateway_restarting",
      });
      if (boundary === "begin")
        (dependencies.phoneVerification.begin as ReturnType<typeof vi.fn>).mockRejectedValue(unavailable);
      else
        (dependencies.phoneVerification.waitForConfirmation as ReturnType<typeof vi.fn>).mockRejectedValue(unavailable);

      await expect(onboarding.run(io)).resolves.toEqual({
        outcome: "paused", mode: "tailscale", reason: "gateway_restarting",
      });
      expect(adapter.rollbackOwned).not.toHaveBeenCalled();
      expect(dependencies.publishPairing).not.toHaveBeenCalled();
      expect(dependencies.createSetupCode).not.toHaveBeenCalled();
      expect(projections).toContainEqual(expect.objectContaining({ stage: "endpoint_ready" }));
    },
  );

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
      expect(io.chooseNetworkMode).toHaveBeenCalledOnce();
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
      reconcileOwned: async () => undefined,
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
      showNetworkDisclosure: async () => undefined,
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

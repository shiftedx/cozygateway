import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LanModeAdapter,
  LanModePause,
  LanModeRollbackError,
  SqliteLanOwnershipStore,
  type LanListenerState,
  type LanListenerOwnership,
  type LanOwnershipStore,
  type LanModeRuntime,
  type LanProbeResult,
} from "../src/lan-mode.ts";
import type { PhysicalLanCandidate, WindowsLanAdapter, WindowsLanInventory } from "../src/lan.ts";
import { openStorage } from "../src/storage.ts";

function physical(overrides: Partial<WindowsLanAdapter> = {}): WindowsLanAdapter {
  return {
    id: "physical-ethernet",
    displayName: "Réseau principal",
    kind: "ethernet",
    hardwareInterface: true,
    status: "up",
    ipv4Addresses: ["192.168.1.23"],
    ...overrides,
  };
}

function copyState(state: LanListenerState): LanListenerState {
  return {
    bindHost: state.bindHost,
    port: state.port,
    hermesTargets: state.hermesTargets.map((target) => ({ ...target })),
    ...(state.persistenceRevision === undefined ? {} : { persistenceRevision: state.persistenceRevision }),
  };
}

function sameState(left: LanListenerState, right: LanListenerState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class FakeLanRuntime implements LanModeRuntime {
  ownership: LanOwnershipStore;
  inventory: WindowsLanInventory = { schemaVersion: 1, adapters: [physical()] };
  listener: LanListenerState = {
    bindHost: "127.0.0.1",
    port: 18787,
    hermesTargets: [
      { profile: "default", url: "http://127.0.0.1:18787" },
      { profile: "cleo", url: "http://127.0.0.1:18787" },
    ],
  };
  probe: LanProbeResult = { health: true, webSocket: true, attachReady: true };
  compareAndSwapCalls: Array<{ expected: LanListenerState; replacement: LanListenerState }> = [];
  restartCalls: LanListenerState[] = [];
  probeCalls = 0;
  failRestartCall?: number;
  rejectCasCall?: number;
  beforeProbe?: () => void;
  chooseAdapter?: (candidates: readonly PhysicalLanCandidate[]) => Promise<string | undefined>;
  selectedAdapterId?: string;
  planListenerState?: (expected: LanListenerState, replacement: LanListenerState) => Promise<LanListenerState>;

  constructor() {
    let stored: LanListenerOwnership | undefined;
    this.ownership = {
      read: async () => stored,
      write: async (value) => {
        if (stored !== undefined) return JSON.stringify(stored) === JSON.stringify(value) ? "existing" : "conflict";
        stored = structuredClone(value);
        return "written";
      },
      replace: async (expected, replacement) => {
        if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
        stored = structuredClone(replacement);
        return true;
      },
      remove: async (expected) => {
        if (JSON.stringify(stored) !== JSON.stringify(expected)) return false;
        stored = undefined;
        return true;
      },
    };
  }

  async readSelectedAdapter(): Promise<string | undefined> { return this.selectedAdapterId; }
  async writeSelectedAdapter(adapterId: string): Promise<void> { this.selectedAdapterId = adapterId; }

  async readAdapterInventory(): Promise<WindowsLanInventory> {
    return structuredClone(this.inventory);
  }

  async readListenerState(): Promise<LanListenerState> {
    return copyState(this.listener);
  }

  async compareAndSwapListener(
    expected: LanListenerState,
    replacement: LanListenerState,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    this.compareAndSwapCalls.push({ expected: copyState(expected), replacement: copyState(replacement) });
    if (this.compareAndSwapCalls.length === this.rejectCasCall) return false;
    if (!sameState(this.listener, expected)) return false;
    this.listener = copyState(replacement);
    return true;
  }

  async restartAndWait(state: LanListenerState): Promise<void> {
    this.restartCalls.push(copyState(state));
    if (this.restartCalls.length === this.failRestartCall) throw new Error("restart failed");
  }

  async probeEndpoint(): Promise<LanProbeResult> {
    this.probeCalls += 1;
    this.beforeProbe?.();
    return { ...this.probe };
  }
}

describe("LanModeAdapter", () => {
  it("persists LAN listener ownership with SQLite compare-and-swap authority", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cozygateway-lan-ownership-"));
    const storage = openStorage(join(directory, "gateway.sqlite"));
    const ownership = new SqliteLanOwnershipStore(storage);
    const before: LanListenerState = {
      bindHost: "127.0.0.1", port: 18_787,
      hermesTargets: [{ profile: "default", url: "http://127.0.0.1:18787" }],
    };
    const provisional: LanListenerOwnership = {
      schemaVersion: 1,
      phase: "provisional",
      ownershipSubtype: "wizard-listener-cas",
      before,
      after: { ...before, bindHost: "0.0.0.0" },
      createdAt: 123,
    };
    try {
      await expect(ownership.write(provisional)).resolves.toBe("written");
      await expect(ownership.read()).resolves.toEqual(provisional);
      const active = { ...provisional, phase: "active" as const, endpointFingerprint: "a".repeat(64) };
      await expect(ownership.replace(provisional, active)).resolves.toBe(true);
      await expect(ownership.replace(provisional, active)).resolves.toBe(false);
      await expect(ownership.remove(provisional)).resolves.toBe(false);
      await expect(ownership.remove(active)).resolves.toBe(true);
    } finally {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists provisional listener authority before CAS and promotes it only after readiness", async () => {
    const runtime = new FakeLanRuntime();
    const events: string[] = [];
    const write = runtime.ownership.write.bind(runtime.ownership);
    runtime.ownership.write = async (value, signal) => {
      events.push(`ownership:${value.phase}`);
      return write(value, signal);
    };
    const replace = runtime.ownership.replace.bind(runtime.ownership);
    runtime.ownership.replace = async (expected, replacement, signal) => {
      events.push(`ownership:${replacement.phase}`);
      return replace(expected, replacement, signal);
    };
    const cas = runtime.compareAndSwapListener.bind(runtime);
    runtime.compareAndSwapListener = async (expected, replacement, signal) => {
      events.push("listener:cas");
      return cas(expected, replacement, signal);
    };

    await expect(new LanModeAdapter(runtime).prepare()).resolves.toMatchObject({ ready: true });
    expect(events).toEqual(["ownership:provisional", "listener:cas", "ownership:active"]);
    await expect(runtime.ownership.read()).resolves.toMatchObject({
      phase: "active",
      ownershipSubtype: "wizard-listener-cas",
    });
  });

  it("persists the exact planned revision before the production listener CAS", async () => {
    const runtime = new FakeLanRuntime();
    runtime.listener.persistenceRevision = "before-revision";
    runtime.planListenerState = async (_expected, replacement) => ({
      ...copyState(replacement), persistenceRevision: "planned-applied-revision",
    });
    let provisional: LanListenerOwnership | undefined;
    const write = runtime.ownership.write.bind(runtime.ownership);
    runtime.ownership.write = async (value, signal) => {
      provisional = structuredClone(value);
      return write(value, signal);
    };

    await new LanModeAdapter(runtime).prepare();

    expect(provisional?.after.persistenceRevision).toBe("planned-applied-revision");
    expect(runtime.compareAndSwapCalls[0]?.replacement.persistenceRevision).toBe("planned-applied-revision");
  });

  it("resumes a listener CAS that completed before process loss from SQLite authority", async () => {
    const runtime = new FakeLanRuntime();
    const before = copyState(runtime.listener);
    const after = { ...before, bindHost: "0.0.0.0" };
    const provisional: LanListenerOwnership = {
      schemaVersion: 1,
      phase: "provisional",
      ownershipSubtype: "wizard-listener-cas",
      before,
      after,
      createdAt: 123,
    };
    await runtime.ownership.write(provisional);
    await runtime.compareAndSwapListener(before, after);

    const endpoint = await new LanModeAdapter(runtime).prepare();

    expect(endpoint).toMatchObject({ ready: true, bindHost: "0.0.0.0" });
    expect(runtime.compareAndSwapCalls).toHaveLength(1);
    await expect(runtime.ownership.read()).resolves.toMatchObject({ phase: "active" });
  });

  it("adopts the exact applied listener revision after a post-CAS process loss", async () => {
    const runtime = new FakeLanRuntime();
    runtime.listener.persistenceRevision = "before-revision";
    const before = copyState(runtime.listener);
    const afterIntent: LanListenerState = {
      bindHost: "0.0.0.0", port: before.port, hermesTargets: before.hermesTargets.map((target) => ({ ...target })),
    };
    const provisional: LanListenerOwnership = {
      schemaVersion: 1,
      phase: "provisional",
      ownershipSubtype: "wizard-listener-cas",
      before,
      after: afterIntent,
      createdAt: 123,
    };
    await runtime.ownership.write(provisional);
    runtime.listener = { ...afterIntent, persistenceRevision: "applied-revision" };

    await expect(new LanModeAdapter(runtime).prepare()).resolves.toMatchObject({ ready: true });

    expect(runtime.compareAndSwapCalls).toEqual([]);
    expect(runtime.restartCalls).toEqual([{ ...afterIntent, persistenceRevision: "applied-revision" }]);
    await expect(runtime.ownership.read()).resolves.toMatchObject({
      phase: "active",
      after: { persistenceRevision: "applied-revision" },
    });
  });

  it("prepares wildcard LAN state, synchronizes Hermes, and discloses every other Up interface", async () => {
    const runtime = new FakeLanRuntime();
    runtime.inventory.adapters.push(
      physical({
        id: "tailscale-software",
        displayName: "Tailscale",
        kind: "other",
        hardwareInterface: false,
        ipv4Addresses: ["100.64.7.9"],
      }),
      physical({ id: "disabled-wifi", displayName: "Guest Wi-Fi", kind: "wifi", status: "disabled" }),
    );
    const adapter = new LanModeAdapter(runtime);

    const endpoint = await adapter.prepare();

    expect(endpoint).toMatchObject({
      mode: "lan",
      canonicalOrigin: "http://192.168.1.23:18787",
      bindHost: "0.0.0.0",
      port: 18787,
      physicalAdapterId: "physical-ethernet",
      dhcpAddress: "192.168.1.23",
      ready: true,
      wildcardExposure: {
        selectedInterface: "Réseau principal",
        otherInterfaces: [{ id: "tailscale-software", displayName: "Tailscale", kind: "other" }],
        message: expect.stringMatching(/0\.0\.0\.0.*Tailscale/i),
      },
    });
    expect(endpoint.plaintextWarning).toMatch(/trusted private network.*plaintext/i);
    expect(runtime.listener).toEqual({
      bindHost: "0.0.0.0",
      port: 18787,
      hermesTargets: [
        { profile: "default", url: "http://127.0.0.1:18787" },
        { profile: "cleo", url: "http://127.0.0.1:18787" },
      ],
    });
    expect(runtime.restartCalls).toHaveLength(1);
  });

  it("returns selection details and raises a typed retryable pause without mutation on ambiguity", async () => {
    const runtime = new FakeLanRuntime();
    runtime.inventory.adapters.push(physical({
      id: "wifi",
      displayName: "Wireless",
      kind: "wifi",
      ipv4Addresses: ["10.0.0.5"],
    }));
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.inspectSelection()).resolves.toMatchObject({
      outcome: "paused",
      reason: "multiple_up_physical_private_ipv4",
      candidates: [{ adapterId: "physical-ethernet" }, { adapterId: "wifi" }],
    });
    const error = await adapter.prepare().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LanModePause);
    expect(error).toMatchObject({
      retryable: true,
      reason: "multiple_up_physical_private_ipv4",
      candidates: [{ adapterId: "physical-ethernet" }, { adapterId: "wifi" }],
    });
    expect(runtime.compareAndSwapCalls).toEqual([]);
    expect(runtime.restartCalls).toEqual([]);
  });

  it("prepares only the explicitly selected normalized candidate when physical adapters are ambiguous", async () => {
    const runtime = new FakeLanRuntime();
    runtime.inventory.adapters.push(physical({
      id: "wifi", displayName: "Wireless", kind: "wifi", ipv4Addresses: ["10.0.0.5"],
    }));
    runtime.chooseAdapter = async (candidates) => {
      expect(candidates).toEqual([
        expect.objectContaining({ adapterId: "physical-ethernet", address: "192.168.1.23" }),
        expect.objectContaining({ adapterId: "wifi", address: "10.0.0.5" }),
      ]);
      return "wifi";
    };
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).resolves.toMatchObject({
      physicalAdapterId: "wifi", dhcpAddress: "10.0.0.5", canonicalOrigin: "http://10.0.0.5:18787",
    });
    runtime.chooseAdapter = async () => { throw new Error("must reuse explicit selection"); };
    await expect(new LanModeAdapter(runtime).inspect()).resolves.toMatchObject({
      physicalAdapterId: "wifi", dhcpAddress: "10.0.0.5",
    });
  });

  it("explicitly replaces a persisted adapter when prepare finds a different sole candidate", async () => {
    const runtime = new FakeLanRuntime();
    runtime.selectedAdapterId = "wifi-that-went-away";
    runtime.chooseAdapter = async (candidates) => {
      expect(candidates).toEqual([
        expect.objectContaining({ adapterId: "physical-ethernet", address: "192.168.1.23" }),
      ]);
      return "physical-ethernet";
    };

    await expect(new LanModeAdapter(runtime).prepare()).resolves.toMatchObject({
      physicalAdapterId: "physical-ethernet", dhcpAddress: "192.168.1.23",
    });
    expect(runtime.selectedAdapterId).toBe("physical-ethernet");
  });

  it.each([undefined, "not-a-current-candidate"])(
    "pauses without mutation when replacement-adapter confirmation returns %s",
    async (replacement) => {
    const runtime = new FakeLanRuntime();
    runtime.selectedAdapterId = "wifi-that-went-away";
    runtime.chooseAdapter = async () => replacement;

    await expect(new LanModeAdapter(runtime).prepare()).rejects.toMatchObject({
      retryable: true, reason: "adapter_changed",
    });
    expect(runtime.selectedAdapterId).toBe("wifi-that-went-away");
    expect(runtime.compareAndSwapCalls).toEqual([]);
    expect(runtime.restartCalls).toEqual([]);
    },
  );

  it.each([
    [{ health: false, webSocket: true, attachReady: true }, "health"],
    [{ health: true, webSocket: false, attachReady: true }, "websocket"],
    [{ health: true, webSocket: true, attachReady: false }, "attach"],
  ] as const)("rolls back exactly the listener and Hermes state it prepared after %s loss", async (probe, reason) => {
    const runtime = new FakeLanRuntime();
    const before = copyState(runtime.listener);
    runtime.probe = probe;
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).rejects.toMatchObject({ reason });

    expect(runtime.listener).toEqual(before);
    expect(runtime.compareAndSwapCalls).toHaveLength(2);
    expect(runtime.probeCalls).toBe(1);
    expect(runtime.restartCalls).toEqual([
      { ...before, bindHost: "0.0.0.0" },
      before,
    ]);
  });

  it("preserves a concurrent listener edit and reports rollback_failed when readiness fails", async () => {
    const runtime = new FakeLanRuntime();
    runtime.probe = { health: false, webSocket: false, attachReady: true };
    runtime.beforeProbe = () => {
      runtime.listener = {
        bindHost: "192.168.1.99",
        port: 19999,
        hermesTargets: [{ profile: "default", url: "http://127.0.0.1:19999" }],
      };
    };
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "rollback_failed" });

    expect(runtime.listener).toEqual({
      bindHost: "192.168.1.99",
      port: 19999,
      hermesTargets: [{ profile: "default", url: "http://127.0.0.1:19999" }],
    });
    expect(runtime.compareAndSwapCalls).toHaveLength(1);
    expect(runtime.restartCalls).toHaveLength(1);
  });

  it("rolls back and reports posture drift when DHCP changes during the final probe", async () => {
    const runtime = new FakeLanRuntime();
    const before = copyState(runtime.listener);
    runtime.beforeProbe = () => {
      runtime.inventory.adapters[0] = physical({ ipv4Addresses: ["192.168.1.24"] });
    };
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "posture" });

    expect(runtime.listener).toEqual(before);
    expect(runtime.compareAndSwapCalls).toHaveLength(2);
  });

  it("rolls back and reports posture drift when the selected adapter is replaced during the final probe", async () => {
    const runtime = new FakeLanRuntime();
    runtime.beforeProbe = () => {
      runtime.inventory.adapters[0] = physical({ id: "replacement-wifi", kind: "wifi" });
    };
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).rejects.toMatchObject({ reason: "posture" });

    expect(runtime.listener.bindHost).toBe("127.0.0.1");
  });

  it.each([
    [
      "no candidate",
      [physical({ status: "down" })],
      "no_up_physical_private_ipv4",
      [],
    ],
    [
      "ambiguous candidates",
      [
        physical(),
        physical({ id: "wifi", displayName: "Wireless", kind: "wifi", ipv4Addresses: ["10.0.0.5"] }),
      ],
      "multiple_up_physical_private_ipv4",
      [{ adapterId: "physical-ethernet" }, { adapterId: "wifi" }],
    ],
  ] as const)("keeps a %s observation during the final probe typed and retryable", async (
    _label,
    adapters,
    reason,
    candidates,
  ) => {
    const runtime = new FakeLanRuntime();
    runtime.beforeProbe = () => {
      runtime.inventory.adapters = structuredClone([...adapters]);
    };
    const adapter = new LanModeAdapter(runtime);

    const error = await adapter.prepare().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LanModePause);
    expect(error).toMatchObject({ retryable: true, reason, candidates });
    expect(runtime.listener.bindHost).toBe("127.0.0.1");
  });

  it("builds wildcard disclosure from the verified post-probe inventory", async () => {
    const runtime = new FakeLanRuntime();
    runtime.beforeProbe = () => {
      runtime.inventory.adapters.push(physical({
        id: "new-software-interface",
        displayName: "New VPN",
        kind: "other",
        hardwareInterface: false,
        ipv4Addresses: ["100.64.20.30"],
      }));
    };
    const adapter = new LanModeAdapter(runtime);

    const endpoint = await adapter.prepare();

    expect(endpoint.wildcardExposure).toMatchObject({
      otherInterfaces: [{ id: "new-software-interface", displayName: "New VPN", kind: "other" }],
      message: expect.stringContaining("New VPN"),
    });
  });

  it("keeps ambiguity discovered by inspect after its probe typed and retryable", async () => {
    const runtime = new FakeLanRuntime();
    runtime.listener.bindHost = "0.0.0.0";
    runtime.beforeProbe = () => {
      runtime.inventory.adapters.push(physical({
        id: "second-physical",
        displayName: "Second physical adapter",
        kind: "wifi",
        ipv4Addresses: ["10.0.0.6"],
      }));
    };
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.inspect()).rejects.toMatchObject({
      retryable: true,
      reason: "multiple_up_physical_private_ipv4",
      candidates: [{ adapterId: "physical-ethernet" }, { adapterId: "second-physical" }],
    });
  });

  it("invalidates a DHCP address change before pairing and conditionally restores owned state", async () => {
    const runtime = new FakeLanRuntime();
    const before = copyState(runtime.listener);
    const adapter = new LanModeAdapter(runtime);
    const endpoint = await adapter.prepare();

    runtime.inventory.adapters[0] = physical({ ipv4Addresses: ["192.168.1.24"] });

    await expect(adapter.verify(endpoint)).resolves.toBe(false);
    await adapter.rollbackOwned(endpoint);
    expect(runtime.listener).toEqual(before);
  });

  it("preserves concurrent changes made after prepare instead of overwriting them during rollback", async () => {
    const runtime = new FakeLanRuntime();
    const adapter = new LanModeAdapter(runtime);
    const endpoint = await adapter.prepare();
    runtime.listener = {
      bindHost: "127.0.0.1",
      port: 20000,
      hermesTargets: [{ profile: "default", url: "http://127.0.0.1:20000" }],
    };
    const concurrent = copyState(runtime.listener);

    await expect(adapter.rollbackOwned(endpoint)).rejects.toBeInstanceOf(LanModeRollbackError);
    await expect(adapter.rollbackOwned(endpoint)).rejects.toMatchObject({ reason: "rollback_failed" });

    expect(runtime.listener).toEqual(concurrent);
    expect(runtime.restartCalls).toHaveLength(1);
  });

  it("reports rollback_failed when the listener rollback CAS loses a race", async () => {
    const runtime = new FakeLanRuntime();
    runtime.rejectCasCall = 2;
    const adapter = new LanModeAdapter(runtime);
    const endpoint = await adapter.prepare();

    await expect(adapter.rollbackOwned(endpoint)).rejects.toMatchObject({ reason: "rollback_failed" });
    expect(runtime.listener.bindHost).toBe("0.0.0.0");
    expect(runtime.restartCalls).toHaveLength(1);
    await expect(runtime.ownership.read()).resolves.toMatchObject({ phase: "rollback-restart-required" });
  });

  it("retains restart-required authority and retries restart after rollback CAS succeeds", async () => {
    const runtime = new FakeLanRuntime();
    const adapter = new LanModeAdapter(runtime);
    const endpoint = await adapter.prepare();
    runtime.failRestartCall = 2;

    await expect(adapter.rollbackOwned(endpoint)).rejects.toMatchObject({ reason: "rollback_failed" });
    expect(runtime.listener.bindHost).toBe("127.0.0.1");
    await expect(runtime.ownership.read()).resolves.toMatchObject({ phase: "rollback-restart-required" });

    runtime.failRestartCall = undefined;
    await expect(new LanModeAdapter(runtime).reconcileOwned()).resolves.toBeUndefined();
    expect(runtime.restartCalls).toHaveLength(3);
    await expect(runtime.ownership.read()).resolves.toBeUndefined();
  });

  it("reports a non-ready endpoint when health or WebSocket proof is later lost", async () => {
    const runtime = new FakeLanRuntime();
    const adapter = new LanModeAdapter(runtime);
    await adapter.prepare();
    runtime.probe = { health: true, webSocket: false, attachReady: true };

    await expect(adapter.inspect()).resolves.toMatchObject({ ready: false });
  });

  it("treats Hermes-target drift as non-ready even while network probes still pass", async () => {
    const runtime = new FakeLanRuntime();
    const adapter = new LanModeAdapter(runtime);
    await adapter.prepare();
    runtime.listener.hermesTargets[0] = { profile: "default", url: "http://127.0.0.1:29999" };

    await expect(adapter.inspect()).resolves.toMatchObject({ ready: false });
  });

  it("restores its exact listener transaction when restart or attach readiness throws", async () => {
    const runtime = new FakeLanRuntime();
    const before = copyState(runtime.listener);
    runtime.failRestartCall = 1;
    const adapter = new LanModeAdapter(runtime);

    await expect(adapter.prepare()).rejects.toThrow("restart failed");

    expect(runtime.listener).toEqual(before);
    expect(runtime.compareAndSwapCalls).toHaveLength(2);
    expect(runtime.restartCalls).toEqual([{ ...before, bindHost: "0.0.0.0" }, before]);
    expect(runtime.probeCalls).toBe(0);
  });
});

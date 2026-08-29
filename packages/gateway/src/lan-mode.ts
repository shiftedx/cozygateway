import { createHash } from "node:crypto";

import {
  selectPhysicalLanCandidate,
  type PhysicalLanCandidate,
  type PhysicalLanSelection,
  type WindowsLanInventory,
} from "./lan.ts";
import { samePreparedEndpoint, type NetworkModeAdapter, type PreparedEndpoint } from "./network-onboarding.ts";
import type { OnboardingOwnershipInput, OnboardingOwnershipWriteResult } from "./storage.ts";

export interface LanHermesTarget {
  profile: string;
  url: string;
}

/** The listener and every installer-managed Hermes target form one compare-and-swap unit. The
 * concrete Windows runtime persists it atomically; durable SQLite intent makes the external CAS
 * recoverable across process loss. */
export interface LanListenerState {
  bindHost: string;
  port: number;
  hermesTargets: LanHermesTarget[];
  /** Opaque hash of the complete persisted config/install-state/Hermes files. It is used only by
   * the concrete writer CAS and is deliberately excluded from endpoint fingerprints. */
  persistenceRevision?: string;
}

export interface LanProbeResult {
  health: boolean;
  webSocket: boolean;
  /** Gateway health is insufficient when no managed Hermes attach stream is ready. */
  attachReady: boolean;
}

export interface LanModeRuntime {
  ownership: LanOwnershipStore;
  readAdapterInventory(signal?: AbortSignal): Promise<WindowsLanInventory>;
  readSelectedAdapter?(signal?: AbortSignal): Promise<string | undefined>;
  writeSelectedAdapter?(adapterId: string, signal?: AbortSignal): Promise<void>;
  chooseAdapter?(
    candidates: readonly PhysicalLanCandidate[],
    signal?: AbortSignal,
  ): Promise<string | undefined>;
  readListenerState(signal?: AbortSignal): Promise<LanListenerState>;
  compareAndSwapListener(
    expected: LanListenerState,
    replacement: LanListenerState,
    signal?: AbortSignal,
  ): Promise<boolean>;
  restartAndWait(state: LanListenerState, signal?: AbortSignal): Promise<void>;
  probeEndpoint(canonicalOrigin: string, signal?: AbortSignal): Promise<LanProbeResult>;
}

export interface ExposedLanInterface {
  id: string;
  displayName: string;
  kind: "ethernet" | "wifi" | "other";
}

export interface LanPreparedEndpoint extends PreparedEndpoint {
  mode: "lan";
  physicalAdapterId: string;
  dhcpAddress: string;
  plaintextWarning: string;
  wildcardExposure: {
    selectedInterface: string;
    otherInterfaces: ExposedLanInterface[];
    message: string;
  };
}

export class LanModePause extends Error {
  readonly retryable = true;
  readonly reason: Extract<PhysicalLanSelection, { outcome: "paused" }>["reason"]
    | "adapter_changed" | "listener_changed";
  readonly candidates: PhysicalLanCandidate[];

  constructor(
    reason: LanModePause["reason"],
    candidates: PhysicalLanCandidate[],
  ) {
    super(`LAN onboarding paused: ${reason}`);
    this.name = "LanModePause";
    this.reason = reason;
    this.candidates = candidates;
  }
}

export class LanModeReadinessError extends Error {
  readonly reason: "health" | "websocket" | "attach" | "posture";

  constructor(reason: LanModeReadinessError["reason"]) {
    super(`LAN endpoint failed ${reason} verification`);
    this.name = "LanModeReadinessError";
    this.reason = reason;
  }
}

export class LanModeRollbackError extends Error {
  readonly reason = "rollback_failed" as const;

  constructor() {
    super("LAN listener rollback failed");
    this.name = "LanModeRollbackError";
  }
}

export interface LanListenerOwnership {
  schemaVersion: 1;
  phase: "provisional" | "active";
  ownershipSubtype: "wizard-listener-cas";
  before: LanListenerState;
  after: LanListenerState;
  endpointFingerprint?: string;
  createdAt: number;
}

export interface LanOwnershipStore {
  read(signal?: AbortSignal): Promise<LanListenerOwnership | undefined>;
  write(ownership: LanListenerOwnership, signal?: AbortSignal): Promise<"written" | "existing" | "conflict">;
  replace(expected: LanListenerOwnership, replacement: LanListenerOwnership, signal?: AbortSignal): Promise<boolean>;
  remove(ownership: LanListenerOwnership, signal?: AbortSignal): Promise<boolean>;
}

export interface LanOwnershipAuthority {
  onboardingOwnership(ownershipKey: string): OnboardingOwnershipInput | undefined;
  recordOnboardingOwnership(input: OnboardingOwnershipInput): OnboardingOwnershipWriteResult;
  replaceOnboardingOwnership(expected: OnboardingOwnershipInput, replacement: OnboardingOwnershipInput): boolean;
  removeOnboardingOwnership(input: OnboardingOwnershipInput): boolean;
}

function copyState(state: LanListenerState): LanListenerState {
  return {
    bindHost: state.bindHost,
    port: state.port,
    hermesTargets: state.hermesTargets.map((target) => ({ ...target })),
    ...(state.persistenceRevision === undefined ? {} : { persistenceRevision: state.persistenceRevision }),
  };
}

const LAN_OWNERSHIP_KEY = "lan:listener";

function ownershipJson(ownership: LanListenerOwnership): string {
  return JSON.stringify({
    schemaVersion: ownership.schemaVersion,
    phase: ownership.phase,
    ownershipSubtype: ownership.ownershipSubtype,
    before: copyState(ownership.before),
    after: copyState(ownership.after),
    ...(ownership.endpointFingerprint === undefined ? {} : { endpointFingerprint: ownership.endpointFingerprint }),
    createdAt: ownership.createdAt,
  });
}

function ownershipFingerprint(ownership: LanListenerOwnership): string {
  return createHash("sha256").update(ownershipJson(ownership)).digest("hex");
}

function validListenerState(value: unknown): value is LanListenerState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  if (typeof state.bindHost !== "string" || !Number.isSafeInteger(state.port)
    || (state.port as number) < 1 || (state.port as number) > 65_535 || !Array.isArray(state.hermesTargets)) return false;
  if (state.persistenceRevision !== undefined && typeof state.persistenceRevision !== "string") return false;
  return state.hermesTargets.every((target) => typeof target === "object" && target !== null && !Array.isArray(target)
    && typeof (target as Record<string, unknown>).profile === "string"
    && typeof (target as Record<string, unknown>).url === "string");
}

function validLanOwnership(value: unknown): value is LanListenerOwnership {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const owned = value as Record<string, unknown>;
  return owned.schemaVersion === 1
    && (owned.phase === "provisional" || owned.phase === "active")
    && owned.ownershipSubtype === "wizard-listener-cas"
    && validListenerState(owned.before)
    && validListenerState(owned.after)
    && (owned.endpointFingerprint === undefined
      || (typeof owned.endpointFingerprint === "string" && /^[0-9a-f]{64}$/.test(owned.endpointFingerprint)))
    && Number.isSafeInteger(owned.createdAt) && (owned.createdAt as number) >= 0;
}

export class SqliteLanOwnershipStore implements LanOwnershipStore {
  readonly #authority: LanOwnershipAuthority;

  constructor(authority: LanOwnershipAuthority) { this.#authority = authority; }

  async read(_signal?: AbortSignal): Promise<LanListenerOwnership | undefined> {
    const row = this.#authority.onboardingOwnership(LAN_OWNERSHIP_KEY);
    if (row === undefined) return undefined;
    if (row.mode !== "lan") throw new LanModeRollbackError();
    let parsed: unknown;
    try { parsed = JSON.parse(row.ownedStateJson); } catch { throw new LanModeRollbackError(); }
    if (!validLanOwnership(parsed) || row.durableFingerprint !== ownershipFingerprint(parsed))
      throw new LanModeRollbackError();
    return parsed;
  }

  async write(ownership: LanListenerOwnership, _signal?: AbortSignal): Promise<"written" | "existing" | "conflict"> {
    if (!validLanOwnership(ownership)) throw new LanModeRollbackError();
    return this.#authority.recordOnboardingOwnership(this.#input(ownership));
  }

  async replace(
    expected: LanListenerOwnership,
    replacement: LanListenerOwnership,
    _signal?: AbortSignal,
  ): Promise<boolean> {
    if (!validLanOwnership(expected) || !validLanOwnership(replacement)) throw new LanModeRollbackError();
    return this.#authority.replaceOnboardingOwnership(this.#input(expected), this.#input(replacement));
  }

  async remove(ownership: LanListenerOwnership, _signal?: AbortSignal): Promise<boolean> {
    if (!validLanOwnership(ownership)) throw new LanModeRollbackError();
    return this.#authority.removeOnboardingOwnership(this.#input(ownership));
  }

  #input(ownership: LanListenerOwnership): OnboardingOwnershipInput {
    return {
      ownershipKey: LAN_OWNERSHIP_KEY,
      mode: "lan",
      durableFingerprint: ownershipFingerprint(ownership),
      ownedStateJson: ownershipJson(ownership),
      createdAt: ownership.createdAt,
    };
  }
}

function stateFingerprint(state: LanListenerState): string {
  const targets = state.hermesTargets
    .map(({ profile, url }) => ({ profile, url }))
    .sort((left, right) => {
      const leftKey = `${left.profile}\u0000${left.url}`;
      const rightKey = `${right.profile}\u0000${right.url}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return JSON.stringify({ bindHost: state.bindHost, port: state.port, hermesTargets: targets });
}

function sameState(left: LanListenerState, right: LanListenerState): boolean {
  return stateFingerprint(left) === stateFingerprint(right);
}

function preparedState(before: LanListenerState): LanListenerState {
  const target = `http://127.0.0.1:${before.port}`;
  return {
    bindHost: "0.0.0.0",
    port: before.port,
    hermesTargets: before.hermesTargets.map(({ profile }) => ({ profile, url: target })),
  };
}

function exposure(inventory: WindowsLanInventory, selected: PhysicalLanCandidate): LanPreparedEndpoint["wildcardExposure"] {
  const otherInterfaces = inventory.adapters
    .filter((adapter) => adapter.status === "up" && adapter.id !== selected.adapterId)
    .map(({ id, displayName, kind }) => ({ id, displayName, kind }));
  const named = otherInterfaces.map(({ displayName }) => displayName).join(", ");
  return {
    selectedInterface: selected.displayName,
    otherInterfaces,
    message: named.length === 0
      ? "Listening on 0.0.0.0 exposes every interface that becomes active."
      : `Listening on 0.0.0.0 also exposes these active interfaces: ${named}.`,
  };
}

type LanOwnershipSubtype = "wizard-listener-cas" | "preexisting-listener";

function endpointFingerprint(
  candidate: PhysicalLanCandidate,
  listener: LanListenerState,
  ownershipSubtype: LanOwnershipSubtype,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      mode: "lan",
      adapterId: candidate.adapterId,
      address: candidate.address,
      listener: JSON.parse(stateFingerprint(listener)) as unknown,
      ownershipSubtype,
    }))
    .digest("hex");
}

function endpointOf(
  candidate: PhysicalLanCandidate,
  inventory: WindowsLanInventory,
  listener: LanListenerState,
  probe: LanProbeResult,
  listenerStable = true,
  ownershipSubtype: LanOwnershipSubtype = "preexisting-listener",
): LanPreparedEndpoint {
  return {
    mode: "lan",
    canonicalOrigin: `http://${candidate.address}:${listener.port}`,
    bindHost: listener.bindHost,
    port: listener.port,
    durableFingerprint: endpointFingerprint(candidate, listener, ownershipSubtype),
    physicalAdapterId: candidate.adapterId,
    dhcpAddress: candidate.address,
    ready: listenerStable
      && sameState(listener, preparedState(listener))
      && probe.health
      && probe.webSocket
      && probe.attachReady,
    plaintextWarning: "Use LAN mode only on a trusted private network; traffic is plaintext.",
    wildcardExposure: exposure(inventory, candidate),
  };
}

/** Strict physical-LAN implementation. All effects are delegated to `LanModeRuntime`; this class
 * never reads host interfaces or mutates files, services, listeners, or Hermes directly. */
export class LanModeAdapter implements NetworkModeAdapter {
  readonly mode = "lan" as const;
  readonly #runtime: LanModeRuntime;
  #owned?: LanListenerOwnership;
  #selectedAdapterId?: string;

  constructor(runtime: LanModeRuntime) {
    this.#runtime = runtime;
  }

  async inspectSelection(signal?: AbortSignal): Promise<PhysicalLanSelection> {
    return selectPhysicalLanCandidate(await this.#runtime.readAdapterInventory(signal));
  }

  async prepare(signal?: AbortSignal): Promise<LanPreparedEndpoint> {
    const inventory = await this.#runtime.readAdapterInventory(signal);
    const candidate = await this.#candidate(inventory, true, signal);
    const before = await this.#runtime.readListenerState(signal);
    const after = preparedState(before);
    let owned = await this.#runtime.ownership.read(signal);
    let listenerMutated = false;
    if (owned !== undefined) {
      if (!sameState(owned.after, preparedState(owned.before)) || !sameState(after, owned.after))
        throw new LanModeRollbackError();
      if (sameState(before, owned.before)) {
        if (!await this.#runtime.compareAndSwapListener(owned.before, owned.after, signal))
          throw new LanModePause("listener_changed", [candidate]);
        listenerMutated = true;
      } else if (!sameState(before, owned.after)) {
        throw new LanModeRollbackError();
      }
      this.#owned = owned;
    } else if (!sameState(before, after)) {
      owned = {
        schemaVersion: 1,
        phase: "provisional",
        ownershipSubtype: "wizard-listener-cas",
        before: copyState(before),
        after: copyState(after),
        createdAt: Date.now(),
      };
      const written = await this.#runtime.ownership.write(owned, signal);
      if (written === "conflict") throw new LanModePause("listener_changed", [candidate]);
      if (!await this.#runtime.compareAndSwapListener(before, after, signal)) {
        await this.#removeOwnership(owned, signal);
        throw new LanModePause("listener_changed", [candidate]);
      }
      listenerMutated = true;
      this.#owned = owned;
    }
    if (owned !== undefined && (listenerMutated || owned.phase === "provisional")) {
      try {
        await this.#runtime.restartAndWait(owned.after, signal);
      } catch (error) {
        await this.#rollbackMutation(signal);
        throw error;
      }
    }

    let endpoint: LanPreparedEndpoint;
    try {
      const inspected = await this.#inspectCandidate(candidate, signal, undefined, owned);
      endpoint = inspected.endpoint;
      if (!endpoint.ready) {
        const reason = !inspected.probe.health
          ? "health"
          : !inspected.probe.webSocket
            ? "websocket"
            : !inspected.probe.attachReady
              ? "attach"
              : "posture";
        throw new LanModeReadinessError(reason);
      }
    } catch (error) {
      await this.#rollbackMutation(signal);
      throw error;
    }
    if (owned !== undefined && owned.phase === "provisional") {
      const active: LanListenerOwnership = {
        ...owned,
        phase: "active",
        endpointFingerprint: endpoint.durableFingerprint,
      };
      if (!await this.#runtime.ownership.replace(owned, active, signal)) {
        await this.#rollbackMutation(signal);
        throw new LanModeRollbackError();
      }
      owned = active;
      this.#owned = active;
    }
    return endpoint;
  }

  async inspect(signal?: AbortSignal): Promise<LanPreparedEndpoint> {
    const inventory = await this.#runtime.readAdapterInventory(signal);
    const candidate = await this.#candidate(inventory, false, signal);
    return (await this.#inspectCandidate(
      candidate,
      signal,
      inventory,
      await this.#runtime.ownership.read(signal),
    )).endpoint;
  }

  async verify(expected: PreparedEndpoint, signal?: AbortSignal): Promise<boolean> {
    try {
      const current = await this.inspect(signal);
      return current.ready && samePreparedEndpoint(expected, current);
    } catch {
      return false;
    }
  }

  async rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void> {
    const owned = this.#owned ?? await this.#runtime.ownership.read(signal);
    if (owned?.endpointFingerprint !== endpoint.durableFingerprint) return;
    await this.reconcileOwned(signal);
  }

  /** SQLite-authoritative crash/uninstall recovery. Call before removing the database. */
  async reconcileOwned(signal?: AbortSignal): Promise<void> {
    await this.#rollbackMutation(signal);
  }

  async #inspectCandidate(
    expectedCandidate: PhysicalLanCandidate,
    signal?: AbortSignal,
    knownInventory?: WindowsLanInventory,
    owned?: LanListenerOwnership,
  ): Promise<{ endpoint: LanPreparedEndpoint; probe: LanProbeResult }> {
    const inventory = knownInventory ?? await this.#runtime.readAdapterInventory(signal);
    const candidate = await this.#candidate(inventory, false, signal);
    if (
      candidate.adapterId !== expectedCandidate.adapterId
      || candidate.address !== expectedCandidate.address
    ) throw new LanModeReadinessError("posture");
    const listener = await this.#runtime.readListenerState(signal);
    const origin = `http://${candidate.address}:${listener.port}`;
    const probe = await this.#runtime.probeEndpoint(origin, signal);
    const [finalInventory, finalListener] = await Promise.all([
      this.#runtime.readAdapterInventory(signal),
      this.#runtime.readListenerState(signal),
    ]);
    const finalCandidate = await this.#candidate(finalInventory, false, signal);
    if (
      finalCandidate.adapterId !== expectedCandidate.adapterId
      || finalCandidate.address !== expectedCandidate.address
    ) throw new LanModeReadinessError("posture");
    return {
      endpoint: endpointOf(
        finalCandidate,
        finalInventory,
        finalListener,
        probe,
        sameState(listener, finalListener),
        owned !== undefined && sameState(finalListener, owned.after)
          ? "wizard-listener-cas"
          : "preexisting-listener",
      ),
      probe,
    };
  }

  async #candidate(
    inventory: WindowsLanInventory,
    allowChoice: boolean,
    signal?: AbortSignal,
  ): Promise<PhysicalLanCandidate> {
    const selection = selectPhysicalLanCandidate(inventory);
    if (this.#selectedAdapterId === undefined && this.#runtime.readSelectedAdapter !== undefined)
      this.#selectedAdapterId = await this.#runtime.readSelectedAdapter(signal);
    if (selection.outcome === "selected") {
      if (this.#selectedAdapterId !== undefined && selection.candidate.adapterId !== this.#selectedAdapterId) {
        if (allowChoice && this.#runtime.chooseAdapter !== undefined) {
          const replacement = await this.#runtime.chooseAdapter([selection.candidate], signal);
          if (replacement === selection.candidate.adapterId) {
            await this.#runtime.writeSelectedAdapter?.(replacement, signal);
            this.#selectedAdapterId = replacement;
            return selection.candidate;
          }
        }
        if (allowChoice) throw new LanModePause("adapter_changed", [selection.candidate]);
        throw new LanModeReadinessError("posture");
      }
      return selection.candidate;
    }
    if (selection.reason !== "multiple_up_physical_private_ipv4")
      throw new LanModePause(selection.reason, selection.candidates);
    let candidate = selection.candidates.find((item) => item.adapterId === this.#selectedAdapterId);
    if (candidate === undefined && allowChoice && this.#runtime.chooseAdapter !== undefined) {
      const adapterId = await this.#runtime.chooseAdapter(selection.candidates, signal);
      candidate = selection.candidates.find((item) => item.adapterId === adapterId);
      if (candidate !== undefined) {
        await this.#runtime.writeSelectedAdapter?.(candidate.adapterId, signal);
        this.#selectedAdapterId = candidate.adapterId;
      }
    }
    if (candidate === undefined) throw new LanModePause(selection.reason, selection.candidates);
    this.#selectedAdapterId = candidate.adapterId;
    return candidate;
  }

  async #rollbackMutation(signal?: AbortSignal): Promise<void> {
    const owned = this.#owned ?? await this.#runtime.ownership.read(signal);
    if (owned === undefined) return;
    const current = await this.#runtime.readListenerState(signal);
    if (sameState(current, owned.before)) {
      await this.#removeOwnership(owned, signal);
      this.#owned = undefined;
      return;
    }
    if (!sameState(current, owned.after)) throw new LanModeRollbackError();
    if (!await this.#runtime.compareAndSwapListener(owned.after, owned.before, signal))
      throw new LanModeRollbackError();
    try {
      await this.#runtime.restartAndWait(owned.before, signal);
    } catch {
      throw new LanModeRollbackError();
    }
    await this.#removeOwnership(owned, signal);
    this.#owned = undefined;
  }

  async #removeOwnership(owned: LanListenerOwnership, signal?: AbortSignal): Promise<void> {
    if (await this.#runtime.ownership.remove(owned, signal)) return;
    if (await this.#runtime.ownership.read(signal) !== undefined) throw new LanModeRollbackError();
  }
}

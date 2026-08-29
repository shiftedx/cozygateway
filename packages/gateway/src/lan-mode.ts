import { createHash } from "node:crypto";

import {
  selectPhysicalLanCandidate,
  type PhysicalLanCandidate,
  type PhysicalLanSelection,
  type WindowsLanInventory,
} from "./lan.ts";
import { samePreparedEndpoint, type NetworkModeAdapter, type PreparedEndpoint } from "./network-onboarding.ts";

export interface LanHermesTarget {
  profile: string;
  url: string;
}

/** The listener and every installer-managed Hermes target form one compare-and-swap unit. The
 * concrete Windows runtime is responsible for persisting it atomically; Task 7 supplies only this
 * injectable boundary and tests it with an inert fake. */
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

interface OwnedListenerMutation {
  before: LanListenerState;
  after: LanListenerState;
  endpointFingerprint?: string;
}

function copyState(state: LanListenerState): LanListenerState {
  return {
    bindHost: state.bindHost,
    port: state.port,
    hermesTargets: state.hermesTargets.map((target) => ({ ...target })),
    ...(state.persistenceRevision === undefined ? {} : { persistenceRevision: state.persistenceRevision }),
  };
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

function endpointFingerprint(candidate: PhysicalLanCandidate, listener: LanListenerState): string {
  return createHash("sha256")
    .update(JSON.stringify({
      mode: "lan",
      adapterId: candidate.adapterId,
      address: candidate.address,
      listener: JSON.parse(stateFingerprint(listener)) as unknown,
    }))
    .digest("hex");
}

function endpointOf(
  candidate: PhysicalLanCandidate,
  inventory: WindowsLanInventory,
  listener: LanListenerState,
  probe: LanProbeResult,
  listenerStable = true,
): LanPreparedEndpoint {
  return {
    mode: "lan",
    canonicalOrigin: `http://${candidate.address}:${listener.port}`,
    bindHost: listener.bindHost,
    port: listener.port,
    durableFingerprint: endpointFingerprint(candidate, listener),
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
  #owned?: OwnedListenerMutation;
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
    if (!sameState(before, after)) {
      if (!await this.#runtime.compareAndSwapListener(before, after, signal)) {
        throw new LanModePause("listener_changed", [candidate]);
      }
      this.#owned = { before: copyState(before), after: copyState(after) };
      try {
        await this.#runtime.restartAndWait(after, signal);
      } catch (error) {
        await this.#rollbackMutation(signal);
        throw error;
      }
    }

    let endpoint: LanPreparedEndpoint;
    try {
      const inspected = await this.#inspectCandidate(candidate, signal);
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
    if (this.#owned !== undefined) this.#owned.endpointFingerprint = endpoint.durableFingerprint;
    return endpoint;
  }

  async inspect(signal?: AbortSignal): Promise<LanPreparedEndpoint> {
    const inventory = await this.#runtime.readAdapterInventory(signal);
    const candidate = await this.#candidate(inventory, false, signal);
    return (await this.#inspectCandidate(candidate, signal, inventory)).endpoint;
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
    if (this.#owned?.endpointFingerprint !== endpoint.durableFingerprint) return;
    await this.#rollbackMutation(signal);
  }

  async #inspectCandidate(
    expectedCandidate: PhysicalLanCandidate,
    signal?: AbortSignal,
    knownInventory?: WindowsLanInventory,
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
    const owned = this.#owned;
    this.#owned = undefined;
    if (owned === undefined) return;
    const restored = await this.#runtime.compareAndSwapListener(owned.after, owned.before, signal);
    if (restored) await this.#runtime.restartAndWait(owned.before, signal);
  }
}

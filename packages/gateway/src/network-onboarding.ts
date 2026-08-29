import {
  publishOnboardingPairing,
  type OnboardingPairingDependencies,
  type OnboardingPairingRequest,
} from "./cli.ts";
import type { NetworkOnboardingState, NetworkOnboardingStateProjection } from "./onboarding-state.ts";
import type { PhoneVerificationChallenge } from "./phone-verification.ts";
import type { PairingOutputInput, PreparedPairingOutput } from "./pairing-output.ts";
import type {
  FinalizeInput,
  FinalizeResult,
  OnboardingMode,
  PublishedCode,
  SetupCodeOutputState,
  TransitionResult,
} from "./storage.ts";

/** Network adapters own all host and network mutation. The orchestrator itself only sequences
 * these methods, so tests and non-Windows callers can use inert adapters. */
export interface NetworkModeAdapter {
  readonly mode: OnboardingMode;
  prepare(signal?: AbortSignal): Promise<PreparedEndpoint>;
  inspect(signal?: AbortSignal): Promise<PreparedEndpoint>;
  rollbackOwned(endpoint: PreparedEndpoint, signal?: AbortSignal): Promise<void>;
}

/** A security-relevant, already-validated endpoint snapshot. Adapters must change the durable
 * fingerprint whenever any mode-specific coordinate changes; the explicit coordinates below are
 * also compared defensively so a faulty adapter cannot hide a changed origin, binding, identity,
 * LAN lease, or Serve mapping behind a stale fingerprint. */
export interface PreparedEndpoint {
  mode: OnboardingMode;
  canonicalOrigin: string;
  bindHost: string;
  port: number;
  durableFingerprint: string;
  ready: boolean;
  accountTailnetHash?: string;
  physicalAdapterId?: string;
  dhcpAddress?: string;
  serveMappingFingerprint?: string;
}

export function samePreparedEndpoint(left: PreparedEndpoint, right: PreparedEndpoint): boolean {
  return left.mode === right.mode
    && left.canonicalOrigin === right.canonicalOrigin
    && left.bindHost === right.bindHost
    && left.port === right.port
    && left.durableFingerprint === right.durableFingerprint
    && left.ready === right.ready
    && left.accountTailnetHash === right.accountTailnetHash
    && left.physicalAdapterId === right.physicalAdapterId
    && left.dhcpAddress === right.dhcpAddress
    && left.serveMappingFingerprint === right.serveMappingFingerprint;
}

export type AuthoritativeOnboardingStatus =
  | { state: "none" }
  | {
      state: "active" | "abandoned";
      mode: OnboardingMode;
      canonicalOrigin: string;
      durableFingerprint: string;
    }
  | {
      state: "complete";
      mode: OnboardingMode;
      canonicalOrigin: string;
      durableFingerprint: string;
      completedAt: number;
    };

/** This boundary is implemented by SQLite. Its status read and all publication transitions must
 * share the same database; a sidecar implementation is intentionally not accepted here. */
export interface OnboardingAuthority {
  status(): AuthoritativeOnboardingStatus | Promise<AuthoritativeOnboardingStatus>;
  finalizeVerifiedSetupCode(input: FinalizeInput): FinalizeResult;
  activatePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState>;
  revokePendingSetupCode(input: PublishedCode): TransitionResult<SetupCodeOutputState>;
}

export interface OnboardingPhoneVerification {
  begin(mode: OnboardingMode): PhoneVerificationChallenge;
  /** Resolves only from Task 5's authoritative confirmation POST. Undefined means the automatic
   * proof failed, expired, or was cancelled; it never authorizes publication by itself. */
  waitForConfirmation(
    challenge: PhoneVerificationChallenge,
    signal?: AbortSignal,
  ): Promise<string | undefined>;
}

export interface OnboardingIo {
  chooseNetworkMode(signal?: AbortSignal): Promise<OnboardingMode | "later" | "cancel">;
  /** The only QR payload parameter is the short-lived verification URL. */
  showPhoneConnectionCheck(verificationUrl: string, signal?: AbortSignal): void | Promise<void>;
  showAuthoritativePhrase(phrase: string, signal?: AbortSignal): void | Promise<void>;
  confirmPhone(phrase: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface OnboardingRuntimeContext {
  verificationEpoch: string;
  bootGeneration: string;
}

export interface NetworkOnboardingDependencies {
  adapters: readonly NetworkModeAdapter[];
  state: NetworkOnboardingStateProjection;
  authority: OnboardingAuthority;
  phoneVerification: OnboardingPhoneVerification;
  runtimeContext(): OnboardingRuntimeContext;
  createSetupCode(): string;
  renderPairingOutput(input: PairingOutputInput): PreparedPairingOutput;
  writePairingOutput(output: string): void | Promise<void>;
  publishPairing?: typeof publishOnboardingPairing;
  now?: () => number;
  color?: boolean;
}

export type OnboardingOutcome =
  | { outcome: "complete"; mode: OnboardingMode; endpoint: PreparedEndpoint; projectionPersisted: boolean }
  | { outcome: "already_complete"; mode: OnboardingMode; endpoint: PreparedEndpoint }
  | { outcome: "deferred" }
  | { outcome: "cancelled" }
  | { outcome: "not_confirmed"; reason: "phone" | "desktop" }
  | { outcome: "invalidated"; reason: "posture" | "verification_epoch" | "phrase" }
  | { outcome: "lost_race" }
  | { outcome: "failed"; reason: "readiness" | "publication" | "rollback_failed" };

export interface NetworkOnboardingStatus {
  stage: "not_started" | NetworkOnboardingState["stage"] | "changed";
  authority: AuthoritativeOnboardingStatus["state"];
  mode?: OnboardingMode;
  healthy: boolean;
  endpoint?: PreparedEndpoint;
}

function selectedMode(state: NetworkOnboardingState | undefined): OnboardingMode | undefined {
  return state !== undefined && state.stage !== "pending_choice" ? state.mode : undefined;
}

function isExactYes(answer: string | undefined): boolean {
  return answer === "y" || answer === "yes";
}

function matchesAuthoritativeStatus(
  endpoint: PreparedEndpoint,
  authority: Exclude<AuthoritativeOnboardingStatus, { state: "none" }>,
): boolean {
  return endpoint.ready
    && endpoint.mode === authority.mode
    && endpoint.canonicalOrigin === authority.canonicalOrigin
    && endpoint.durableFingerprint === authority.durableFingerprint;
}

class ProofInvalidated extends Error {
  readonly reason: "posture" | "verification_epoch";

  constructor(reason: "posture" | "verification_epoch") {
    super(`phone proof invalidated by ${reason}`);
    this.reason = reason;
  }
}

export class NetworkOnboarding {
  readonly #dependencies: NetworkOnboardingDependencies;
  readonly #adapters: ReadonlyMap<OnboardingMode, NetworkModeAdapter>;
  readonly #publish: typeof publishOnboardingPairing;
  readonly #now: () => number;

  constructor(dependencies: NetworkOnboardingDependencies) {
    this.#dependencies = dependencies;
    this.#publish = dependencies.publishPairing ?? publishOnboardingPairing;
    this.#now = dependencies.now ?? Date.now;
    const adapters = new Map<OnboardingMode, NetworkModeAdapter>();
    for (const adapter of dependencies.adapters) {
      if (adapters.has(adapter.mode)) throw new Error(`duplicate network adapter: ${adapter.mode}`);
      adapters.set(adapter.mode, adapter);
    }
    this.#adapters = adapters;
  }

  async run(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome> {
    const current = await this.status(signal);
    if (
      current.authority === "complete"
      && current.stage === "complete"
      && current.mode !== undefined
      && current.endpoint !== undefined
    ) return { outcome: "already_complete", mode: current.mode, endpoint: current.endpoint };
    await this.#dependencies.state.write({ version: 1, stage: "pending_choice", updatedAt: this.#now() });
    const choice = await io.chooseNetworkMode(signal);
    if (choice === "later") return { outcome: "deferred" };
    if (choice === "cancel") return { outcome: "cancelled" };
    return this.#continue(choice, io, signal, true);
  }

  async resume(io: OnboardingIo, signal?: AbortSignal): Promise<OnboardingOutcome> {
    const current = await this.status(signal);
    if (current.authority === "complete" && current.stage === "complete" && current.mode !== undefined && current.endpoint !== undefined) {
      return { outcome: "already_complete", mode: current.mode, endpoint: current.endpoint };
    }
    const authority = await this.#dependencies.authority.status();
    const projection = authority.state === "none" ? await this.#safeProjection() : undefined;
    const mode = authority.state === "none" ? selectedMode(projection) : authority.mode;
    if (mode === undefined) return this.run(io, signal);
    const adapter = this.#adapters.get(mode);
    if (adapter === undefined) return { outcome: "failed", reason: "readiness" };
    const inspected = current.endpoint;
    const authoritativeMatch = authority.state === "none"
      || (inspected !== undefined && matchesAuthoritativeStatus(inspected, authority));
    return this.#continue(
      mode,
      io,
      signal,
      inspected === undefined || !inspected.ready || !authoritativeMatch,
      inspected,
    );
  }

  async status(signal?: AbortSignal): Promise<NetworkOnboardingStatus> {
    const authority = await this.#dependencies.authority.status();
    let projection: NetworkOnboardingState | undefined;
    let mode: OnboardingMode | undefined;
    if (authority.state === "none") {
      projection = await this.#safeProjection();
      mode = selectedMode(projection);
    } else {
      mode = authority.mode;
    }
    if (mode === undefined) {
      return {
        stage: projection?.stage ?? "not_started",
        authority: authority.state,
        healthy: false,
      };
    }
    const adapter = this.#adapters.get(mode);
    if (adapter === undefined)
      return { stage: "changed", authority: authority.state, mode, healthy: false };
    let endpoint: PreparedEndpoint;
    try {
      endpoint = await adapter.inspect(signal);
    } catch {
      return { stage: "changed", authority: authority.state, mode, healthy: false };
    }
    if (authority.state !== "none" && !matchesAuthoritativeStatus(endpoint, authority)) {
      return {
        stage: "changed",
        authority: authority.state,
        mode,
        healthy: false,
        endpoint,
      };
    }
    if (authority.state === "complete") {
      await this.#writeProjectionBestEffort({
        version: 1,
        stage: "complete",
        mode,
        deploymentFingerprint: authority.durableFingerprint,
        verifiedAt: authority.completedAt,
        updatedAt: this.#now(),
      });
      return {
        stage: "complete",
        authority: authority.state,
        mode,
        healthy: true,
        endpoint,
      };
    }
    projection = await this.#safeProjection();
    const projectionMatches = projection !== undefined
      && projection.stage !== "pending_choice"
      && projection.mode === mode
      && (!("deploymentFingerprint" in projection)
        || projection.deploymentFingerprint === endpoint.durableFingerprint);
    const stage = endpoint.ready && projectionMatches && projection !== undefined
      ? projection.stage
      : "changed";
    return {
      stage,
      authority: authority.state,
      mode,
      healthy: endpoint.ready && projectionMatches,
      endpoint,
    };
  }

  async #continue(
    mode: OnboardingMode,
    io: OnboardingIo,
    signal: AbortSignal | undefined,
    prepare: boolean,
    inspected?: PreparedEndpoint,
  ): Promise<OnboardingOutcome> {
    const adapter = this.#adapters.get(mode);
    if (adapter === undefined) return { outcome: "failed", reason: "readiness" };
    await this.#dependencies.state.write({
      version: 1,
      stage: "network_selected",
      mode,
      updatedAt: this.#now(),
    });
    let endpoint: PreparedEndpoint;
    try {
      endpoint = prepare ? await adapter.prepare(signal) : inspected!;
    } catch {
      return { outcome: "failed", reason: "readiness" };
    }
    if (endpoint.mode !== mode || !endpoint.ready) return this.#rollbackFailure(adapter, endpoint, signal, "readiness");
    await this.#dependencies.state.write({
      version: 1,
      stage: "endpoint_ready",
      mode,
      deploymentFingerprint: endpoint.durableFingerprint,
      updatedAt: this.#now(),
    });

    const initialRuntime = this.#dependencies.runtimeContext();
    let challenge: PhoneVerificationChallenge;
    try {
      challenge = this.#dependencies.phoneVerification.begin(mode);
    } catch {
      return this.#rollbackFailure(adapter, endpoint, signal, "readiness");
    }
    try {
      await io.showPhoneConnectionCheck(challenge.verificationUrl, signal);
      await this.#dependencies.state.write({
        version: 1,
        stage: "verifying_phone",
        mode,
        deploymentFingerprint: endpoint.durableFingerprint,
        updatedAt: this.#now(),
      });
    } catch {
      return this.#rollbackFailure(adapter, endpoint, signal, "phone");
    }

    let provenPhrase: string | undefined;
    try {
      provenPhrase = await this.#dependencies.phoneVerification.waitForConfirmation(challenge, signal);
    } catch {
      return this.#rollbackFailure(adapter, endpoint, signal, "phone");
    }
    if (provenPhrase === undefined)
      return this.#rollbackFailure(adapter, endpoint, signal, "phone");
    if (provenPhrase !== challenge.phrase)
      return this.#rollbackFailure(adapter, endpoint, signal, "phrase");
    let answer: string | undefined;
    try {
      await io.showAuthoritativePhrase(provenPhrase, signal);
      answer = await io.confirmPhone(provenPhrase, signal);
    } catch {
      return this.#rollbackFailure(adapter, endpoint, signal, "desktop");
    }
    if (!isExactYes(answer)) return this.#rollbackFailure(adapter, endpoint, signal, "desktop");

    const request: OnboardingPairingRequest = {
      phoneConfirmed: true,
      desktopAnswer: answer,
      gatewayUrl: endpoint.canonicalOrigin,
      color: this.#dependencies.color ?? false,
      finalizeContext: {
        sessionId: challenge.sessionId,
        challengeId: challenge.challengeId,
        canonicalOrigin: endpoint.canonicalOrigin,
        durableFingerprint: endpoint.durableFingerprint,
        verificationEpoch: initialRuntime.verificationEpoch,
        bootGeneration: initialRuntime.bootGeneration,
        now: this.#now(),
      },
    };
    let finalizedAt: number | undefined;
    const publicationDependencies: OnboardingPairingDependencies = {
      createSetupCode: this.#dependencies.createSetupCode,
      render: this.#dependencies.renderPairingOutput,
      beforeFinalize: async () => {
        // Rendering has already succeeded. After this last awaited operation Task 3 invokes the
        // synchronous SQLite finalizer directly, leaving no yield point for a stale proof to mint.
        let finalEndpoint: PreparedEndpoint;
        try {
          finalEndpoint = await adapter.inspect(signal);
        } catch {
          throw new ProofInvalidated("posture");
        }
        if (!samePreparedEndpoint(endpoint, finalEndpoint) || !finalEndpoint.ready)
          throw new ProofInvalidated("posture");
        const finalRuntime = this.#dependencies.runtimeContext();
        if (
          finalRuntime.verificationEpoch !== initialRuntime.verificationEpoch
          || finalRuntime.bootGeneration !== initialRuntime.bootGeneration
        ) throw new ProofInvalidated("verification_epoch");
      },
      finalizationNow: () => {
        finalizedAt = this.#now();
        return finalizedAt;
      },
      finalize: (input) => this.#dependencies.authority.finalizeVerifiedSetupCode(input),
      write: this.#dependencies.writePairingOutput,
      activate: (input) => this.#dependencies.authority.activatePendingSetupCode(input),
      revoke: (input) => this.#dependencies.authority.revokePendingSetupCode(input),
    };
    let published: "published" | "not_published";
    try {
      published = await this.#publish(request, publicationDependencies);
    } catch (error) {
      if (error instanceof ProofInvalidated)
        return this.#rollbackFailure(adapter, endpoint, signal, error.reason);
      return this.#rollbackFailure(adapter, endpoint, signal, "publication");
    }
    if (published !== "published") return { outcome: "lost_race" };
    const complete: NetworkOnboardingState = {
      version: 1,
      stage: "complete",
      mode,
      deploymentFingerprint: endpoint.durableFingerprint,
      verifiedAt: finalizedAt ?? request.finalizeContext.now,
      updatedAt: finalizedAt ?? request.finalizeContext.now,
    };
    const projectionPersisted = await this.#writeProjectionBestEffort(complete);
    return { outcome: "complete", mode, endpoint, projectionPersisted };
  }

  async #rollbackFailure(
    adapter: NetworkModeAdapter,
    endpoint: PreparedEndpoint,
    signal: AbortSignal | undefined,
    reason: "readiness" | "phone" | "desktop" | "posture" | "verification_epoch" | "phrase" | "publication",
  ): Promise<OnboardingOutcome> {
    try {
      await adapter.rollbackOwned(endpoint, signal);
    } catch {
      return { outcome: "failed", reason: "rollback_failed" };
    }
    if (reason === "phone" || reason === "desktop") return { outcome: "not_confirmed", reason };
    if (reason === "posture" || reason === "verification_epoch" || reason === "phrase")
      return { outcome: "invalidated", reason };
    return { outcome: "failed", reason };
  }

  async #safeProjection(): Promise<NetworkOnboardingState | undefined> {
    try {
      return await this.#dependencies.state.read();
    } catch {
      // A corrupt or inaccessible projection cannot override SQLite. Later successful progress
      // rewrites it atomically.
      return undefined;
    }
  }

  async #writeProjectionBestEffort(state: NetworkOnboardingState): Promise<boolean> {
    try {
      await this.#dependencies.state.write(state);
      return true;
    } catch {
      return false;
    }
  }
}

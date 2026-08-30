import type {
  GatewayHarness,
  HarnessInstallMethod,
  HarnessUpdateCheck,
  HarnessUpdateReceipt,
  HarnessUpdateStart,
  HarnessUpdateStatus,
} from "cozygateway-contract";

import { HermesTimeout, type HermesClient } from "./client.ts";
import { HarnessSettingsInvalid } from "../harness-settings.ts";

const POLL_AFTER_MS = 1_000;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const ACTION_ID_RE = /^[0-9a-f]{32}$/;

export class HarnessUpdateStale extends Error {
  readonly currentVersion: string;

  constructor(currentVersion: string) {
    super("the confirmed Hermes version is stale; check for updates again");
    this.name = "HarnessUpdateStale";
    this.currentVersion = currentVersion;
  }
}

export class HarnessUpdateBlocked extends Error {
  readonly guidance: string;

  constructor(guidance: string) {
    super("this Hermes installation cannot apply updates in place");
    this.name = "HarnessUpdateBlocked";
    this.guidance = guidance;
  }
}

export class HarnessUpdateUnavailable extends Error {
  constructor() {
    super("Hermes update state is unavailable");
    this.name = "HarnessUpdateUnavailable";
  }
}

interface ActiveUpdate {
  expectedVersion: string;
  actionId?: string;
  ambiguous: boolean;
  startedAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function version(value: unknown): string | undefined {
  return typeof value === "string" && VERSION_RE.test(value) ? value : undefined;
}

function actionId(value: unknown): string | undefined {
  return typeof value === "string" && ACTION_ID_RE.test(value) ? value : undefined;
}

function millis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function installMethod(value: unknown): HarnessInstallMethod {
  if (typeof value !== "string") return "unknown";
  switch (value.trim().toLowerCase()) {
    case "git": return "git";
    case "docker":
    case "image-marker":
    case "image-marker-invalid": return "docker";
    case "nix":
    case "nixos": return "nix";
    case "apt": return "apt";
    case "managed-runtime": return "managed";
    default: return "unknown";
  }
}

export function updateGuidance(method: HarnessInstallMethod): string {
  switch (method) {
    case "docker":
      return "Redeploy Hermes with a newer container image through your container manager.";
    case "nix":
      return "Update Hermes through the Nix configuration or package source that manages this installation.";
    case "apt":
      return "Update Hermes through the APT package manager that owns this installation.";
    case "managed":
      return "Update Hermes through the platform that manages this runtime.";
    default:
      return "Update Hermes through the system that installed it, then check again.";
  }
}

function isAmbiguousTimeout(error: unknown): boolean {
  if (error instanceof HermesTimeout) return true;
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "TimeoutError" || name === "AbortError";
}

function receipt(value: unknown): HarnessUpdateReceipt | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const outcome = raw["outcome"];
  if (outcome !== "success" && outcome !== "partial" && outcome !== "failed" && outcome !== "refused")
    return undefined;
  const startedAt = millis(raw["started_at"]);
  const finishedAt = millis(raw["finished_at"]);
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return undefined;
  const postVersion = version(raw["post_version"]);
  return {
    outcome,
    startedAt,
    finishedAt,
    ...(postVersion === undefined ? {} : { postVersion }),
  };
}

export class HermesHarnessUpdateAdapter {
  readonly #client: HermesClient;
  readonly #harness: GatewayHarness;
  readonly #now: () => number;
  #startTail: Promise<void> = Promise.resolve();
  #active: ActiveUpdate | undefined;

  constructor(client: HermesClient, harness: GatewayHarness, now: () => number = Date.now) {
    this.#client = client;
    this.#harness = harness;
    this.#now = now;
  }

  descriptor(): GatewayHarness { return this.#harness; }

  async check(): Promise<HarnessUpdateCheck> {
    let result: unknown;
    try {
      result = await this.#client.dashboardJson("/api/hermes/update/check?force=true");
    } catch {
      throw new HarnessUpdateUnavailable();
    }
    const raw = record(result);
    const currentVersion = version(raw?.["current_version"]);
    if (!raw || currentVersion === undefined) throw new HarnessUpdateUnavailable();
    const method = installMethod(raw["install_method"]);
    const rawBehind = raw["behind"];
    const behind = typeof rawBehind === "number" && Number.isSafeInteger(rawBehind) && rawBehind >= 0
      ? rawBehind
      : null;
    const canApply = method === "git" && raw["can_apply"] === true;
    return {
      harnessId: this.#harness.id,
      currentVersion,
      installMethod: method,
      behind,
      updateAvailable: raw["update_available"] === true,
      canApply,
      guidance: canApply ? null : updateGuidance(method),
      checkedAt: this.#now(),
    };
  }

  start(expectedCurrentVersion: string): Promise<HarnessUpdateStart> {
    if (!VERSION_RE.test(expectedCurrentVersion))
      return Promise.reject(new HarnessSettingsInvalid("expectedCurrentVersion is invalid"));
    return this.#serialize(async () => {
      const active = this.#active;
      if (active?.expectedVersion === expectedCurrentVersion) {
        return {
          harnessId: this.#harness.id,
          state: active.ambiguous ? "ambiguous" : "running",
          ...(active.actionId === undefined ? {} : { actionId: active.actionId }),
          coalesced: true,
          pollAfterMs: POLL_AFTER_MS,
        };
      }

      const check = await this.check();
      if (check.currentVersion !== expectedCurrentVersion)
        throw new HarnessUpdateStale(check.currentVersion);
      if (!check.canApply) throw new HarnessUpdateBlocked(check.guidance!);
      if (!check.updateAvailable)
        throw new HarnessUpdateBlocked("Hermes is already up to date. Check again before confirming another update.");
      if (this.#active !== undefined)
        throw new HarnessUpdateBlocked("A Hermes update is already in progress. Poll its status before trying again.");

      const startedAt = this.#now();
      try {
        const response = record(await this.#client.dashboardJson("/api/hermes/update", { method: "POST" }));
        if (!response || response["ok"] !== true) {
          throw new HarnessUpdateBlocked("Hermes cannot apply this update in place. Check again for current guidance.");
        }
        const id = actionId(response["action_id"]);
        const coalesced = response["already_running"] === true;
        this.#active = {
          expectedVersion: expectedCurrentVersion,
          ...(id === undefined ? {} : { actionId: id }),
          ambiguous: false,
          startedAt,
        };
        return {
          harnessId: this.#harness.id,
          state: "running",
          ...(id === undefined ? {} : { actionId: id }),
          coalesced,
          pollAfterMs: POLL_AFTER_MS,
        };
      } catch (error) {
        if (error instanceof HarnessUpdateBlocked) throw error;
        if (!isAmbiguousTimeout(error)) throw new HarnessUpdateUnavailable();
        this.#active = {
          expectedVersion: expectedCurrentVersion,
          ambiguous: true,
          startedAt,
        };
        return {
          harnessId: this.#harness.id,
          state: "ambiguous",
          coalesced: false,
          pollAfterMs: POLL_AFTER_MS,
        };
      }
    });
  }

  async status(): Promise<HarnessUpdateStatus> {
    let result: unknown;
    try {
      result = await this.#client.dashboardJson("/api/actions/hermes-update/status?lines=1");
    } catch {
      throw new HarnessUpdateUnavailable();
    }
    const raw = record(result);
    if (!raw || typeof raw["running"] !== "boolean") throw new HarnessUpdateUnavailable();
    const active = this.#active;
    if (raw["running"]) {
      return {
        harnessId: this.#harness.id,
        state: "running",
        ...(active?.actionId === undefined ? {} : { actionId: active.actionId }),
        pollAfterMs: POLL_AFTER_MS,
      };
    }

    const durableActionId = actionId(raw["action_id"]);
    let durableReceipt = receipt(raw["receipt"]);
    if (active?.actionId !== undefined && durableActionId !== active.actionId)
      durableReceipt = undefined;
    if (active?.actionId === undefined && active !== undefined && durableReceipt !== undefined &&
        durableReceipt.startedAt < active.startedAt - 60_000)
      durableReceipt = undefined;

    if (durableReceipt !== undefined) {
      this.#active = undefined;
      const state = durableReceipt.outcome === "success"
        ? "success"
        : durableReceipt.outcome === "partial"
          ? "partial"
          : "failed";
      return {
        harnessId: this.#harness.id,
        state,
        ...(durableActionId === undefined ? {} : { actionId: durableActionId }),
        receipt: durableReceipt,
        ...(state === "partial"
          ? { guidance: "Hermes updated only partially. Review Hermes locally before trying another update." }
          : state === "failed"
            ? { guidance: "Hermes did not complete the update. Review Hermes locally before trying again." }
            : {}),
      };
    }

    if (active !== undefined) {
      return {
        harnessId: this.#harness.id,
        state: "unknown",
        ...(active.actionId === undefined ? {} : { actionId: active.actionId }),
        pollAfterMs: POLL_AFTER_MS,
        guidance: "The update outcome is not yet durable. Keep polling status; do not start it again.",
      };
    }

    if (typeof raw["exit_code"] === "number") {
      return {
        harnessId: this.#harness.id,
        state: "failed",
        guidance: "Hermes finished without a durable success receipt. Review Hermes locally before trying again.",
      };
    }
    return { harnessId: this.#harness.id, state: "idle" };
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#startTail.then(operation, operation);
    this.#startTail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class GatewayHarnessUpdates {
  readonly #adapters: ReadonlyMap<string, HermesHarnessUpdateAdapter>;

  constructor(adapters: readonly HermesHarnessUpdateAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.descriptor().id, adapter]));
    if (this.#adapters.size !== adapters.length) throw new Error("duplicate gateway harness update id");
  }

  adapter(harnessId: string): HermesHarnessUpdateAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new HarnessSettingsInvalid(`unknown agent harness: ${harnessId}`);
    return adapter;
  }
}

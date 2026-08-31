import type {
  GatewayHarness,
  HarnessInstallMethod,
  HarnessUpdateCheck,
  HarnessUpdateReceipt,
  HarnessUpdateStart,
  HarnessUpdateStatus,
} from "cozygateway-contract";

import type { HermesClient } from "./client.ts";
import { HarnessSettingsInvalid } from "../harness-settings.ts";

const POLL_AFTER_MS = 1_000;
export const UPDATE_JSON_MAX_BYTES = 64 * 1024;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/;
const ACTION_ID_RE = /^[0-9a-f]{32}$/;
const NO_RECEIPT_DETAIL = "No update receipt found (no `hermes update` run recorded).";
const REFUSAL_CODES = new Set([
  "dashboard_update_managed_externally",
  "docker_update_unsupported",
  "apt_update_required",
  "nix_update_unsupported",
  "update_not_in_place",
]);

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

interface ReceiptEvidence {
  public: HarnessUpdateReceipt;
  fingerprint: string;
}

interface StatusSnapshot {
  running: boolean;
  exitCode: number | null;
  actionId?: string;
  receipt?: ReceiptEvidence;
}

interface ActiveUpdate {
  expectedVersion: string;
  actionId?: string;
  baselineReceiptFingerprint?: string;
}

type UpdateRequestInit = {
  method?: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";
  body?: unknown;
};

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

async function updateJson(
  client: HermesClient,
  path: string,
  init: UpdateRequestInit = {},
): Promise<{ status: number; body: unknown }> {
  const response = await client.dashboardResponse(path, {
    ...init,
    headers: { accept: "application/json" },
  });
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > UPDATE_JSON_MAX_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("oversized Hermes update response");
  }
  if (response.body === null) throw new Error("empty Hermes update response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > UPDATE_JSON_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("oversized Hermes update response");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { status: response.status, body: JSON.parse(text) as unknown };
}

function receiptEvidence(value: unknown): ReceiptEvidence | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const outcome = raw["outcome"];
  if (outcome !== "success" && outcome !== "partial" && outcome !== "failed" && outcome !== "refused")
    return undefined;
  const startedAt = millis(raw["started_at"]);
  const finishedAt = millis(raw["finished_at"]);
  if (startedAt === undefined || finishedAt === undefined || finishedAt < startedAt) return undefined;
  const postVersion = version(raw["post_version"]);
  if (raw["post_version"] !== null && raw["post_version"] !== undefined && postVersion === undefined)
    return undefined;
  const preSha = raw["pre_sha"];
  const postSha = raw["post_sha"];
  const fleetStates = raw["fleet_states"];
  if ((preSha !== null && preSha !== undefined && typeof preSha !== "string")
    || (postSha !== null && postSha !== undefined && typeof postSha !== "string")
    || !Array.isArray(fleetStates) || !fleetStates.every((state) => typeof state === "string"))
    return undefined;
  return {
    public: {
      outcome,
      startedAt,
      finishedAt,
      ...(postVersion === undefined ? {} : { postVersion }),
    },
    fingerprint: JSON.stringify([
      outcome,
      raw["started_at"],
      raw["finished_at"],
      preSha ?? null,
      postSha ?? null,
      raw["post_version"] ?? null,
      [...fleetStates].sort(),
    ]),
  };
}

function parseStatus(value: unknown): StatusSnapshot | undefined {
  const raw = record(value);
  if (!raw || raw["name"] !== "hermes-update" || typeof raw["running"] !== "boolean"
    || !Array.isArray(raw["lines"])) return undefined;
  const exitCode = raw["exit_code"];
  if (exitCode !== null && (!Number.isSafeInteger(exitCode) || typeof exitCode !== "number")) return undefined;
  const durableActionId = actionId(raw["action_id"]);
  if (raw["action_id"] !== undefined && durableActionId === undefined) return undefined;
  const durableReceipt = receiptEvidence(raw["receipt"]);
  if (raw["receipt"] !== undefined && durableReceipt === undefined) return undefined;
  return {
    running: raw["running"],
    exitCode,
    ...(durableActionId === undefined ? {} : { actionId: durableActionId }),
    ...(durableReceipt === undefined ? {} : { receipt: durableReceipt }),
  };
}

function isValidatedRefusal(status: number, value: unknown): boolean {
  const raw = record(value);
  return status === 200
    && raw?.["ok"] === false
    && raw["name"] === "hermes-update"
    && raw["pid"] === null
    && typeof raw["error"] === "string"
    && REFUSAL_CODES.has(raw["error"])
    && typeof raw["message"] === "string"
    && typeof raw["update_command"] === "string";
}

function projectReceipt(
  harnessId: string,
  evidence: ReceiptEvidence,
  correlatedActionId?: string,
): HarnessUpdateStatus {
  const state = evidence.public.outcome === "success"
    ? "success"
    : evidence.public.outcome === "partial"
      ? "partial"
      : "failed";
  return {
    harnessId,
    state,
    ...(correlatedActionId === undefined ? {} : { actionId: correlatedActionId }),
    receipt: evidence.public,
    ...(state === "partial"
      ? { guidance: "Hermes updated only partially. Review Hermes locally before trying another update." }
      : state === "failed"
        ? { guidance: "Hermes did not complete the update. Review Hermes locally before trying again." }
        : {}),
  };
}

export class HermesHarnessUpdateAdapter {
  readonly #client: HermesClient;
  readonly #harness: GatewayHarness;
  readonly #now: () => number;
  #startTail: Promise<void> = Promise.resolve();
  readonly #startFlights = new Map<string, Promise<HarnessUpdateStart>>();
  #active: ActiveUpdate | undefined;

  constructor(client: HermesClient, harness: GatewayHarness, now: () => number = Date.now) {
    this.#client = client;
    this.#harness = harness;
    this.#now = now;
  }

  descriptor(): GatewayHarness { return this.#harness; }

  async #readCheck(force: boolean): Promise<HarnessUpdateCheck> {
    let result: { status: number; body: unknown };
    try {
      result = await updateJson(this.#client, `/api/hermes/update/check${force ? "?force=true" : ""}`);
    } catch {
      throw new HarnessUpdateUnavailable();
    }
    const raw = record(result.body);
    const currentVersion = version(raw?.["current_version"]);
    const rawBehind = raw?.["behind"];
    if (result.status !== 200 || !raw || currentVersion === undefined
      || typeof raw["install_method"] !== "string"
      || (rawBehind !== null && (!Number.isSafeInteger(rawBehind) || typeof rawBehind !== "number" || rawBehind < -1))
      || typeof raw["update_available"] !== "boolean" || typeof raw["can_apply"] !== "boolean")
      throw new HarnessUpdateUnavailable();
    const method = installMethod(raw["install_method"]);
    const behind = typeof rawBehind === "number" && rawBehind >= 0 ? rawBehind : null;
    const canApply = method === "git" && raw["can_apply"] === true;
    return {
      harnessId: this.#harness.id,
      currentVersion,
      installMethod: method,
      behind,
      updateAvailable: raw["update_available"],
      canApply,
      guidance: canApply ? null : updateGuidance(method),
      checkedAt: this.#now(),
    };
  }

  check(): Promise<HarnessUpdateCheck> {
    return this.#readCheck(true);
  }

  async #readStatus(): Promise<StatusSnapshot> {
    let result: { status: number; body: unknown };
    try {
      result = await updateJson(this.#client, "/api/actions/hermes-update/status?lines=1");
    } catch {
      throw new HarnessUpdateUnavailable();
    }
    const parsed = result.status === 200 ? parseStatus(result.body) : undefined;
    if (parsed === undefined) throw new HarnessUpdateUnavailable();
    return parsed;
  }

  async probe(): Promise<void> {
    await this.#readCheck(false);
    await this.#readStatus();
    const result = await updateJson(this.#client, "/api/hermes/update/receipt");
    if (result.status === 404) {
      if (record(result.body)?.["detail"] !== NO_RECEIPT_DETAIL) throw new HarnessUpdateUnavailable();
      await this.#probeAction();
      return;
    }
    const summary = record(result.body)?.["summary"];
    if (result.status !== 200 || receiptEvidence(summary) === undefined)
      throw new HarnessUpdateUnavailable();

    await this.#probeAction();
  }

  async #probeAction(): Promise<void> {
    let response: Response;
    try {
      // The POST is mutative, so Starlette's route-specific 405 to OPTIONS is the pinned,
      // side-effect-free proof that the action route exists.
      response = await this.#client.dashboardResponse("/api/hermes/update", { method: "OPTIONS" });
    } catch {
      throw new HarnessUpdateUnavailable();
    }
    await response.body?.cancel().catch(() => {});
    const allowsPost = response.headers.get("allow")
      ?.split(",")
      .some((method) => method.trim().toUpperCase() === "POST") === true;
    if (response.status !== 405 || !allowsPost) throw new HarnessUpdateUnavailable();
  }

  start(expectedCurrentVersion: string): Promise<HarnessUpdateStart> {
    if (!VERSION_RE.test(expectedCurrentVersion))
      return Promise.reject(new HarnessSettingsInvalid("expectedCurrentVersion is invalid"));
    const arrivalFlight = this.#startFlights.get(expectedCurrentVersion);
    if (arrivalFlight !== undefined) {
      return arrivalFlight.then((result) => ({ ...result, coalesced: true }));
    }
    const result = this.#serialize<HarnessUpdateStart>(async () => {
      let confirmed = await this.check();
      if (confirmed.currentVersion !== expectedCurrentVersion)
        throw new HarnessUpdateStale(confirmed.currentVersion);

      const active = this.#active;
      if (active !== undefined) {
        const activeStatus = await this.status();
        if (this.#active !== undefined) {
          if (active.expectedVersion !== expectedCurrentVersion)
            throw new HarnessUpdateBlocked("A Hermes update is already in progress. Poll its status before trying again.");
          return {
            harnessId: this.#harness.id,
            state: activeStatus.state === "running" ? "running" : "ambiguous",
            ...(active.actionId === undefined ? {} : { actionId: active.actionId }),
            coalesced: true,
            pollAfterMs: POLL_AFTER_MS,
          };
        }
        // The prior action became terminal while validating it. Its update may have changed the
        // installed version, so the confirmation must be checked again before a new POST.
        confirmed = await this.check();
        if (confirmed.currentVersion !== expectedCurrentVersion)
          throw new HarnessUpdateStale(confirmed.currentVersion);
      }

      if (!confirmed.canApply) throw new HarnessUpdateBlocked(confirmed.guidance!);
      if (!confirmed.updateAvailable)
        throw new HarnessUpdateBlocked("Hermes is already up to date. Check again before confirming another update.");

      const baseline = await this.#readStatus();
      try {
        const attempted = await updateJson(this.#client, "/api/hermes/update", { method: "POST" });
        if (isValidatedRefusal(attempted.status, attempted.body)) {
          throw new HarnessUpdateBlocked("Hermes cannot apply this update in place. Check again for current guidance.");
        }
        const response = record(attempted.body);
        if (attempted.status !== 200 || response?.["ok"] !== true
          || response["name"] !== "hermes-update"
          || (response["already_running"] !== undefined && response["already_running"] !== true))
          throw new Error("non-authoritative Hermes update response");
        const id = actionId(response["action_id"]);
        if (response["action_id"] !== undefined && id === undefined)
          throw new Error("non-authoritative Hermes update identity");
        const coalesced = response["already_running"] === true;
        this.#active = {
          expectedVersion: expectedCurrentVersion,
          ...(id === undefined ? {} : { actionId: id }),
          ...(baseline.receipt === undefined
            ? {} : { baselineReceiptFingerprint: baseline.receipt.fingerprint }),
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
        // Once the mutative request is attempted, a disconnect, non-2xx reply, oversized or
        // malformed body, and invalid success shape are indistinguishable from "Hermes accepted
        // it but the acknowledgement was lost." Only the exact pinned refusal above is definite.
        this.#active = {
          expectedVersion: expectedCurrentVersion,
          ...(baseline.receipt === undefined
            ? {} : { baselineReceiptFingerprint: baseline.receipt.fingerprint }),
        };
        return {
          harnessId: this.#harness.id,
          state: "ambiguous",
          coalesced: false,
          pollAfterMs: POLL_AFTER_MS,
        };
      }
    });
    this.#startFlights.set(expectedCurrentVersion, result);
    const clear = (): void => {
      if (this.#startFlights.get(expectedCurrentVersion) === result)
        this.#startFlights.delete(expectedCurrentVersion);
    };
    void result.then(clear, clear);
    return result;
  }

  async status(): Promise<HarnessUpdateStatus> {
    const snapshot = await this.#readStatus();
    const active = this.#active;
    if (snapshot.running) {
      return {
        harnessId: this.#harness.id,
        state: "running",
        ...(active?.actionId === undefined ? {} : { actionId: active.actionId }),
        pollAfterMs: POLL_AFTER_MS,
      };
    }

    if (active !== undefined) {
      const durableReceipt = snapshot.receipt;
      const changed = durableReceipt !== undefined
        && durableReceipt.fingerprint !== active.baselineReceiptFingerprint;
      if (changed) {
        if (durableReceipt.public.outcome === "success" && active.actionId !== undefined
          && snapshot.actionId !== active.actionId) {
          this.#active = undefined;
          return {
            harnessId: this.#harness.id,
            state: "unknown",
            guidance: "Hermes wrote a new success receipt without matching action identity. Refresh status; do not retry the update.",
            pollAfterMs: POLL_AFTER_MS,
          };
        }
        this.#active = undefined;
        // Non-success receipts do not carry an action id in pinned Hermes. The exact pre-POST
        // fingerprint establishes that this is newer durable harness state; never echo the stale
        // success-marker id that Hermes may place beside it.
        const correlatedActionId = durableReceipt.public.outcome === "success"
          ? active.actionId ?? snapshot.actionId
          : undefined;
        return projectReceipt(this.#harness.id, durableReceipt, correlatedActionId);
      }
      return {
        harnessId: this.#harness.id,
        state: "unknown",
        ...(active.actionId === undefined ? {} : { actionId: active.actionId }),
        pollAfterMs: POLL_AFTER_MS,
        guidance: "The update outcome is not yet a new durable receipt. Keep polling status; do not start it again.",
      };
    }

    if (snapshot.receipt !== undefined) {
      const receiptActionId = snapshot.receipt.public.outcome === "success"
        ? snapshot.actionId
        : undefined;
      return projectReceipt(this.#harness.id, snapshot.receipt, receiptActionId);
    }
    if (snapshot.exitCode !== null) {
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

export async function discoverHermesUpdates(
  client: HermesClient,
  harness: GatewayHarness,
): Promise<HermesHarnessUpdateAdapter | undefined> {
  const adapter = new HermesHarnessUpdateAdapter(client, harness);
  try {
    await adapter.probe();
    return adapter;
  } catch {
    return undefined;
  }
}

export class GatewayHarnessUpdates {
  readonly #adapters: ReadonlyMap<string, HermesHarnessUpdateAdapter>;

  constructor(adapters: readonly HermesHarnessUpdateAdapter[]) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.descriptor().id, adapter]));
    if (this.#adapters.size !== adapters.length) throw new Error("duplicate gateway harness update id");
  }

  get available(): boolean { return this.#adapters.size > 0; }

  adapter(harnessId: string): HermesHarnessUpdateAdapter {
    const adapter = this.#adapters.get(harnessId);
    if (!adapter) throw new HarnessSettingsInvalid(`unknown agent harness: ${harnessId}`);
    return adapter;
  }
}

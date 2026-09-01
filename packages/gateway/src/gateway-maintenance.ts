import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import {
  assertValid,
  GatewayMaintenanceStatusSchema,
  type GatewayMaintenanceReceipt,
  type GatewayMaintenanceStatus,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";

const REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const SOCKET_TIMEOUT_MS = 1_500;

export class GatewayMaintenanceFailure extends Error {
  readonly code: "stale_version" | "operation_in_progress" | "restart_unavailable" | "update_unavailable" | "insufficient_storage" | "maintenance_failed";
  readonly status: 409 | 422 | 507 | 500;

  constructor(
    code: "stale_version" | "operation_in_progress" | "restart_unavailable" | "update_unavailable" | "insufficient_storage" | "maintenance_failed",
    status: 409 | 422 | 507 | 500,
  ) {
    super(code.replaceAll("_", " "));
    this.name = "GatewayMaintenanceFailure";
    this.code = code;
    this.status = status;
  }
}

/** This is intentionally a tiny, host-owned IPC protocol. The gateway container can request an
 * operation, but it never receives Docker credentials or executes compose itself. */
export interface GatewayMaintenanceSupervisor {
  status(): Promise<GatewayMaintenanceStatus>;
  restart(operationId: string): Promise<void>;
  update(operationId: string, expectedTargetVersion: string): Promise<void>;
}

type SupervisorRequest =
  | { action: "status" }
  | { action: "restart"; operationId: string }
  | { action: "update"; operationId: string; expectedTargetVersion: string };

type SupervisorResponse =
  | { ok: true; status: GatewayMaintenanceStatus }
  | { ok: true }
  | { ok: false; code?: string };

function failureForSupervisor(code: string | undefined, action: "restart" | "update"): GatewayMaintenanceFailure {
  if (code === "insufficient_storage") return new GatewayMaintenanceFailure("insufficient_storage", 507);
  if (code === "operation_in_progress") return new GatewayMaintenanceFailure("operation_in_progress", 409);
  if (code === "restart_unavailable") return new GatewayMaintenanceFailure("restart_unavailable", 422);
  if (code === "update_unavailable") return new GatewayMaintenanceFailure("update_unavailable", 422);
  return new GatewayMaintenanceFailure(action === "restart" ? "restart_unavailable" : "update_unavailable", 422);
}

export class UnixSocketGatewayMaintenanceSupervisor implements GatewayMaintenanceSupervisor {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = SOCKET_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async status(): Promise<GatewayMaintenanceStatus> {
    const response = await this.request({ action: "status" });
    if (!response.ok || !("status" in response))
      throw failureForSupervisor(response.ok ? undefined : response.code, "restart");
    return assertValid(GatewayMaintenanceStatusSchema, response.status);
  }

  async restart(operationId: string): Promise<void> {
    const response = await this.request({ action: "restart", operationId });
    if (!response.ok) throw failureForSupervisor(response.code, "restart");
  }

  async update(operationId: string, expectedTargetVersion: string): Promise<void> {
    const response = await this.request({ action: "update", operationId, expectedTargetVersion });
    if (!response.ok) throw failureForSupervisor(response.code, "update");
  }

  private request(message: SupervisorRequest): Promise<SupervisorResponse> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      let body = "";
      const timer = setTimeout(() => socket.destroy(new Error("maintenance supervisor timed out")), this.timeoutMs);
      const finish = (error?: Error, result?: SupervisorResponse) => {
        clearTimeout(timer);
        socket.destroy();
        if (error !== undefined) reject(error); else resolve(result!);
      };
      socket.setEncoding("utf8");
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk: string) => {
        body += chunk;
        const newline = body.indexOf("\n");
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(body.slice(0, newline)) as SupervisorResponse;
          if (typeof parsed !== "object" || parsed === null || typeof parsed.ok !== "boolean")
            throw new Error("maintenance supervisor returned an invalid response");
          finish(undefined, parsed);
        } catch (error) {
          finish(error instanceof Error ? error : new Error("maintenance supervisor returned invalid JSON"));
        }
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    });
  }
}

type StoredReceipt = {
  fingerprint: string;
  receipt: GatewayMaintenanceReceipt;
  state: "pending" | "handed_off";
};

/** Paired route policy on top of the host seam. Receipts are durable in gateway SQLite; actual
 * process ownership remains entirely host-side. */
export class GatewayMaintenance {
  #active = false;
  #status: GatewayMaintenanceStatus;
  #inFlight = new Map<string, Promise<GatewayMaintenanceReceipt>>();
  private readonly storage: Storage;
  private readonly supervisor: GatewayMaintenanceSupervisor;
  private readonly currentVersion: string;
  private readonly now: () => number;

  constructor(
    storage: Storage,
    supervisor: GatewayMaintenanceSupervisor,
    initialStatus: GatewayMaintenanceStatus,
    currentVersion: string,
    now: () => number,
  ) {
    this.storage = storage;
    this.supervisor = supervisor;
    this.#status = initialStatus;
    this.currentVersion = currentVersion;
    this.now = now;
  }

  /** Serve the last verified status immediately, then refresh without making a phone wait on the
   * host. A failed refresh replaces actionable state with an unavailable snapshot. */
  status(): GatewayMaintenanceStatus {
    void this.supervisor.status().then((status) => { this.#status = status; }).catch(() => {
      // A stale control surface is unsafe: if the host supervisor disappears after boot, the
      // paired app must stop offering destructive maintenance actions until a fresh probe works.
      this.#status = {
        currentVersion: this.currentVersion,
        restartSupported: false,
        update: { state: "unavailable" },
      };
    });
    return { ...this.#status, currentVersion: this.currentVersion };
  }

  async restart(requestId: string): Promise<GatewayMaintenanceReceipt> {
    const fingerprint = `restart:${requestId}`;
    const existing = this.stored(requestId, fingerprint);
    if (existing?.state === "handed_off") return existing.receipt;
    if (existing?.state === "pending")
      return this.handoff(requestId, fingerprint, (operationId) => this.supervisor.restart(operationId));
    if (!this.#status.restartSupported) throw new GatewayMaintenanceFailure("restart_unavailable", 422);
    return this.handoff(requestId, fingerprint, (operationId) => this.supervisor.restart(operationId));
  }

  async update(
    requestId: string,
    expectedCurrentVersion: string,
    expectedTargetVersion: string,
  ): Promise<GatewayMaintenanceReceipt> {
    const fingerprint = `update:${expectedCurrentVersion}:${expectedTargetVersion}`;
    const existing = this.stored(requestId, fingerprint);
    if (existing?.state === "handed_off") return existing.receipt;
    if (existing?.state === "pending")
      return this.handoff(requestId, fingerprint, (operationId) =>
        this.supervisor.update(operationId, expectedTargetVersion));
    if (expectedCurrentVersion !== this.currentVersion)
      throw new GatewayMaintenanceFailure("stale_version", 409);
    const update = this.#status.update;
    if (update.state === "unavailable") throw new GatewayMaintenanceFailure("update_unavailable", 422);
    if (update.state !== "available" || update.latestVersion !== expectedTargetVersion)
      throw new GatewayMaintenanceFailure("stale_version", 409);
    return this.handoff(requestId, fingerprint, (operationId) =>
      this.supervisor.update(operationId, expectedTargetVersion));
  }

  private async handoff(
    requestId: string,
    fingerprint: string,
    requestSupervisor: (operationId: string) => Promise<void>,
  ): Promise<GatewayMaintenanceReceipt> {
    const running = this.#inFlight.get(requestId);
    if (running !== undefined) return running;
    const stored = this.stored(requestId, fingerprint);
    if (stored?.state === "handed_off") return stored.receipt;
    if (this.#active) throw new GatewayMaintenanceFailure("operation_in_progress", 409);
    const receipt = stored?.receipt ?? this.receipt();
    // Persist BEFORE IPC. A process crash after this point leaves a retryable pending request
    // carrying the same operation id; it never manufactures a second restart/update identity.
    if (stored === undefined)
      this.storage.rememberGatewayMaintenanceRequest(requestId, fingerprint, receipt, this.now() + REQUEST_RETENTION_MS);
    this.#active = true;
    const inFlight = (async () => {
      try {
        await requestSupervisor(receipt.operationId);
        this.storage.markGatewayMaintenanceHandedOff(requestId, receipt.operationId);
        return receipt;
      } catch (error) {
        this.#active = false;
        throw error instanceof GatewayMaintenanceFailure
          ? error
          : new GatewayMaintenanceFailure("maintenance_failed", 500);
      } finally {
        this.#inFlight.delete(requestId);
      }
    })();
    this.#inFlight.set(requestId, inFlight);
    return inFlight;
  }

  private stored(requestId: string, fingerprint: string): StoredReceipt | undefined {
    const stored = this.storage.gatewayMaintenanceRequest(requestId, this.now()) as StoredReceipt | undefined;
    if (stored !== undefined && stored.fingerprint !== fingerprint)
      throw new GatewayMaintenanceFailure("stale_version", 409);
    return stored;
  }

  private receipt(): GatewayMaintenanceReceipt {
    return { operationId: `maintenance_${randomUUID().replaceAll("-", "")}`, acceptedAt: this.now() };
  }
}

/** Returns undefined unless an actual host supervisor accepts an authenticated local IPC probe.
 * This keeps the capability absent for ordinary containers and unsupported local installs. */
export async function discoverGatewayMaintenance(
  environment: NodeJS.ProcessEnv,
  storage: Storage,
  currentVersion: string,
  now: () => number,
): Promise<GatewayMaintenance | undefined> {
  const socketPath = environment.COZYGATEWAY_MAINTENANCE_SOCKET;
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  try {
    const supervisor = new UnixSocketGatewayMaintenanceSupervisor(socketPath);
    const status = await supervisor.status();
    return new GatewayMaintenance(storage, supervisor, status, currentVersion, now);
  } catch {
    return undefined;
  }
}

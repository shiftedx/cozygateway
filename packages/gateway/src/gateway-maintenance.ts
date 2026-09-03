import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import type {
  GatewayMaintenanceOperation,
  GatewayMaintenanceReceipt,
  GatewayMaintenanceStatus,
  GatewayMaintenanceUpdate,
} from "cozygateway-contract";

import type { Storage } from "./storage.ts";

const SOCKET_TIMEOUT_MS = 1_500;

export class GatewayMaintenanceFailure extends Error {
  readonly code: "stale_version" | "operation_in_progress" | "restart_unavailable" | "update_unavailable" | "insufficient_storage" | "maintenance_failed";
  readonly status: 409 | 422 | 507 | 500;

  constructor(code: GatewayMaintenanceFailure["code"], status: GatewayMaintenanceFailure["status"]) {
    super(code.replaceAll("_", " "));
    this.name = "GatewayMaintenanceFailure";
    this.code = code;
    this.status = status;
  }
}

export class GatewayMaintenanceNotFound extends Error {
  constructor() {
    super("Gateway maintenance operation was not found.");
    this.name = "GatewayMaintenanceNotFound";
  }
}

export interface GatewayMaintenanceHostStatus {
  currentVersion: string;
  restartSupported: boolean;
  update: GatewayMaintenanceUpdate;
  cozyAgents?: { installed: true; version?: string; ready: boolean; failureCode?: string; runnerId?: string };
}

export interface GatewayMaintenanceRuntimeHealth {
  harness: "hermes" | "cozyagents";
  attach?: { configured: number; online: number; deadLetters: number };
  localRunnerAttached?: boolean;
}

export interface GatewayMaintenanceSupervisor {
  status(): Promise<GatewayMaintenanceHostStatus>;
  start(operationId: string): Promise<void>;
}

type SupervisorRequest = { action: "status" } | { action: "start"; operationId: string };
type SupervisorResponse =
  | { ok: true; status: GatewayMaintenanceHostStatus }
  | { ok: true }
  | { ok: false; code?: string };

function failureForSupervisor(code: string | undefined): GatewayMaintenanceFailure {
  if (code === "insufficient_storage") return new GatewayMaintenanceFailure("insufficient_storage", 507);
  if (code === "operation_in_progress") return new GatewayMaintenanceFailure("operation_in_progress", 409);
  if (code === "update_unavailable") return new GatewayMaintenanceFailure("update_unavailable", 422);
  return new GatewayMaintenanceFailure("restart_unavailable", 422);
}

export class UnixSocketGatewayMaintenanceSupervisor implements GatewayMaintenanceSupervisor {
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(socketPath: string, timeoutMs = SOCKET_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
  }

  async status(): Promise<GatewayMaintenanceHostStatus> {
    const response = await this.request({ action: "status" });
    if (!response.ok || !("status" in response))
      throw failureForSupervisor(response.ok ? undefined : response.code);
    return response.status;
  }

  async start(operationId: string): Promise<void> {
    const response = await this.request({ action: "start", operationId });
    if (!response.ok) throw failureForSupervisor(response.code);
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

export class GatewayMaintenance {
  #status: GatewayMaintenanceHostStatus;
  private readonly storage: Storage;
  private readonly supervisor: GatewayMaintenanceSupervisor;
  private readonly currentVersion: string;
  private readonly now: () => number;
  private readonly runtimeHealth: () => GatewayMaintenanceRuntimeHealth;

  constructor(
    storage: Storage,
    supervisor: GatewayMaintenanceSupervisor,
    initialStatus: GatewayMaintenanceHostStatus,
    currentVersion: string,
    now: () => number,
    runtimeHealth: () => GatewayMaintenanceRuntimeHealth = () => ({
      harness: "hermes",
      attach: { configured: 1, online: 1, deadLetters: 0 },
    }),
  ) {
    this.storage = storage;
    this.supervisor = supervisor;
    this.#status = initialStatus;
    this.currentVersion = currentVersion;
    this.now = now;
    this.runtimeHealth = runtimeHealth;
  }

  status(): GatewayMaintenanceStatus {
    void this.supervisor.status().then((status) => { this.#status = status; }).catch(() => {
      this.#status = { currentVersion: this.currentVersion, restartSupported: false, update: { state: "unavailable" } };
    });
    let runtime: GatewayMaintenanceRuntimeHealth;
    try {
      runtime = this.runtimeHealth();
    } catch {
      runtime = { harness: this.#status.cozyAgents === undefined ? "hermes" : "cozyagents" };
    }
    const active = this.storage.activeGatewayMaintenanceOperation();
    const attached = runtime.harness === "hermes"
      ? runtime.attach !== undefined && runtime.attach.configured > 0
        && runtime.attach.online === runtime.attach.configured && runtime.attach.deadLetters === 0
      : runtime.localRunnerAttached === true;
    return {
      ...this.#status,
      currentVersion: this.currentVersion,
      health: {
        state: active === undefined ? (attached ? "working" : "needs_attention") : "updating",
        gateway: active === undefined
          ? { state: "working", version: this.currentVersion }
          : { state: "updating", version: this.currentVersion, operationId: active.operationId },
        harness: attached
          ? { product: runtime.harness, state: "attached" }
          : {
              product: runtime.harness,
              state: "needs_attention",
              failureCode: runtime.harness === "hermes" ? "hermes_attach_not_ready" : "cozyagents_not_attached",
              message: runtime.harness === "hermes" ? "Hermes attachment is not ready." : "CozyAgents is not attached.",
              nextAction: "run_repair",
            },
        ...(this.#status.cozyAgents === undefined ? {} : {
          cozyAgents: {
            state: active?.step === "agents"
              ? "updating" as const
              : this.#status.cozyAgents.ready ? "working" as const : "needs_attention" as const,
            ...(this.#status.cozyAgents.version === undefined ? {} : { version: this.#status.cozyAgents.version }),
            ...(this.#status.cozyAgents.ready ? {} : {
              failureCode: this.#status.cozyAgents.failureCode ?? "cozyagents_not_attached",
              message: "CozyAgents is not ready.",
              nextAction: "run_repair" as const,
            }),
          },
        }),
      },
    };
  }

  restart(requestId: string): Promise<GatewayMaintenanceReceipt> {
    return this.accept("restart", requestId, "restart", this.priorVersions());
  }

  update(requestId: string, expectedCurrentVersion: string, expectedTargetVersion: string): Promise<GatewayMaintenanceReceipt> {
    return this.accept(
      "update",
      requestId,
      JSON.stringify({ expectedCurrentVersion, expectedTargetVersion }),
      this.priorVersions(),
    );
  }

  operation(operationId: string): GatewayMaintenanceOperation {
    const operation = this.storage.gatewayMaintenanceOperation(operationId);
    if (operation === undefined) throw new GatewayMaintenanceNotFound();
    return operation;
  }

  coLocatedRunnerId(): string | undefined {
    return this.#status.cozyAgents?.runnerId;
  }

  private async accept(
    action: "restart" | "update",
    requestId: string,
    fingerprint: string,
    priorVersions: { gateway: string; cozyAgents?: string },
  ): Promise<GatewayMaintenanceReceipt> {
    const existing = this.storage.gatewayMaintenanceOperationByKey(requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) throw new GatewayMaintenanceFailure("stale_version", 409);
      return { operationId: existing.operationId, acceptedAt: existing.createdAt };
    }
    if (action === "restart" && !this.#status.restartSupported)
      throw new GatewayMaintenanceFailure("restart_unavailable", 422);
    if (action === "update") {
      const expected = JSON.parse(fingerprint) as { expectedCurrentVersion: string; expectedTargetVersion: string };
      if (expected.expectedCurrentVersion !== this.currentVersion)
        throw new GatewayMaintenanceFailure("stale_version", 409);
      if (this.#status.update.state === "unavailable")
        throw new GatewayMaintenanceFailure("update_unavailable", 422);
      if (this.#status.update.state !== "available" || this.#status.update.latestVersion !== expected.expectedTargetVersion)
        throw new GatewayMaintenanceFailure("stale_version", 409);
    }

    let operation: GatewayMaintenanceOperation;
    try {
      operation = this.storage.createGatewayMaintenanceOperation({
        operationId: `maintenance_${randomUUID().replaceAll("-", "")}`,
        idempotencyKey: requestId,
        fingerprint,
        action,
        step: action === "update" && this.#status.cozyAgents !== undefined ? "agents" : "gateway",
        priorVersions,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof Error && error.message === "operation_in_progress")
        throw new GatewayMaintenanceFailure("operation_in_progress", 409);
      throw error;
    }
    try {
      await this.supervisor.start(operation.operationId);
    } catch {
      this.storage.advanceGatewayMaintenanceOperation({
        operationId: operation.operationId,
        from: { status: "pending", step: operation.step },
        to: {
          status: "failed",
          step: operation.step,
          completedAt: this.now(),
          failureCode: "maintenance_handoff_failed",
          message: "Gateway maintenance could not start.",
          nextAction: "retry_update",
        },
        now: this.now(),
      });
      throw new GatewayMaintenanceFailure("maintenance_failed", 500);
    }
    return { operationId: operation.operationId, acceptedAt: operation.createdAt };
  }

  private priorVersions(): { gateway: string; cozyAgents?: string } {
    return {
      gateway: this.currentVersion,
      ...(this.#status.cozyAgents?.version === undefined ? {} : { cozyAgents: this.#status.cozyAgents.version }),
    };
  }
}

export async function discoverGatewayMaintenance(
  environment: NodeJS.ProcessEnv,
  storage: Storage,
  currentVersion: string,
  runtimeHealth: () => GatewayMaintenanceRuntimeHealth,
  now: () => number,
): Promise<GatewayMaintenance | undefined> {
  const socketPath = environment.COZYGATEWAY_MAINTENANCE_SOCKET;
  if (socketPath === undefined || socketPath.length === 0) return undefined;
  try {
    const supervisor = new UnixSocketGatewayMaintenanceSupervisor(socketPath);
    const status = await supervisor.status();
    return new GatewayMaintenance(storage, supervisor, status, currentVersion, now, runtimeHealth);
  } catch {
    return undefined;
  }
}

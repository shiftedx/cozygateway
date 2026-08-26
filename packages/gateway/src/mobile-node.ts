import {
  check,
  MobileNodePhoneStatusResultSchema,
  type MobileNodeCancelFrame,
  type MobileNodeGatewayStatusResult,
  type MobileNodePhoneStatusResult,
  type MobileNodeRequestFrame,
  type MobileNodeResultFrame,
} from "cozygateway-contract";

import { emitTrace, type TraceLog } from "./trace.ts";

export type MobileNodeTerminal =
  | "ok" | "denied" | "expired" | "cancelled" | "device_unavailable"
  | "foreground_required" | "policy_blocked";
export type MobileNodeResult =
  | { requestId: string; status: "ok"; result: MobileNodeGatewayStatusResult }
  | { requestId: string; status: "ok"; result: { latitude: number; longitude: number } }
  | { requestId: string; status: Exclude<MobileNodeTerminal, "ok"> };

interface Pending {
  deviceId: string;
  agentId: string;
  turnId: string;
  command: MobileNodeCommand;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export type MobileNodeCommand = "device.status" | "location.current";
export const MOBILE_NODE_FAILURE_REASONS = [
  "no_selected_device",
  "command_not_advertised",
  "selected_socket_unavailable",
  "frame_send_failed",
  "phone_disconnected_pending",
  "invalid_phone_payload",
  "broker_closed_pending",
] as const;
export type MobileNodeFailureReason = typeof MOBILE_NODE_FAILURE_REASONS[number];
export type MobileNodeSendOutcome = "sent"
  | "command_not_advertised" | "selected_socket_unavailable" | "frame_send_failed";
export interface MobileNodeRoute {
  status: "available" | "command_not_advertised" | "selected_socket_unavailable";
  selectedSocketPresent: boolean;
  selectedSocketOpen: boolean;
  commandAdvertised: boolean;
  connectedSocketCount: number;
}

export interface MobileNodeFailureFields {
  command: MobileNodeCommand | "unknown";
  selectedDevicePresent: boolean;
  selectedSocketPresent: boolean;
  selectedSocketOpen: boolean;
  commandAdvertised: boolean;
  connectedSocketCount: number;
  pendingCount?: number;
  payloadParseable?: boolean;
  payloadSchemaValid?: boolean;
}

/** Emit only a bounded reason and non-sensitive route state. */
export function emitMobileNodeFailure(
  trace: TraceLog | undefined,
  reason: MobileNodeFailureReason,
  fields: MobileNodeFailureFields,
): void {
  emitTrace(trace, "mobile_node_failure", {
    reason,
    command: fields.command,
    selectedDevicePresent: fields.selectedDevicePresent,
    selectedSocketPresent: fields.selectedSocketPresent,
    selectedSocketOpen: fields.selectedSocketOpen,
    commandAdvertised: fields.commandAdvertised,
    connectedSocketCount: boundedCount(fields.connectedSocketCount),
    ...(fields.pendingCount === undefined ? {} : { pendingCount: boundedCount(fields.pendingCount) }),
    ...(fields.payloadParseable === undefined ? {} : { payloadParseable: fields.payloadParseable }),
    ...(fields.payloadSchemaValid === undefined ? {} : { payloadSchemaValid: fields.payloadSchemaValid }),
  });
}
interface MobileNodeInvocationBase {
  requestId: string;
  bot: string;
  threadId: string;
  turnId: string;
  expiresAt: number;
  deviceId?: string;
  agentId: string;
}
export type MobileNodeInvocation =
  | (MobileNodeInvocationBase & { command: "device.status"; purpose: string })
  | (MobileNodeInvocationBase & { command: "location.current"; purpose: string });

const TERMINAL_TTL_MS = 30_000;
const TERMINAL_LIMIT = 1_024;

/** Origin-bound ephemeral requests; status may run in background, location may not. */
export class MobileNodeBroker {
  readonly #pending = new Map<string, Pending>();
  /** Every admitted id remains here until its volatile terminal window lapses. */
  readonly #terminal = new Map<string, number>();
  readonly #route: (deviceId: string, command: MobileNodeCommand) => MobileNodeRoute;
  readonly #send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean | MobileNodeSendOutcome;
  readonly #result: (agentId: string, frame: MobileNodeResult) => void;
  readonly #now: () => number;
  readonly #trace: TraceLog | undefined;
  readonly #terminalTtlMs: number;
  readonly #terminalLimit: number;

  constructor(deps: {
    available?: (deviceId: string, command: MobileNodeCommand) => boolean;
    route?: (deviceId: string, command: MobileNodeCommand) => MobileNodeRoute;
    send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean | MobileNodeSendOutcome;
    result: (agentId: string, frame: MobileNodeResult) => void;
    trace?: TraceLog;
    now?: () => number;
    terminalTtlMs?: number;
    terminalLimit?: number;
  }) {
    if (deps.route === undefined && deps.available === undefined)
      throw new Error("mobile-node route dependency is required");
    this.#route = deps.route ?? ((deviceId, command) => legacyRoute(deps.available!(deviceId, command)));
    this.#send = deps.send;
    this.#result = deps.result;
    this.#now = deps.now ?? Date.now;
    this.#trace = deps.trace;
    this.#terminalTtlMs = deps.terminalTtlMs ?? TERMINAL_TTL_MS;
    this.#terminalLimit = deps.terminalLimit ?? TERMINAL_LIMIT;
  }

  invoke(input: MobileNodeInvocation): void {
    this.#pruneTerminal();
    // `requestId` is a one-shot idempotency key. Never replace a live timer/prompt.
    if (this.#pending.has(input.requestId) || this.#terminal.has(input.requestId)) return;
    if (!input.deviceId) {
      this.#diagnose("no_selected_device", input.command, false, noRoute());
      this.#terminalize(input.agentId, input.requestId, "device_unavailable", input.expiresAt);
      return;
    }
    if (input.expiresAt <= this.#now() || input.expiresAt > this.#now() + 30_000 || !isPurpose(input.purpose)) {
      this.#terminalize(input.agentId, input.requestId, "policy_blocked", input.expiresAt);
      return;
    }
    const route = this.#route(input.deviceId, input.command);
    if (route.status !== "available") {
      this.#diagnose(route.status, input.command, true, route);
      this.#terminalize(input.agentId, input.requestId, "foreground_required", input.expiresAt);
      return;
    }
    // No eviction is safe: a retained unexpired id is the only duplicate-prompt defense.
    // Dropping a new admission while full is intentionally fail-closed and non-durable.
    if (!this.#canAdmit()) return;
    const frame: MobileNodeRequestFrame = {
      type: "mobile_node_request", requestId: input.requestId, command: input.command, bot: input.bot,
      threadId: input.threadId, turnId: input.turnId, expiresAt: input.expiresAt, purpose: input.purpose,
    };
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#pending.set(input.requestId, { deviceId: input.deviceId, agentId: input.agentId, turnId: input.turnId, command: input.command, expiresAt: input.expiresAt, timer });
    let sendOutcome: boolean | MobileNodeSendOutcome;
    try {
      sendOutcome = this.#send(input.deviceId, frame);
    } catch {
      sendOutcome = "frame_send_failed";
    }
    const normalizedSend = normalizeSendOutcome(sendOutcome);
    if (normalizedSend !== "sent") {
      const failedRoute = normalizedSend === "frame_send_failed"
        ? route
        : this.#route(input.deviceId, input.command);
      this.#diagnose(normalizedSend, input.command, true, failedRoute);
      this.#finish(input.requestId, "device_unavailable");
    }
  }

  reject(agentId: string, requestId: string, status: Exclude<MobileNodeTerminal, "ok"> = "policy_blocked"): void {
    this.#terminalize(agentId, requestId, status, this.#now());
  }

  result(deviceId: string, frame: MobileNodeResultFrame): void {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.deviceId !== deviceId) return;
    if (pending.expiresAt <= this.#now()) {
      this.#finish(frame.requestId, "expired", true);
      return;
    }
    if (frame.status === "ok") {
      if (pending.command === "location.current") {
        const route = this.#route(deviceId, pending.command);
        if (route.status !== "available") {
          this.#diagnose(route.status, pending.command, true, route);
          this.#finish(frame.requestId, "foreground_required");
          return;
        }
      }
      let valid = false;
      try {
        valid = pending.command === "device.status"
          ? check(MobileNodePhoneStatusResultSchema, frame.result)
          : isLocation(frame.result);
      } catch {
        valid = false;
      }
      if (!valid) {
        this.#diagnose("invalid_phone_payload", pending.command, true, this.#route(deviceId, pending.command), {
          payloadParseable: true,
          payloadSchemaValid: false,
        });
        return;
      }
      this.#finish(frame.requestId, "ok", false, frame.result);
      return;
    }
    this.#finish(frame.requestId, frame.status);
  }

  cancelTurn(agentId: string, turnId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.agentId === agentId && pending.turnId === turnId) this.#finish(requestId, "cancelled", true);
    }
  }

  cancelRequest(agentId: string, requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (pending?.agentId === agentId) this.#finish(requestId, "cancelled", true);
  }

  disconnectDevice(deviceId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.deviceId === deviceId) {
        this.#diagnose("phone_disconnected_pending", pending.command, true, this.#route(deviceId, pending.command));
        this.#finish(requestId, "device_unavailable");
      }
    }
  }

  disconnectAgent(agentId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.agentId === agentId) this.#finish(requestId, "cancelled", true);
    }
  }

  close(): void {
    for (const [requestId, pending] of this.#pending) {
      this.#diagnose("broker_closed_pending", pending.command, true, this.#route(pending.deviceId, pending.command));
      this.#finish(requestId, "device_unavailable");
    }
  }

  #diagnose(
    reason: MobileNodeFailureReason,
    command: MobileNodeCommand,
    selectedDevicePresent: boolean,
    route: MobileNodeRoute,
    payload: Pick<MobileNodeFailureFields, "payloadParseable" | "payloadSchemaValid"> = {},
  ): void {
    emitMobileNodeFailure(this.#trace, reason, {
      command,
      selectedDevicePresent,
      selectedSocketPresent: route.selectedSocketPresent,
      selectedSocketOpen: route.selectedSocketOpen,
      commandAdvertised: route.commandAdvertised,
      connectedSocketCount: route.connectedSocketCount,
      pendingCount: this.#pending.size,
      ...payload,
    });
  }

  #finish(requestId: string, status: MobileNodeTerminal, notifyDevice = false, result?: MobileNodePhoneStatusResult | { latitude: number; longitude: number }): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    this.#rememberTerminal(requestId, Math.max(pending.expiresAt, this.#now() + this.#terminalTtlMs));
    if (notifyDevice && (status === "cancelled" || status === "expired")) {
      this.#send(pending.deviceId, { type: "mobile_node_cancel", requestId, status });
    }
    if (status === "ok" && result !== undefined)
      this.#result(pending.agentId, pending.command === "location.current"
        ? { requestId, status, result: result as { latitude: number; longitude: number } }
        : {
            requestId, status,
            result: {
              ...(result as MobileNodePhoneStatusResult),
              authenticatedReachable: true,
              lastAuthenticatedPresenceAt: this.#now(),
            },
          });
    else this.#result(pending.agentId, { requestId, status: status === "ok" ? "device_unavailable" : status });
  }

  #rememberTerminal(requestId: string, until: number): void {
    this.#pruneTerminal();
    if (!this.#canAdmit()) return;
    this.#terminal.set(requestId, until);
  }

  #terminalize(
    agentId: string,
    requestId: string,
    status: Exclude<MobileNodeTerminal, "ok">,
    expiresAt: number,
  ): void {
    this.#pruneTerminal();
    if (this.#pending.has(requestId) || this.#terminal.has(requestId) || !this.#canAdmit()) return;
    this.#terminal.set(requestId, Math.max(expiresAt, this.#now() + this.#terminalTtlMs));
    this.#result(agentId, { requestId, status });
  }

  #canAdmit(): boolean {
    return this.#pending.size + this.#terminal.size < this.#terminalLimit;
  }

  #pruneTerminal(): void {
    const now = this.#now();
    for (const [requestId, until] of this.#terminal) {
      if (until <= now) this.#terminal.delete(requestId);
    }
  }
}

function boundedCount(value: number): number {
  return Math.min(Math.max(Math.trunc(value), 0), 1_024);
}

function noRoute(): MobileNodeRoute {
  return {
    status: "selected_socket_unavailable",
    selectedSocketPresent: false,
    selectedSocketOpen: false,
    commandAdvertised: false,
    connectedSocketCount: 0,
  };
}

function legacyRoute(available: boolean): MobileNodeRoute {
  return available
    ? {
        status: "available", selectedSocketPresent: true, selectedSocketOpen: true,
        commandAdvertised: true, connectedSocketCount: 1,
      }
    : {
        status: "command_not_advertised", selectedSocketPresent: false, selectedSocketOpen: false,
        commandAdvertised: false, connectedSocketCount: 0,
      };
}

function normalizeSendOutcome(outcome: boolean | MobileNodeSendOutcome): MobileNodeSendOutcome {
  if (outcome === true) return "sent";
  if (outcome === false) return "frame_send_failed";
  return outcome;
}

function isPurpose(value: string): boolean {
  return value.length > 0
    && value === value.trim().replace(/\s+/gu, " ")
    && Buffer.byteLength(value, "utf8") <= 160
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function isLocation(value: unknown): value is { latitude: number; longitude: number } {
  if (typeof value !== "object" || value === null) return false;
  const { latitude, longitude } = value as { latitude?: unknown; longitude?: unknown };
  return typeof latitude === "number" && typeof longitude === "number"
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180
    && Math.abs(latitude * 100 - Math.round(latitude * 100)) < 1e-8
    && Math.abs(longitude * 100 - Math.round(longitude * 100)) < 1e-8
    && Object.keys(value).length === 2;
}

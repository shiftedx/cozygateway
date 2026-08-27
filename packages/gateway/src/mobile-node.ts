import { randomBytes } from "node:crypto";

import {
  check,
  MobileNodePhoneStatusResultSchema,
  MobileNodeRequestFrameSchema,
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
export const MOBILE_NODE_FAILURE_STAGES = [
  "policy", "routing", "dispatch", "response", "media", "receipt", "lifecycle",
] as const;
export type MobileNodeFailureStage = typeof MOBILE_NODE_FAILURE_STAGES[number];
export interface MobileNodeFailureDiagnostic {
  stage: MobileNodeFailureStage;
  reason: MobileNodeFailureReason;
}
export type MobileNodeResult =
  | { requestId: string; status: "ok"; result: MobileNodeGatewayStatusResult }
  | { requestId: string; status: "ok"; result: { latitude: number; longitude: number } }
  | { requestId: string; status: "ok"; result: MobileNodeMediaDescriptor }
  | { requestId: string; status: "ok"; result: { action: "approve" | "snooze" | "open" | "cancel" } }
  | ({ requestId: string; status: Exclude<MobileNodeTerminal, "ok"> } & Partial<MobileNodeFailureDiagnostic>);

export interface MobileNodeReceiptInput {
  requestId: string;
  bot: string;
  threadId: string;
  turnId: string;
  command: MobileNodeCommand;
  purpose: string;
  sharedDescription: "Device status" | "Approximate location" | "Camera photo" | "Camera video" | "Selected photo" | "Selected file" | "Notification action";
}

interface Pending {
  deviceId: string;
  agentId: string;
  turnId: string;
  command: MobileNodeCommand;
  expiresAt: number;
  frame: MobileNodeRequestFrame;
  timer: ReturnType<typeof setTimeout>;
}

export type MobileNodeCommand = "device.status" | "location.current" | "camera.capture" | "file.pick" | "notification.present";
export type MobileNodeMediaDescriptor = { mediaId: string; mimeType: string; byteCount: number; sha256: string; filename: string; family: "image" | "audio" | "video" | "file" };
interface MobileNodeMediaUploadClaim { agentId: string; command: "camera.capture" | "file.pick"; pending: Pending; }
export const MOBILE_NODE_FAILURE_REASONS = [
  "no_selected_device",
  "command_not_advertised",
  "selected_socket_unavailable",
  "frame_send_failed",
  "phone_disconnected_pending",
  "invalid_phone_payload",
  "lease_mismatch",
  "cross_device_result",
  "receipt_persistence_failed",
  "broker_closed_pending",
  // The gateway built a frame the contract does not allow. The phone would drop it in silence,
  // so this refuses to send it and says so instead.
  "malformed_request_frame",
  // A frame the gateway wrote to the phone that no answer ever came back for. Without this an
  // expiry was the one outcome that left no operator reason at all, so a phone that receives a
  // request and silently ignores it looked identical to one that was never sent anything.
  "request_expired_unanswered",
  "request_policy_rejected",
  "selected_app_not_foreground",
  "media_validation_failed",
  "media_storage_failed",
] as const;
export type MobileNodeFailureReason = typeof MOBILE_NODE_FAILURE_REASONS[number];
export type MobileNodeSendOutcome = "sent"
  | "command_not_advertised" | "selected_socket_unavailable" | "frame_send_failed";
export interface MobileNodeRoute {
  status: "available" | "command_not_advertised" | "selected_socket_unavailable";
  selectedSocketPresent: boolean;
  selectedSocketOpen: boolean;
  commandAdvertised: boolean;
  foreground?: boolean;
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
  | (MobileNodeInvocationBase & { command: "location.current"; purpose: string })
  | (MobileNodeInvocationBase & { command: "camera.capture"; purpose: string; camera: "front" | "rear"; capture: "photo" | "video"; videoDurationSeconds: 10 })
  | (MobileNodeInvocationBase & { command: "file.pick"; purpose: string; selection: "photo" | "file" })
  | (MobileNodeInvocationBase & { command: "notification.present"; purpose: string; title: string; body: string });

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
  readonly #receipt: (receipt: MobileNodeReceiptInput) => boolean;
  readonly #now: () => number;
  readonly #trace: TraceLog | undefined;
  readonly #terminalTtlMs: number;
  readonly #terminalLimit: number;

  constructor(deps: {
    available?: (deviceId: string, command: MobileNodeCommand) => boolean;
    route?: (deviceId: string, command: MobileNodeCommand) => MobileNodeRoute;
    send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean | MobileNodeSendOutcome;
    result: (agentId: string, frame: MobileNodeResult) => void;
    receipt: (receipt: MobileNodeReceiptInput) => boolean;
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
    this.#receipt = deps.receipt;
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
      this.#terminalize(input.agentId, input.requestId, "device_unavailable", input.expiresAt,
        failure("routing", "no_selected_device"));
      return;
    }
    if (input.expiresAt <= this.#now() || input.expiresAt > this.#now() + 30_000 || !isPurpose(input.purpose)) {
      this.#diagnose("request_policy_rejected", input.command, true, noRoute());
      this.#terminalize(input.agentId, input.requestId, "policy_blocked", input.expiresAt,
        failure("policy", "request_policy_rejected"));
      return;
    }
    const route = this.#route(input.deviceId, input.command);
    if (route.status !== "available") {
      this.#diagnose(route.status, input.command, true, route);
      this.#terminalize(input.agentId, input.requestId, "foreground_required", input.expiresAt,
        failure("routing", route.status));
      return;
    }
    // No eviction is safe: a retained unexpired id is the only duplicate-prompt defense.
    // Dropping a new admission while full is intentionally fail-closed and non-durable.
    if (!this.#canAdmit()) return;
    if (requiresForeground(input.command) && route.foreground !== true) {
      this.#diagnose("selected_app_not_foreground", input.command, true, route);
      this.#terminalize(input.agentId, input.requestId, "foreground_required", input.expiresAt,
        failure("routing", "selected_app_not_foreground"));
      return;
    }
    const { deviceId: _deviceId, agentId: _agentId, ...request } = input;
    const frame = { type: "mobile_node_request", lease: issueLease(), ...request } as MobileNodeRequestFrame;
    // The cast above is a compile-time claim, not a runtime one, and a spread can carry a key the
    // contract forbids. The app validates the exact key set and drops anything else WITHOUT a
    // word, so an unchecked frame fails as a 30 second silence with nothing to read. Check it here,
    // where the schema's closed key set can still be enforced.
    if (!check(MobileNodeRequestFrameSchema, frame)) {
      this.#diagnose("malformed_request_frame", input.command, true, route);
      this.#terminalize(input.agentId, input.requestId, "policy_blocked", input.expiresAt,
        failure("dispatch", "malformed_request_frame"));
      return;
    }
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#pending.set(input.requestId, { deviceId: input.deviceId, agentId: input.agentId, turnId: input.turnId, command: input.command, expiresAt: input.expiresAt, frame, timer });
    let sendOutcome: boolean | MobileNodeSendOutcome;
    try {
      sendOutcome = this.#send(input.deviceId, frame);
    } catch {
      sendOutcome = "frame_send_failed";
    }
    const normalizedSend = normalizeSendOutcome(sendOutcome);
    if (normalizedSend === "sent") {
      emitTrace(this.#trace, "mobile_node_dispatch", {
        command: input.command,
        selectedSocketPresent: route.selectedSocketPresent,
        selectedSocketOpen: route.selectedSocketOpen,
        commandAdvertised: route.commandAdvertised,
        connectedSocketCount: route.connectedSocketCount,
        foreground: route.foreground === true,
      });
    }
    if (normalizedSend !== "sent") {
      const failedRoute = normalizedSend === "frame_send_failed"
        ? route
        : this.#route(input.deviceId, input.command);
      this.#diagnose(normalizedSend, input.command, true, failedRoute);
      this.#finish(input.requestId, "device_unavailable", false, undefined,
        failure("dispatch", normalizedSend));
    }
  }

  reject(agentId: string, requestId: string, status: Exclude<MobileNodeTerminal, "ok"> = "policy_blocked"): void {
    this.#terminalize(agentId, requestId, status, this.#now(),
      status === "policy_blocked" ? failure("policy", "request_policy_rejected") : undefined);
  }

  result(deviceId: string, frame: MobileNodeResultFrame): void {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.frame.lease !== frame.lease) {
      this.#diagnose("lease_mismatch", "unknown", false, noRoute());
      return;
    }
    if (pending.deviceId !== deviceId) {
      this.#diagnose("cross_device_result", pending.command, true, this.#route(deviceId, pending.command));
      return;
    }
    if (pending.expiresAt <= this.#now()) {
      this.#finish(frame.requestId, "expired", true);
      return;
    }
    // A matching answer consumes the lease before validation, receipt persistence, or attach
    // settlement. No callback below can leave a reusable authorization behind.
    this.#consume(frame.requestId, pending);
    if (frame.status === "ok") {
      if (requiresForeground(pending.command)) {
        const route = this.#route(deviceId, pending.command);
        if (route.status !== "available") {
          this.#diagnose(route.status, pending.command, true, route);
          this.#settle(pending, "foreground_required", undefined, failure("routing", route.status));
          return;
        }
      }
      let valid = false;
      try {
        valid = pending.command === "device.status"
          ? check(MobileNodePhoneStatusResultSchema, frame.result)
          : pending.command === "location.current" ? isLocation(frame.result)
          : pending.command === "notification.present" ? isNotification(frame.result)
          : false;
      } catch {
        valid = false;
      }
      if (!valid) {
        this.#diagnose("invalid_phone_payload", pending.command, true, this.#route(deviceId, pending.command), {
          payloadParseable: true,
          payloadSchemaValid: false,
        });
        this.#settle(pending, "policy_blocked", undefined, failure("response", "invalid_phone_payload"));
        return;
      }
      this.#settle(pending, "ok", frame.result);
      return;
    }
    this.#settle(pending, frame.status);
  }

  cancelTurn(agentId: string, turnId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.agentId === agentId && pending.turnId === turnId)
        this.#finish(pending.frame.requestId, "cancelled", true);
    }
  }

  cancelRequest(agentId: string, requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (pending?.agentId === agentId) this.#finish(requestId, "cancelled", true);
  }

  disconnectDevice(deviceId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.deviceId === deviceId)
        this.#diagnose("phone_disconnected_pending", pending.command, true, this.#route(deviceId, pending.command));
    }
  }

  reconnectDevice(deviceId: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.deviceId !== deviceId) continue;
      if (pending.expiresAt <= this.#now()) {
        this.#finish(pending.frame.requestId, "expired", true);
        continue;
      }
      const route = this.#route(deviceId, pending.command);
      if (route.status !== "available" || (requiresForeground(pending.command) && route.foreground !== true)) continue;
      try {
        const outcome = normalizeSendOutcome(this.#send(deviceId, pending.frame));
        if (outcome !== "sent")
          this.#diagnose(outcome, pending.command, true, this.#route(deviceId, pending.command));
      } catch {
        this.#diagnose(
          "frame_send_failed",
          pending.command,
          true,
          this.#route(deviceId, pending.command),
        );
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
      this.#finish(requestId, "device_unavailable", false, undefined,
        failure("lifecycle", "broker_closed_pending"));
    }
  }

  /** Starts the only binary lane. The lease is consumed before bytes are admitted, so retries,
   * replays, and a second device cannot turn one consent into two uploads. */
  beginMediaUpload(deviceId: string, requestId: string, lease: string): MobileNodeMediaUploadClaim | undefined {
    const pending = this.#pending.get(requestId);
    if (pending === undefined || pending.frame.lease !== lease || !isMediaCommand(pending.command)) return undefined;
    if (pending.deviceId !== deviceId || pending.expiresAt <= this.#now()) {
      if (pending.expiresAt <= this.#now()) this.#finish(requestId, "expired", true);
      return undefined;
    }
    const route = this.#route(deviceId, pending.command);
    if (route.status !== "available" || route.foreground !== true) {
      this.#finish(requestId, "foreground_required", true);
      return undefined;
    }
    this.#consume(requestId, pending);
    return { agentId: pending.agentId, command: pending.command, pending };
  }

  completeMediaUpload(
    claim: MobileNodeMediaUploadClaim,
    media: MobileNodeMediaDescriptor | undefined,
    failedReason: "media_validation_failed" | "media_storage_failed" = "media_validation_failed",
  ): boolean {
    if (media === undefined) {
      this.#diagnose(failedReason, claim.pending.command, true,
        this.#route(claim.pending.deviceId, claim.pending.command));
      this.#settle(claim.pending, "policy_blocked", undefined, failure("media", failedReason));
      return false;
    }
    if (claim.pending.expiresAt <= this.#now()) { this.#settle(claim.pending, "expired"); return false; }
    const route = this.#route(claim.pending.deviceId, claim.pending.command);
    if (route.status !== "available" || route.foreground !== true) { this.#settle(claim.pending, "foreground_required"); return false; }
    return this.#settle(claim.pending, "ok", media);
  }

  #diagnose(
    reason: MobileNodeFailureReason,
    command: MobileNodeCommand | "unknown",
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

  #consume(requestId: string, pending: Pending): void {
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    this.#rememberTerminal(requestId, Math.max(pending.expiresAt, this.#now() + this.#terminalTtlMs));
  }

  #finish(
    requestId: string,
    status: MobileNodeTerminal,
    notifyDevice = false,
    result?: MobileNodePhoneStatusResult | { latitude: number; longitude: number } | MobileNodeMediaDescriptor | { action: "approve" | "snooze" | "open" | "cancel" },
    diagnostic?: MobileNodeFailureDiagnostic,
  ): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#consume(requestId, pending);
    if (status === "expired") {
      this.#diagnose("request_expired_unanswered", pending.command, true,
                     this.#route(pending.deviceId, pending.command));
      diagnostic = failure("response", "request_expired_unanswered");
    }
    if (notifyDevice && (status === "cancelled" || status === "expired")) {
      this.#send(pending.deviceId, {
        type: "mobile_node_cancel",
        requestId,
        lease: pending.frame.lease,
        status,
      });
    }
    this.#settle(pending, status, result, diagnostic);
  }

  #settle(
    pending: Pending,
    status: MobileNodeTerminal,
    result?: MobileNodePhoneStatusResult | { latitude: number; longitude: number } | MobileNodeMediaDescriptor | { action: "approve" | "snooze" | "open" | "cancel" },
    diagnostic?: MobileNodeFailureDiagnostic,
  ): boolean {
    const { requestId, bot, threadId, turnId, command, purpose } = pending.frame;
    if (status === "ok" && result !== undefined) {
      let recorded = false;
      try { recorded = this.#receipt({ requestId, bot, threadId, turnId, command, purpose, sharedDescription: receiptDescription(pending.frame) }); } catch {}
      if (!recorded) {
        this.#diagnose("receipt_persistence_failed", command, true, this.#route(pending.deviceId, command));
        this.#result(pending.agentId, {
          requestId, status: "device_unavailable", ...failure("receipt", "receipt_persistence_failed"),
        });
        return false;
      }
    }
    if (status === "ok" && result !== undefined)
      this.#result(pending.agentId, pending.command === "device.status"
        ? {
            requestId, status,
            result: {
              ...(result as MobileNodePhoneStatusResult),
              authenticatedReachable: true,
              lastAuthenticatedPresenceAt: this.#now(),
            },
          }
        : pending.command === "location.current"
          ? { requestId, status, result: result as { latitude: number; longitude: number } }
          : pending.command === "notification.present"
            ? { requestId, status, result: result as { action: "approve" | "snooze" | "open" | "cancel" } }
            : { requestId, status, result: result as MobileNodeMediaDescriptor });
    else this.#result(pending.agentId, {
      requestId, status: status === "ok" ? "device_unavailable" : status, ...diagnostic,
    });
    return status === "ok";
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
    diagnostic?: MobileNodeFailureDiagnostic,
  ): void {
    this.#pruneTerminal();
    if (this.#pending.has(requestId) || this.#terminal.has(requestId) || !this.#canAdmit()) return;
    this.#terminal.set(requestId, Math.max(expiresAt, this.#now() + this.#terminalTtlMs));
    this.#result(agentId, { requestId, status, ...diagnostic });
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

function failure(stage: MobileNodeFailureStage, reason: MobileNodeFailureReason): MobileNodeFailureDiagnostic {
  return { stage, reason };
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
    foreground: false,
    connectedSocketCount: 0,
  };
}

function legacyRoute(available: boolean): MobileNodeRoute {
  return available
    ? {
        status: "available", selectedSocketPresent: true, selectedSocketOpen: true,
        commandAdvertised: true, connectedSocketCount: 1,
        foreground: true,
      }
    : {
        status: "command_not_advertised", selectedSocketPresent: false, selectedSocketOpen: false,
        commandAdvertised: false, connectedSocketCount: 0,
        foreground: false,
      };
}

function normalizeSendOutcome(outcome: boolean | MobileNodeSendOutcome): MobileNodeSendOutcome {
  if (outcome === true) return "sent";
  if (outcome === false) return "frame_send_failed";
  return outcome;
}

function issueLease(): string {
  return randomBytes(32).toString("base64url");
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

function isMediaCommand(command: MobileNodeCommand): command is "camera.capture" | "file.pick" {
  return command === "camera.capture" || command === "file.pick";
}
function requiresForeground(command: MobileNodeCommand): boolean {
  return command === "location.current" || isMediaCommand(command);
}
function isNotification(value: unknown): value is { action: "approve" | "snooze" | "open" | "cancel" } {
  return typeof value === "object" && value !== null && Object.keys(value).length === 1
    && ["approve", "snooze", "open", "cancel"].includes((value as { action?: unknown }).action as string);
}
function receiptDescription(frame: MobileNodeRequestFrame): MobileNodeReceiptInput["sharedDescription"] {
  if (frame.command === "device.status") return "Device status";
  if (frame.command === "location.current") return "Approximate location";
  if (frame.command === "camera.capture") return frame.capture === "video" ? "Camera video" : "Camera photo";
  if (frame.command === "file.pick") return frame.selection === "photo" ? "Selected photo" : "Selected file";
  return "Notification action";
}

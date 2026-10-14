import { randomBytes } from "node:crypto";

import {
  check,
  MobileNodePhoneStatusResultSchema,
  MobileNodeRequestFrameSchema,
  type MobileNodeCancelFrame,
  type MobileNodeProgressFrame,
  type MobileNodeProgressStage,
  type MobileRequestState,
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

/** Capability 68. One typed step of one request's lifecycle. It carries the binding (profile,
 *  conversation, turn, the one target device, and through that device the person it is paired to)
 *  and never the lease, the phone's answer, or anything the phone measured. */
export interface MobileNodeLifecycleEvent {
  requestId: string;
  bot: string;
  sessionId: string;
  turnId: string;
  /** Absent only when no device was selected, which is itself the outcome. */
  deviceId?: string;
  command: MobileNodeCommand;
  purpose: string;
  state: MobileRequestState;
  at: number;
  expiresAt: number;
}

interface Pending {
  deviceId: string;
  /** The furthest stage the TARGET device reported for this request. Undefined means the phone has
   *  said nothing since the frame went out, which is every phone below mobile-node 6. */
  stage?: MobileNodeProgressStage;
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
/** Capability 70 (contract/ext-bots-v1.md row 70). WHERE the one target device comes from, and
 *  nothing else. Row 68 still owns the binding: this runs ONCE, at admission, and everything after
 *  it is unchanged, so the target never moves and a second device attaching never becomes one.
 *
 *  THE ONLY TWO SOURCES ARE THE PERSON'S. Their recorded choice for this conversation, then the
 *  device that opened the turn. A PEER HAS NO INPUT HERE AND THERE IS NO PARAMETER FOR ONE: which
 *  of somebody's phones rings is theirs to decide, not something a bot or a harness can name, and
 *  no frame on this wire carries a field for one, so there is nothing to ignore here either.
 *
 *  A stored choice naming a device that is no longer paired is skipped rather than resolved,
 *  because a target that cannot answer is worse than the turn origin it displaced. */
export type MobileTargetDeviceSource = "preference" | "turn_origin" | "none";
export function resolveMobileTargetDevice(input: {
  preferred?: string | undefined;
  turnOrigin?: string | undefined;
  isPaired: (deviceId: string) => boolean;
}): { deviceId: string | undefined; source: MobileTargetDeviceSource } {
  const wellFormed = (value: string | undefined): value is string =>
    typeof value === "string" && value.length >= 1 && value.length <= 256;
  if (wellFormed(input.preferred) && input.isPaired(input.preferred))
    return { deviceId: input.preferred, source: "preference" };
  if (wellFormed(input.turnOrigin))
    return { deviceId: input.turnOrigin, source: "turn_origin" };
  return { deviceId: undefined, source: "none" };
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
const QUERY_DEADLINE_MS = 30_000;
const INTERACTION_DEADLINE_MS = 120_000;

function maxDeadlineMs(command: MobileNodeCommand): number {
  return command === "device.status" || command === "location.current"
    ? QUERY_DEADLINE_MS
    : INTERACTION_DEADLINE_MS;
}

export interface MobileTaskWait { agentId: string; threadId: string; turnId: string; requestId: string; expiresAt: number; status: string }

/** Origin-bound ephemeral requests; status may run in background, location may not. */
export class MobileNodeBroker {
  readonly #pending = new Map<string, Pending>();
  /** Every admitted id remains here until its volatile terminal window lapses. */
  readonly #terminal = new Map<string, number>();
  readonly #route: (deviceId: string, command: MobileNodeCommand) => MobileNodeRoute;
  readonly #wake: ((deviceId: string) => boolean) | undefined;
  readonly #send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean | MobileNodeSendOutcome;
  readonly #result: (agentId: string, frame: MobileNodeResult) => void;
  readonly #receipt: (receipt: MobileNodeReceiptInput) => boolean;
  readonly #lifecycle: ((event: MobileNodeLifecycleEvent) => void) | undefined;
  readonly #now: () => number;
  readonly #taskWait: ((wait: MobileTaskWait) => void) | undefined;
  readonly #trace: TraceLog | undefined;
  readonly #terminalTtlMs: number;
  readonly #terminalLimit: number;

  constructor(deps: {
    taskWait?: (wait: MobileTaskWait) => void;
    route: (deviceId: string, command: MobileNodeCommand) => MobileNodeRoute;
    wake?: (deviceId: string) => boolean;
    send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean | MobileNodeSendOutcome;
    result: (agentId: string, frame: MobileNodeResult) => void;
    receipt: (receipt: MobileNodeReceiptInput) => boolean;
    lifecycle?: (event: MobileNodeLifecycleEvent) => void;
    trace?: TraceLog;
    now?: () => number;
    terminalTtlMs?: number;
    terminalLimit?: number;
  }) {
    this.#route = deps.route;
    this.#taskWait = deps.taskWait;
    this.#wake = deps.wake;
    this.#send = deps.send;
    this.#result = deps.result;
    this.#receipt = deps.receipt;
    this.#lifecycle = deps.lifecycle;
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
      this.#refuse(input, undefined, "device_unavailable", "failed",
        failure("routing", "no_selected_device"));
      return;
    }
    if (input.expiresAt <= this.#now()
      || input.expiresAt > this.#now() + maxDeadlineMs(input.command)
      || !isPurpose(input.purpose)) {
      this.#diagnose("request_policy_rejected", input.command, true, noRoute());
      this.#refuse(input, input.deviceId, "policy_blocked", "policy_blocked",
        failure("policy", "request_policy_rejected"));
      return;
    }
    const route = this.#route(input.deviceId, input.command);
    const wakeEligible = input.command === "device.status" && route.status === "selected_socket_unavailable";
    if (route.status !== "available" && !wakeEligible) {
      this.#diagnose(route.status, input.command, true, route);
      this.#refuse(input, input.deviceId, "foreground_required", "foreground_required",
        failure("routing", route.status));
      return;
    }
    // No eviction is safe: a retained unexpired id is the only duplicate-prompt defense.
    // Dropping a new admission while full is intentionally fail-closed and non-durable.
    // ponytail: the admission ceiling drops the request fail-closed and SILENTLY, which is the
    // pre-68 behavior; the peer waits out its own deadline. No lifecycle terminal is recorded
    // either, because a durable outcome nobody was told would disagree with the peer. Upgrade
    // path: tell the peer here, then this can record the terminal it was told.
    if (!this.#canAdmit()) return;
    if (requiresForeground(input.command) && route.foreground !== true) {
      this.#diagnose("selected_app_not_foreground", input.command, true, route);
      this.#refuse(input, input.deviceId, "foreground_required", "foreground_required",
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
      this.#refuse(input, input.deviceId, "policy_blocked", "policy_blocked",
        failure("dispatch", "malformed_request_frame"));
      return;
    }
    this.#life(input, input.deviceId, "requested");
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#taskWait?.({ agentId: input.agentId, threadId: input.threadId, turnId: input.turnId, requestId: input.requestId, expiresAt: input.expiresAt, status: "pending" });
    this.#pending.set(input.requestId, { deviceId: input.deviceId, agentId: input.agentId, turnId: input.turnId, command: input.command, expiresAt: input.expiresAt, frame, timer });
    if (wakeEligible) {
      let scheduled = false;
      try {
        scheduled = this.#wake?.(input.deviceId) === true;
      } catch {
        scheduled = false;
      }
      if (!scheduled) {
        this.#diagnose("selected_socket_unavailable", input.command, true, route);
        this.#finish(input.requestId, "foreground_required", false, undefined,
          failure("routing", "selected_socket_unavailable"));
      }
      return;
    }
    let sendOutcome: boolean | MobileNodeSendOutcome;
    try {
      sendOutcome = this.#send(input.deviceId, frame);
    } catch {
      sendOutcome = "frame_send_failed";
    }
    const normalizedSend = normalizeSendOutcome(sendOutcome);
    if (normalizedSend === "sent") {
      this.#life(input, input.deviceId, "routed");
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

  /** Capability 68. The target phone reporting one NON-TERMINAL stage of a request it holds. It
   *  can never settle a request and never carries a payload: it moves the typed lifecycle forward
   *  so a resuming app can see where a request actually got to, and it tells this gateway the
   *  phone already has the frame, which is what makes the reconnect below safe. */
  progress(deviceId: string, frame: MobileNodeProgressFrame): void {
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
    if (stageRank(frame.stage) <= stageRank(pending.stage)) return;
    pending.stage = frame.stage;
    this.#life(pending.frame, pending.deviceId, frame.stage);
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
      // The phone told us it holds this request (capability 68). Sending the frame again is how a
      // reconnect turns one consent into two prompts, or one action into two. A phone that reports
      // nothing, which is every phone below mobile-node 6, still gets the resend it always got.
      if (pending.stage !== undefined) continue;
      const route = this.#route(deviceId, pending.command);
      if (route.status !== "available" || (requiresForeground(pending.command) && route.foreground !== true)) continue;
      try {
        const outcome = normalizeSendOutcome(this.#send(deviceId, pending.frame));
        if (outcome === "sent") this.#life(pending.frame, deviceId, "routed");
        else this.#diagnose(outcome, pending.command, true, this.#route(deviceId, pending.command));
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

  expireRequest(agentId: string, turnId: string, requestId: string, at: number): void {
    const pending = this.#pending.get(requestId);
    if (pending?.agentId === agentId && pending.frame.turnId === turnId && pending.expiresAt <= at) this.#finish(requestId, "expired", true);
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
    // Derived, with no phone change: an upload claiming the lease IS the phone executing.
    pending.stage = "executing";
    this.#life(pending.frame, pending.deviceId, "executing");
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
    // beginMediaUpload consumed the one-shot lease before the request body was admitted. Once
    // that happened on time, the original interaction deadline must not invalidate bytes merely
    // because reading, validating, and storing them crossed the deadline.
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

  /** A refusal the peer IS told about, and only then a durable record of it: the pair of states a
   *  person reads is exactly the outcome the peer received. A refusal the ceiling swallows records
   *  nothing (see the ponytail note in `invoke`). */
  #refuse(
    input: MobileNodeInvocation,
    deviceId: string | undefined,
    status: Exclude<MobileNodeTerminal, "ok">,
    state: MobileRequestState,
    diagnostic: MobileNodeFailureDiagnostic,
  ): void {
    if (!this.#terminalize(input.agentId, input.requestId, status, input.expiresAt, diagnostic)) return;
    this.#life(input, deviceId, "requested");
    this.#life(input, deviceId, state);
  }

  /** Never throws into the request: a lifecycle record that could not be written must not lose the
   *  phone request it describes, exactly as a failed receipt does not lose one. */
  #life(
    request: { requestId: string; bot: string; threadId: string; turnId: string; command: MobileNodeCommand; purpose: string; expiresAt: number },
    deviceId: string | undefined,
    state: MobileRequestState,
  ): void {
    if (this.#lifecycle === undefined) return;
    try {
      this.#lifecycle({
        requestId: request.requestId, bot: request.bot, sessionId: request.threadId,
        turnId: request.turnId, ...(deviceId === undefined ? {} : { deviceId }),
        command: request.command, purpose: request.purpose, state,
        at: this.#now(), expiresAt: request.expiresAt,
      });
    } catch {}
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
        // The peer is about to be told this failed. Sealing `completed` first and compensating
        // afterwards cannot work: the first terminal is sealed, so the compensation would be
        // dropped and a person would read an outcome the peer never got.
        this.#life(pending.frame, pending.deviceId, "failed");
        this.#taskWait?.({ agentId: pending.agentId, threadId, turnId, requestId, expiresAt: pending.expiresAt, status: "device_unavailable" });
        this.#diagnose("receipt_persistence_failed", command, true, this.#route(pending.deviceId, command));
        this.#result(pending.agentId, {
          requestId, status: "device_unavailable", ...failure("receipt", "receipt_persistence_failed"),
        });
        return false;
      }
    }
    // Everything below this point IS the outcome, so it is safe to seal it now. `policy_blocked`
    // never appears here: this request was already routed to a phone, and a refusal of what came
    // back is a failure rather than a claim the gateway blocked it before anyone saw it.
    this.#life(pending.frame, pending.deviceId, settledState(status, result !== undefined));
    this.#taskWait?.({ agentId: pending.agentId, threadId, turnId, requestId, expiresAt: pending.expiresAt, status: status === "ok" && result === undefined ? "device_unavailable" : status });
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

  /** Answers whether the peer was actually told, so a caller records the durable terminal only
   *  when one was delivered. */
  #terminalize(
    agentId: string,
    requestId: string,
    status: Exclude<MobileNodeTerminal, "ok">,
    expiresAt: number,
    diagnostic?: MobileNodeFailureDiagnostic,
  ): boolean {
    this.#pruneTerminal();
    if (this.#pending.has(requestId) || this.#terminal.has(requestId) || !this.#canAdmit()) return false;
    this.#terminal.set(requestId, Math.max(expiresAt, this.#now() + this.#terminalTtlMs));
    this.#result(agentId, { requestId, status, ...diagnostic });
    return true;
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

function stageRank(stage: MobileNodeProgressStage | undefined): number {
  return stage === undefined ? 0
    : stage === "device_received" ? 1
    : stage === "consent_presented" ? 2
    : stage === "approved" ? 3
    : 4;
}

/** The typed outcome a person reads. `device_unavailable` is the one internal status with no
 *  user-facing name of its own: nothing reached a phone, which is a failure. `policy_blocked` and
 *  `foreground_required` keep their own names on purpose. */
function terminalState(status: MobileNodeTerminal): MobileRequestState {
  return status === "ok" || status === "device_unavailable" ? "failed" : status;
}

/** The outcome of a request that WAS routed to a phone. `policy_blocked` means the gateway refused
 *  the request before any phone saw it, so it cannot name what happened after one ran it: an
 *  unusable answer, a failed media validation and a refused store are all failures. The peer's own
 *  status is unchanged, for wire compatibility; only the state a person reads differs. */
function settledState(status: MobileNodeTerminal, delivered: boolean): MobileRequestState {
  if (status === "ok") return delivered ? "completed" : "failed";
  return status === "policy_blocked" ? "failed" : terminalState(status);
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

import type { MobileNodeCancelFrame, MobileNodeRequestFrame, MobileNodeResultFrame } from "cozygateway-contract";

export type MobileNodeTerminal =
  | "ok" | "denied" | "expired" | "cancelled" | "device_unavailable"
  | "foreground_required" | "policy_blocked";
export type MobileNodeResult =
  | { requestId: string; status: "ok"; result: { foreground: true } }
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

type MobileNodeCommand = "device.status" | "location.current";
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
  | (MobileNodeInvocationBase & { command: "device.status" })
  | (MobileNodeInvocationBase & { command: "location.current"; purpose: string });

const TERMINAL_TTL_MS = 30_000;
const TERMINAL_LIMIT = 1_024;

/** One foreground-only, origin-bound request at a time. Nothing here is durable. */
export class MobileNodeBroker {
  readonly #pending = new Map<string, Pending>();
  /** Every admitted id remains here until its volatile terminal window lapses. */
  readonly #terminal = new Map<string, number>();
  readonly #available: (deviceId: string, command: MobileNodeCommand) => boolean;
  readonly #send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean;
  readonly #result: (agentId: string, frame: MobileNodeResult) => void;
  readonly #now: () => number;
  readonly #terminalTtlMs: number;
  readonly #terminalLimit: number;

  constructor(deps: {
    available: (deviceId: string, command: MobileNodeCommand) => boolean;
    send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean;
    result: (agentId: string, frame: MobileNodeResult) => void;
    now?: () => number;
    terminalTtlMs?: number;
    terminalLimit?: number;
  }) {
    this.#available = deps.available;
    this.#send = deps.send;
    this.#result = deps.result;
    this.#now = deps.now ?? Date.now;
    this.#terminalTtlMs = deps.terminalTtlMs ?? TERMINAL_TTL_MS;
    this.#terminalLimit = deps.terminalLimit ?? TERMINAL_LIMIT;
  }

  invoke(input: MobileNodeInvocation): void {
    this.#pruneTerminal();
    // `requestId` is a one-shot idempotency key. Never replace a live timer/prompt.
    if (this.#pending.has(input.requestId) || this.#terminal.has(input.requestId)) return;
    if (!input.deviceId) {
      this.#terminalize(input.agentId, input.requestId, "device_unavailable", input.expiresAt);
      return;
    }
    if (input.expiresAt <= this.#now() || input.expiresAt > this.#now() + 30_000 || (input.command === "location.current" && !isPurpose(input.purpose))) {
      this.#terminalize(input.agentId, input.requestId, "policy_blocked", input.expiresAt);
      return;
    }
    if (!this.#available(input.deviceId, input.command)) {
      this.#terminalize(input.agentId, input.requestId, "foreground_required", input.expiresAt);
      return;
    }
    // No eviction is safe: a retained unexpired id is the only duplicate-prompt defense.
    // Dropping a new admission while full is intentionally fail-closed and non-durable.
    if (!this.#canAdmit()) return;
    const frame: MobileNodeRequestFrame = input.command === "device.status"
      ? { type: "mobile_node_request", requestId: input.requestId, command: input.command, bot: input.bot, threadId: input.threadId, turnId: input.turnId, expiresAt: input.expiresAt }
      : { type: "mobile_node_request", requestId: input.requestId, command: input.command, bot: input.bot, threadId: input.threadId, turnId: input.turnId, expiresAt: input.expiresAt, purpose: input.purpose };
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#pending.set(input.requestId, { deviceId: input.deviceId, agentId: input.agentId, turnId: input.turnId, command: input.command, expiresAt: input.expiresAt, timer });
    if (!this.#send(input.deviceId, frame)) this.#finish(input.requestId, "device_unavailable");
  }

  reject(agentId: string, requestId: string, status: Exclude<MobileNodeTerminal, "ok"> = "policy_blocked"): void {
    this.#terminalize(agentId, requestId, status, this.#now());
  }

  result(deviceId: string, frame: MobileNodeResultFrame): void {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.deviceId !== deviceId) return;
    if (frame.status === "ok") {
      if (pending.command === "device.status" && "foreground" in frame.result && frame.result.foreground === true)
        this.#finish(frame.requestId, "ok", false, frame.result);
      else if (pending.command === "location.current" && isLocation(frame.result))
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
      if (pending.deviceId === deviceId) this.#finish(requestId, "device_unavailable");
    }
  }

  disconnectAgent(agentId: string): void {
    for (const [requestId, pending] of this.#pending) {
      if (pending.agentId === agentId) this.#finish(requestId, "cancelled", true);
    }
  }

  close(): void {
    for (const requestId of this.#pending.keys()) this.#finish(requestId, "device_unavailable");
  }

  #finish(requestId: string, status: MobileNodeTerminal, notifyDevice = false, result?: { foreground: true } | { latitude: number; longitude: number }): void {
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
        : { requestId, status, result: result as { foreground: true } });
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

import type { MobileNodeCancelFrame, MobileNodeRequestFrame, MobileNodeResultFrame } from "cozygateway-contract";

export type MobileNodeTerminal =
  | "ok" | "denied" | "expired" | "cancelled" | "device_unavailable"
  | "foreground_required" | "policy_blocked";
export type MobileNodeResult =
  | { requestId: string; status: "ok"; result: { foreground: true } }
  | { requestId: string; status: Exclude<MobileNodeTerminal, "ok"> };

interface Pending {
  deviceId: string;
  agentId: string;
  turnId: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface MobileNodeInvocation {
  requestId: string;
  command: "device.status";
  bot: string;
  threadId: string;
  turnId: string;
  expiresAt: number;
  deviceId?: string;
  agentId: string;
}

const TERMINAL_TTL_MS = 30_000;
const TERMINAL_LIMIT = 1_024;

/** One foreground-only, origin-bound request at a time. Nothing here is durable. */
export class MobileNodeBroker {
  readonly #pending = new Map<string, Pending>();
  /** Recently terminal request ids are a bounded, volatile idempotency cache. */
  readonly #terminal = new Map<string, number>();
  readonly #available: (deviceId: string) => boolean;
  readonly #send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean;
  readonly #result: (agentId: string, frame: MobileNodeResult) => void;
  readonly #now: () => number;
  readonly #terminalTtlMs: number;
  readonly #terminalLimit: number;

  constructor(deps: {
    available: (deviceId: string) => boolean;
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
      this.#result(input.agentId, { requestId: input.requestId, status: "device_unavailable" });
      return;
    }
    if (input.command !== "device.status" || input.expiresAt <= this.#now() || input.expiresAt > this.#now() + 30_000) {
      this.#result(input.agentId, { requestId: input.requestId, status: "policy_blocked" });
      return;
    }
    if (!this.#available(input.deviceId)) {
      this.#result(input.agentId, { requestId: input.requestId, status: "foreground_required" });
      return;
    }
    const frame: MobileNodeRequestFrame = {
      type: "mobile_node_request", requestId: input.requestId, command: "device.status",
      bot: input.bot, threadId: input.threadId, turnId: input.turnId, expiresAt: input.expiresAt,
    };
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#pending.set(input.requestId, { deviceId: input.deviceId, agentId: input.agentId, turnId: input.turnId, expiresAt: input.expiresAt, timer });
    if (!this.#send(input.deviceId, frame)) this.#finish(input.requestId, "device_unavailable");
  }

  reject(agentId: string, requestId: string, status: Exclude<MobileNodeTerminal, "ok"> = "policy_blocked"): void {
    this.#result(agentId, { requestId, status });
  }

  result(deviceId: string, frame: MobileNodeResultFrame): void {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.deviceId !== deviceId) return;
    if (frame.status === "ok" && frame.result.foreground !== true) return;
    this.#finish(frame.requestId, frame.status, false, frame.status === "ok" ? frame.result : undefined);
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

  #finish(requestId: string, status: MobileNodeTerminal, notifyDevice = false, result?: { foreground: true }): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    this.#rememberTerminal(requestId, Math.max(pending.expiresAt, this.#now() + this.#terminalTtlMs));
    if (notifyDevice && (status === "cancelled" || status === "expired")) {
      this.#send(pending.deviceId, { type: "mobile_node_cancel", requestId, status });
    }
    if (status === "ok" && result !== undefined)
      this.#result(pending.agentId, { requestId, status, result });
    else this.#result(pending.agentId, { requestId, status: status === "ok" ? "device_unavailable" : status });
  }

  #rememberTerminal(requestId: string, until: number): void {
    this.#pruneTerminal();
    this.#terminal.set(requestId, until);
    while (this.#terminal.size > this.#terminalLimit) {
      const oldest = this.#terminal.keys().next().value;
      if (oldest === undefined) return;
      this.#terminal.delete(oldest);
    }
  }

  #pruneTerminal(): void {
    const now = this.#now();
    for (const [requestId, until] of this.#terminal) {
      if (until <= now) this.#terminal.delete(requestId);
    }
  }
}

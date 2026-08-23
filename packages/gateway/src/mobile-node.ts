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
  timer: ReturnType<typeof setTimeout>;
}

/** One foreground-only, origin-bound request at a time. Nothing here is durable. */
export class MobileNodeBroker {
  readonly #pending = new Map<string, Pending>();
  readonly #available: (deviceId: string) => boolean;
  readonly #send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean;
  readonly #result: (agentId: string, frame: MobileNodeResult) => void;
  readonly #now: () => number;

  constructor(deps: {
    available: (deviceId: string) => boolean;
    send: (deviceId: string, frame: MobileNodeRequestFrame | MobileNodeCancelFrame) => boolean;
    result: (agentId: string, frame: MobileNodeResult) => void;
    now?: () => number;
  }) {
    this.#available = deps.available;
    this.#send = deps.send;
    this.#result = deps.result;
    this.#now = deps.now ?? Date.now;
  }

  invoke(input: Omit<MobileNodeRequestFrame, "type"> & { deviceId?: string; agentId: string }): void {
    // `requestId` is a one-shot idempotency key. Never replace a live timer/prompt.
    if (this.#pending.has(input.requestId)) return;
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
    const { agentId, deviceId, ...request } = input;
    const frame: MobileNodeRequestFrame = { type: "mobile_node_request", ...request };
    const timer = setTimeout(() => this.#finish(input.requestId, "expired", true), input.expiresAt - this.#now());
    timer.unref();
    this.#pending.set(input.requestId, { deviceId, agentId, turnId: input.turnId, timer });
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
    if (notifyDevice && (status === "cancelled" || status === "expired")) {
      this.#send(pending.deviceId, { type: "mobile_node_cancel", requestId, status });
    }
    if (status === "ok" && result !== undefined)
      this.#result(pending.agentId, { requestId, status, result });
    else this.#result(pending.agentId, { requestId, status: status === "ok" ? "device_unavailable" : status });
  }
}

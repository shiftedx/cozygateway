import { randomUUID } from "node:crypto";

import { BotMemoryKindSchema } from "cozygateway-contract";
import type {
  BotMemoryDeleteResponse,
  BotMemoryGraphResponse,
  BotMemoryItem,
  BotMemoryItemsResponse,
  BotMemoryKind,
  BotMemoryOverviewResponse,
  BotMemoryWriteResponse,
} from "cozygateway-contract";

import { BackendUnavailable } from "../errors.ts";
import { createPhotoRateLimiter, type PhotoRateLimiter } from "./photos.ts";
import type { AttachV1MemoryRequest, AttachV1MemoryResult } from "../adapters/attach/protocol-v1.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";

export type MemoryOperation = AttachV1MemoryRequest["operation"];
export type MemoryInput = AttachV1MemoryRequest["input"];
export type MemoryResult = BotMemoryOverviewResponse | BotMemoryItemsResponse | BotMemoryGraphResponse | BotMemoryItem | BotMemoryWriteResponse | BotMemoryDeleteResponse;

/** The kind filter's allow-list, read off the contract union rather than restated,
 *  so a kind added to the wire cannot be rejected here by an out-of-date copy. */
export const MEMORY_KINDS: readonly BotMemoryKind[] = BotMemoryKindSchema.anyOf.map((member) => member.const as BotMemoryKind);

/** Per-device budget for the memory lane. Each request costs the attached plugin a
 *  filesystem or provider scan it serves one at a time, so a browsing client gets a
 *  generous burst and a fast refill while a loop gets stopped at the gateway rather
 *  than at the profile. The bucket is the photo lane's, with memory's own numbers. */
export const MEMORY_RATE_CAPACITY = 30;
export const MEMORY_RATE_REFILL_MS = 1_000;
export type MemoryRateLimiter = PhotoRateLimiter;
export function createMemoryRateLimiter(opts: { capacity?: number; refillMs?: number } = {}): MemoryRateLimiter {
  return createPhotoRateLimiter({ capacity: opts.capacity ?? MEMORY_RATE_CAPACITY, refillMs: opts.refillMs ?? MEMORY_RATE_REFILL_MS });
}

export class MemoryConflict extends Error {
  readonly current: BotMemoryItem | undefined;
  constructor(current?: BotMemoryItem, message = "memory item changed; refresh and try again") { super(message); this.current = current; }
}
export class MemoryNotFound extends Error {}
export class MemoryInvalidRequest extends Error {}

export interface MemorySurface {
  overview(name: string): Promise<BotMemoryOverviewResponse>;
  items(name: string, input: MemoryInput): Promise<BotMemoryItemsResponse>;
  item(name: string, sourceId: string, itemId: string): Promise<BotMemoryItem>;
  create(name: string, sourceId: string, input: MemoryInput): Promise<BotMemoryWriteResponse>;
  update(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryWriteResponse>;
  remove(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryDeleteResponse>;
  graph(name: string, input: MemoryInput): Promise<BotMemoryGraphResponse>;
  audit(actorId: string, name: string, action: "create" | "update" | "delete", sourceId: string, itemId: string): void;
}

interface Pending { agentId: string; resolve: (value: MemoryResult) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; }

/** Correlates the bounded live attach-v1 management lane. It retains only a
 * waiter, never memory content. Disconnected plugins fail immediately so a
 * timed-out mutation cannot execute later after reconnect. */
export class AttachMemorySurface implements MemorySurface {
  readonly #pending = new Map<string, Pending>();
  readonly #endpoint: { sendMemoryRequest(agentId: string, input: AttachV1MemoryRequest): boolean };
  readonly #timeoutMs: number;
  readonly #trace: TraceLog | undefined;
  constructor(endpoint: { sendMemoryRequest(agentId: string, input: AttachV1MemoryRequest): boolean }, timeoutMs = 12_000, trace?: TraceLog) { this.#endpoint = endpoint; this.#timeoutMs = timeoutMs; this.#trace = trace; }

  #request(agentId: string, operation: MemoryOperation, input: MemoryInput): Promise<MemoryResult> {
    const requestId = randomUUID();
    return new Promise<MemoryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new BackendUnavailable("memory management reply timed out"));
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { agentId, resolve, reject, timer });
      if (!this.#endpoint.sendMemoryRequest(agentId, { kind: "memory_request", requestId, operation, input })) {
        clearTimeout(timer); this.#pending.delete(requestId);
        reject(new BackendUnavailable("memory management is unavailable for this bot"));
      }
    });
  }
  async overview(name: string): Promise<BotMemoryOverviewResponse> { return await this.#request(name, "overview", {}) as BotMemoryOverviewResponse; }
  async items(name: string, input: MemoryInput): Promise<BotMemoryItemsResponse> { return await this.#request(name, "items", input) as BotMemoryItemsResponse; }
  async item(name: string, sourceId: string, itemId: string): Promise<BotMemoryItem> { return await this.#request(name, "item", { sourceId, itemId }) as BotMemoryItem; }
  async create(name: string, sourceId: string, input: MemoryInput): Promise<BotMemoryWriteResponse> { return await this.#request(name, "create", { ...input, sourceId }) as BotMemoryWriteResponse; }
  async update(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryWriteResponse> { return await this.#request(name, "update", { ...input, sourceId, itemId }) as BotMemoryWriteResponse; }
  async remove(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryDeleteResponse> { return await this.#request(name, "delete", { ...input, sourceId, itemId }) as BotMemoryDeleteResponse; }
  async graph(name: string, input: MemoryInput): Promise<BotMemoryGraphResponse> { return await this.#request(name, "graph", input) as BotMemoryGraphResponse; }
  audit(actorId: string, name: string, action: "create" | "update" | "delete", sourceId: string, itemId: string): void {
    emitTrace(this.#trace, "bot_memory_mutation", {
      actor: traceId(actorId), profile: traceId(name), source: traceId(sourceId), item: traceId(itemId), action, at: Date.now(),
    });
  }

  handle(agentId: string, frame: AttachV1MemoryResult): boolean {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.agentId !== agentId) return false;
    this.#pending.delete(frame.requestId); clearTimeout(pending.timer);
    if (frame.status === "ok" && frame.result !== undefined) pending.resolve(frame.result as MemoryResult);
    else if (frame.status === "conflict") pending.reject(new MemoryConflict(frame.current, frame.message));
    else if (frame.status === "not_found") pending.reject(new MemoryNotFound(frame.message));
    else if (frame.status === "invalid_request") pending.reject(new MemoryInvalidRequest(frame.message));
    else pending.reject(new BackendUnavailable(frame.message ?? "memory source is unavailable"));
    return true;
  }
  close(): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BackendUnavailable("gateway is shutting down")); } this.#pending.clear(); }
}

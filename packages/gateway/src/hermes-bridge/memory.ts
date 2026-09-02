import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
  BotMemoryDeleteResponseSchema,
  BotMemoryGraphResponseSchema,
  BotMemoryItemSchema,
  BotMemoryItemsResponseSchema,
  BotMemoryKindSchema,
  BotMemoryOverviewResponseSchema,
  BotMemoryWriteResponseSchema,
} from "cozygateway-contract";
import type {
  BotMemoryDeleteResponse,
  BotMemoryGraphResponse,
  BotMemoryItem,
  BotMemoryItemsResponse,
  BotMemoryKind,
  BotMemoryOverviewResponse,
  BotMemorySetupRequest,
  BotMemoryWriteResponse,
} from "cozygateway-contract";

import { BackendUnavailable } from "../errors.ts";
import { createPhotoRateLimiter, type PhotoRateLimiter } from "./photos.ts";
import type { MemorySendOutcome } from "../adapters/attach/ingress-v1.ts";
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

/** What the memory lane needs from the attach ingress. `negotiatedCapabilities` is optional
 *  because the unit seams in the test suite model only sending; production always has it, and its
 *  absence is read as "no observation", never as "not negotiated". */
export interface MemoryEndpoint {
  sendMemoryRequest(agentId: string, input: AttachV1MemoryRequest): MemorySendOutcome;
  negotiatedCapabilities?(agentId: string): ReadonlySet<string>;
}

export interface MemorySurface {
  overview(name: string): Promise<BotMemoryOverviewResponse>;
  setup(name: string, input: BotMemorySetupRequest): Promise<BotMemoryOverviewResponse>;
  items(name: string, input: MemoryInput): Promise<BotMemoryItemsResponse>;
  item(name: string, sourceId: string, itemId: string): Promise<BotMemoryItem>;
  create(name: string, sourceId: string, input: MemoryInput): Promise<BotMemoryWriteResponse>;
  update(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryWriteResponse>;
  remove(name: string, sourceId: string, itemId: string, input: MemoryInput): Promise<BotMemoryDeleteResponse>;
  graph(name: string, input: MemoryInput): Promise<BotMemoryGraphResponse>;
  audit(actorId: string, name: string, action: "create" | "update" | "delete", sourceId: string, itemId: string): void;
  auditSetup(actorId: string, name: string, input: BotMemorySetupRequest): void;
}

interface Pending { agentId: string; operation: MemoryOperation; resolve: (value: MemoryResult) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout>; }

function validResult(operation: MemoryOperation, result: unknown): result is MemoryResult {
  switch (operation) {
    case "overview": case "setup": return Value.Check(BotMemoryOverviewResponseSchema, result);
    case "items": return Value.Check(BotMemoryItemsResponseSchema, result);
    case "graph": return Value.Check(BotMemoryGraphResponseSchema, result);
    case "item": return Value.Check(BotMemoryItemSchema, result);
    case "create": case "update": return Value.Check(BotMemoryWriteResponseSchema, result);
    case "delete": return Value.Check(BotMemoryDeleteResponseSchema, result);
  }
}

/** The operator-facing reading of each refusal. A plugin that connected but negotiated an older
 *  hello reads identically to an offline one from the phone, so the message has to separate them:
 *  one needs the bot brought online, the other needs its plugin restarted. */
const MEMORY_UNAVAILABLE: Record<Exclude<MemorySendOutcome, "sent">, string> = {
  unknown_bot: "this bot has no attach profile on this gateway",
  not_attached: "this bot's plugin is not attached right now",
  capability_not_negotiated: "this bot's attached plugin negotiated without memory_management; restart the Hermes profile so it picks up the current plugin",
};

/** Correlates the bounded live attach-v1 management lane. It retains only a
 * waiter, never memory content. Disconnected plugins fail immediately so a
 * timed-out mutation cannot execute later after reconnect. */
export class AttachMemorySurface implements MemorySurface {
  readonly #pending = new Map<string, Pending>();
  readonly #endpoint: MemoryEndpoint;
  readonly #timeoutMs: number;
  readonly #trace: TraceLog | undefined;
  constructor(endpoint: MemoryEndpoint, timeoutMs = 12_000, trace?: TraceLog) { this.#endpoint = endpoint; this.#timeoutMs = timeoutMs; this.#trace = trace; }

  /** Whether capability-42 setup is OFFERED for this bot, which is a fact about the attached peer's
   *  hello and not about the memory it just answered with. A client that only ever reads
   *  `sources` cannot tell a bot whose plugin serves the setup lane from one whose plugin does not,
   *  and inferring it from an empty source list is wrong in both directions: a runtime bot that
   *  already has a source still has switches to offer, and an old plugin with no sources has none.
   *
   *  `undefined` when this deployment exposes no capability observation at all (the unit seams do
   *  not), so the field is omitted rather than answered `false` on no evidence. */
  #setupAvailable(agentId: string): boolean | undefined {
    const capabilitiesFor = this.#endpoint.negotiatedCapabilities;
    if (typeof capabilitiesFor !== "function") return undefined;
    return capabilitiesFor.call(this.#endpoint, agentId).has("memory_setup");
  }

  /** Stamps the gateway's own `setupAvailable` onto a projection the peer produced. The peer's
   *  reply is validated before this runs and is never overwritten anywhere else. */
  #withSetup<T extends BotMemoryOverviewResponse | BotMemoryItemsResponse>(agentId: string, result: T): T {
    const available = this.#setupAvailable(agentId);
    return available === undefined ? result : { ...result, setupAvailable: available };
  }

  #request(agentId: string, operation: MemoryOperation, input: MemoryInput): Promise<MemoryResult> {
    const requestId = randomUUID();
    return new Promise<MemoryResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new BackendUnavailable("memory management reply timed out"));
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { agentId, operation, resolve, reject, timer });
      // Public methods below keep operation and input paired; this assertion bridges that
      // correlation across the internal union-valued helper parameters.
      const request = { kind: "memory_request", requestId, operation, input } as AttachV1MemoryRequest;
      const outcome = this.#endpoint.sendMemoryRequest(agentId, request);
      if (outcome !== "sent") {
        clearTimeout(timer); this.#pending.delete(requestId);
        emitTrace(this.#trace, "bot_memory_unavailable", { profile: traceId(agentId), operation, reason: outcome });
        const detail = outcome === "capability_not_negotiated" && operation === "setup"
          ? "this bot's attached plugin negotiated without memory_setup; restart the Hermes profile so it picks up the current plugin"
          : MEMORY_UNAVAILABLE[outcome];
        reject(new BackendUnavailable(`memory management is unavailable for this bot: ${detail}`));
      }
    });
  }
  async overview(name: string): Promise<BotMemoryOverviewResponse> { return this.#withSetup(name, await this.#request(name, "overview", {}) as BotMemoryOverviewResponse); }
  async setup(name: string, input: BotMemorySetupRequest): Promise<BotMemoryOverviewResponse> { return this.#withSetup(name, await this.#request(name, "setup", input) as BotMemoryOverviewResponse); }
  async items(name: string, input: MemoryInput): Promise<BotMemoryItemsResponse> { return this.#withSetup(name, await this.#request(name, "items", input) as BotMemoryItemsResponse); }
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
  auditSetup(actorId: string, name: string, input: BotMemorySetupRequest): void {
    emitTrace(this.#trace, "bot_memory_setup", {
      actor: traceId(actorId), profile: traceId(name), action: "setup", ...input, at: Date.now(),
    });
  }

  handle(agentId: string, frame: AttachV1MemoryResult): boolean {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.agentId !== agentId) return false;
    this.#pending.delete(frame.requestId); clearTimeout(pending.timer);
    if (frame.status === "ok" && validResult(pending.operation, frame.result)) pending.resolve(frame.result);
    else if (frame.status === "ok") pending.reject(new BackendUnavailable("memory management returned an invalid reply"));
    else if (frame.status === "conflict") pending.reject(new MemoryConflict(frame.current, frame.message));
    else if (frame.status === "not_found") pending.reject(new MemoryNotFound(frame.message));
    else if (frame.status === "invalid_request") pending.reject(new MemoryInvalidRequest(frame.message));
    else pending.reject(new BackendUnavailable(frame.message ?? "memory source is unavailable"));
    return true;
  }
  close(): void { for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BackendUnavailable("gateway is shutting down")); } this.#pending.clear(); }
}

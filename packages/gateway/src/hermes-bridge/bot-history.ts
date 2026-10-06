import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
  BotHistoryDiffResponseSchema,
  BotHistoryListResponseSchema,
  BotHistoryResolveResponseSchema,
  BotHistoryRestoreResponseSchema,
  BotHistoryTryDiscardResponseSchema,
  BotHistoryTryKeepResponseSchema,
  BotHistoryTryStartResponseSchema,
} from "cozygateway-contract";
import type {
  BotHistoryConflictFile,
  BotHistoryDiffResponse,
  BotHistoryListQuery,
  BotHistoryListResponse,
  BotHistoryResolveChoice,
  BotHistoryResolveResponse,
  BotHistoryRestoreResponse,
  BotHistoryTryDiscardResponse,
  BotHistoryTryKeepResponse,
  BotHistoryTryStartResponse,
} from "cozygateway-contract";

import { BackendUnavailable } from "../errors.ts";
import { createPhotoRateLimiter, type PhotoRateLimiter } from "./photos.ts";
import type { AttachV1HistoryRequest, AttachV1HistoryResult } from "../adapters/attach/protocol-v1.ts";
import type { HistorySendOutcome } from "../adapters/attach/ingress-v1.ts";
import { BotNotFound } from "./crud.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";

export type HistoryOperation = AttachV1HistoryRequest["operation"];
type HistoryInput = AttachV1HistoryRequest["input"];
type HistoryResult = NonNullable<AttachV1HistoryResult["result"]>;

/** Per-bot budget for the history lane, the config lane's bucket with history's own numbers. A
 *  history read costs the peer a `git log` or a `git diff --numstat` it serves one at a time, so a
 *  Changes pane scrolling gets a generous burst while a loop is stopped here rather than at the
 *  peer. The key is the BOT for the same reason the config lane's is: the thing being protected is
 *  the ONE peer serving it, and a per-device bucket would let N devices spend N times what that
 *  peer can absorb. The same trade applies, and it is worth restating: two people looking at one
 *  bot's history share the bucket. */
export const HISTORY_RATE_CAPACITY = 30;
export const HISTORY_RATE_REFILL_MS = 1_000;
export type HistoryRateLimiter = PhotoRateLimiter;
export function createHistoryRateLimiter(opts: { capacity?: number; refillMs?: number } = {}): HistoryRateLimiter {
  return createPhotoRateLimiter({ capacity: opts.capacity ?? HISTORY_RATE_CAPACITY, refillMs: opts.refillMs ?? HISTORY_RATE_REFILL_MS });
}

/** The peer is attached but never offered `bot_history`, which is a different fact from "offline".
 *  The caller turns it into the same `409 unsupported_for_runtime` a Hermes bot receives on these
 *  routes, because a runtime bot with no checkpointed workspace genuinely has no history section
 *  rather than a temporarily unreachable one, and a `503` there would offer a retry that can never
 *  succeed. */
export class HistoryNotNegotiated extends Error {
  readonly bot: string;
  constructor(bot: string) {
    super(`bot "${bot}" is attached but its peer did not negotiate bot_history`);
    this.name = "HistoryNotNegotiated";
    this.bot = bot;
  }
}

/** A checkpoint id that names nothing in this bot's history, or a `try.keep`/`try.discard` with no
 *  experiment in flight. It extends `BotNotFound` because that is the class every bots route
 *  already answers `404 not_found` on, and the message is rewritten so the answer says what is
 *  missing rather than claiming the bot is: the bot is on the roster and its chat lane works. */
export class HistoryNotFound extends BotNotFound {
  constructor(bot: string, what: string) {
    super(bot);
    this.name = "HistoryNotFound";
    this.message = `bot "${bot}" has no ${what}`;
  }
}

/** A history request the peer refused because of what it carried: a malformed checkpoint id, a
 *  resolve naming a path the peer never reported as conflicted. Reported with the peer's own
 *  words, because the peer is the only side that knows which rule was broken. */
export class HistoryInvalidRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryInvalidRequest";
  }
}

/** Keeping an experiment after the working version moved: the ONE case section 4.4 designs for.
 *  Nothing broke, nothing is lost, and a PERSON has to choose per file, so this is neither a
 *  failure nor a success and carries the question rather than a diagnosis. The choices ride along
 *  because they ARE the answer the route has to put on screen; the caller sends them back through
 *  `resolve`. */
export class HistoryConflict extends Error {
  readonly conflicts: readonly BotHistoryConflictFile[];
  constructor(message: string, conflicts: readonly BotHistoryConflictFile[]) {
    super(message);
    this.name = "HistoryConflict";
    this.conflicts = conflicts;
  }
}

/** The seven history operations, named as the surface methods the routes call rather than as wire
 *  strings, so the routes never restate the lane's vocabulary. */
export interface HistorySurface {
  list(name: string, query: BotHistoryListQuery): Promise<BotHistoryListResponse>;
  diff(name: string, from: string, to?: string): Promise<BotHistoryDiffResponse>;
  restore(name: string, checkpoint: string): Promise<BotHistoryRestoreResponse>;
  tryStart(name: string, label: string): Promise<BotHistoryTryStartResponse>;
  tryKeep(name: string): Promise<BotHistoryTryKeepResponse>;
  tryDiscard(name: string): Promise<BotHistoryTryDiscardResponse>;
  resolve(name: string, choices: readonly BotHistoryResolveChoice[]): Promise<BotHistoryResolveResponse>;
}

interface Pending {
  agentId: string;
  operation: HistoryOperation;
  resolve: (value: HistoryResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The reply shape each operation must produce. A peer that answers `ok` with the wrong body is
 *  refused rather than cast, because casting is how a Changes list ends up rendering a file list. */
function validResult(operation: HistoryOperation, result: unknown): result is HistoryResult {
  switch (operation) {
    case "list": return Value.Check(BotHistoryListResponseSchema, result);
    case "diff": return Value.Check(BotHistoryDiffResponseSchema, result);
    case "restore": return Value.Check(BotHistoryRestoreResponseSchema, result);
    case "try.start": return Value.Check(BotHistoryTryStartResponseSchema, result);
    case "try.keep": return Value.Check(BotHistoryTryKeepResponseSchema, result);
    case "try.discard": return Value.Check(BotHistoryTryDiscardResponseSchema, result);
    case "resolve": return Value.Check(BotHistoryResolveResponseSchema, result);
  }
}

/** The operator-facing reading of each refusal, kept apart for the same reason the config lane
 *  keeps them apart: an unconfigured bot, an offline peer, and an attached peer that speaks an
 *  older hello need three different fixes. */
const HISTORY_UNAVAILABLE: Record<Exclude<HistorySendOutcome, "sent" | "capability_not_negotiated">, string> = {
  unknown_bot: "this bot has no attach profile on this gateway",
  not_attached: "this bot's peer is not attached right now",
};

/** What a `not_found` on each operation means is missing, in the words the person reading it
 *  needs. `list` is absent on purpose: an empty history is an empty list, not an absence, and
 *  answering `404` for a bot that has simply not changed anything yet would hide the whole
 *  surface. */
const MISSING: Partial<Record<HistoryOperation, string>> = {
  diff: "such checkpoint to compare",
  restore: "such checkpoint to go back to",
  "try.keep": "experiment in progress to keep",
  "try.discard": "experiment in progress to throw away",
  resolve: "experiment waiting on a choice",
};

export interface AttachHistorySurfaceOptions {
  rateLimiter?: HistoryRateLimiter;
  now?: () => number;
}

/** Correlates the bounded live attach-v1 bot-history lane. A clone of `AttachConfigSurface`: it
 *  retains only a waiter, never a checkpoint, never a diff, and a disconnected peer fails
 *  immediately so a timed-out restore cannot execute later after reconnect. That last rule matters
 *  more here than it did for config: a restore that lands minutes after the person gave up on it
 *  would silently throw away everything they did in between. */
export class AttachHistorySurface implements HistorySurface {
  readonly #pending = new Map<string, Pending>();
  readonly #endpoint: { sendHistoryRequest(agentId: string, input: AttachV1HistoryRequest): HistorySendOutcome };
  readonly #timeoutMs: number;
  readonly #trace: TraceLog | undefined;
  readonly #rate: HistoryRateLimiter;
  readonly #now: () => number;

  constructor(
    endpoint: { sendHistoryRequest(agentId: string, input: AttachV1HistoryRequest): HistorySendOutcome },
    timeoutMs = 12_000,
    trace?: TraceLog,
    opts: AttachHistorySurfaceOptions = {},
  ) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
    this.#trace = trace;
    this.#rate = opts.rateLimiter ?? createHistoryRateLimiter();
    this.#now = opts.now ?? Date.now;
  }

  #request(agentId: string, operation: HistoryOperation, input: HistoryInput): Promise<HistoryResult> {
    const requestId = randomUUID();
    return new Promise<HistoryResult>((resolve, reject) => {
      const spend = this.#rate.take(agentId, this.#now());
      if (!spend.ok) {
        emitTrace(this.#trace, "bot_history_rate_limited", { profile: traceId(agentId), operation, retryAfterMs: spend.retryAfterMs });
        reject(new BackendUnavailable(`too many bot history requests for this bot; retry in ${spend.retryAfterMs}ms`));
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new BackendUnavailable("bot history reply timed out"));
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { agentId, operation, resolve, reject, timer });
      // The public methods below keep operation and input paired; this assertion bridges that
      // correlation across the internal union-valued helper parameters.
      const request = { kind: "history_request", requestId, operation, input } as AttachV1HistoryRequest;
      const outcome = this.#endpoint.sendHistoryRequest(agentId, request);
      if (outcome === "sent") return;
      clearTimeout(timer);
      this.#pending.delete(requestId);
      emitTrace(this.#trace, "bot_history_unavailable", { profile: traceId(agentId), operation, reason: outcome });
      reject(
        outcome === "capability_not_negotiated"
          ? new HistoryNotNegotiated(agentId)
          : new BackendUnavailable(`bot history is unavailable for this bot: ${HISTORY_UNAVAILABLE[outcome]}`),
      );
    });
  }

  async list(name: string, query: BotHistoryListQuery): Promise<BotHistoryListResponse> {
    return await this.#request(name, "list", query) as BotHistoryListResponse;
  }
  async diff(name: string, from: string, to?: string): Promise<BotHistoryDiffResponse> {
    // `to` is omitted rather than sent as undefined: the frame schema is closed, and an explicit
    // `to: undefined` serializes to a key the peer's validator rejects.
    return await this.#request(name, "diff", { from, ...(to === undefined ? {} : { to }) }) as BotHistoryDiffResponse;
  }
  async restore(name: string, checkpoint: string): Promise<BotHistoryRestoreResponse> {
    return await this.#request(name, "restore", { checkpoint }) as BotHistoryRestoreResponse;
  }
  async tryStart(name: string, label: string): Promise<BotHistoryTryStartResponse> {
    return await this.#request(name, "try.start", { label }) as BotHistoryTryStartResponse;
  }
  async tryKeep(name: string): Promise<BotHistoryTryKeepResponse> {
    return await this.#request(name, "try.keep", {}) as BotHistoryTryKeepResponse;
  }
  async tryDiscard(name: string): Promise<BotHistoryTryDiscardResponse> {
    return await this.#request(name, "try.discard", {}) as BotHistoryTryDiscardResponse;
  }
  async resolve(name: string, choices: readonly BotHistoryResolveChoice[]): Promise<BotHistoryResolveResponse> {
    return await this.#request(name, "resolve", { choices: [...choices] }) as BotHistoryResolveResponse;
  }

  handle(agentId: string, frame: AttachV1HistoryResult): boolean {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.agentId !== agentId) return false;
    this.#pending.delete(frame.requestId);
    clearTimeout(pending.timer);
    if (frame.status === "ok" && validResult(pending.operation, frame.result)) pending.resolve(frame.result);
    else if (frame.status === "ok") pending.reject(new BackendUnavailable("bot history returned an invalid reply"));
    else pending.reject(refusal(pending, frame));
    return true;
  }

  close(): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new BackendUnavailable("gateway is shutting down"));
    }
    this.#pending.clear();
  }
}

/** A non-`ok` status, turned into the error the history routes answer. `conflict` is checked first
 *  and separately: it is the only status that carries a body, and that body is the question the
 *  person is about to be asked rather than a description of a failure. A `conflict` whose body
 *  does not actually list the files is refused, because a per-file choice with no files is a
 *  dialog with no buttons. */
function refusal(pending: Pick<Pending, "agentId" | "operation">, frame: AttachV1HistoryResult): Error {
  const message = frame.message ?? "the bot's peer refused the history request";
  if (frame.status === "conflict") {
    if (!Value.Check(BotHistoryTryKeepResponseSchema, frame.result) || frame.result.conflicts === undefined)
      return new BackendUnavailable("bot history reported a conflict without saying which files");
    return new HistoryConflict(
      frame.message ?? "the working version changed while this was being tried",
      frame.result.conflicts,
    );
  }
  if (frame.status === "not_found") {
    const what = MISSING[pending.operation];
    if (what !== undefined) return new HistoryNotFound(pending.agentId, what);
  }
  if (frame.status === "invalid_request") return new HistoryInvalidRequest(message);
  return new BackendUnavailable(`bot history is unavailable for this bot: ${message}`);
}

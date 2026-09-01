import { randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";
import {
  BotModelConfigSchema,
  BotProfileConfigureResponseSchema,
  BotProfileSchema,
  BotRoutineListResponseSchema,
  BotRoutineWriteResponseSchema,
} from "cozygateway-contract";
import type {
  BotModelConfig,
  BotModelConfigPatch,
  BotProfile,
  BotProfileConfigureResponse,
  BotProfilePatch,
  BotRoutineCreateRequest,
  BotRoutineListResponse,
  BotRoutinePatch,
  BotRoutineWriteResponse,
} from "cozygateway-contract";

import { BackendUnavailable } from "../errors.ts";
import { createPhotoRateLimiter, type PhotoRateLimiter } from "./photos.ts";
import { AttachV1ConfigAckSchema } from "../adapters/attach/protocol-v1.ts";
import type { AttachV1ConfigRequest, AttachV1ConfigResult } from "../adapters/attach/protocol-v1.ts";
import type { ConfigSendOutcome } from "../adapters/attach/ingress-v1.ts";
import type { BotRoutineList } from "./bridge.ts";
import type { ProfileConfigureResult } from "./profile.ts";
import { ModelConfigInvalid } from "./model-config.ts";
import { RoutineNotFound, type RoutineWriteResult } from "./routines.ts";
import { emitTrace, traceId, type TraceLog } from "../trace.ts";

export type ConfigOperation = AttachV1ConfigRequest["operation"];
type ConfigInput = AttachV1ConfigRequest["input"];
type ConfigResult = NonNullable<AttachV1ConfigResult["result"]>;

/** Per-bot budget for the config lane. A config read costs the peer a file read or a scheduler
 *  scan it serves one at a time, so an editor gets a generous burst and a fast refill while a loop
 *  is stopped here rather than at the peer. Same bucket as the photo and memory lanes, with the
 *  config lane's own numbers: the key is the BOT, because this lane has no device id. */
export const CONFIG_RATE_CAPACITY = 30;
export const CONFIG_RATE_REFILL_MS = 1_000;
export type ConfigRateLimiter = PhotoRateLimiter;
export function createConfigRateLimiter(opts: { capacity?: number; refillMs?: number } = {}): ConfigRateLimiter {
  return createPhotoRateLimiter({ capacity: opts.capacity ?? CONFIG_RATE_CAPACITY, refillMs: opts.refillMs ?? CONFIG_RATE_REFILL_MS });
}

/** The peer is attached but never offered `bot_config`, which is a different fact from "offline"
 *  and gets a different answer: the caller turns this into the same `409 unsupported_for_runtime`
 *  a bot with no config lane at all receives, because the section really is absent rather than
 *  temporarily unreachable. */
export class ConfigNotNegotiated extends Error {
  readonly bot: string;
  constructor(bot: string) {
    super(`bot "${bot}" is attached but its peer did not negotiate bot_config`);
    this.name = "ConfigNotNegotiated";
    this.bot = bot;
  }
}

/** A config request the peer refused because of what it carried, reported with the peer's own
 *  words. It extends `ModelConfigInvalid` because that is the class every bots route already
 *  answers `400 invalid_request` and this lane adds no route change; the subclass keeps its own
 *  name so a log line still says which lane refused. The alternative was reusing
 *  `RoutineRefused`, whose route text reads "hermes refused the cron add" -- a sentence about a
 *  backend that is not involved, in front of a user editing a runtime bot's profile. */
export class ConfigInvalidRequest extends ModelConfigInvalid {
  constructor(message: string) {
    super(message);
    this.name = "ConfigInvalidRequest";
  }
}

/** The nine config operations, named as the surface methods they answer for rather than as wire
 *  strings, so the native data plane routes to them without restating the lane's vocabulary. */
export interface ConfigSurface {
  botProfile(name: string): Promise<BotProfile>;
  configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult>;
  modelConfig(name: string): Promise<BotModelConfig>;
  configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig>;
  routines(name: string): Promise<BotRoutineList>;
  createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult>;
  patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult>;
  deleteRoutine(name: string, id: string): Promise<void>;
  /** Trigger one run now. It has no REST route in this version; the lane carries it so a peer
   *  implements the whole set once rather than growing a second wire change later. */
  runRoutine(name: string, id: string): Promise<void>;
}

interface Pending {
  agentId: string;
  operation: ConfigOperation;
  /** The routine this request acts on, so a `not_found` names the routine and not the bot. */
  routineId: string | undefined;
  resolve: (value: ConfigResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The reply shape each operation must produce. A peer that answers `ok` with the wrong body is
 *  refused rather than cast, because casting is how a routines pane ends up rendering a profile. */
function validResult(operation: ConfigOperation, result: unknown): result is ConfigResult {
  switch (operation) {
    case "profile.read": return Value.Check(BotProfileSchema, result);
    case "profile.write": return Value.Check(BotProfileConfigureResponseSchema, result);
    case "model.read": case "model.write": return Value.Check(BotModelConfigSchema, result);
    case "routines.list": return Value.Check(BotRoutineListResponseSchema, result);
    case "routines.create": case "routines.update": return Value.Check(BotRoutineWriteResponseSchema, result);
    case "routines.delete": case "routines.run": return Value.Check(AttachV1ConfigAckSchema, result);
  }
}

/** The operator-facing reading of each refusal, kept apart for the same reason the memory lane
 *  keeps them apart: an unconfigured bot, an offline peer, and an attached peer that speaks an
 *  older hello need three different fixes. */
const CONFIG_UNAVAILABLE: Record<Exclude<ConfigSendOutcome, "sent" | "capability_not_negotiated">, string> = {
  unknown_bot: "this bot has no attach profile on this gateway",
  not_attached: "this bot's peer is not attached right now",
};

/** The routine an operation acts on, when it acts on one. `routines.create` and `routines.list`
 *  name none, and neither do the profile and model operations. */
function routineIdOf(input: ConfigInput): string | undefined {
  return typeof input === "object" && input !== null && "id" in input ? input.id : undefined;
}

export interface AttachConfigSurfaceOptions {
  rateLimiter?: ConfigRateLimiter;
  now?: () => number;
}

/** Correlates the bounded live attach-v1 bot-config lane. A clone of `AttachMemorySurface`: it
 *  retains only a waiter, never config content, and a disconnected peer fails immediately so a
 *  timed-out write cannot execute later after reconnect. */
export class AttachConfigSurface implements ConfigSurface {
  readonly #pending = new Map<string, Pending>();
  readonly #endpoint: { sendConfigRequest(agentId: string, input: AttachV1ConfigRequest): ConfigSendOutcome };
  readonly #timeoutMs: number;
  readonly #trace: TraceLog | undefined;
  readonly #rate: ConfigRateLimiter;
  readonly #now: () => number;

  constructor(
    endpoint: { sendConfigRequest(agentId: string, input: AttachV1ConfigRequest): ConfigSendOutcome },
    timeoutMs = 12_000,
    trace?: TraceLog,
    opts: AttachConfigSurfaceOptions = {},
  ) {
    this.#endpoint = endpoint;
    this.#timeoutMs = timeoutMs;
    this.#trace = trace;
    this.#rate = opts.rateLimiter ?? createConfigRateLimiter();
    this.#now = opts.now ?? Date.now;
  }

  #request(agentId: string, operation: ConfigOperation, input: ConfigInput): Promise<ConfigResult> {
    const requestId = randomUUID();
    return new Promise<ConfigResult>((resolve, reject) => {
      const spend = this.#rate.take(agentId, this.#now());
      if (!spend.ok) {
        emitTrace(this.#trace, "bot_config_rate_limited", { profile: traceId(agentId), operation, retryAfterMs: spend.retryAfterMs });
        reject(new BackendUnavailable(`too many bot config requests for this bot; retry in ${spend.retryAfterMs}ms`));
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending.delete(requestId)) reject(new BackendUnavailable("bot config reply timed out"));
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { agentId, operation, routineId: routineIdOf(input), resolve, reject, timer });
      // The public methods below keep operation and input paired; this assertion bridges that
      // correlation across the internal union-valued helper parameters.
      const request = { kind: "config_request", requestId, operation, input } as AttachV1ConfigRequest;
      const outcome = this.#endpoint.sendConfigRequest(agentId, request);
      if (outcome === "sent") return;
      clearTimeout(timer);
      this.#pending.delete(requestId);
      emitTrace(this.#trace, "bot_config_unavailable", { profile: traceId(agentId), operation, reason: outcome });
      reject(
        outcome === "capability_not_negotiated"
          ? new ConfigNotNegotiated(agentId)
          : new BackendUnavailable(`bot config is unavailable for this bot: ${CONFIG_UNAVAILABLE[outcome]}`),
      );
    });
  }

  async botProfile(name: string): Promise<BotProfile> {
    return await this.#request(name, "profile.read", {}) as BotProfile;
  }
  async configureProfile(name: string, patch: BotProfilePatch): Promise<ProfileConfigureResult> {
    // The wire body is the PUBLISHED configure response, which additionally echoes the bot name.
    // The internal result deliberately does not carry it twice: the caller already knows it.
    const result = await this.#request(name, "profile.write", patch) as BotProfileConfigureResponse;
    return {
      outcome: result.outcome,
      ok: result.ok,
      applied: result.applied,
      requested: result.requested as ProfileConfigureResult["requested"],
    };
  }
  async modelConfig(name: string): Promise<BotModelConfig> {
    return await this.#request(name, "model.read", {}) as BotModelConfig;
  }
  async configureModel(name: string, patch: BotModelConfigPatch): Promise<BotModelConfig> {
    return await this.#request(name, "model.write", patch) as BotModelConfig;
  }
  async routines(name: string): Promise<BotRoutineList> {
    const { name: bot, routines, updatedAt } = await this.#request(name, "routines.list", {}) as BotRoutineListResponse;
    return { name: bot, routines, updatedAt };
  }
  async createRoutine(name: string, input: BotRoutineCreateRequest): Promise<RoutineWriteResult> {
    return this.#write(await this.#request(name, "routines.create", input));
  }
  async patchRoutine(name: string, id: string, patch: BotRoutinePatch): Promise<RoutineWriteResult> {
    return this.#write(await this.#request(name, "routines.update", { id, patch }));
  }
  async deleteRoutine(name: string, id: string): Promise<void> {
    await this.#request(name, "routines.delete", { id });
  }
  async runRoutine(name: string, id: string): Promise<void> {
    await this.#request(name, "routines.run", { id });
  }

  /** The published write response minus the bot name the caller already holds. `replacedId` and
   *  `orphanedId` are carried only when the peer sent them: an absent key means no rewrite
   *  happened, and inventing one would hand a client an id to retire that never existed. */
  #write(result: ConfigResult): RoutineWriteResult {
    const written = result as BotRoutineWriteResponse;
    return {
      routine: written.routine,
      ...(written.replacedId === undefined ? {} : { replacedId: written.replacedId }),
      ...(written.orphanedId === undefined ? {} : { orphanedId: written.orphanedId }),
    };
  }

  handle(agentId: string, frame: AttachV1ConfigResult): boolean {
    const pending = this.#pending.get(frame.requestId);
    if (pending === undefined || pending.agentId !== agentId) return false;
    this.#pending.delete(frame.requestId);
    clearTimeout(pending.timer);
    if (frame.status === "ok" && validResult(pending.operation, frame.result)) pending.resolve(frame.result);
    else if (frame.status === "ok") pending.reject(new BackendUnavailable("bot config returned an invalid reply"));
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

/** A non-`ok` status, turned into the error the existing bot routes already answer correctly.
 *  This lane adds no route change, so it speaks in the vocabulary those routes read:
 *  `RoutineNotFound` is their 404, `ConfigInvalidRequest` their 400, `BackendUnavailable` their
 *  503. */
function refusal(pending: Pick<Pending, "operation" | "routineId">, frame: AttachV1ConfigResult): Error {
  const message = frame.message ?? "the bot's peer refused the config request";
  if (frame.status === "not_found" && pending.routineId !== undefined) return new RoutineNotFound(pending.routineId);
  if (frame.status === "invalid_request") return new ConfigInvalidRequest(message);
  // A profile or model read the peer cannot answer is not a missing BOT: the bot is on the roster
  // and its chat lane works. Reported as unavailable so a client keeps the bot and hides the pane.
  return new BackendUnavailable(`bot config is unavailable for this bot: ${message}`);
}

import { randomBytes, randomUUID } from "node:crypto";

import { type Static, Type } from "@sinclair/typebox";
import { ContractViolation, assertValid } from "cozygateway-contract";
import type {
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteResponse,
  BotRuntimeProjection,
  BotRuntimeStage,
} from "cozygateway-contract";

import {
  BotNameInvalid,
  BotNameTaken,
  BotNotFound,
  BotTurnActive,
  RESERVED_PROFILE_NAMES,
  normalizeProfileName,
  validateNewBotName,
} from "../hermes-bridge/crud.ts";
import type { Storage } from "../storage.ts";
import type { RunnerLane } from "./lane.ts";

/** The runtime spec a create is given when the operator configured one. Everything is optional:
 *  a gateway that names nothing sends nothing, and the runner falls back to its own compose
 *  defaults rather than the gateway inventing an image tag or a model id it cannot verify.
 *
 *  The schema is the validation, not a second description of it: a malformed operator value is
 *  refused at create time with the variable named, rather than dropped in silence and discovered
 *  later as a container that came up on the wrong ceiling. */
const RuntimeSpecCommon = {
  model: Type.Optional(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 200 }),
      provider: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
      endpoint: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }, { additionalProperties: false }),
  ),
  resources: Type.Optional(
    Type.Object({
      cpus: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1024 })),
      memoryMb: Type.Optional(Type.Integer({ minimum: 64, maximum: 1_048_576 })),
      pids: Type.Optional(Type.Integer({ minimum: 16, maximum: 1_048_576 })),
    }, { additionalProperties: false }),
  ),
};

/** A union rather than one object with two optional keys, because "at most one of `image` and
 *  `entrypoint`" is the contract (`contract/runner-v1.md`) rather than a convention: a runtime is
 *  either an image for the Docker backend or an argv for the process backend, and a command
 *  carrying both would leave the runner to guess which one the operator meant. Both branches are
 *  closed, so an object naming both matches neither and is refused. */
export const RuntimeSpecSchema = Type.Union([
  Type.Object({
    image: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    ...RuntimeSpecCommon,
  }, { additionalProperties: false }),
  Type.Object({
    /** Argv, not a shell string. */
    entrypoint: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { minItems: 1, maxItems: 32 })),
    ...RuntimeSpecCommon,
  }, { additionalProperties: false }),
]);
export type RuntimeSpecDefaults = Static<typeof RuntimeSpecSchema>;

/** Reads the runtime spec an operator configured for new bots out of the environment, the same way
 *  every other container-friendly gateway knob is read. Nothing here is a secret: an image
 *  reference, an entrypoint argv, a model id and resource ceilings. Everything is optional, and a
 *  value that is not set is simply absent from the operation rather than guessed.
 *
 *  A malformed value throws `ContractViolation`, which the create route answers as `400` naming
 *  the variable. It is read lazily, per create, rather than at boot: a mistyped ceiling should not
 *  keep a gateway full of working bots from starting, and it should not be silently ignored
 *  either. */
export function runtimeSpecDefaults(env: Record<string, string | undefined>): RuntimeSpecDefaults {
  const text = (name: string): string | undefined => {
    const value = env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const numeric = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
      throw new ContractViolation(`${name} must be a number`, `/${name}`);
    return parsed;
  };
  const modelId = text("COZYGATEWAY_RUNNER_MODEL_ID");
  const provider = text("COZYGATEWAY_RUNNER_MODEL_PROVIDER");
  const endpoint = text("COZYGATEWAY_RUNNER_MODEL_ENDPOINT");
  const cpus = numeric("COZYGATEWAY_RUNNER_CPUS");
  const memoryMb = numeric("COZYGATEWAY_RUNNER_MEMORY_MB");
  const pids = numeric("COZYGATEWAY_RUNNER_PIDS");
  const image = text("COZYGATEWAY_RUNNER_IMAGE");
  // Argv, so it is JSON rather than a string a shell would have to split. A runner spawns it
  // directly and quoting rules never enter into it.
  const entrypointJson = text("COZYGATEWAY_RUNNER_ENTRYPOINT_JSON");
  let entrypoint: unknown;
  if (entrypointJson !== undefined) {
    try {
      entrypoint = JSON.parse(entrypointJson);
    } catch {
      throw new ContractViolation(
        "COZYGATEWAY_RUNNER_ENTRYPOINT_JSON must be a JSON array of strings",
        "/COZYGATEWAY_RUNNER_ENTRYPOINT_JSON",
      );
    }
  }
  // Named before the schema gets to it, because "you set both" is a far more useful sentence than
  // "no union branch matched".
  if (image !== undefined && entrypointJson !== undefined) {
    throw new ContractViolation(
      "set COZYGATEWAY_RUNNER_IMAGE or COZYGATEWAY_RUNNER_ENTRYPOINT_JSON, not both: a runtime is either an image for the docker backend or an argv for the process backend",
      "/COZYGATEWAY_RUNNER_IMAGE",
    );
  }
  const resources = {
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(pids === undefined ? {} : { pids }),
  };
  const spec = {
    ...(image === undefined ? {} : { image }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(modelId === undefined
      ? {}
      : { model: { id: modelId, ...(provider === undefined ? {} : { provider }), ...(endpoint === undefined ? {} : { endpoint }) } }),
    ...(Object.keys(resources).length === 0 ? {} : { resources }),
  };
  return assertValid(RuntimeSpecSchema, spec) as RuntimeSpecDefaults;
}

/** Capability 54. The account has no computer at all, so there is nowhere to put the bot. The
 *  create route answers `409 no_runner_paired`, which the app turns into "Add a computer first". */
export class NoRunnerPaired extends Error {
  constructor(
    message = "no computer is paired with this gateway yet, so there is nowhere to run this bot; add a computer first",
  ) {
    super(message);
    this.name = "NoRunnerPaired";
  }
}

/** Capability 54. Several computers and none of them the account default, so the gateway will not
 *  pick for the person. A separate code from `NoRunnerPaired` because it is a separate sentence:
 *  the app shows a chooser for this one and "Add a computer first" for the other. */
export class RunnerChoiceRequired extends Error {
  /** What the app's chooser renders and sends back. The ids live here and nowhere else: the message
   *  carries names, and a create needs an id. */
  readonly runners: readonly { id: string; name: string; isDefault: boolean }[];
  constructor(runners: readonly { id: string; name: string; isDefault: boolean }[]) {
    super(
      "this account has more than one computer and none of them is the default, so name one in runnerId: "
        + runners.map((runner) => runner.name).join(", "),
    );
    this.name = "RunnerChoiceRequired";
    this.runners = runners;
  }
}

/** Capability 54. The request named a computer this gateway does not have. A client bug rather than
 *  a missing machine, so it is a `400` naming the field rather than one of the two 409s. */
export class RunnerUnknown extends Error {
  constructor(requested: string) {
    super(`runnerId "${requested}" names no paired computer on this gateway`);
    this.name = "RunnerUnknown";
  }
}

/** One runtime bot as every surface downstream of configuration sees it: no `tokenEnv`, no source,
 *  just the identity this gateway serves. */
export interface ResolvedRuntimeBot {
  id: string;
  name: string;
  avatar: string | null;
  runtime: "cozyagents";
  /** Capability 54. The computer this bot was placed on, null for a config-declared bot and for one
   *  created before 54. */
  runnerId: string | null;
}

/** Merges the two sources of runtime bots into one namespace. The config file is a BOOTSTRAP
 *  source (capability 45); a storage row created through `POST /bots {runtime}` (capability 49)
 *  WINS on collision, because it is the row this gateway minted the credential for and the
 *  operator's line for the same id is then stale rather than authoritative. */
export function mergeRuntimeBots(
  configBots: readonly { id: string; name?: string; avatar?: string; runtime: "cozyagents" }[],
  storedBots: readonly {
    id: string; name: string; avatar: string | null; runtime: "cozyagents"; runnerId?: string | null;
  }[],
): { bots: ResolvedRuntimeBot[]; fromConfig: string[] } {
  const stored = new Set(storedBots.map((bot) => bot.id));
  const fromConfig = configBots.filter((bot) => !stored.has(bot.id));
  return {
    bots: [
      ...fromConfig.map((bot) => ({
        id: bot.id,
        name: bot.name ?? bot.id,
        avatar: bot.avatar ?? null,
        runtime: bot.runtime,
        runnerId: null,
      })),
      ...storedBots.map((bot) => ({
        id: bot.id,
        name: bot.name,
        avatar: bot.avatar,
        runtime: bot.runtime,
        runnerId: bot.runnerId ?? null,
      })),
    ],
    fromConfig: fromConfig.map((bot) => bot.id),
  };
}

export interface RuntimeBotRegistration {
  id: string;
  name: string;
  avatar: string | null;
  runtime: "cozyagents";
  token: string;
  /** Capability 54. The computer this bot was placed on, absent when the gateway records none. */
  runnerId?: string | null;
}

export interface RuntimeBotServiceOptions {
  storage: Storage;
  /** Absent means this deployment has no runner credential configured. Operations are still
   *  accepted and still wait; they are simply never handed to anybody until one exists. */
  lane?: RunnerLane;
  /** Read per create, so a malformed operator value is a named `400` on the create that would have
   *  used it rather than a boot failure or a silent drop. */
  spec?: () => RuntimeSpecDefaults;
  now?: () => number;
  /** Makes the new identity live in this process: the attach token map, the native/runtime sets,
   *  the roster overlay, and the agents row. The inverse of `killAttachIdentity`. */
  register: (bot: RuntimeBotRegistration) => void;
  /** Tears the identity back down. Returns whether an attach token was actually held. */
  unregister: (id: string) => boolean;
  /** Capability 54. Which runner a create belongs to, given the request's choice. Throws
   *  `NoRunnerPaired` when the account has none, `RunnerChoiceRequired` when there are several and
   *  no default, and `RunnerUnknown` when the request names one this gateway does not have; the
   *  route answers those 409, 409 and 400. Absent is the pre-54 gateway: no create records a
   *  runner, and every operation stays unaddressed. */
  resolveRunner?: (requested: string | undefined) => { id: string; name: string };
  /** Capability 54. What a recorded runner id is called right now, so a renamed computer renames
   *  itself on every row that names it and a revoked one simply has no name to render. */
  runnerName?: (id: string) => string | undefined;
  /** Names this gateway must not hand out: every Hermes profile it serves. */
  reservedName?: (id: string) => boolean;
  /** Ask the roster to republish. A create has to be visible without a restart, which is the
   *  whole point of the storage-backed row. */
  rosterChanged?: (reason: string) => void;
  log?: (line: string) => void;
}

/** Capability 49. Creating, deleting, and projecting a Bot this gateway owns outright.
 *
 * The gateway is the lifecycle authority (ADR 0002): it writes the durable row, mints the attach
 * credential, registers the live identity, and enqueues the operation a CozyRunner reconciles. It
 * never waits on the runner to answer, so `POST /bots` is the same fast 201 a Hermes create is
 * even when no runner has ever connected. */
export class RuntimeBotService {
  readonly #storage: Storage;
  readonly #lane: RunnerLane | undefined;
  readonly #spec: () => RuntimeSpecDefaults;
  readonly #now: () => number;
  readonly #register: RuntimeBotServiceOptions["register"];
  readonly #unregister: RuntimeBotServiceOptions["unregister"];
  readonly #resolveRunner: RuntimeBotServiceOptions["resolveRunner"];
  readonly #runnerName: (id: string) => string | undefined;
  readonly #reservedName: (id: string) => boolean;
  readonly #rosterChanged: (reason: string) => void;
  readonly #log: (line: string) => void;

  constructor(opts: RuntimeBotServiceOptions) {
    this.#storage = opts.storage;
    this.#lane = opts.lane;
    this.#spec = opts.spec ?? (() => ({}));
    this.#now = opts.now ?? Date.now;
    this.#register = opts.register;
    this.#unregister = opts.unregister;
    this.#resolveRunner = opts.resolveRunner;
    this.#runnerName = opts.runnerName ?? (() => undefined);
    this.#reservedName = opts.reservedName ?? (() => false);
    this.#rosterChanged = opts.rosterChanged ?? (() => {});
    this.#log = opts.log ?? ((line) => void process.stderr.write(`[runtime-bot] ${line}\n`));
  }

  /** True for a bot whose row this gateway owns right now. This is the delete authorization: only
   *  a live gateway-owned row may be deleted through the bots route. */
  owns(id: string): boolean {
    return this.#storage.runtimeBot(id) !== undefined;
  }

  /** True for a bot that has a gateway-owned runtime OR had one: a delete leaves the operation
   *  behind so its cleanup stays watchable. It is the difference between "this bot has no runtime
   *  to project" (409) and "this bot's runtime is finished" (404). */
  hasRuntime(id: string): boolean {
    return (
      this.#storage.runtimeBot(id) !== undefined ||
      this.#storage.latestRunnerOperationForBot(id) !== undefined
    );
  }

  /** Creates a runtime bot and returns the roster row for it. The bot exists, is addressable, and
   *  can authenticate the moment this returns; its container does not, which is exactly what the
   *  runtime projection is for. */
  create(input: BotCreateRequest, row: (id: string) => BotCreateResponse["bot"]): BotCreateResponse {
    const name = validateNewBotName(input.name);
    if (this.#storage.runtimeBot(name) !== undefined) throw new BotNameTaken(name);
    if (this.#reservedName(name)) throw new BotNameTaken(name);
    // Read and validated FIRST, before a row, a credential, or an operation exists: a bot created
    // against a malformed ceiling would be a bot the runner cannot honestly build.
    const spec = this.#spec();
    // Resolved before anything durable exists, for the same reason the spec is: a bot placed on no
    // computer is a bot nothing can ever run, and the 409 that says so must arrive instead of a
    // 201, not after one.
    const runner = this.#resolveRunner?.(input.runnerId);
    const at = this.#now();
    // 32 bytes of CSPRNG, hex encoded: the same shape the operator-placed attach tokens have, so
    // nothing downstream can tell a minted credential from a placed one.
    const token = randomBytes(32).toString("hex");
    const display = input.title?.trim();
    this.#storage.insertRuntimeBot({
      id: name,
      name: display !== undefined && display.length > 0 ? display : name,
      avatar: null,
      token,
      runtime: "cozyagents",
      specGeneration: 1,
      createdAt: at,
      runnerId: runner?.id ?? null,
    });
    this.#storage.upsertAgent({
      id: name,
      name: display !== undefined && display.length > 0 ? display : name,
      avatar: null,
      backend: "attach",
    });
    this.#register({
      id: name,
      name: display !== undefined && display.length > 0 ? display : name,
      avatar: null,
      runtime: "cozyagents",
      token,
      runnerId: runner?.id ?? null,
    });
    const operationId = `op_${randomUUID()}`;
    this.#storage.enqueueRunnerOperation({
      operationId,
      bot: name,
      kind: "create_runtime",
      specGeneration: 1,
      payload: spec,
      at,
      runnerId: runner?.id ?? null,
    });
    this.#log(`created runtime bot ${name}, operation ${operationId}`);
    this.#lane?.dispatchPending();
    this.#rosterChanged(`runtime bot ${name} created`);
    const warnings: string[] = [];
    if (this.#lane?.connected() !== true) {
      warnings.push(
        "no runner is connected, so this bot is waiting for one; it will start on its own as soon as a runner attaches",
      );
    }
    if ((input.toolsets?.length ?? 0) > 0 || (input.mcpServers?.length ?? 0) > 0) {
      warnings.push(
        "toolsets and MCP servers are Hermes seeding options and were ignored; set this bot's tools from its own settings once it is running",
      );
    }
    return { bot: row(name), ...(warnings.length === 0 ? {} : { warnings }) };
  }

  /** The inverse, under the same refusals the Hermes delete applies: a reserved name is never
   *  deletable through this route, and a bot with a native turn in flight is refused with the
   *  turn id unless `force` is set. The identity dies first, exactly as it does for a Hermes bot:
   *  from here on the minted token authenticates nothing, so no in-flight connection can race the
   *  purge. */
  delete(name: string, opts: { force?: boolean } = {}): BotDeleteResponse {
    const canon = normalizeProfileName(name);
    if (RESERVED_PROFILE_NAMES.has(canon))
      throw new BotNameInvalid(`"${canon}" is reserved and cannot be deleted through this route`);
    const bot = this.#storage.runtimeBot(canon);
    if (bot === undefined) throw new BotNotFound(canon);
    const active = this.#storage.nativeBotActiveTurn(canon);
    if (active !== undefined && opts.force !== true) throw new BotTurnActive(canon, active.turnId);
    const tokenRevoked = this.#unregister(canon);
    const purged = this.#storage.purgeBot(canon);
    const operationId = `op_${randomUUID()}`;
    this.#storage.enqueueRunnerOperation({
      operationId,
      bot: canon,
      kind: "delete_runtime",
      specGeneration: bot.specGeneration,
      payload: {},
      at: this.#now(),
      // The same computer the create went to: the container and the volumes to remove are there
      // and nowhere else. Unless that computer has since been revoked, in which case the cleanup
      // is addressed to nobody rather than to a runner that can never collect it, and the account
      // default picks it up exactly as it picks up a pre-54 row.
      runnerId: this.#placement(bot.runnerId),
    });
    this.#log(`deleted runtime bot ${canon}, operation ${operationId}`);
    this.#lane?.dispatchPending();
    this.#rosterChanged(`runtime bot ${canon} deleted`);
    return {
      name: canon,
      // Truthful rather than convenient: a runtime bot never had a Hermes profile, so the host it
      // does not live on holds nothing to delete.
      hermesProfile: "already_absent",
      purged,
      tokenRevoked,
      residue: [
        "the runner still has this bot's container and volumes; they are removed when it applies the delete_runtime operation",
        `GET /bots/${canon}/runtime keeps answering until the runner receipts the delete, so the cleanup is watchable`,
      ],
    };
  }

  /** Where an operation for a bot that names `runnerId` should actually be addressed. A runner this
   *  gateway no longer has is not an address, and an operation carrying one would wait forever. */
  #placement(runnerId: string | null): string | null {
    if (runnerId === null) return null;
    return this.#runnerName(runnerId) === undefined ? null : runnerId;
  }

  /** `GET /bots/:name/runtime`. Reads only durable rows plus the live lane's last contact, so it
   *  is the same answer before and after a gateway restart. */
  projection(name: string): BotRuntimeProjection {
    const bot = this.#storage.runtimeBot(name);
    const operation = this.#storage.latestRunnerOperationForBot(name);
    // A deleted bot keeps a readable projection until the runner says the container and volumes
    // are gone. The identity was purged the moment the delete returned, so nothing here can be
    // talked to; this is the cleanup finishing in the open rather than a bot that still exists.
    if (bot === undefined) {
      if (operation === undefined || operation.kind !== "delete_runtime" || operation.stage === "deleted")
        throw new BotNotFound(name);
      return this.#project(operation.specGeneration, operation, "deletion_pending", operation.runnerId);
    }
    return this.#project(bot.specGeneration, operation, "waiting_for_runner", bot.runnerId);
  }

  #project(
    specGeneration: number,
    operation: ReturnType<Storage["latestRunnerOperationForBot"]>,
    fallback: BotRuntimeStage,
    runnerId: string | null,
  ): BotRuntimeProjection {
    // `waiting_for_runner` on a delete reads as `deletion_pending`: the wait is the same, but what
    // is being waited on is the cleanup, and a client should not be told the bot is provisioning.
    const recorded = operation?.stage;
    const stage = (
      recorded === undefined || (recorded === "waiting_for_runner" && fallback === "deletion_pending")
        ? fallback
        : recorded
    ) as BotRuntimeStage;
    const contact = operation?.lastContactAt ?? null;
    // The live contact of the machine this bot is actually on, not of whichever runner spoke last:
    // a second computer's heartbeat says nothing about this bot.
    const live = this.#lane?.lastContactAt(runnerId ?? undefined) ?? null;
    const runnerName = runnerId === null ? undefined : this.#runnerName(runnerId);
    return {
      stage,
      specGeneration,
      observedGeneration: operation?.observedGeneration ?? null,
      lastRunnerContactAt:
        contact === null && live === null ? null : Math.max(contact ?? 0, live ?? 0),
      ...(operation?.code === null || operation?.code === undefined ? {} : { code: operation.code }),
      ...(runnerId === null ? {} : { runnerId }),
      ...(runnerName === undefined ? {} : { runnerName }),
    };
  }
}

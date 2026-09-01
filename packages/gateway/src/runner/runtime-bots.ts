import { randomBytes, randomUUID } from "node:crypto";

import type {
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteResponse,
  BotRuntimeProjection,
  BotRuntimeStage,
} from "cozygateway-contract";

import { BotNameTaken, BotNotFound, validateNewBotName } from "../hermes-bridge/crud.ts";
import type { Storage } from "../storage.ts";
import type { RunnerLane } from "./lane.ts";

/** The runtime spec a create is given when the operator configured one. Everything is optional:
 *  a gateway that names nothing sends nothing, and the runner falls back to its own compose
 *  defaults rather than the gateway inventing an image tag or a model id it cannot verify. */
export interface RuntimeSpecDefaults {
  image?: string;
  entrypoint?: string;
  model?: { provider?: string; endpoint?: string; id: string };
  resources?: { cpus?: number; memoryMb?: number; pids?: number };
}

/** Reads the runtime spec an operator configured for new bots out of the environment, the same way
 *  every other container-friendly gateway knob is read. Nothing here is a secret: an image
 *  reference, an entrypoint, a model id and resource ceilings. Everything is optional, and a value
 *  that is not set is simply absent from the operation rather than guessed. */
export function runtimeSpecDefaults(env: Record<string, string | undefined>): RuntimeSpecDefaults {
  const text = (name: string): string | undefined => {
    const value = env[name];
    return value !== undefined && value.length > 0 ? value : undefined;
  };
  const positive = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const modelId = text("COZYGATEWAY_RUNNER_MODEL_ID");
  const provider = text("COZYGATEWAY_RUNNER_MODEL_PROVIDER");
  const endpoint = text("COZYGATEWAY_RUNNER_MODEL_ENDPOINT");
  const cpus = positive("COZYGATEWAY_RUNNER_CPUS");
  const memoryMb = positive("COZYGATEWAY_RUNNER_MEMORY_MB");
  const pids = positive("COZYGATEWAY_RUNNER_PIDS");
  const image = text("COZYGATEWAY_RUNNER_IMAGE");
  const entrypoint = text("COZYGATEWAY_RUNNER_ENTRYPOINT");
  const resources = { ...(cpus === undefined ? {} : { cpus }), ...(memoryMb === undefined ? {} : { memoryMb }), ...(pids === undefined ? {} : { pids }) };
  return {
    ...(image === undefined ? {} : { image }),
    ...(entrypoint === undefined ? {} : { entrypoint }),
    ...(modelId === undefined
      ? {}
      : { model: { id: modelId, ...(provider === undefined ? {} : { provider }), ...(endpoint === undefined ? {} : { endpoint }) } }),
    ...(Object.keys(resources).length === 0 ? {} : { resources }),
  };
}

export interface RuntimeBotRegistration {
  id: string;
  name: string;
  avatar: string | null;
  runtime: "cozyagents";
  token: string;
}

export interface RuntimeBotServiceOptions {
  storage: Storage;
  /** Absent means this deployment has no runner credential configured. Operations are still
   *  accepted and still wait; they are simply never handed to anybody until one exists. */
  lane?: RunnerLane;
  spec?: RuntimeSpecDefaults;
  now?: () => number;
  /** Makes the new identity live in this process: the attach token map, the native/runtime sets,
   *  the roster overlay, and the agents row. The inverse of `killAttachIdentity`. */
  register: (bot: RuntimeBotRegistration) => void;
  /** Tears the identity back down. Returns whether an attach token was actually held. */
  unregister: (id: string) => boolean;
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
  readonly #spec: RuntimeSpecDefaults;
  readonly #now: () => number;
  readonly #register: RuntimeBotServiceOptions["register"];
  readonly #unregister: RuntimeBotServiceOptions["unregister"];
  readonly #reservedName: (id: string) => boolean;
  readonly #rosterChanged: (reason: string) => void;
  readonly #log: (line: string) => void;

  constructor(opts: RuntimeBotServiceOptions) {
    this.#storage = opts.storage;
    this.#lane = opts.lane;
    this.#spec = opts.spec ?? {};
    this.#now = opts.now ?? Date.now;
    this.#register = opts.register;
    this.#unregister = opts.unregister;
    this.#reservedName = opts.reservedName ?? (() => false);
    this.#rosterChanged = opts.rosterChanged ?? (() => {});
    this.#log = opts.log ?? ((line) => void process.stderr.write(`[runtime-bot] ${line}\n`));
  }

  /** True for a bot whose row this gateway owns. */
  owns(id: string): boolean {
    return this.#storage.runtimeBot(id) !== undefined;
  }

  /** Creates a runtime bot and returns the roster row for it. The bot exists, is addressable, and
   *  can authenticate the moment this returns; its container does not, which is exactly what the
   *  runtime projection is for. */
  create(input: BotCreateRequest, row: (id: string) => BotCreateResponse["bot"]): BotCreateResponse {
    const name = validateNewBotName(input.name);
    if (this.#storage.runtimeBot(name) !== undefined) throw new BotNameTaken(name);
    if (this.#reservedName(name)) throw new BotNameTaken(name);
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
    });
    const operationId = `op_${randomUUID()}`;
    this.#storage.enqueueRunnerOperation({
      operationId,
      bot: name,
      kind: "create_runtime",
      specGeneration: 1,
      payload: {
        ...(this.#spec.image === undefined ? {} : { image: this.#spec.image }),
        ...(this.#spec.entrypoint === undefined ? {} : { entrypoint: this.#spec.entrypoint }),
        ...(this.#spec.model === undefined ? {} : { model: this.#spec.model }),
        ...(this.#spec.resources === undefined ? {} : { resources: this.#spec.resources }),
      },
      at,
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

  /** The inverse. The identity dies first, exactly as it does for a Hermes bot: from here on the
   *  minted token authenticates nothing, so no in-flight connection can race the purge. */
  delete(name: string): BotDeleteResponse {
    const bot = this.#storage.runtimeBot(name);
    if (bot === undefined) throw new BotNotFound(name);
    const tokenRevoked = this.#unregister(name);
    const purged = this.#storage.purgeBot(name);
    const operationId = `op_${randomUUID()}`;
    this.#storage.enqueueRunnerOperation({
      operationId,
      bot: name,
      kind: "delete_runtime",
      specGeneration: bot.specGeneration,
      payload: {},
      at: this.#now(),
    });
    this.#log(`deleted runtime bot ${name}, operation ${operationId}`);
    this.#lane?.dispatchPending();
    this.#rosterChanged(`runtime bot ${name} deleted`);
    return {
      name,
      // Truthful rather than convenient: a runtime bot never had a Hermes profile, so the host it
      // does not live on holds nothing to delete.
      hermesProfile: "already_absent",
      purged,
      tokenRevoked,
      residue: [
        "the runner still has this bot's container and volumes; they are removed when it applies the delete_runtime operation",
        `follow the runtime operation for ${name} on the runner's own logs if it does not settle`,
      ],
    };
  }

  /** `GET /bots/:name/runtime`. Reads only durable rows plus the live lane's last contact, so it
   *  is the same answer before and after a gateway restart. */
  projection(name: string): BotRuntimeProjection {
    const bot = this.#storage.runtimeBot(name);
    if (bot === undefined) throw new BotNotFound(name);
    const operation = this.#storage.latestRunnerOperationForBot(name);
    const stage = (operation?.stage ?? "waiting_for_runner") as BotRuntimeStage;
    const contact = operation?.lastContactAt ?? null;
    const live = this.#lane?.lastContactAt() ?? null;
    return {
      stage,
      specGeneration: bot.specGeneration,
      observedGeneration: operation?.observedGeneration ?? null,
      lastRunnerContactAt:
        contact === null && live === null ? null : Math.max(contact ?? 0, live ?? 0),
      ...(operation?.code === null || operation?.code === undefined ? {} : { code: operation.code }),
    };
  }
}

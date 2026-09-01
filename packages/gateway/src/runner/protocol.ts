import { type Static, Type } from "@sinclair/typebox";

/** The private control protocol between this gateway and one CozyRunner (ADR 0002, capability 49).
 *  It is NOT the app-facing contract: no phone speaks it, and nothing here is published in
 *  `cozygateway-contract`. It is documented in `contract/runner-v1.md` so the runner in the
 *  CozyAgents repo has one normative shape to build against.
 *
 *  The socket is opened BY the runner, outbound, to `/runner/v1`, and authenticated with a single
 *  bearer token the local admin places in `COZYGATEWAY_RUNNER_TOKEN` (the pairing-code flow and
 *  short-lived per-runner credentials are deliberately out of scope for wave 3). */
export const RUNNER_V1_VERSION = 1;

/** How often the gateway sends a heartbeat, and how long total silence is tolerated before the
 *  socket is terminated. The gateway initiates: a runner that cannot answer is a runner that
 *  cannot be handed a mutation either. */
export const RUNNER_V1_HEARTBEAT_INTERVAL_MS = 15_000;
export const RUNNER_V1_HEARTBEAT_TIMEOUT_MS = 45_000;

/** Every stage a receipt may carry. Deliberately the same vocabulary as the published
 *  `BotRuntimeStage`, so a receipt projects onto `GET /bots/:name/runtime` without translation. */
export const RunnerStageSchema = Type.Union([
  Type.Literal("waiting_for_runner"),
  Type.Literal("waiting_for_capacity"),
  Type.Literal("pulling_image"),
  Type.Literal("creating"),
  Type.Literal("starting"),
  Type.Literal("ready"),
  Type.Literal("draining"),
  Type.Literal("stopping"),
  Type.Literal("stopped"),
  Type.Literal("recovering"),
  Type.Literal("upgrading"),
  Type.Literal("deleting"),
  Type.Literal("needs_attention"),
]);
export type RunnerStage = Static<typeof RunnerStageSchema>;

/** The runner's opening frame. `backends` says what this host can actually do, so a gateway can
 *  tell an operator why a create is sitting in `waiting_for_capacity` rather than guessing.
 *  `inventory` is what the runner already believes it holds; wave 3 records the contact and does
 *  not reconcile from it (unknown-container reconciliation is explicitly out of scope). */
export const RunnerHelloSchema = Type.Object({
  kind: Type.Literal("hello"),
  version: Type.Integer({ minimum: 1, maximum: 1 }),
  runnerId: Type.String({ minLength: 1, maxLength: 120 }),
  backends: Type.Array(Type.Union([Type.Literal("docker"), Type.Literal("process")]), {
    minItems: 1,
    maxItems: 4,
  }),
  inventory: Type.Optional(
    Type.Array(
      Type.Object({
        botId: Type.String({ minLength: 1, maxLength: 64 }),
        specGeneration: Type.Integer({ minimum: 0 }),
        stage: RunnerStageSchema,
      }, { additionalProperties: false }),
      { maxItems: 256 },
    ),
  ),
}, { additionalProperties: false });
export type RunnerHello = Static<typeof RunnerHelloSchema>;

/** The runner's heartbeat answer. It carries nothing: liveness is the whole message. */
export const RunnerHeartbeatSchema = Type.Object({
  kind: Type.Literal("heartbeat"),
  sentAt: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });

/** An immutable stage receipt. `code` is a stable, safe error identifier, never free-form
 *  diagnostics: no secrets, no env values, no host paths, and no workspace content ever cross
 *  this frame (ADR 0002, "Audit, errors, and cancellation"). */
export const RunnerReceiptSchema = Type.Object({
  kind: Type.Literal("receipt"),
  operationId: Type.String({ minLength: 1, maxLength: 120 }),
  botId: Type.String({ minLength: 1, maxLength: 64 }),
  specGeneration: Type.Integer({ minimum: 0 }),
  stage: RunnerStageSchema,
  at: Type.Integer({ minimum: 0 }),
  code: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false });
export type RunnerReceipt = Static<typeof RunnerReceiptSchema>;

export const RunnerClientFrameSchema = Type.Union([
  RunnerHelloSchema,
  RunnerHeartbeatSchema,
  RunnerReceiptSchema,
]);
export type RunnerClientFrame = Static<typeof RunnerClientFrameSchema>;

/** What a runner is asked to make true. `attachToken` is the credential the container needs to
 *  attach back to this gateway; it exists on this frame and nowhere else on any wire, and never
 *  in a log line or a receipt. Exactly one of `image` and `entrypoint` is present: an image for
 *  the Docker backend, an entrypoint for the development process backend. */
export interface RunnerCreateRuntimePayload {
  operationId: string;
  botId: string;
  specGeneration: number;
  attachToken: string;
  image?: string;
  entrypoint?: string;
  model?: { provider?: string; endpoint?: string; id: string };
  resources?: { cpus?: number; memoryMb?: number; pids?: number };
}

export interface RunnerDeleteRuntimePayload {
  operationId: string;
  botId: string;
  specGeneration: number;
}

export type RunnerServerFrame =
  | { kind: "hello_ack"; version: number; heartbeatIntervalMs: number }
  | { kind: "heartbeat"; sentAt: number }
  | { kind: "command"; command: "create_runtime"; payload: RunnerCreateRuntimePayload }
  | { kind: "command"; command: "delete_runtime"; payload: RunnerDeleteRuntimePayload };

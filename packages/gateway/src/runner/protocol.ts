import { type Static, Type } from "@sinclair/typebox";

/** The private control protocol between this gateway and one CozyRunner (ADR 0002, capability 49).
 *  It is NOT the app-facing contract: no phone speaks it, and nothing here is published in
 *  `cozygateway-contract`. It is documented in `contract/runner-v1.md` so the runner in the
 *  CozyAgents repo has one normative shape to build against.
 *
 *  The socket is opened BY the runner, outbound, to `/runner/v1`, and authenticated with a single
 *  bearer token: from capability 52 that is a per-runner token minted by `POST /pair
 *  {kind: "runner"}`, with the operator-placed `COZYGATEWAY_RUNNER_TOKEN` kept as the legacy
 *  shared credential. */
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
  Type.Literal("deleted"),
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
  /** Capability 52, all optional and all recorded on the runner's roster row. A runner built
   *  before 52 sends none of them and simply has nulls on its row; a runner that sends them to a
   *  gateway below 52 has them ignored, because unknown properties are ignored on every runner
   *  frame. `name` is what the machine calls itself, and every hello that carries one updates the
   *  row: renaming a computer is a thing people do, and a roster still showing the name it had at
   *  pairing time would be stale rather than stable. A hello without it changes nothing. */
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  platform: Type.Optional(
    Type.Object({
      os: Type.String({ minLength: 1, maxLength: 40 }),
      arch: Type.String({ minLength: 1, maxLength: 20 }),
      release: Type.Optional(Type.String({ maxLength: 60 })),
    }),
  ),
  agentVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  inventory: Type.Optional(
    Type.Array(
      // Additive fields are ALLOWED here and on every other runner frame: a runner that starts
      // reporting an image digest or a measured isolation level must not have its socket closed by
      // an older gateway. Unknown properties are ignored, never echoed, and never persisted.
      Type.Object({
        botId: Type.String({ minLength: 1, maxLength: 64 }),
        specGeneration: Type.Integer({ minimum: 0 }),
        stage: RunnerStageSchema,
      }),
      { maxItems: 256 },
    ),
  ),
});
export type RunnerHello = Static<typeof RunnerHelloSchema>;

/** The runner's heartbeat answer. It carries nothing: liveness is the whole message. */
export const RunnerHeartbeatSchema = Type.Object({
  kind: Type.Literal("heartbeat"),
  sentAt: Type.Optional(Type.Integer({ minimum: 0 })),
});

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
});
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
  /** Argv, not a shell string: the process backend spawns it directly, so quoting rules never
   *  enter into it. */
  entrypoint?: string[];
  model?: {
    provider?: string;
    endpoint?: string;
    id: string;
    contextWindow?: number;
    maxTokens?: number;
  };
  resources?: { cpus?: number; memoryMb?: number; pids?: number };
}

export interface RunnerDeleteRuntimePayload {
  operationId: string;
  botId: string;
  specGeneration: number;
}

/** The frame kinds this gateway understands. A frame naming anything else is IGNORED with a log
 *  line rather than closing the socket, so a runner that adds a frame type stays connected to an
 *  older gateway instead of being disconnected mid-reconciliation. */
export const RUNNER_CLIENT_FRAME_KINDS: ReadonlySet<string> = new Set(["hello", "heartbeat", "receipt"]);

export type RunnerServerFrame =
  // The runner parses hello acknowledgements as an exact four-field wire frame. The gateway does
  // not implement any optional runner commands yet, so it acknowledges an explicit empty set.
  | { kind: "hello_ack"; version: number; capabilities: readonly []; heartbeatIntervalMs: number }
  | { kind: "heartbeat"; sentAt: number }
  | { kind: "command"; command: "create_runtime"; payload: RunnerCreateRuntimePayload }
  | { kind: "command"; command: "delete_runtime"; payload: RunnerDeleteRuntimePayload };

/** The flat string a roster row stores for a reported platform. One shape, decided once here, so
 *  every reader sees the same value: `darwin/arm64` or `linux/x64/6.8.0`. */
export function platformLabel(
  platform: { os: string; arch: string; release?: string } | undefined,
): string | undefined {
  if (platform === undefined) return undefined;
  const parts = [platform.os, platform.arch, ...(platform.release === undefined ? [] : [platform.release])];
  return parts.join("/").slice(0, 120);
}

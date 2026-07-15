import { randomUUID } from "node:crypto";

import type { PresenceState, RichBlock } from "cozygateway-contract";

import type { AgentConfig } from "../../config.ts";
import type { BackendAdapter, BackendSession, TurnHandlers } from "../types.ts";
import type {
  AttachInterruptFrame,
  AttachSteerFrame,
  AttachTurnFrame,
  AttachUpdate,
} from "./protocol.ts";
import { blocksToText } from "./blocks-to-text.ts";

/** The slice of the ingress a turn needs. A seam so adapter tests run with no sockets;
 *  AttachIngress satisfies it structurally. */
export interface TurnEndpoint {
  isAttached(agentId: string): boolean;
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean;
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean;
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean;
}

/** A BackendAdapter that also receives routed ingress events for its agent. */
export interface AttachAdapter extends BackendAdapter {
  handleUpdate(threadId: string, update: AttachUpdate): void;
  handleDisconnect(): void;
}

/** Generous by default: agentic turns with tool use can legitimately run for minutes. The
 *  per-agent options.turnTimeoutSeconds overrides it. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 600;

export interface ParsedAttachOptions {
  tokenEnv: string;
  token: string;
  turnTimeoutMs: number;
}

/** Parse and validate an attach agent's options. The config file carries the NAME of the
 *  environment variable holding the connection token, never the token itself; startup fails
 *  closed when the variable is missing or empty. */
export function parseAttachOptions(
  agent: AgentConfig,
  env: Record<string, string | undefined>,
): ParsedAttachOptions {
  const options = agent.options ?? {};
  const tokenEnv = options["tokenEnv"];
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    throw new Error(
      `agent "${agent.id}": the attach backend requires options.tokenEnv, the NAME of an environment variable holding the connection token`,
    );
  }
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `agent "${agent.id}": environment variable "${tokenEnv}" is not set; the attach token rides the environment, never the config file`,
    );
  }
  const rawTimeout = options["turnTimeoutSeconds"];
  let turnTimeoutMs = DEFAULT_TURN_TIMEOUT_SECONDS * 1000;
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
      throw new Error(`agent "${agent.id}": options.turnTimeoutSeconds must be a positive number`);
    }
    turnTimeoutMs = rawTimeout * 1000;
  }
  return { tokenEnv, token, turnTimeoutMs };
}

/** Build the token-to-agentId map the ingress authenticates against. The token IS the agent
 *  identity on /attach, so a shared token is a hard startup error, not a warning. */
export function collectAttachTokens(
  agents: AgentConfig[],
  env: Record<string, string | undefined>,
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const agent of agents) {
    if (agent.backend !== "attach") continue;
    const { token } = parseAttachOptions(agent, env);
    const holder = tokens.get(token);
    if (holder !== undefined) {
      throw new Error(
        `agent "${agent.id}": attach token collides with agent "${holder}"; every attach agent needs its own token`,
      );
    }
    tokens.set(token, agent.id);
  }
  return tokens;
}

interface InflightTurn {
  threadId: string;
  handlers: TurnHandlers;
  latest: RichBlock[] | undefined;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** One attach agent's BackendAdapter. Sessions are per thread (the runner caches one per
 *  thread); turns across threads may be in flight concurrently, each correlated by a wire
 *  turnId this adapter mints. Frames for unknown turns, foreign threads, or settled turns are
 *  dropped. */
export function createAttachAdapter(deps: {
  agentId: string;
  endpoint: TurnEndpoint;
  turnTimeoutMs: number;
}): AttachAdapter {
  const turns = new Map<string, InflightTurn>();
  // One in-flight turn per thread (the runner serializes per thread); steer/interrupt look the
  // active turnId up by threadId.
  const inflightByThread = new Map<string, string>();

  const settle = (turnId: string): InflightTurn | undefined => {
    const turn = turns.get(turnId);
    if (turn === undefined) return undefined;
    turns.delete(turnId);
    if (inflightByThread.get(turn.threadId) === turnId) inflightByThread.delete(turn.threadId);
    clearTimeout(turn.timer);
    return turn;
  };

  const failTurn = (turnId: string, message: string): void => {
    settle(turnId)?.reject(new Error(message));
  };

  return {
    backend: "attach",
    midTurnDelivery: "steer",

    async startSession(threadId: string): Promise<BackendSession> {
      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          if (!deps.endpoint.isAttached(deps.agentId)) {
            return Promise.reject(new Error(`agent "${deps.agentId}" is not attached`));
          }
          const turnId = randomUUID();
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => failTurn(turnId, `turn timed out after ${deps.turnTimeoutMs / 1000}s`),
              deps.turnTimeoutMs,
            );
            timer.unref();
            turns.set(turnId, { threadId, handlers, latest: undefined, timer, resolve, reject });
            inflightByThread.set(threadId, turnId);
            let sent: boolean;
            try {
              sent = deps.endpoint.sendTurn(deps.agentId, {
                kind: "turn",
                threadId,
                turnId,
                text: blocksToText(blocks),
              });
            } catch {
              // A throw from sendTurn takes the same immediate-failure path as a false return:
              // the pending entry is removed now, not left to linger until the per-turn timeout.
              failTurn(turnId, `agent "${deps.agentId}" is not attached`);
              return;
            }
            if (!sent) failTurn(turnId, `agent "${deps.agentId}" is not attached`);
          });
        },
        async steer(steerBlocks: RichBlock[]): Promise<void> {
          const turnId = inflightByThread.get(threadId);
          if (turnId === undefined) return; // race: no in-flight turn for this thread
          // The plugin injects this as another inbound message; with the agent-side Hermes config
          // busy_input_mode=steer, injection steers the running turn natively. The reply continues
          // under the EXISTING turnId (no new turn), so no local turn bookkeeping changes here.
          deps.endpoint.sendSteer(deps.agentId, {
            kind: "steer",
            threadId,
            turnId,
            text: blocksToText(steerBlocks),
          });
        },
        async interrupt(): Promise<void> {
          const turnId = inflightByThread.get(threadId);
          if (turnId === undefined) return;
          // Fire the native interrupt to the plugin (best-effort), then fail the in-flight turn so
          // the runner (which set its interrupting flag first) records turn.interrupted.
          try {
            deps.endpoint.sendInterrupt(deps.agentId, { kind: "interrupt", threadId, turnId });
          } catch {
            // a socket write failure still proceeds to fail the turn locally
          }
          failTurn(turnId, "interrupted by user");
        },
        async close(): Promise<void> {},
      };
    },

    presence: (): PresenceState => (deps.endpoint.isAttached(deps.agentId) ? "online" : "absent"),

    handleUpdate(threadId: string, update: AttachUpdate): void {
      const turn = turns.get(update.turnId);
      if (turn === undefined || turn.threadId !== threadId) return;
      if (update.kind === "draft") {
        turn.latest = update.blocks;
        turn.handlers.onDraft({ blocks: update.blocks, toolCalls: update.toolCalls ?? [] });
        return;
      }
      if (update.kind === "failed") {
        failTurn(update.turnId, update.message ?? "the agent reported a failed turn");
        return;
      }
      // kind === "done": seal the latest draft. A turn with no draft content is a failure, so
      // the runner records turn.failed instead of committing an empty reply.
      const latest = turn.latest;
      if (latest === undefined || latest.length === 0) {
        failTurn(update.turnId, "the agent finished the turn without any reply content");
        return;
      }
      const settled = settle(update.turnId);
      if (settled === undefined) return;
      settled.handlers.onCommit({ blocks: latest });
      settled.handlers.onDone();
      settled.resolve();
    },

    handleDisconnect(): void {
      for (const turnId of [...turns.keys()]) {
        failTurn(turnId, "the attached connection dropped mid-turn");
      }
    },
  };
}

/** Routes ingress events to the owning agent's adapter. The server registers each attach
 *  adapter here at build time; events for agents with no adapter are dropped. */
export class AttachRouter {
  readonly #adapters = new Map<string, AttachAdapter>();

  register(agentId: string, adapter: AttachAdapter): void {
    this.#adapters.set(agentId, adapter);
  }

  onUpdate(agentId: string, threadId: string, update: AttachUpdate): void {
    this.#adapters.get(agentId)?.handleUpdate(threadId, update);
  }

  onDisconnect(agentId: string): void {
    this.#adapters.get(agentId)?.handleDisconnect();
  }
}

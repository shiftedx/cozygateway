import { randomUUID } from "node:crypto";

import type { PresenceState, RichBlock, ToolCall } from "cozygateway-contract";

import type { HermesBridgeConfig } from "../../config.ts";
import type { BackendAdapter, BackendSession, TurnHandlers } from "../types.ts";
import type { AttachV1EventFrame } from "./protocol-v1.ts";
import { blocksToText } from "./blocks-to-text.ts";

export interface AttachTurnFrame { kind: "turn"; threadId: string; turnId: string; text: string }
export interface AttachSteerFrame { kind: "steer"; threadId: string; turnId: string; text: string }
export interface AttachInterruptFrame { kind: "interrupt"; threadId: string; turnId: string }

/** The slice of the v1 ingress a turn needs. A seam so adapter tests run with no sockets. */
export interface TurnEndpoint {
  isAttached(agentId: string): boolean;
  /** Durable v1 endpoints accept while absent and replay after reconnection. */
  canQueue(agentId: string): boolean;
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean;
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean;
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean;
  sendApprovalResolution?(
    agentId: string,
    input: { threadId: string; turnId: string; approvalId: string; decision: "approve" | "deny" },
  ): boolean;
}

/** A BackendAdapter that also receives routed ingress events for its agent. */
export interface AttachAdapter extends BackendAdapter {
  handleV1Event(frame: AttachV1EventFrame): boolean;
  handleDisconnect(): void;
}

export interface ParsedAttachOptions {
  tokenEnv: string;
  token: string;
}

/** Parse and validate an attach agent's options. The config file carries the NAME of the
 *  environment variable holding the connection token, never the token itself; startup fails
 *  closed when the variable is missing or empty. */
export function parseAttachOptions(
  profileId: string,
  profile: HermesBridgeConfig["profiles"][string],
  env: Record<string, string | undefined>,
  subject = "Hermes profile",
): ParsedAttachOptions {
  const tokenEnv = profile.tokenEnv;
  const token = env[tokenEnv];
  if (token === undefined || token.length === 0) {
    throw new Error(
      `${subject} "${profileId}": environment variable "${tokenEnv}" is not set; the attach token rides the environment, never the config file`,
    );
  }
  return { tokenEnv, token };
}

/** Build the token-to-agentId map the ingress authenticates against. The token IS the agent
 *  identity on /attach/v1, so a shared token is a hard startup error, not a warning. `subject`
 *  words the error for whatever is calling: Hermes profiles (default) or native runtime bots. */
export function collectAttachTokens(
  profiles: HermesBridgeConfig["profiles"],
  env: Record<string, string | undefined>,
  subject = "Hermes profile",
): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [rawProfileId, profile] of Object.entries(profiles)) {
    const profileId = rawProfileId.trim().toLowerCase();
    const { token } = parseAttachOptions(profileId, profile, env, subject);
    const holder = tokens.get(token);
    if (holder !== undefined) {
      throw new Error(
        `${subject} "${profileId}": attach token collides with profile "${holder}"; every profile needs its own token`,
      );
    }
    tokens.set(token, profileId);
  }
  return tokens;
}

interface InflightTurn {
  threadId: string;
  handlers: TurnHandlers;
  latest: RichBlock[] | undefined;
  toolCalls: Map<string, ToolCall>;
  timer?: ReturnType<typeof setTimeout>;
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
    if (turn.timer !== undefined) clearTimeout(turn.timer);
    return turn;
  };

  const failTurn = (turnId: string, message: string): void => {
    settle(turnId)?.reject(new Error(message));
  };

  const completeTurn = (threadId: string, turnId: string): void => {
    const turn = turns.get(turnId);
    if (turn === undefined || turn.threadId !== threadId) return;
    const latest = turn.latest;
    if (latest === undefined || latest.length === 0) {
      failTurn(turnId, "the agent finished the turn without any reply content");
      return;
    }
    const settled = settle(turnId);
    if (settled === undefined) return;
    settled.handlers.onCommit({ blocks: latest });
    settled.handlers.onDone();
    settled.resolve();
  };

  return {
    backend: "attach",
    midTurnDelivery: "steer",

    async startSession(threadId: string): Promise<BackendSession> {
      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          if (!deps.endpoint.isAttached(deps.agentId) && !deps.endpoint.canQueue(deps.agentId)) {
            return Promise.reject(new Error(`agent "${deps.agentId}" is not attached`));
          }
          const turnId = randomUUID();
          return new Promise<void>((resolve, reject) => {
            const timer = deps.turnTimeoutMs === 0
              ? undefined
              : setTimeout(
                  () => failTurn(turnId, `turn timed out after ${deps.turnTimeoutMs / 1000}s`),
                  deps.turnTimeoutMs,
                );
            timer?.unref();
            turns.set(turnId, { threadId, handlers, latest: undefined, toolCalls: new Map(), ...(timer === undefined ? {} : { timer }), resolve, reject });
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
        async steer(steerBlocks: RichBlock[]): Promise<boolean> {
          const turnId = inflightByThread.get(threadId);
          // Race: no in-flight turn for this thread, so nothing took these blocks. Reporting
          // non-acceptance is what lets the runner fall back to a queued turn carrying them
          // (see BackendSession.steer).
          if (turnId === undefined) return false;
          // The plugin injects this as another inbound message; with the agent-side Hermes config
          // busy_input_mode=steer, injection steers the running turn natively. The reply continues
          // under the EXISTING turnId (no new turn), so no local turn bookkeeping changes here.
          // sendSteer answers false when the agent holds no live socket: the frame went nowhere,
          // which is a non-acceptance too, not a silent drop.
          return deps.endpoint.sendSteer(deps.agentId, {
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
        async resolveApproval(approvalId, decision): Promise<boolean> {
          const turnId = inflightByThread.get(threadId);
          if (turnId === undefined || deps.endpoint.sendApprovalResolution === undefined) return false;
          return deps.endpoint.sendApprovalResolution(deps.agentId, {
            threadId,
            turnId,
            approvalId,
            decision,
          });
        },
        async close(): Promise<void> {},
      };
    },

    presence: (): PresenceState => (deps.endpoint.isAttached(deps.agentId) ? "online" : "absent"),

    handleV1Event(frame: AttachV1EventFrame): boolean {
      const event = frame.event;
      if (!("turnId" in event) || !("threadId" in event)) return false;
      const turn = turns.get(event.turnId);
      if (turn === undefined || turn.threadId !== event.threadId) return false;
      switch (event.kind) {
        case "draft":
          turn.latest = event.blocks;
          turn.handlers.onDraft({ blocks: event.blocks, toolCalls: [...turn.toolCalls.values()] });
          return true;
        case "tool": {
          const call: ToolCall = {
            id: event.callId,
            name: event.name,
            status: event.status,
            ...(event.detail === undefined ? {} : { detail: event.detail }),
          };
          turn.toolCalls.set(event.callId, call);
          turn.handlers.onDraft({ blocks: turn.latest ?? [], toolCalls: [...turn.toolCalls.values()] });
          return true;
        }
        case "approval":
          if (event.status === "pending") {
            turn.handlers.onApprovalPending?.({ toolCallId: event.approvalId, name: event.name });
          } else {
            const outcome = event.status === "approved" ? "approved"
              : event.status === "denied" ? "denied"
                : event.status === "expired" ? "expired" : "expired";
            turn.handlers.onApprovalResolved?.({ toolCallId: event.approvalId, outcome });
          }
          return true;
        case "commit":
          turn.latest = event.blocks;
          turn.handlers.onDraft({ blocks: event.blocks, toolCalls: [...turn.toolCalls.values()] });
          completeTurn(event.threadId, event.turnId);
          return true;
        case "failed":
          failTurn(event.turnId, event.message ?? "the agent reported a failed turn");
          return true;
        case "cancelled":
          failTurn(event.turnId, "the agent cancelled the turn");
          return true;
        case "interrupted":
          failTurn(event.turnId, "the agent interrupted the turn");
          return true;
        case "clarify":
          // Clarification is a distinct v1 interaction and has no frozen core-thread frame yet.
          // It remains durably journaled and is projected by the Bot Mode native sink.
          return true;
        case "delegation":
          // Delegation batch cards are a Bot Mode surface (capability 34): the native sink
          // projects them and the frozen core-thread contract carries no equivalent frame.
          return true;
        case "thinking":
          // The live thinking preview is a Bot Mode surface (capability 35): the native sink
          // projects it and the frozen core-thread contract carries no equivalent frame.
          return true;
      }
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

  onDisconnect(agentId: string): void {
    this.#adapters.get(agentId)?.handleDisconnect();
  }

  /** Drops a deleted bot's adapter. Any turn still in flight is failed first, exactly as a
   *  dropped socket would fail it: the identity is gone, so nothing can ever commit that turn,
   *  and leaving the caller's promise pending would hold the turn open forever. */
  unregister(agentId: string): void {
    this.#adapters.get(agentId)?.handleDisconnect();
    this.#adapters.delete(agentId);
  }

  onV1Event(agentId: string, frame: AttachV1EventFrame): boolean {
    return this.#adapters.get(agentId)?.handleV1Event(frame) ?? false;
  }
}

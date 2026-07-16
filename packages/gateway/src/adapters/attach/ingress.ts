import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { timingSafeEqual } from "node:crypto";

import { WebSocketServer, WebSocket } from "ws";
import { check } from "cozygateway-contract";

import {
  AttachInboundFrameSchema,
  type AttachInterruptFrame,
  type AttachSteerFrame,
  type AttachTurnFrame,
  type AttachUpdate,
} from "./protocol.ts";

/** What the ingress reports upward. The server maps presence transitions to contract v1
 *  presence frames; the router maps updates/disconnects to the owning agent's adapter. */
export interface AttachEvents {
  onUpdate(agentId: string, threadId: string, update: AttachUpdate): void;
  onDisconnect(agentId: string): void;
  onPresence(agentId: string, state: "online" | "absent"): void;
}

/** Constant-time secret comparison; a length mismatch returns false without a timing oracle
 *  on where the strings diverge. */
function tokenEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/** The adapter-facing /attach WebSocket server. Authenticates each connection by bearer token
 *  (header only, never the URL), keeps ONE live connection per agent (newest wins), validates
 *  every inbound frame against the closed attach union as defense in depth, and reports
 *  connection liveness as agent presence. */
export class AttachIngress {
  readonly #tokens: Map<string, string>;
  readonly #events: AttachEvents;
  readonly #current = new Map<string, WebSocket>();
  readonly #wss: WebSocketServer;

  constructor(deps: { tokens: Map<string, string>; events: AttachEvents }) {
    this.#tokens = deps.tokens;
    this.#events = deps.events;
    // noServer: true means this WebSocketServer never attaches its own 'upgrade' listener; the
    // caller routes matching requests to handleUpgrade() below. See upgrade-dispatcher.ts.
    this.#wss = new WebSocketServer({ noServer: true });
    // Swallow server-level errors: an unhandled 'error' event would crash the process.
    this.#wss.on("error", () => {});
    this.#wss.on("connection", (socket, req) => this.#onConnection(socket, req));
  }

  /** Completes a WebSocket handshake for an upgrade request already routed to this ingress by
   *  pathname. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#wss.emit("connection", ws, req));
  }

  #agentForRequest(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token === "") return undefined;
    for (const [candidate, agentId] of this.#tokens) {
      if (tokenEquals(candidate, token)) return agentId;
    }
    return undefined;
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    // A ws socket with no 'error' listener crashes the process on the first socket error.
    socket.on("error", () => {
      try {
        socket.close(1008, "socket error");
      } catch {
        socket.terminate();
      }
    });

    const agentId = this.#agentForRequest(req);
    if (agentId === undefined) {
      socket.close(1008, "unauthorized");
      return;
    }

    // Newest wins: supersede any existing connection for this agent. Its in-flight turns are
    // dead (the new plugin instance knows nothing about them), so fire onDisconnect for them,
    // but presence never flips: the agent stays online across the handover.
    const previous = this.#current.get(agentId);
    if (previous !== undefined) {
      this.#current.delete(agentId);
      previous.close(4000, "superseded");
      this.#events.onDisconnect(agentId);
    }
    this.#current.set(agentId, socket);
    if (previous === undefined) this.#events.onPresence(agentId, "online");

    socket.on("message", (data) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(data));
      } catch {
        return; // malformed JSON: drop (defense in depth)
      }
      if (!check(AttachInboundFrameSchema, frame)) return; // outside the closed union: drop
      this.#events.onUpdate(agentId, frame.threadId, frame.update);
    });

    socket.on("close", () => {
      // Only the CURRENT connection's close flips presence; a superseded socket's close is
      // already accounted for.
      if (this.#current.get(agentId) === socket) {
        this.#current.delete(agentId);
        this.#events.onPresence(agentId, "absent");
        this.#events.onDisconnect(agentId);
      }
    });
  }

  isAttached(agentId: string): boolean {
    return this.#current.get(agentId)?.readyState === WebSocket.OPEN;
  }

  #send(agentId: string, frame: AttachTurnFrame | AttachSteerFrame | AttachInterruptFrame): boolean {
    const socket = this.#current.get(agentId);
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  /** Deliver a turn frame to the agent's live connection. False when there is none (the adapter
   *  fails the turn fast rather than queueing). */
  sendTurn(agentId: string, frame: AttachTurnFrame): boolean {
    return this.#send(agentId, frame);
  }

  /** Deliver a steer frame (mid-turn injection). False when no live connection. */
  sendSteer(agentId: string, frame: AttachSteerFrame): boolean {
    return this.#send(agentId, frame);
  }

  /** Deliver an interrupt frame (native stop). False when no live connection. */
  sendInterrupt(agentId: string, frame: AttachInterruptFrame): boolean {
    return this.#send(agentId, frame);
  }

  close(): void {
    for (const socket of this.#current.values()) socket.close(1001, "server shutdown");
    this.#current.clear();
    this.#wss.close();
  }
}

import { randomUUID } from "node:crypto";

import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import type { BackendAdapter, BackendSession } from "./adapters/types.ts";
import { BackendUnavailable } from "./errors.ts";
import { isStopPhrase, stopCandidateFromBlocks } from "./stop-phrase.ts";

export interface Notifier {
  notify(
    event: { threadId: string; agentName: string; preview: string },
    connectedDeviceIds: ReadonlySet<string>,
  ): void;
}

export const nullNotifier: Notifier = { notify: () => {} };

interface Hub {
  broadcast(frame: ServerFrame): void;
  connectedDeviceIds(): ReadonlySet<string>;
}

/** Outcome of an interrupt dispatch. The REST layer maps both in-flight outcomes ("interrupting"
 *  for a steer-capable backend, "unsupported" for a queue-only one) to HTTP 202, and "idle" to
 *  HTTP 204. */
export type InterruptOutcome = "interrupting" | "unsupported" | "idle";

interface Inflight {
  turnId: string;
  session: BackendSession;
  steerCapable: boolean;
  interrupting: boolean;
  /** Set when the wall-clock bound (not a manual stop) triggered the interrupt, so the turn's
   *  system marker carries the time-limit text instead of the plain interrupted text. */
  timedOut: boolean;
}

function preview(blocks: RichBlock[]): string {
  const paragraph = blocks.find((b) => b.type === "paragraph");
  return paragraph !== undefined && paragraph.type === "paragraph" ? paragraph.text : "New message";
}

export class TurnRunner {
  readonly #storage: Storage;
  readonly #hub: Hub;
  readonly #adapters: Map<string, BackendAdapter>;
  readonly #notifier: Notifier;
  readonly #now: () => number;
  readonly #turnTimeoutMs: number;
  readonly #sessions = new Map<string, Promise<BackendSession>>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #inflight = new Map<string, Inflight>();

  constructor(deps: {
    storage: Storage;
    hub: Hub;
    adapters: Map<string, BackendAdapter>;
    notifier: Notifier;
    now: () => number;
    /** Per-turn wall-clock bound in milliseconds. 0 (the default when omitted) disables the bound.
     *  server.ts passes config.turnTimeoutSeconds * 1000. */
    turnTimeoutMs?: number;
  }) {
    this.#storage = deps.storage;
    this.#hub = deps.hub;
    this.#adapters = deps.adapters;
    this.#notifier = deps.notifier;
    this.#now = deps.now;
    this.#turnTimeoutMs = deps.turnTimeoutMs ?? 0;
  }

  submitUserMessage(threadId: string, blocks: RichBlock[]): Message {
    const thread = this.#storage.threadById(threadId);
    if (thread === undefined) throw new Error(`unknown thread "${threadId}"`);
    const adapter = this.#adapters.get(thread.agentId);
    if (adapter === undefined) {
      throw new BackendUnavailable(`no adapter for agent "${thread.agentId}"`);
    }
    const agentName = this.#storage.agentById(thread.agentId)?.name ?? thread.agentId;

    // Stop-phrase detection (whole-message only). A match routes to the interrupt path AND still
    // commits the user message normally (delivery absent), so it becomes the next queued turn.
    const candidate = stopCandidateFromBlocks(blocks);
    if (candidate !== undefined && isStopPhrase(candidate)) {
      const active = this.#inflight.get(threadId);
      if (active !== undefined) this.#dispatchInterrupt(threadId, active);
      return this.#commitAndQueue(threadId, agentName, adapter, blocks);
    }

    // Mid-turn steer: an in-flight, steer-capable turn takes the message immediately, under its
    // existing turnId, and the user message commits with delivery "steer". The in-flight check is
    // synchronous, so a send handled after the turn has already settled reads no record and falls
    // through to the queue branch below (the race rule: fall back to a normal queued turn).
    const inflight = this.#inflight.get(threadId);
    if (inflight !== undefined && inflight.steerCapable && inflight.session.steer !== undefined) {
      const userMessage = this.#storage.appendMessage(
        threadId,
        { role: "user", blocks, delivery: "steer" },
        this.#now(),
      );
      this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });
      void inflight.session.steer(blocks).catch(() => {
        // Best-effort mid-turn delivery: drafts continue under the existing turnId.
      });
      return userMessage;
    }

    return this.#commitAndQueue(threadId, agentName, adapter, blocks);
  }

  /** Request a hard interrupt of the thread's in-flight turn. Returns "idle" when nothing is in
   *  flight (HTTP 204). See InterruptOutcome. */
  interrupt(threadId: string): InterruptOutcome {
    const inflight = this.#inflight.get(threadId);
    if (inflight === undefined) return "idle";
    return this.#dispatchInterrupt(threadId, inflight);
  }

  #dispatchInterrupt(threadId: string, inflight: Inflight): InterruptOutcome {
    if (inflight.steerCapable && inflight.session.interrupt !== undefined) {
      inflight.interrupting = true;
      void inflight.session.interrupt().catch(() => {
        // The interrupting flag drives the turn.interrupted outcome once send() settles.
      });
      return "interrupting";
    }
    // Queue-only backend: it cannot interrupt. Be honest with a clean, thread-scoped error frame.
    this.#hub.broadcast({
      type: "error",
      code: "interrupt_unsupported",
      message: "interrupt unsupported",
      threadId,
    });
    return "unsupported";
  }

  #commitAndQueue(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Message {
    const userMessage = this.#storage.appendMessage(threadId, { role: "user", blocks }, this.#now());
    this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });
    // Invariant: #runTurn never rejects, so the chain promise never rejects.
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    void next.then(() => {
      if (this.#queues.get(threadId) === next) this.#queues.delete(threadId);
    });
    return userMessage;
  }

  /** Runs one agent turn. NEVER rejects: a backend failure becomes a turn.failed marker plus an
   *  error frame; a deliberately interrupted turn becomes a turn.interrupted marker plus a done
   *  frame; a double fault on either failure path is swallowed. */
  async #runTurn(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Promise<void> {
    const turnId = randomUUID();
    let record: Inflight | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let sessionPromise = this.#sessions.get(threadId);
      if (sessionPromise === undefined) {
        sessionPromise = adapter.startSession(threadId);
        this.#sessions.set(threadId, sessionPromise);
      }
      const session = await sessionPromise;
      record = {
        turnId,
        session,
        steerCapable: adapter.midTurnDelivery === "steer" && session.steer !== undefined,
        interrupting: false,
        timedOut: false,
      };
      this.#inflight.set(threadId, record);
      // Wall-clock bound: a turn whose device vanished (or whose driver timed out) must not run
      // forever looping tool calls. On expiry, fire the SAME interrupt path a manual stop uses.
      // Only arm when the session can actually be interrupted, so a queue-only backend never gets
      // a spurious interrupt_unsupported frame from the timer. unref() keeps the timer from holding
      // the process open. The finally clears it, so a turn that settles first never fires it.
      if (this.#turnTimeoutMs > 0 && record.steerCapable && record.session.interrupt !== undefined) {
        const armed = record;
        timer = setTimeout(() => {
          if (this.#inflight.get(threadId) === armed && !armed.interrupting) {
            armed.timedOut = true;
            this.#dispatchInterrupt(threadId, armed);
          }
        }, this.#turnTimeoutMs);
        timer.unref();
      }
      await session.send(blocks, {
        onDraft: (update) => {
          this.#hub.broadcast({ type: "draft", threadId, turnId, blocks: update.blocks, toolCalls: update.toolCalls });
        },
        onCommit: (final) => {
          const message = this.#storage.appendMessage(
            threadId,
            { role: "agent", blocks: final.blocks, turnId },
            this.#now(),
          );
          this.#hub.broadcast({ type: "committed", threadId, seq: message.seq, message });
          this.#notifier.notify(
            { threadId, agentName, preview: preview(final.blocks) },
            this.#hub.connectedDeviceIds(),
          );
        },
        onDone: () => {
          this.#hub.broadcast({ type: "done", threadId, turnId });
        },
      });
    } catch (err) {
      const interrupted = record?.interrupting === true;
      const timedOut = record?.timedOut === true;
      try {
        const system = this.#storage.appendMessage(
          threadId,
          {
            role: "system",
            blocks: [
              {
                type: "paragraph",
                text: timedOut
                  ? "The turn exceeded the time limit and was interrupted."
                  : interrupted
                    ? "The turn was interrupted."
                    : "The agent turn failed. Send again to retry.",
              },
            ],
            turnId,
            marker: interrupted ? "turn.interrupted" : "turn.failed",
          },
          this.#now(),
        );
        this.#hub.broadcast({ type: "committed", threadId, seq: system.seq, message: system });
        if (interrupted) {
          // A deliberately interrupted turn ends with the normal done frame (contract v1.x).
          this.#hub.broadcast({ type: "done", threadId, turnId });
        } else {
          const message = err instanceof Error ? err.message : "unknown failure";
          this.#hub.broadcast({ type: "error", code: "turn_failed", message, threadId });
        }
      } catch {
        // Double fault (e.g. storage already closed): swallow to keep the never-rejects invariant.
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.#inflight.get(threadId) === record) this.#inflight.delete(threadId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
    this.#queues.clear();
    this.#inflight.clear();
    for (const sessionPromise of this.#sessions.values()) {
      try {
        const session = await sessionPromise;
        await session.close();
      } catch {
        // a session that failed to open has nothing to close
      }
    }
    this.#sessions.clear();
  }
}

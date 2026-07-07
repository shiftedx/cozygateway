import { randomUUID } from "node:crypto";

import type { Message, RichBlock, ServerFrame } from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import type { BackendAdapter, BackendSession } from "./adapters/types.ts";
import { BackendUnavailable } from "./errors.ts";

export interface Notifier {
  notify(event: { threadId: string; agentName: string; preview: string }): void;
}

export const nullNotifier: Notifier = { notify: () => {} };

interface Hub {
  broadcast(frame: ServerFrame): void;
  hasClients(): boolean;
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
  readonly #sessions = new Map<string, Promise<BackendSession>>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(deps: {
    storage: Storage;
    hub: Hub;
    adapters: Map<string, BackendAdapter>;
    notifier: Notifier;
    now: () => number;
  }) {
    this.#storage = deps.storage;
    this.#hub = deps.hub;
    this.#adapters = deps.adapters;
    this.#notifier = deps.notifier;
    this.#now = deps.now;
  }

  submitUserMessage(threadId: string, blocks: RichBlock[]): Message {
    const thread = this.#storage.threadById(threadId);
    if (thread === undefined) throw new Error(`unknown thread "${threadId}"`);
    const adapter = this.#adapters.get(thread.agentId);
    if (adapter === undefined) {
      throw new BackendUnavailable(`no adapter for agent "${thread.agentId}"`);
    }
    const userMessage = this.#storage.appendMessage(threadId, { role: "user", blocks }, this.#now());
    this.#hub.broadcast({ type: "committed", threadId, seq: userMessage.seq, message: userMessage });

    const agentName = this.#storage.agentById(thread.agentId)?.name ?? thread.agentId;
    // Invariant: #runTurn never rejects, so `next` never rejects and storing it as-is can
    // never surface an unhandled rejection; closeAll drains these real chain promises.
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    void next.then(() => {
      if (this.#queues.get(threadId) === next) this.#queues.delete(threadId);
    });
    return userMessage;
  }

  /** Runs one agent turn. NEVER rejects: an adapter failure is converted into a turn.failed
   *  marker plus an error frame, and a double fault on that failure path is swallowed. */
  async #runTurn(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): Promise<void> {
    const turnId = randomUUID();
    try {
      let sessionPromise = this.#sessions.get(threadId);
      if (sessionPromise === undefined) {
        sessionPromise = adapter.startSession(threadId);
        this.#sessions.set(threadId, sessionPromise);
      }
      const session = await sessionPromise;
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
          if (!this.#hub.hasClients()) {
            this.#notifier.notify({ threadId, agentName, preview: preview(final.blocks) });
          }
        },
        onDone: () => {
          this.#hub.broadcast({ type: "done", threadId, turnId });
        },
      });
    } catch (err) {
      try {
        const failure = this.#storage.appendMessage(
          threadId,
          {
            role: "system",
            blocks: [{ type: "paragraph", text: "The agent turn failed. Send again to retry." }],
            turnId,
            marker: "turn.failed",
          },
          this.#now(),
        );
        this.#hub.broadcast({ type: "committed", threadId, seq: failure.seq, message: failure });
        const message = err instanceof Error ? err.message : "unknown failure";
        this.#hub.broadcast({ type: "error", code: "turn_failed", message, threadId });
      } catch {
        // Double fault (e.g. storage already closed): swallow to keep the never-rejects
        // invariant; the per-thread chain must stay unbreakable.
      }
    }
  }

  async closeAll(): Promise<void> {
    // Drain every per-thread chain first so no in-flight onCommit races storage.close().
    await Promise.allSettled([...this.#queues.values()]);
    this.#queues.clear();
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

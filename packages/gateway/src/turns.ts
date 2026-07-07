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
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, thread.agentId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    return userMessage;
  }

  async #runTurn(
    threadId: string,
    agentId: string,
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
    }
  }

  async closeAll(): Promise<void> {
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

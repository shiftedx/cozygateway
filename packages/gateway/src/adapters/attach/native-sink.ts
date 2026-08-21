import type { RichBlock, ServerFrame } from "cozygateway-contract";

import type { Storage } from "../../storage.ts";
import type { Notifier } from "../../turns.ts";
import type { AttachV1EventFrame } from "./protocol-v1.ts";

interface AttachNativeSinkDeps {
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  notifier: Notifier;
  connectedDeviceIds: () => ReadonlySet<string>;
  now: () => number;
}

/** Restart-recovery projection for native events that no longer have an in-memory TurnRunner
 * waiter. The normal live path remains the adapter callbacks; this path commits the same existing
 * transcript/client/push contract directly, so a gateway restart does not orphan a Hermes reply. */
export class AttachNativeSink {
  readonly #deps: AttachNativeSinkDeps;

  constructor(deps: AttachNativeSinkDeps) {
    this.#deps = deps;
  }

  handle(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (event.kind === "scheduled") {
      const delivery = this.#deps.storage.attachScheduledDelivery(agentId, event.deliveryId);
      if (delivery === undefined || delivery.threadId !== event.threadId || delivery.messageId !== event.messageId) return false;
      return this.#commit(agentId, event.threadId, event.messageId, event.blocks, event.deliveryId);
    }
    if (!("threadId" in event) || !("turnId" in event)) return false;
    const command = this.#deps.storage.attachTurnCommand(agentId, event.turnId);
    if (command === undefined || command.threadId !== event.threadId) return false;
    if (event.kind === "commit") return this.#commit(agentId, event.threadId, event.messageId, event.blocks, event.turnId);
    if (event.kind !== "failed" && event.kind !== "cancelled" && event.kind !== "interrupted") return false;
    const thread = this.#deps.storage.threadById(event.threadId);
    if (thread === undefined || thread.agentId !== agentId) return false;
    const interrupted = event.kind === "interrupted";
    const message = this.#deps.storage.appendMessage(
      event.threadId,
      {
        role: "system",
        blocks: [{ type: "paragraph", text: interrupted ? "The turn was interrupted." : "The agent turn failed. Send again to retry." }],
        turnId: event.turnId,
        marker: interrupted ? "turn.interrupted" : "turn.failed",
      },
      this.#deps.now(),
    );
    this.#deps.broadcast({ type: "committed", threadId: event.threadId, seq: message.seq, message });
    if (interrupted) this.#deps.broadcast({ type: "done", threadId: event.threadId, turnId: event.turnId });
    else this.#deps.broadcast({ type: "error", code: "turn_failed", message: event.kind === "failed" ? event.message ?? "agent failed" : "agent cancelled", threadId: event.threadId });
    return true;
  }

  #commit(agentId: string, threadId: string, _messageId: string, blocks: RichBlock[], turnId: string): boolean {
    const thread = this.#deps.storage.threadById(threadId);
    if (thread === undefined || thread.agentId !== agentId || blocks.length === 0) return false;
    if (this.#deps.storage.messageByExternalId(threadId, _messageId) !== undefined) return true;
    const message = this.#deps.storage.appendMessage(threadId, { role: "agent", blocks, turnId, externalId: _messageId }, this.#deps.now());
    this.#deps.broadcast({ type: "committed", threadId, seq: message.seq, message });
    this.#deps.broadcast({ type: "done", threadId, turnId });
    const agent = this.#deps.storage.agentById(agentId);
    this.#deps.notifier.notify(
      { threadId, agentName: agent?.name ?? agentId, preview: blocks.map((block) => "text" in block ? block.text : "code" in block ? block.code : "").filter(Boolean).join(" ").slice(0, 240) },
      this.#deps.connectedDeviceIds(),
    );
    return true;
  }
}

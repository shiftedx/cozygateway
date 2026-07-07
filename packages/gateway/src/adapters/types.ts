import type { PresenceState, RichBlock, ToolCall } from "cozygateway-contract";

/** Callbacks for one agent turn. The adapter calls onDraft zero or more times (full-replace
 *  semantics), then exactly one onCommit, then onDone. A failed turn REJECTS the send()
 *  promise instead of calling onCommit/onDone. */
export interface TurnHandlers {
  onDraft(update: { blocks: RichBlock[]; toolCalls: ToolCall[] }): void;
  onCommit(final: { blocks: RichBlock[] }): void;
  onDone(): void;
}

export interface BackendSession {
  send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void>;
  close(): Promise<void>;
}

export interface BackendAdapter {
  readonly backend: string;
  startSession(threadId: string): Promise<BackendSession>;
  presence(): PresenceState;
}

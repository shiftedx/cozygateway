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
  /** Deliver blocks mid-turn into the CURRENTLY in-flight turn of this session (no new turnId).
   *  Present only on steer-capable sessions (adapter.midTurnDelivery === "steer"). Best-effort:
   *  the runner only calls this while the session's send() promise is unsettled. */
  steer?(blocks: RichBlock[]): Promise<void>;
  /** Hard-interrupt the in-flight turn: the pending send() promise rejects, and the runner (which
   *  set its interrupting flag first) records a turn.interrupted system message. Present only on
   *  steer-capable sessions. */
  interrupt?(): Promise<void>;
}

export interface BackendAdapter {
  readonly backend: string;
  /** Static declaration of how a mid-turn send is handled: "steer" delivers into the in-flight
   *  turn (the session exposes steer/interrupt); "queue" serializes behind it as today. */
  readonly midTurnDelivery: "steer" | "queue";
  startSession(threadId: string): Promise<BackendSession>;
  presence(): PresenceState;
}

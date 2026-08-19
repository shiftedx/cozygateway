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
   *  Present only on steer-capable sessions (adapter.midTurnDelivery === "steer"). The runner only
   *  calls this while the session's send() promise is unsettled.
   *
   *  ACCEPTANCE: resolve `false` when the blocks were NOT taken into a live turn (the adapter's own
   *  turn had already settled, there is no live connection, ...). The runner then falls back to a
   *  queued turn carrying the same blocks, so a lost race cannot swallow a user message. Resolve
   *  `true` when they were taken. A REJECTION is read as "not accepted" and takes the same
   *  fallback. `void`/`undefined` is the backward-compatible legacy return and is read as ACCEPTED,
   *  so an out-of-tree adapter written against the older `Promise<void>` shape keeps its
   *  best-effort behavior instead of silently gaining duplicate queued turns; every in-tree
   *  adapter reports a real boolean. */
  steer?(blocks: RichBlock[]): Promise<boolean | void>;
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

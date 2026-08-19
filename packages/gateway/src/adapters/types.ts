import type {
  ApprovalArgSummary,
  ApprovalOutcome,
  PresenceState,
  RichBlock,
  ToolCall,
} from "cozygateway-contract";

/** One tool call inside the turn that is waiting on a human decision. `toolCallId` is the
 *  correlation id everything downstream keys on: the fanned-out frame, the resolve route, the
 *  audit line, and the resolution handed back to this session.
 *
 *  `argSummary` is argument key NAMES mapped to JSON type TAGS, never argument values, and the
 *  type says so (contract/v1.md section 5a). The runner re-validates it against the wire schema
 *  before broadcasting, so an out-of-tree adapter that ignores this cannot leak a raw value onto
 *  every paired device: its approval is refused with an `invalid_request` error frame instead. */
export interface ApprovalRequest {
  toolCallId: string;
  name: string;
  argSummary?: ApprovalArgSummary;
}

/** The only scope a client can express is per-call (native `once`), so the decision is binary. */
export type ApprovalDecision = "approve" | "deny";

/** Callbacks for one agent turn. The adapter calls onDraft zero or more times (full-replace
 *  semantics), then exactly one onCommit, then onDone. A failed turn REJECTS the send()
 *  promise instead of calling onCommit/onDone. */
export interface TurnHandlers {
  onDraft(update: { blocks: RichBlock[]; toolCalls: ToolCall[] }): void;
  onCommit(final: { blocks: RichBlock[] }): void;
  onDone(): void;
  /** OPTIONAL, and optional on purpose: `TurnHandlers` is public surface (it is exported from the
   *  package root), so an out-of-tree host that builds its own handlers object keeps compiling.
   *  An adapter therefore calls it as `handlers.onApprovalPending?.(...)`.
   *
   *  Raise one pending approval for the in-flight turn. The runner records it under the turn's
   *  own turnId and fans it out; a second call for the same toolCallId is ignored. */
  onApprovalPending?(request: ApprovalRequest): void;
  /** Report that a pending approval reached a terminal state the BACKEND decided: in practice
   *  `expired` (the backend's own approval timeout lapsed). A resolution the gateway itself
   *  dispatched is already recorded when `resolveApproval` accepts it, so repeating it here is
   *  harmless and ignored: the first terminal state per toolCallId wins, and exactly one
   *  `approval_resolved` frame is ever emitted for it. */
  onApprovalResolved?(resolution: { toolCallId: string; outcome: ApprovalOutcome }): void;
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
  /** Resolve one approval this session raised through `onApprovalPending`. Present only on
   *  approval-capable sessions; a session that raises approvals without implementing this leaves
   *  them unresolvable, and the gateway answers such a resolve with `backend_unavailable`.
   *
   *  ACCEPTANCE follows the same discipline as `steer` (PR #53): resolve `true` when the decision
   *  was taken into the live turn, `false` when it was not (the backend had already expired or
   *  resolved it, the connection is gone, the id is not the one it is waiting on). A rejection is
   *  read as not accepted. Only an accepted decision becomes an `approval_resolved` frame, so a
   *  lost race reports "not pending" to the caller instead of announcing an outcome that never
   *  happened. */
  resolveApproval?(toolCallId: string, decision: ApprovalDecision): Promise<boolean>;
}

export interface BackendAdapter {
  readonly backend: string;
  /** Static declaration of how a mid-turn send is handled: "steer" delivers into the in-flight
   *  turn (the session exposes steer/interrupt); "queue" serializes behind it as today. */
  readonly midTurnDelivery: "steer" | "queue";
  startSession(threadId: string): Promise<BackendSession>;
  presence(): PresenceState;
}

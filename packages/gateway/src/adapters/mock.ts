import { randomUUID } from "node:crypto";

import type { RichBlock } from "cozygateway-contract";

import type { ApprovalDecision, BackendAdapter, BackendSession, TurnHandlers } from "./types.ts";

function firstText(blocks: RichBlock[]): string {
  const first = blocks[0];
  return first !== undefined && first.type === "paragraph" ? first.text : "(rich content)";
}

/** Reference echo backend. contract/v1.md section 7 freezes these semantics; the conformance
 *  suite asserts them frame by frame. Change nothing here without a contract version bump. It
 *  declares "queue" mid-turn delivery: a send while a turn is in flight serializes behind it. */
export function createMockAdapter(options?: {
  failOn?: string;
  /** Test-only, opt-in and ABSENT by default (so the frozen echo semantics above are untouched):
   *  a message containing this token drafts as usual and then holds the turn in flight for
   *  `holdMs` before committing normally. It exists so a test can catch this queue-only backend
   *  mid-turn -- the only way to drive the runner's "unsupported" interrupt outcome through the
   *  real HTTP stack. The hold is bounded rather than open-ended because TurnRunner.closeAll()
   *  awaits the thread's queue, so a turn that never settled would wedge gateway shutdown. */
  holdOn?: string;
  holdMs?: number;
}): BackendAdapter {
  const failToken = options?.failOn ?? "[[fail]]";
  const holdToken = options?.holdOn;
  const holdMs = options?.holdMs ?? 1_000;

  const session: BackendSession = {
    async send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
      const text = firstText(blocks);
      await Promise.resolve();
      handlers.onDraft({ blocks: [{ type: "paragraph", text: "Echo: " }], toolCalls: [] });
      if (text.includes(failToken)) {
        await Promise.resolve();
        throw new Error("scripted failure");
      }
      if (holdToken !== undefined && text.includes(holdToken)) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, holdMs);
          timer.unref();
        });
      }
      await Promise.resolve();
      const final: RichBlock[] = [{ type: "paragraph", text: `Echo: ${text}` }];
      handlers.onDraft({ blocks: final, toolCalls: [] });
      await Promise.resolve();
      handlers.onCommit({ blocks: final });
      await Promise.resolve();
      handlers.onDone();
    },
    async close(): Promise<void> {},
  };

  return {
    backend: "mock",
    midTurnDelivery: "queue",
    async startSession(): Promise<BackendSession> {
      return session;
    },
    presence: () => "online",
  };
}

/** LLM-free steer-capable backend used to exercise the TurnRunner steer/interrupt policy and the
 *  full HTTP/WS stack end to end. A send emits one draft ("Working: <text>") and stays in flight;
 *  it never completes on its own. A steer folds the steer text ("Working: <text> + <steer>") and
 *  then commits + done + resolves. An interrupt rejects the pending send. One in-flight turn at a
 *  time per session (the runner serializes turns per thread and caches one session per thread). */
export function createSteerMockAdapter(): BackendAdapter {
  return {
    backend: "mock-steer",
    midTurnDelivery: "steer",
    presence: () => "online",
    async startSession(): Promise<BackendSession> {
      let inflight:
        | {
            handlers: TurnHandlers;
            text: string;
            resolve: () => void;
            reject: (err: Error) => void;
            settled: boolean;
          }
        | undefined;

      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          const text = `Working: ${firstText(blocks)}`;
          return new Promise<void>((resolve, reject) => {
            inflight = { handlers, text, resolve, reject, settled: false };
            handlers.onDraft({ blocks: [{ type: "paragraph", text }], toolCalls: [] });
            // Deliberately does not resolve: the turn stays in flight until steer/interrupt.
          });
        },
        async steer(steerBlocks: RichBlock[]): Promise<boolean> {
          const cur = inflight;
          // Race: the turn already ended, so these blocks were NOT taken. Reporting non-acceptance
          // is what lets the runner answer them with a queued turn instead of dropping them.
          if (cur === undefined || cur.settled) return false;
          cur.text = `${cur.text} + ${firstText(steerBlocks)}`;
          const final: RichBlock[] = [{ type: "paragraph", text: cur.text }];
          cur.handlers.onDraft({ blocks: final, toolCalls: [] });
          cur.settled = true;
          cur.handlers.onCommit({ blocks: final });
          cur.handlers.onDone();
          cur.resolve();
          inflight = undefined;
          return true;
        },
        async interrupt(): Promise<void> {
          const cur = inflight;
          if (cur === undefined || cur.settled) return;
          cur.settled = true;
          cur.reject(new Error("interrupted by user"));
          inflight = undefined;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

/** LLM-free approval-capable backend: the reference implementation of the conformance suite's
 *  OPTIONAL approval hook, and the way an approval round trip is drivable in tests with no real
 *  backend behind it. The frozen echo semantics of `createMockAdapter` above are untouched;
 *  approvals live in their own backend for the same reason the stall backend does (issue #21):
 *  the hook needs its own agent id anyway, and the echo backend must keep answering instantly.
 *
 *  A send emits one draft ("Working: <text>"), raises ONE pending approval, and stays in flight.
 *  The turn ends only when the approval reaches a terminal state:
 *  - `resolveApproval` accepts a decision -> the turn commits "Approval <outcome>: <text>";
 *  - nobody decides within `expiryMs` -> the backend lapses the approval itself, reports
 *    `expired`, and commits the same way. That self-lapse is how the third terminal state is
 *    drivable at all without waiting on a real approval timeout, and it is also why the park is
 *    BOUNDED rather than open-ended: TurnRunner.closeAll() awaits each thread's queue, so a turn
 *    nobody ever decided would otherwise wedge gateway shutdown (the same reason
 *    createMockAdapter's hold is bounded). Shorten it to drive expiry deliberately; the default
 *    is long enough that a test which does decide always wins the race. */
export function createApprovalMockAdapter(options?: {
  /** How long a parked approval waits before lapsing itself as `expired`. */
  expiryMs?: number;
}): BackendAdapter {
  const expiryMs = options?.expiryMs ?? 2_000;

  return {
    backend: "mock-approval",
    midTurnDelivery: "queue",
    presence: () => "online",
    async startSession(): Promise<BackendSession> {
      let inflight:
        | { handlers: TurnHandlers; text: string; toolCallId: string; done: boolean; finish: (outcome: string) => void }
        | undefined;

      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          const text = firstText(blocks);
          const toolCallId = `call_${randomUUID()}`;
          return new Promise<void>((resolve) => {
            const finish = (outcome: string): void => {
              const cur = inflight;
              if (cur === undefined || cur.done) return;
              cur.done = true;
              inflight = undefined;
              const final: RichBlock[] = [{ type: "paragraph", text: `Approval ${outcome}: ${text}` }];
              cur.handlers.onDraft({ blocks: final, toolCalls: [] });
              cur.handlers.onCommit({ blocks: final });
              cur.handlers.onDone();
              resolve();
            };
            inflight = { handlers, text, toolCallId, done: false, finish };
            handlers.onDraft({ blocks: [{ type: "paragraph", text: `Working: ${text}` }], toolCalls: [] });
            // argSummary is names + type TAGS only, the same discipline a real backend owes.
            handlers.onApprovalPending?.({
              toolCallId,
              name: "run_shell",
              argSummary: { command: "string" },
            });
            const timer = setTimeout(() => {
              const cur = inflight;
              if (cur === undefined || cur.done) return;
              cur.handlers.onApprovalResolved?.({ toolCallId, outcome: "expired" });
              // Deferred like the decision path below, so the gateway's approval_resolved frame
              // is out before the turn's own closing frames.
              setTimeout(() => cur.finish("expired"), 0).unref();
            }, expiryMs);
            timer.unref();
          });
        },
        async resolveApproval(toolCallId: string, decision: ApprovalDecision): Promise<boolean> {
          const cur = inflight;
          // Not accepted: no pending approval, or not the one this backend is waiting on. The
          // runner turns that into "not pending" rather than announcing an outcome.
          if (cur === undefined || cur.done || cur.toolCallId !== toolCallId) return false;
          // The turn finishes on the next macrotask, AFTER the runner has broadcast the
          // approval_resolved frame this acceptance produces, so the frame order a client sees is
          // deterministic: resolved, then the rest of the turn.
          const outcome = decision === "approve" ? "approved" : "denied";
          setTimeout(() => cur.finish(outcome), 0).unref();
          return true;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

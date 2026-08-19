import { randomUUID } from "node:crypto";

import type { ApprovalOutcome, Message, RichBlock, ServerFrame } from "cozygateway-contract";
import { ApprovalPendingFrameSchema, ContractViolation, assertValid } from "cozygateway-contract";

import type { Storage } from "./storage.ts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  BackendAdapter,
  BackendSession,
} from "./adapters/types.ts";
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

/** Outcome of a resolve dispatch (contract v1.md section 5a). The REST layer maps
 *  approved/denied to 202, `unknown` to 404, `not_pending` to 409 `approval_not_pending`,
 *  `expired` to 409 `approval_expired`, and `unsupported` to 503 `backend_unavailable`. */
export type ApprovalResolveOutcome =
  | "approved"
  | "denied"
  | "unknown"
  | "not_pending"
  | "expired"
  | "unsupported";

/** One approval the runner is tracking. Terminal records are KEPT (bounded, see APPROVAL_MEMORY)
 *  so a late second decision can be answered honestly ("already resolved", "expired") instead of
 *  collapsing into "never heard of it". */
interface ApprovalRecord {
  turnId: string;
  session: BackendSession;
  state: "pending" | ApprovalOutcome;
}

/** Per-thread cap on remembered approvals. Oldest-first eviction: a thread that ran thousands of
 *  approvals forgets its ancient ones (a resolve for one of those reads as unknown), which is the
 *  right trade against unbounded growth in a long-lived gateway. */
const APPROVAL_MEMORY = 200;

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
  /** threadId -> toolCallId -> record. Thread-scoped because every route that reaches an approval
   *  reaches it through a thread, so a correlation id from one thread can never address another
   *  thread's approval even if the ids ever collided. */
  readonly #approvals = new Map<string, Map<string, ApprovalRecord>>();
  readonly #approvalLog: (line: string) => void;

  constructor(deps: {
    storage: Storage;
    hub: Hub;
    adapters: Map<string, BackendAdapter>;
    notifier: Notifier;
    now: () => number;
    /** Per-turn wall-clock bound in milliseconds. 0 (the default when omitted) disables the bound.
     *  server.ts passes config.turnTimeoutSeconds * 1000. */
    turnTimeoutMs?: number;
    /** Audit sink for approval resolutions, one line per terminal transition. Defaults to
     *  stderr, matching how this gateway logs its other security-relevant events (the openclaw
     *  root-token caveat, the push notifier's failures); an injected sink is how a test reads it.
     *  A line names the thread, the turn, the toolCallId, the outcome, and the resolving device.
     *  It NEVER carries the argument summary, let alone an argument value. */
    approvalLog?: (line: string) => void;
  }) {
    this.#approvalLog =
      deps.approvalLog ?? ((line: string) => void process.stderr.write(`${line}\n`));
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
      // Defense in depth, NOT a fix for a live bug: this record is cleared in the microtask before
      // the next request's macrotask, so no HTTP/WS-driven send reaches here against a turn the
      // ADAPTER has already settled. Should that invariant ever stop holding (an in-process
      // caller, a backend that settles its own turn without the runner noticing), the adapter is
      // the only party that knows -- and now it says so. A steer that reports non-acceptance (or
      // rejects) falls back to a normal queued turn carrying these same blocks, so the message is
      // answered instead of dropped on the floor by a best-effort no-op. The already-broadcast
      // delivery marker stays "steer": that frame records the route chosen at submit time and is
      // never rewritten.
      void inflight.session.steer(blocks).then(
        (accepted) => {
          if (accepted === false) this.#enqueueTurn(threadId, agentName, adapter, blocks);
        },
        () => {
          this.#enqueueTurn(threadId, agentName, adapter, blocks);
        },
      );
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

  /** Resolve one pending approval on behalf of an authenticated device.
   *
   *  Server-authoritative by construction: the caller supplies a thread and a correlation id, and
   *  everything that decides what actually gets approved -- which turn, which session, whether it
   *  is still pending -- comes from the runner's own record, never from the request. */
  async resolveApproval(
    threadId: string,
    toolCallId: string,
    decision: ApprovalDecision,
    deviceId: string,
  ): Promise<ApprovalResolveOutcome> {
    const record = this.#approvals.get(threadId)?.get(toolCallId);
    if (record === undefined) return "unknown";
    const settled = this.#settledOutcome(record);
    if (settled !== undefined) return settled;
    if (record.session.resolveApproval === undefined) return "unsupported";

    let accepted = false;
    try {
      accepted = await record.session.resolveApproval(toolCallId, decision);
    } catch {
      // A rejection is read as "not accepted", exactly like steer's acceptance contract.
      accepted = false;
    }
    // The await is a real window: the backend may have expired the approval, or another device
    // may have resolved it, while this call was in flight. The record is re-read rather than
    // trusted from before the await, so the second decision is answered instead of duplicated.
    const settledDuring = this.#settledOutcome(record);
    if (settledDuring !== undefined) return settledDuring;
    if (!accepted) return "not_pending";

    const outcome: ApprovalOutcome = decision === "approve" ? "approved" : "denied";
    this.#settleApproval(threadId, toolCallId, record, outcome, deviceId);
    return outcome;
  }

  #settledOutcome(record: ApprovalRecord): ApprovalResolveOutcome | undefined {
    if (record.state === "pending") return undefined;
    return record.state === "expired" ? "expired" : "not_pending";
  }

  /** Record one pending approval raised by the backend and fan it out. Rejects anything that is
   *  not a valid `approval_pending` frame (in particular an argSummary carrying a raw argument
   *  value): the frame is dropped, an `invalid_request` error frame goes out in its place, and
   *  nothing is recorded, so a resolve for it reads as unknown. */
  #raiseApproval(threadId: string, turnId: string, session: BackendSession, request: ApprovalRequest): void {
    const frame = {
      type: "approval_pending" as const,
      threadId,
      turnId,
      toolCallId: request.toolCallId,
      name: request.name,
      ...(request.argSummary === undefined ? {} : { argSummary: request.argSummary }),
    };
    try {
      assertValid(ApprovalPendingFrameSchema, frame);
    } catch (err) {
      const detail = err instanceof ContractViolation ? err.message : "malformed approval";
      this.#hub.broadcast({
        type: "error",
        code: "invalid_request",
        // Deliberately does not echo the offending value back onto the wire.
        message: `approval refused: ${detail}`,
        threadId,
      });
      return;
    }
    let byId = this.#approvals.get(threadId);
    if (byId === undefined) {
      byId = new Map();
      this.#approvals.set(threadId, byId);
    }
    // Idempotent: a backend that re-announces the same pending approval does not get a second
    // frame, and never resets a record that has already reached a terminal state.
    if (byId.has(request.toolCallId)) return;
    byId.set(request.toolCallId, { turnId, session, state: "pending" });
    while (byId.size > APPROVAL_MEMORY) {
      const oldest = byId.keys().next();
      if (oldest.done === true) break;
      byId.delete(oldest.value);
    }
    this.#hub.broadcast(frame);
  }

  /** A terminal state the BACKEND decided (in practice: its approval timeout lapsed). */
  #backendResolvedApproval(threadId: string, toolCallId: string, outcome: ApprovalOutcome): void {
    const record = this.#approvals.get(threadId)?.get(toolCallId);
    if (record === undefined || record.state !== "pending") return;
    this.#settleApproval(threadId, toolCallId, record, outcome, undefined);
  }

  #settleApproval(
    threadId: string,
    toolCallId: string,
    record: ApprovalRecord,
    outcome: ApprovalOutcome,
    deviceId: string | undefined,
  ): void {
    record.state = outcome;
    this.#approvalLog(
      `approval ${outcome} thread=${threadId} turn=${record.turnId} toolCall=${toolCallId} device=${deviceId ?? "-"}`,
    );
    this.#hub.broadcast({
      type: "approval_resolved",
      threadId,
      turnId: record.turnId,
      toolCallId,
      outcome,
    });
  }

  /** No approval outlives its turn. Whatever is still pending when a turn ends (committed,
   *  failed, or interrupted) can never be answered by that turn's backend, so it lapses as
   *  `expired` -- the outcome that already means "nobody's decision took effect". */
  #expirePendingApprovals(threadId: string, turnId: string): void {
    const byId = this.#approvals.get(threadId);
    if (byId === undefined) return;
    for (const [toolCallId, record] of byId) {
      if (record.turnId === turnId && record.state === "pending") {
        this.#settleApproval(threadId, toolCallId, record, "expired", undefined);
      }
    }
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
    this.#enqueueTurn(threadId, agentName, adapter, blocks);
    return userMessage;
  }

  /** The queue half of #commitAndQueue, without the commit: chain one turn behind whatever this
   *  thread is already running. The steer fallback uses it directly, since its user message was
   *  committed (and broadcast) on the steer path already and must not be committed twice. */
  #enqueueTurn(
    threadId: string,
    agentName: string,
    adapter: BackendAdapter,
    blocks: RichBlock[],
  ): void {
    // Invariant: #runTurn never rejects, so the chain promise never rejects.
    const previous = this.#queues.get(threadId) ?? Promise.resolve();
    const next = previous.then(() => this.#runTurn(threadId, agentName, adapter, blocks));
    this.#queues.set(threadId, next);
    void next.then(() => {
      if (this.#queues.get(threadId) === next) this.#queues.delete(threadId);
    });
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
        onApprovalPending: (request) => {
          this.#raiseApproval(threadId, turnId, session, request);
        },
        onApprovalResolved: (resolution) => {
          this.#backendResolvedApproval(threadId, resolution.toolCallId, resolution.outcome);
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
      // Runs on every exit path (normal, failed, interrupted): nothing this turn raised is left
      // hanging as pending against a turn that is over.
      this.#expirePendingApprovals(threadId, turnId);
    }
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#queues.values()]);
    this.#queues.clear();
    this.#inflight.clear();
    this.#approvals.clear();
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

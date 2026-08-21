import type { ApprovalOutcome, ServerFrame } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";
import type { HermesEvent } from "./client.ts";
import type { StreamBinding } from "./chat-stream.ts";

/** Mobile approve/deny for BOT chats: the hermes leg of cozygateway issue #19.
 *
 *  ## Why this is not the core approval surface
 *
 *  PR #57 put approvals on the threads spine: `TurnHandlers.onApprovalPending`, `TurnRunner`'s
 *  per-thread record, `BackendSession.resolveApproval`, and the `approval_pending` /
 *  `approval_resolved` frames keyed on `threadId`. The bots surface does not go through ANY of
 *  that. It is a parallel path: no `BackendAdapter`, no `TurnRunner`, no thread, no session
 *  object. Its turns are `prompt.submit` plus a `session.resume` poll (`chat-turns.ts`) and every
 *  frame it emits is keyed `bot` + `sessionId`. So a bot's approval cannot ride the core frames,
 *  and this module is the bots-channel mirror of the same lifecycle: capability 10.
 *
 *  ## What hermes actually offers (probe, 2026-08-19, hermes 0.20.3/0.20.4)
 *
 *  ONE event, `approval.request`, on the same `/api/ws` socket everything else here speaks over:
 *
 *  ```
 *  { request_id, command, description, pattern_key, pattern_keys,
 *    allow_permanent, allow_session, smart_denied?, choices }
 *  ```
 *
 *  It carries NO tool call id, NO turn id, NO tool name, and NO structured arguments. So:
 *
 *  - `toolCallId` IS the `request_id`. It is the only correlation key on offer, and it is what the
 *    frame, the resolve route, the audit line and the push collapse id all key on.
 *  - `turnId` is the GATEWAY's own turn for that chat (`chat-stream.ts` mints it and
 *    `bot_chat_delta` already carries it), because the hermes event is session-scoped and names no
 *    turn at all.
 *  - `name` is DERIVED from `pattern_key`; see `approvalName` for the exact rule.
 *  - there is no `argSummary`, on the frame or in the push, because there is nothing structured to
 *    summarize. The frame has no such member at all.
 *  - `command` and `description` are free text. They are NEVER forwarded: not into a frame, not
 *    into a push payload, not into a log line. They are read only to be ignored.
 *
 *  Resolution is the `approval.respond` RPC, `{ session_id, request_id, choice }`, answering
 *  `{"resolved": <int>}`. The injected `/approve` slash command is deliberately NOT used: it
 *  resolves the FIFO-oldest entry and cannot target a `request_id`, which is wrong the moment two
 *  tool calls are pending in one session (parallel subagents make that routine). Only `once` and
 *  `deny` are ever sent; `session` and `always` are native scopes a mobile client is never given.
 *
 *  Expiry is SYNTHESIZED here. Hermes emits no expiry event of any kind: the wait loop falls out of
 *  its deadline, drops the queue entry, and tells nobody. So this module runs its own timer,
 *  seeded to mirror the configured `approvals.timeout` (300 s by default), and a `{"resolved": 0}`
 *  answer maps to the same terminal state, since it means the entry is gone and therefore that
 *  nobody's decision took effect.
 *
 *  ## Deployment, and why this can look dead on a misconfigured box
 *
 *  Two hermes settings decide whether this module ever sees anything, and neither is visible on
 *  the wire (see `docs/agent-install.md`):
 *
 *  - `approvals.mode` defaults to `smart`, an aux-LLM guardian that can APPROVE a call with no
 *    event emitted at all. A bridged profile must pin `manual`.
 *  - `security.approval.transport`, if set, routes the whole prompt to a plugin BEFORE the gateway
 *    branch, so approvals never reach the WS. A bridged profile must not set it.
 */

/** The hermes `approvals.timeout` default, in milliseconds. Mirrored rather than read: the value
 *  is not exposed on the JSON-RPC surface (`config.get` offers `approvals.mode` and not the
 *  timeout), so an operator who changes it hermes-side sets the matching gateway knob too. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** Longest derived `name` this module will put on a frame. A pattern key is hermes-side data of
 *  unbounded length; the cap is a bound on what crosses the wire, not a claim about its content. */
export const APPROVAL_NAME_MAX = 120;

/** What `name` reads when hermes sent no usable pattern key. Deliberately a fixed literal rather
 *  than anything derived from `command`: an honest "we do not know" beats a leaked shell line. */
export const APPROVAL_NAME_FALLBACK = "unknown";

/** Per-bot cap on remembered approvals. Terminal records are KEPT (bounded) so a late second
 *  decision is answered honestly instead of collapsing into "never heard of it"; oldest-first
 *  eviction is the trade against unbounded growth in a long-lived gateway. Same rule, and the same
 *  number, as `TurnRunner`'s per-thread cap. */
export const APPROVAL_MEMORY = 200;

/** Outcome of a resolve dispatch, mirroring `TurnRunner`'s vocabulary one for one so the bots
 *  route can map it to exactly the statuses the core route maps to (contract v1.md section 5a):
 *  approved/denied to 202, `unknown` to 404, `not_pending` to 409 `approval_not_pending`,
 *  `expired` to 409 `approval_expired`, and `unsupported` to 503 `backend_unavailable`. */
export type BotApprovalResolveOutcome =
  | "approved"
  | "denied"
  | "unknown"
  | "not_pending"
  | "expired"
  | "unsupported";

/** The only scope a client can express is per-call (native `once`), so the decision is binary. */
export type BotApprovalDecision = "approve" | "deny";

/** What a turn path knows about a runtime session, and all this module is allowed to ask it: who
 *  the session belongs to, and which turn the client is currently seeing for it. Narrow on
 *  purpose, so the approval path cannot reach into the draft and a test can stand in for it. */
export interface ApprovalChatLookup {
  /** Who a hermes RUNTIME session id belongs to, or undefined for a session this gateway is not
   *  driving (a human talking to the same hermes from the desktop). */
  binding(runtimeSessionId: string): StreamBinding | undefined;
  /** The turn id a client is currently rendering for that session (`bot_chat_delta.turnId`), or
   *  undefined when no turn is in flight. */
  turnId(runtimeSessionId: string): string | undefined;
}

/** The out-of-band leg, for a device with no live socket. Shaped in the bots surface's own terms;
 *  mapping it onto the push-v0 payload (which is keyed `threadId` + `agentId`) is the caller's
 *  job, exactly as it is for the group escalation. */
export type BotApprovalPush =
  | {
      kind: "approval_pending";
      bot: string;
      sessionId: string;
      turnId: string;
      toolCallId: string;
      name: string;
    }
  | {
      kind: "approval_resolved";
      bot: string;
      sessionId: string;
      turnId: string;
      toolCallId: string;
      outcome: ApprovalOutcome;
    };

export interface BotApprovalsOptions {
  rpc: HermesRpc;
  chat: ApprovalChatLookup;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** How long a pending approval waits before this module calls it `expired`. Mirror of the
   *  hermes `approvals.timeout`. Default `DEFAULT_APPROVAL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Operational log. Never carries an approval's free text. */
  log?: (message: string) => void;
  /** Audit sink, one line per terminal transition, naming the bot, the chat, the turn, the
   *  toolCallId, the outcome and the deciding device. It never carries anything describing the
   *  action itself. Defaults to the operational log. */
  approvalLog?: (line: string) => void;
  /** Raised on every pending and every resolution. Unset (as in every test that does not care)
   *  means the lifecycle stays in-band. */
  raisePush?: (event: BotApprovalPush) => void;
}

interface ApprovalRecord {
  bot: string;
  /** The STORED chat id, the one every bots frame is keyed on. */
  sessionId: string;
  /** The hermes RUNTIME session id `approval.respond` must be addressed to. Held here, and read
   *  from here on resolve, so nothing a client sends can steer which session gets answered. */
  runtimeId: string;
  turnId: string;
  room: string | undefined;
  name: string;
  state: "pending" | ApprovalOutcome;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** The hermes correlation key, and the only one on the event. */
export function approvalRequestId(payload: unknown): string | undefined {
  return nonEmptyString(asRecord(payload)?.["request_id"]);
}

/** THE NAME DERIVATION RULE, in one place so it can be pointed at.
 *
 *  `name` on the core frame is a tool name. The hermes event has no tool name, so the closest
 *  honest thing it does carry is `pattern_key`: the approval RULE that matched (`terminal:rm`,
 *  `execute_code:python`, `<tool> (plugin approval rule)`). It is a classification of the action,
 *  not the action, which is exactly what a name should be.
 *
 *  1. `pattern_key`, trimmed, when it is a non-empty string.
 *  2. else the first non-empty string in `pattern_keys`.
 *  3. else `APPROVAL_NAME_FALLBACK`, a fixed literal.
 *
 *  Then capped at `APPROVAL_NAME_MAX`.
 *
 *  Step 3 is the honest fallback and it is deliberately NOT "fall back to `command`". Every
 *  hermes path that raises an approval sets `pattern_key`, so step 3 should be unreachable in
 *  practice; it exists because a payload shape this module cannot read is a payload it must not
 *  guess about, and `command` is free text that may still hold a secret-shaped literal the
 *  upstream redactor missed. A client that sees `unknown` learns that hermes described the rule in
 *  a way this gateway did not recognize, which is true, rather than being shown a shell line. */
export function approvalName(payload: unknown): string {
  const record = asRecord(payload);
  const direct = nonEmptyString(record?.["pattern_key"]);
  let name = direct;
  if (name === undefined) {
    const keys = record?.["pattern_keys"];
    if (Array.isArray(keys)) {
      for (const key of keys) {
        const candidate = nonEmptyString(key);
        if (candidate !== undefined) {
          name = candidate;
          break;
        }
      }
    }
  }
  return (name ?? APPROVAL_NAME_FALLBACK).slice(0, APPROVAL_NAME_MAX);
}

/** `approval.respond` answers `{"resolved": <int>}`, the number of entries it resolved. Anything
 *  that is not a positive integer reads as zero, which is the "the entry is gone" path. */
function resolvedCount(result: unknown): number {
  const value = asRecord(result)?.["resolved"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export class BotApprovals {
  readonly #rpc: HermesRpc;
  readonly #chat: ApprovalChatLookup;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #approvalLog: (line: string) => void;
  readonly #raisePush: ((event: BotApprovalPush) => void) | undefined;

  /** bot -> toolCallId -> record. Per BOT, not global, so a correlation id from one bot's chat can
   *  never address another bot's approval even if the ids ever collided: the route reaches a
   *  record only through the bot named in its path. */
  readonly #records = new Map<string, Map<string, ApprovalRecord>>();
  #mintSeq = 0;
  #closed = false;

  constructor(opts: BotApprovalsOptions) {
    this.#rpc = opts.rpc;
    this.#chat = opts.chat;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.#log = opts.log ?? (() => {});
    this.#approvalLog = opts.approvalLog ?? this.#log;
    this.#raisePush = opts.raisePush;
  }

  /** Every hermes event frame passes through here. Only `approval.request` is read. */
  handleEvent(event: HermesEvent): void {
    if (event.type !== "approval.request") return;
    if (event.sessionId === undefined) return;
    this.ingest(event.sessionId, event.payload);
  }

  /** Records one pending approval and fans it out. Public because hermes reports the SAME entry on
   *  two surfaces: the live `approval.request` event, and `session.info`'s `pending_approval`
   *  replay a reconnecting client gets. Both land here and the second one is silent, because the
   *  record is keyed on `request_id` and an id already known is never re-raised. That dedupe is
   *  what keeps a reconnect from putting a second banner on every phone for an approval the
   *  gateway is already tracking. */
  ingest(runtimeSessionId: string, payload: unknown): void {
    if (this.#closed) return;
    const toolCallId = approvalRequestId(payload);
    if (toolCallId === undefined) return;
    const binding = this.#chat.binding(runtimeSessionId);
    if (binding === undefined) {
      // A session this gateway is not driving: a human at the hermes desktop, or a bot chat this
      // process has not submitted into since it started. There is no chat to attach the approval
      // to and no id a client could address it by, so it is dropped rather than invented.
      this.#log("dropped an approval for a hermes session this gateway is not driving");
      return;
    }
    let byId = this.#records.get(binding.bot);
    if (byId === undefined) {
      byId = new Map();
      this.#records.set(binding.bot, byId);
    }
    if (byId.has(toolCallId)) return;

    const record: ApprovalRecord = {
      bot: binding.bot,
      sessionId: binding.sessionId,
      runtimeId: runtimeSessionId,
      // The turn a client is already rendering for this chat, so the approval lands on the bubble
      // it belongs to. When no turn is in flight (an approval raised by a routine, a turn whose
      // draft never started) one is minted and then held for the life of the approval, so the
      // pending frame and the resolved frame always agree.
      turnId: this.#chat.turnId(runtimeSessionId) ?? `${runtimeSessionId}#approval-${this.#now()}-${(this.#mintSeq += 1)}`,
      room: binding.room,
      name: approvalName(payload),
      state: "pending",
      timer: undefined,
    };
    byId.set(toolCallId, record);
    while (byId.size > APPROVAL_MEMORY) {
      const oldest = byId.keys().next();
      if (oldest.done === true) break;
      this.#clearTimer(byId.get(oldest.value));
      byId.delete(oldest.value);
    }

    // Hermes tells nobody when its own timeout lapses, so the gateway is the only thing that can
    // end a pending approval nobody answered. unref() keeps it from holding the process open.
    const timer = setTimeout(() => {
      record.timer = undefined;
      this.#settle(toolCallId, record, "expired", undefined);
    }, this.#timeoutMs);
    timer.unref?.();
    record.timer = timer;

    this.#broadcast({
      type: "bot_approval_pending",
      bot: record.bot,
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolCallId,
      name: record.name,
      updatedAt: this.#now(),
      ...(record.room === undefined ? {} : { room: record.room }),
    });
    this.#raisePush?.({
      kind: "approval_pending",
      bot: record.bot,
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolCallId,
      name: record.name,
    });
  }

  /** Resolve one pending approval on behalf of an authenticated device.
   *
   *  Server-authoritative by construction, the same posture the core route has: the caller names a
   *  bot and a correlation id, and everything that decides what actually gets approved -- which
   *  hermes session, which turn, whether it is still pending -- comes from this module's own
   *  record. A client cannot address a hermes session, cannot pick a scope, and cannot reach an
   *  approval belonging to a bot other than the one in its URL. */
  async resolve(
    bot: string,
    toolCallId: string,
    decision: BotApprovalDecision,
    deviceId: string,
  ): Promise<BotApprovalResolveOutcome> {
    const record = this.#records.get(bot)?.get(toolCallId);
    if (record === undefined) return "unknown";
    const settled = settledOutcome(record);
    if (settled !== undefined) return settled;

    let count: number;
    try {
      count = resolvedCount(
        await this.#rpc.request("approval.respond", {
          session_id: record.runtimeId,
          request_id: toolCallId,
          // `once` and `deny` ONLY. `session` and `always` write to the session or the permanent
          // allow-list, which is a scope a phone is never handed; `all` would resolve every
          // pending entry in the session, which is a decision nobody made.
          choice: decision === "approve" ? "once" : "deny",
        }),
      );
    } catch (err) {
      // Either hermes said no (an old build with no `approval.respond`, a session it no longer
      // knows) or the link could not carry the call. Both mean the decision did NOT land, so
      // nothing is announced and the approval stays pending until its timer ends it.
      this.#log(
        `could not resolve an approval for ${bot}: ${err instanceof Error ? err.message : "unknown"}`,
      );
      return "unsupported";
    }
    // The await is a real window: the timer may have fired, or another device may have resolved
    // it, while the call was in flight. The record is re-read rather than trusted from before.
    const during = settledOutcome(record);
    if (during !== undefined) return during;
    if (count <= 0) {
      // Hermes no longer had the entry. That conflates expired / already resolved elsewhere /
      // session closed, and every one of those means nobody's decision took effect, which is
      // exactly what `expired` means on this wire.
      this.#settle(toolCallId, record, "expired", deviceId);
      return "expired";
    }
    const outcome: ApprovalOutcome = decision === "approve" ? "approved" : "denied";
    this.#settle(toolCallId, record, outcome, deviceId);
    return outcome;
  }

  /** Drops everything held for one bot: its records and their timers. Called when a bot's chat is
   *  retired or its profile deleted, so an approval can never outlive the thing it belonged to. */
  forgetBot(name: string): void {
    const byId = this.#records.get(name);
    if (byId === undefined) return;
    for (const record of byId.values()) this.#clearTimer(record);
    this.#records.delete(name);
  }

  close(): void {
    this.#closed = true;
    for (const byId of this.#records.values()) {
      for (const record of byId.values()) this.#clearTimer(record);
    }
    this.#records.clear();
  }

  /** Test seam: is this approval still awaiting a decision? */
  pending(bot: string, toolCallId: string): boolean {
    return this.#records.get(bot)?.get(toolCallId)?.state === "pending";
  }

  #settle(
    toolCallId: string,
    record: ApprovalRecord,
    outcome: ApprovalOutcome,
    deviceId: string | undefined,
  ): void {
    if (this.#closed || record.state !== "pending") return;
    record.state = outcome;
    this.#clearTimer(record);
    this.#approvalLog(
      `approval ${outcome} bot=${record.bot} session=${record.sessionId} turn=${record.turnId} toolCall=${toolCallId} device=${deviceId ?? "-"}`,
    );
    this.#broadcast({
      type: "bot_approval_resolved",
      bot: record.bot,
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolCallId,
      outcome,
      updatedAt: this.#now(),
      ...(record.room === undefined ? {} : { room: record.room }),
    });
    this.#raisePush?.({
      kind: "approval_resolved",
      bot: record.bot,
      sessionId: record.sessionId,
      turnId: record.turnId,
      toolCallId,
      outcome,
    });
  }

  #clearTimer(record: ApprovalRecord | undefined): void {
    if (record?.timer === undefined) return;
    clearTimeout(record.timer);
    record.timer = undefined;
  }
}

function settledOutcome(record: ApprovalRecord): BotApprovalResolveOutcome | undefined {
  if (record.state === "pending") return undefined;
  return record.state === "expired" ? "expired" : "not_pending";
}

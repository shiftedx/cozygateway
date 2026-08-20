import type { BotToolStep, ServerFrame } from "cozygateway-contract";

import type { StreamBinding } from "./chat-stream.ts";
import type { HermesEvent } from "./client.ts";

/** Live tool activity for BOT chats: cozygateway issue #60, ext-bots capability 12.
 *
 *  Kyle's dogfood note is the whole brief: a bot ran a long turn and the app could show only
 *  "thinking". This module is what turns that into a strip of chips that fills in as the turn runs.
 *
 *  ## What hermes actually offers (probe, 2026-08-19, hermes 0.20.3/0.20.4)
 *
 *  Two events on the same `/api/ws` socket everything else here speaks over, both keyed on the
 *  RUNTIME session id and both gated on `display.tool_progress`:
 *
 *  ```
 *  tool.start     { tool_id, name, context, args?, args_text? }        server.py:5812-5843
 *  tool.complete  { tool_id, name, args, duration_s?, result,
 *                   summary?, result_text?, todos?, inline_diff? }     server.py:5845-5885
 *  ```
 *
 *  `tool_id` is the correlation key the pair shares. Everything else about the shape is a problem
 *  this module exists to solve:
 *
 *  - **No turn id, on either event.** The stream's own turn is used instead, exactly as the approval
 *    leg does, so `bot_tool_activity`, `bot_chat_delta` and `bot_approval_pending` all name the same
 *    turn for the same bubble. A turn is delimited on the hermes stream only by the `message.start`
 *    / `message.complete` envelope (server.py:10529, :11050), which is why `message.complete` is the
 *    third event read here: it is the only signal that a turn is over.
 *  - **No status flag on `tool.complete`.** The executor computes `is_error` and passes it on a
 *    DIFFERENT callback (tool_executor.py:1804-1810), and `_on_tool_complete` is invoked without it
 *    (tool_executor.py:1829-1834), so the flag is dropped before the event is built. The outcome
 *    therefore has to be classified from `result` here; `toolStepStatus` is that rule, and it is the
 *    same move the OpenClaw adapter makes on the threads surface, where an `error` string is
 *    collapsed to a boolean at the narrowing site and never forwarded.
 *  - **No pairing guarantee.** A blocked call emits neither event (tool_executor.py:640), and a turn
 *    that dies between the two emits only the start. So a start with no completion is expected, and
 *    the turn-end sweep is what stops a chip spinning forever.
 *  - **Tools run concurrently** in a thread pool (tool_executor.py:1464), so several starts are open
 *    at once and completions arrive out of order. Correlation is strictly by `tool_id`, never by
 *    ordering.
 *
 *  ## Redaction: the shape is the guard
 *
 *  `BotToolStep` has no member that can hold tool input or tool output, and that is deliberate
 *  rather than incidental. Of the fields hermes offers, the probe found exactly three that are
 *  safe -- `name`, `tool_id` and `duration_s` -- and every other one radioactive:
 *
 *  - `args` is the raw argument map, unredacted but for `browser_type.text` (display.py:400-414):
 *    full file contents on a write, full shell commands, full patches.
 *  - `context` is `build_tool_preview(..., max_len=80)`: the raw shell command, file paths, search
 *    queries, message bodies, truncated to 80 characters and otherwise untouched.
 *  - `result` gets no redaction of any kind (server.py:5857-5860): command stdout, file contents.
 *  - `inline_diff` is verbatim file content; `todos` is user-authored task text.
 *  - `args_text` / `result_text` DO go through `redact_sensitive_text`, but secret-redacted raw
 *    content is still raw content.
 *  - `summary` is a bounded phrasing in two branches and arbitrary tool text in a third (its
 *    `fallback_warning` branch, server.py:5804-5807), so it is treated as unbounded.
 *
 *  NONE of them is read for anything that leaves this process. `result` is read, once, to decide
 *  between two literals. Nothing is forwarded into a frame, a stored row, a push payload or a log
 *  line. A member that does not exist cannot leak.
 *
 *  ## Not pushed
 *
 *  There is no `raisePush` here and there is no push kind for a tool step. Chips are a foreground
 *  surface: they are worth showing to somebody watching a turn run and worth nothing to a phone in
 *  a pocket, where they would be a stream of notifications about something nobody was asked to
 *  decide. `contract/push-v0.md` keeps its three payload kinds and this capability adds none.
 *
 *  ## Durability
 *
 *  Hermes replays no tool LIFECYCLE on reconnect: no status, no timing, nothing on `session.info`
 *  and nothing in a `session.resume` inflight snapshot (methods_session.py:520 and friends, whose
 *  `inflight` is always `None`). Its `session.history` projection does re-serve `{name, context,
 *  args}` for persisted tool rows (server.py:7518-7525) -- which is to say it re-serves the
 *  radioactive half and none of the half this surface renders. So the gateway writes its own steps
 *  down, through the `store` seam, and serves them back on `GET /bots/:name/chat/messages`. Without
 *  that, a turn's activity would exist for exactly as long as one socket stayed open.
 *
 *  ## Deployment, and why this can look dead on a misconfigured box
 *
 *  One hermes setting decides whether this module ever sees anything, and it is not visible on the
 *  wire: `display.tool_progress` (server.py:4450-4460). It defaults to `all`, so the ordinary case
 *  is that this works; set to `off` it suppresses both events and a bridged profile goes silent
 *  here while looking perfectly healthy everywhere else.
 */

/** How long a stored tool step stays fetchable. Far longer than the photo TTL and for the opposite
 *  reason: a step is a handful of columns rather than bytes, and the whole point of writing it down
 *  is that the collapsed strip under an old reply still expands. 90 days is the bound on unbounded
 *  growth, not a retention policy anyone asked for. */
export const TOOL_STEP_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Longest `name` this module will put on a frame. */
export const TOOL_NAME_MAX = 120;

/** What `name` reads when hermes sent none, or none that survived narrowing. Deliberately a fixed
 *  literal and deliberately NOT a fall back to `context` or `args`, which are the free-text fields
 *  this whole module exists to keep off the wire. The same literal hermes' own desktop uses. */
export const TOOL_NAME_FALLBACK = "tool";

/** The identifier class a tool name is narrowed to. Hermes' own MCP namespacing already sanitizes
 *  to `[A-Za-z0-9_]` (mcp_tool.py:6381-6389) and native tool names are registry constants, so on
 *  every path the probe could trace this rewrites nothing. It is here for the path it could not
 *  vouch for: the codex runtime derives a name from provider items with no allow-list at all, and a
 *  name is the one piece of hermes text this frame carries. Dot, colon and dash are kept because
 *  they appear in legitimate tool identifiers; everything that could make a name read as a path, a
 *  command or a sentence does not survive. */
const NAME_UNSAFE = /[^A-Za-z0-9_.:-]+/g;

/** How often a turn's activity may go on the wire. Same reasoning and same number as the chat
 *  draft's throttle: a turn firing tools in a tight loop should cost frames per second, not frames
 *  per event. Terminal frames ignore it -- the end of a step is news. */
export const TOOL_ACTIVITY_THROTTLE_MS = 200;

/** How many steps one turn may report. A frame carries the whole set, so this bounds the frame as
 *  well as the memory: past it new steps are dropped and the ones already open still finish, which
 *  keeps a runaway loop from turning one turn into an unbounded broadcast. */
export const MAX_STEPS_PER_TURN = 200;

/** One step, as it is written down. The store seam is this narrow on purpose: it is the only thing
 *  in this module that touches a database, and everything it carries is already on the wire. */
export interface ToolStepRecord {
  bot: string;
  sessionId: string;
  turnId: string;
  stepId: string;
  seq: number;
  name: string;
  status: BotToolStep["status"];
  startedAt: number;
  endedAt: number | undefined;
}

/** Where a step goes to survive the socket it was seen on. */
export interface ToolStepStore {
  record(step: ToolStepRecord): void;
}

/** What a turn path knows about a runtime session, and all this module is allowed to ask it. The
 *  same pair the approval leg asks for, and for the same reason: a step belongs to the turn whose
 *  bubble the user is looking at, and the bindings are written in exactly one place. */
export interface ToolActivityChatLookup {
  binding(runtimeSessionId: string): StreamBinding | undefined;
  turnId(runtimeSessionId: string): string | undefined;
}

export interface BotToolActivityOptions {
  chat: ToolActivityChatLookup;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  store: ToolStepStore;
  throttleMs?: number;
  /** Operational log. Never carries anything a tool was asked to do or returned. */
  log?: (message: string) => void;
}

const TOOL_START = "tool.start";
const TOOL_COMPLETE = "tool.complete";
const MESSAGE_COMPLETE = "message.complete";

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

/** The hermes correlation key a step's start and completion share. */
export function toolStepId(payload: unknown): string | undefined {
  return nonEmptyString(asRecord(payload)?.["tool_id"]);
}

/** THE NAME RULE, in one place so it can be pointed at: narrow to the identifier class, cap, and
 *  fall back to a fixed literal rather than to any other member of the payload. */
export function toolStepName(payload: unknown): string {
  const raw = nonEmptyString(asRecord(payload)?.["name"]);
  if (raw === undefined) return TOOL_NAME_FALLBACK;
  const narrowed = raw.replace(NAME_UNSAFE, "_").slice(0, TOOL_NAME_MAX).replace(/^_+|_+$/g, "");
  return narrowed.length === 0 ? TOOL_NAME_FALLBACK : narrowed;
}

/** Error-shaped strings hermes synthesizes when it could not run a tool at all. Both are fixed
 *  prefixes it writes itself (tool_executor.py:1657, :1691, :1069-1072), which is what makes
 *  matching them safe where a substring search for "error" anywhere in a result would not be: an
 *  ordinary result that merely mentions the word is not a failure. */
const ERROR_PREFIXES = ["Error executing tool", "Error:", "[Tool execution cancelled"];

/** THE STATUS RULE. Hermes drops its own `is_error` flag before the event is built, so the outcome
 *  is reconstructed here from structure, mirroring the in-tree heuristic `_detect_tool_failure`
 *  (display.py:1335-1382) but taking only its structured arms:
 *
 *  1. a non-zero `exit_code` -- the one truly structured failure signal hermes offers;
 *  2. `success: false`, or a present `error` key, which is the shape every other tool uses;
 *  3. a `status` of `cancelled`, `failed` or `error`, which is how an interrupt and a guardrail
 *    block come back;
 *  4. one of the fixed prefixes hermes writes when it returns an unparsed error string.
 *
 *  Anything else is `ok`. The broad `'"error"' in lower` string sniff the display heuristic falls
 *  back to is deliberately NOT copied: it calls any result that happens to contain the word a
 *  failure, and a chip that goes red because a build log mentioned an error is worse than one that
 *  stays green because a rare tool reported its failure in prose.
 *
 *  `result` is read here and NOWHERE else. What leaves this function is one of two literals. */
export function toolStepStatus(payload: unknown): BotToolStep["status"] & ("ok" | "error") {
  const result = asRecord(payload)?.["result"];
  if (typeof result === "string") {
    return ERROR_PREFIXES.some((prefix) => result.startsWith(prefix)) ? "error" : "ok";
  }
  const record = asRecord(result);
  if (record === undefined) return "ok";
  const exit = record["exit_code"];
  if (typeof exit === "number" && exit !== 0) return "error";
  if (record["success"] === false) return "error";
  if (record["error"] !== undefined && record["error"] !== null) return "error";
  const status = record["status"];
  if (status === "cancelled" || status === "failed" || status === "error") return "error";
  return "ok";
}

interface StepState {
  seq: number;
  name: string;
  status: BotToolStep["status"];
  startedAt: number;
  endedAt: number | undefined;
}

interface TurnActivity {
  turnId: string;
  binding: StreamBinding;
  /** stepId -> state, in first-seen order, which is the order the frame carries. */
  steps: Map<string, StepState>;
  /** Frame seq, monotonic within the turn from 1. */
  frameSeq: number;
  /** Serialized steps of the last frame that went out, so an unchanged snapshot is silent. */
  emitted: string;
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastEmitAt: number;
}

export class BotToolActivity {
  readonly #chat: ToolActivityChatLookup;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #store: ToolStepStore;
  readonly #throttleMs: number;
  readonly #log: (message: string) => void;

  /** runtime session id -> the turn currently reporting activity on it. */
  readonly #turns = new Map<string, TurnActivity>();
  #mintSeq = 0;
  #closed = false;

  constructor(opts: BotToolActivityOptions) {
    this.#chat = opts.chat;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#store = opts.store;
    this.#throttleMs = opts.throttleMs ?? TOOL_ACTIVITY_THROTTLE_MS;
    this.#log = opts.log ?? (() => {});
  }

  /** Every hermes event frame passes through here. Only the three types named above are read, and
   *  the `default` branch is the same deliberate drop `chat-stream.ts` documents: an event this
   *  module does not name is not a case, it is the default, and the default returns. */
  handleEvent(event: HermesEvent): void {
    if (this.#closed) return;
    const runtimeId = event.sessionId;
    if (runtimeId === undefined) return;
    switch (event.type) {
      case TOOL_START:
        this.#onStep(runtimeId, event.payload, false);
        return;
      case TOOL_COMPLETE:
        this.#onStep(runtimeId, event.payload, true);
        return;
      case MESSAGE_COMPLETE:
        this.#finish(runtimeId);
        return;
      default:
        return;
    }
  }

  /** Drops everything held for one bot. Called when its chat is retired or its profile deleted, so
   *  activity can never outlive the turn it described. Silent: no terminal frame is emitted for a
   *  chat that is going away. */
  forgetBot(name: string): void {
    for (const [runtimeId, turn] of [...this.#turns]) {
      if (turn.binding.bot !== name) continue;
      this.#drop(runtimeId);
    }
  }

  /** Drops every turn in flight WITHOUT emitting anything. Called when the hermes link leaves
   *  `online`: the events that would have completed those steps went with the socket, and claiming
   *  an outcome for them would be inventing one. The stored rows stay as they were last written. */
  reset(): void {
    for (const runtimeId of [...this.#turns.keys()]) this.#drop(runtimeId);
  }

  close(): void {
    this.#closed = true;
    this.reset();
  }

  /** Test seam: the steps currently reported for a runtime session. */
  steps(runtimeSessionId: string): BotToolStep[] {
    const turn = this.#turns.get(runtimeSessionId);
    return turn === undefined ? [] : snapshot(turn);
  }

  #onStep(runtimeId: string, payload: unknown, terminal: boolean): void {
    const stepId = toolStepId(payload);
    if (stepId === undefined) {
      // Without the correlation key a start can never be matched to its completion, and a step that
      // can only ever spin is worse than no step. Dropped rather than given a minted id.
      this.#log("dropped a hermes tool event carrying no tool id");
      return;
    }
    const turn = this.#turnFor(runtimeId);
    if (turn === undefined) return;

    const at = this.#now();
    let step = turn.steps.get(stepId);
    if (step === undefined) {
      // Past the cap the turn stops taking new steps. Steps already open are unaffected: they still
      // complete, so the strip a client is watching finishes rather than freezing.
      if (turn.steps.size >= MAX_STEPS_PER_TURN) return;
      // A completion with no start is recorded anyway. The event stream this gateway attached to
      // mid-turn delivers exactly that, and a step known only by its end is still a true thing that
      // happened.
      step = { seq: turn.steps.size + 1, name: toolStepName(payload), status: "running", startedAt: at, endedAt: undefined };
      turn.steps.set(stepId, step);
    }
    if (terminal && step.status === "running") {
      step.status = toolStepStatus(payload);
      step.endedAt = at;
    }
    this.#persist(turn, stepId, step);
    this.#schedule(runtimeId, turn);
  }

  /** The turn a step belongs to, opening one when there is none and rolling over when the chat has
   *  moved on to the next. */
  #turnFor(runtimeId: string): TurnActivity | undefined {
    const current = this.#turns.get(runtimeId);
    // The turn a client is already rendering for this chat, so activity lands on the bubble it
    // belongs to. When no turn is in flight (a step raised by a routine, a turn whose draft never
    // started) one is minted and then held for the life of the turn, exactly as the approval leg
    // mints one, so every frame of the turn agrees about which turn it is.
    const live = this.#chat.turnId(runtimeId);
    if (current !== undefined && !current.finished && (live === undefined || live === current.turnId)) {
      return current;
    }
    if (current !== undefined) {
      // A turn already closed out, with the chat still on that same turn: this is a late event for
      // a strip the client has been told is finished. Dropped. Opening a fresh turn under the same
      // turn id would replace the completed strip a client is rendering with a one-step one, which
      // is a visible regression where dropping the event is invisible.
      if (current.finished && (live === undefined || live === current.turnId)) return undefined;
      // A different turn id means the previous one is over even if no `message.complete` said so.
      // Closed out properly rather than abandoned, so its steps reach a terminal state.
      this.#finish(runtimeId);
    }

    const binding = this.#chat.binding(runtimeId);
    if (binding === undefined) {
      // A session this gateway is not driving: a human at the hermes desktop, or a bot chat this
      // process has not submitted into since it started. There is no chat to attach activity to, so
      // it is dropped rather than invented.
      this.#log("dropped hermes tool activity for a session this gateway is not driving");
      return undefined;
    }
    const turn: TurnActivity = {
      turnId: live ?? `${runtimeId}#tools-${this.#now()}-${(this.#mintSeq += 1)}`,
      binding,
      steps: new Map(),
      frameSeq: 0,
      emitted: "",
      finished: false,
      timer: undefined,
      // Zero, not `now()`: the first frame of a turn goes out immediately rather than waiting out a
      // throttle window the turn never used.
      lastEmitAt: 0,
    };
    this.#turns.set(runtimeId, turn);
    return turn;
  }

  /** Closes a turn out: sweeps anything still running to a terminal state and sends the `done`
   *  frame. A turn that ran no tools is closed silently -- there was never a strip to finish. */
  #finish(runtimeId: string): void {
    const turn = this.#turns.get(runtimeId);
    if (turn === undefined || turn.finished) return;
    turn.finished = true;
    this.#clearTimer(turn);
    if (turn.steps.size === 0) {
      this.#turns.delete(runtimeId);
      return;
    }
    const at = this.#now();
    for (const [stepId, step] of turn.steps) {
      if (step.status !== "running") continue;
      // The turn ended and this step never reported. `error` is what that means on this wire (see
      // `BotToolStep.status`): not a claim that the tool failed, a statement that it did not finish
      // cleanly. Leaving it `running` would spin a chip forever, and calling it `ok` would claim an
      // outcome nobody observed.
      step.status = "error";
      step.endedAt = at;
      this.#persist(turn, stepId, step);
    }
    this.#emit(runtimeId, turn, true);
    // Kept, marked finished, rather than deleted, so a late event for a turn the client has already
    // been told is over reopens nothing: `#turnFor` sees a finished turn and starts a fresh one.
  }

  #persist(turn: TurnActivity, stepId: string, step: StepState): void {
    // Defense in depth: the ws event fan-out that calls this already guards each handler against a
    // throw (cozygateway#65), but this write is synchronous SQLite and worth its own guard so a
    // storage failure (SQLITE_BUSY, disk, missing table) degrades to "this step wasn't recorded"
    // rather than propagating at all. A tool chip is never worth the link.
    try {
      this.#store.record({
        bot: turn.binding.bot,
        sessionId: turn.binding.sessionId,
        turnId: turn.turnId,
        stepId,
        seq: step.seq,
        name: step.name,
        status: step.status,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#log(`failed to persist tool step ${stepId} for turn ${turn.turnId}; continuing (${detail})`);
    }
  }

  #schedule(runtimeId: string, turn: TurnActivity): void {
    if (turn.timer !== undefined) return;
    const waited = this.#now() - turn.lastEmitAt;
    if (waited >= this.#throttleMs) {
      this.#emit(runtimeId, turn, false);
      return;
    }
    turn.timer = setTimeout(() => {
      turn.timer = undefined;
      if (this.#closed || this.#turns.get(runtimeId) !== turn || turn.finished) return;
      this.#emit(runtimeId, turn, false);
    }, this.#throttleMs - waited);
    turn.timer.unref?.();
  }

  #emit(runtimeId: string, turn: TurnActivity, done: boolean): void {
    const steps = snapshot(turn);
    const key = JSON.stringify(steps);
    // An unchanged snapshot is silent, except for the final frame: `done` is news even when no step
    // changed with it.
    if (!done && key === turn.emitted) return;
    turn.emitted = key;
    turn.frameSeq += 1;
    turn.lastEmitAt = this.#now();
    this.#broadcast({
      type: "bot_tool_activity",
      bot: turn.binding.bot,
      sessionId: turn.binding.sessionId,
      turnId: turn.turnId,
      steps,
      seq: turn.frameSeq,
      updatedAt: turn.lastEmitAt,
      ...(done ? { done: true } : {}),
      ...(turn.binding.room === undefined ? {} : { room: turn.binding.room }),
    });
  }

  #drop(runtimeId: string): void {
    const turn = this.#turns.get(runtimeId);
    if (turn === undefined) return;
    this.#clearTimer(turn);
    this.#turns.delete(runtimeId);
  }

  #clearTimer(turn: TurnActivity): void {
    if (turn.timer !== undefined) clearTimeout(turn.timer);
    turn.timer = undefined;
  }
}

/** The turn's steps as the wire carries them: first-seen order, `endedAt` absent rather than null
 *  while a step runs. */
function snapshot(turn: TurnActivity): BotToolStep[] {
  return [...turn.steps].map(([stepId, step]) => ({
    stepId,
    seq: step.seq,
    name: step.name,
    status: step.status,
    startedAt: step.startedAt,
    ...(step.endedAt === undefined ? {} : { endedAt: step.endedAt }),
  }));
}

/** Groups stored rows into the per-turn shape `GET /bots/:name/chat/messages` hands back. Lives
 *  here, beside the frame it mirrors, so the two shapes cannot drift: a turn's history strip and
 *  its live strip are the same steps in the same order. */
export function groupToolSteps(
  rows: ReadonlyArray<{
    turnId: string;
    stepId: string;
    seq: number;
    name: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
  }>,
): Array<{ turnId: string; startedAt: number; endedAt?: number; steps: BotToolStep[] }> {
  const byTurn = new Map<string, { turnId: string; startedAt: number; endedAt: number | undefined; steps: BotToolStep[] }>();
  for (const row of rows) {
    const status: BotToolStep["status"] =
      row.status === "ok" || row.status === "error" || row.status === "running" ? row.status : "error";
    let turn = byTurn.get(row.turnId);
    if (turn === undefined) {
      turn = { turnId: row.turnId, startedAt: row.startedAt, endedAt: undefined, steps: [] };
      byTurn.set(row.turnId, turn);
    }
    turn.startedAt = Math.min(turn.startedAt, row.startedAt);
    turn.steps.push({
      stepId: row.stepId,
      seq: row.seq,
      name: row.name,
      status,
      startedAt: row.startedAt,
      ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    });
    // A turn whose every step ended has an end; one still holding a `running` step does not, which
    // after a restart is a turn whose end this gateway never saw.
    if (status === "running" || row.endedAt === null) turn.endedAt = undefined;
    else if (turn.steps.every((step) => step.endedAt !== undefined)) {
      turn.endedAt = Math.max(...turn.steps.map((step) => step.endedAt ?? 0));
    }
  }
  return [...byTurn.values()]
    .map((turn) => {
      turn.steps.sort((a, b) => a.seq - b.seq);
      return turn.endedAt === undefined
        ? { turnId: turn.turnId, startedAt: turn.startedAt, steps: turn.steps }
        : { turnId: turn.turnId, startedAt: turn.startedAt, endedAt: turn.endedAt, steps: turn.steps };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

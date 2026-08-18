import type { ServerFrame } from "cozygateway-contract";

import type { HermesEvent } from "./client.ts";

/** The live draft of a reply, streamed off Hermes' own token events.
 *
 *  Hermes pushes `message.start` / `message.delta` / `message.complete` on the SAME `/api/ws` socket
 *  the bridge already holds open (probe, 2026-08-18): a delta frame is
 *  `{ method: "event", params: { type: "message.delta", session_id, payload: { text } } }`, one per
 *  token, coalesced server-side on a 33 ms timer. The bridge used to handle three event types and
 *  drop the rest, so the deltas were already landing here and going in the bin.
 *
 *  This module turns them into `bot_chat_delta` frames, and it is deliberately the ONLY thing in the
 *  gateway that reads a token stream. Everything about it is decoration:
 *  - the canonical reply still arrives through the existing `session.resume` poll and the `bot_chat`
 *    frame, which stays authoritative and is the only thing a client stores;
 *  - every frame carries the FULL accumulated text, so any subset of them can be dropped;
 *  - a turn that streams nothing (a Hermes build with no `message.*` events, a stolen transport, a
 *    reconnect mid-turn) is a turn with no draft, and nothing downstream notices.
 *
 *  ## Routing, and why the draft can go quiet
 *
 *  Hermes routes an event with a session id to the transport stored ON THAT SESSION, and every
 *  `session.resume` from ANY connection rebinds it (`server.py:8732`). The bridge resumes before
 *  every `prompt.submit` and again on every poll, so bot sessions are bound here. But a human
 *  opening the same session in the Hermes dashboard steals the route, and the deltas go to the
 *  dashboard until the bridge's next poll (<= 2 s) claims it back. The honest, visible effect: the
 *  draft freezes for up to a poll interval and then jumps forward, or the turn simply never streams.
 *  The reply itself is never at risk, because it does not come from here.
 *
 *  ## Chain of thought never leaves the gateway
 *
 *  The same socket carries `thinking.delta` (cosmetic: the probe sampled
 *  `"( •_•)>⌐■-■ cogitating..."`), `reasoning.delta` and `reasoning.available`, which carry model
 *  reasoning. `handleEvent` matches on an explicit ALLOW-LIST of three `message.*` types, so a
 *  reasoning event of any kind, present or future, cannot reach a client through this path: an
 *  unknown type is not a case, it is the default branch, and the default branch returns. */

/** How often a draft may go on the wire, per session. The design target is 150-250 ms: fast enough
 *  to read as live text (Hermes coalesces tokens at ~33 ms, so this is one frame per 5-8 batches),
 *  slow enough that a long reply costs tens of frames rather than hundreds on a phone radio. */
export const CHAT_DELTA_THROTTLE_MS = 200;

/** Draft ceiling (review PR40 M1): the streamed draft is decoration, and re-sending the full
 *  accumulated text every throttle tick amplifies long replies without bound (a 20 KB reply
 *  already fans out megabytes per device). Past this many characters the draft stops growing
 *  and stops emitting; the authoritative complete message still arrives whole via the poll. */
export const CHAT_DELTA_MAX_CHARS = 65536;

/** How many sessions may hold a binding. A binding is ~100 bytes and one is written per send, so
 *  this is a leak stop rather than a tuning knob: the oldest entry is evicted past the cap. */
const MAX_BINDINGS = 512;

/** The event types this module forwards. Nothing else is read, and in particular no event carrying
 *  reasoning or thinking text is (see the module comment). */
const MESSAGE_START = "message.start";
const MESSAGE_DELTA = "message.delta";
const MESSAGE_COMPLETE = "message.complete";

/** Who a runtime session id belongs to. `sessionId` is the STORED id, the one every other bots frame
 *  uses; the runtime id is a Hermes internal that no client has ever seen and none is told here. */
export interface StreamBinding {
  bot: string;
  sessionId: string;
  /** Set for a member's turn inside a group room. */
  room?: string;
}

/** What a turn path needs from the stream, and all it is allowed to do to it: say who a runtime
 *  session belongs to, and take that back. Narrow on purpose, so the poll loops cannot reach into
 *  the draft and a test can stand in for it. */
export interface ChatStreamBinder {
  bind(runtimeSessionId: string, binding: StreamBinding): void;
  forgetBot(name: string): void;
}

interface TurnState {
  turnId: string;
  text: string;
  seq: number;
  /** Text of the last frame that actually went out, so an unchanged draft is silent. */
  emitted: string;
  /** Set by `message.complete`. A late delta for a finished turn is dropped rather than reviving a
   *  draft the client has already retired. */
  finished: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastEmitAt: number;
}

export interface ChatStreamOptions {
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  throttleMs?: number;
}

function textOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  // `text` and NOT `rendered`: both may be present on a delta, and `rendered` is the TUI's own
  // markup pass, not the assistant's words.
  const text = (payload as Record<string, unknown>)["text"];
  return typeof text === "string" ? text : undefined;
}

export class BotChatStream implements ChatStreamBinder {
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #throttleMs: number;

  /** runtime session id -> who it belongs to. */
  readonly #bindings = new Map<string, StreamBinding>();
  /** runtime session id -> the turn currently being drafted. */
  readonly #turns = new Map<string, TurnState>();
  #turnSeq = 0;
  #closed = false;

  constructor(opts: ChatStreamOptions) {
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#throttleMs = opts.throttleMs ?? CHAT_DELTA_THROTTLE_MS;
  }

  /** Declares who a runtime session id belongs to. Called just before `prompt.submit`, which is the
   *  one place in the gateway where the runtime id is already resolved, so learning it costs no
   *  round trip. Re-binding the same id replaces the binding and drops any half-drafted turn on it:
   *  Hermes REUSES a session id across turns, and a draft from the previous one must never bleed
   *  into the next. */
  bind(runtimeSessionId: string, binding: StreamBinding): void {
    if (this.#closed || runtimeSessionId.length === 0) return;
    this.#dropTurn(runtimeSessionId);
    // Reinsertion moves the key to the end of the iteration order, which is what makes the eviction
    // below least-recently-BOUND rather than arbitrary.
    this.#bindings.delete(runtimeSessionId);
    this.#bindings.set(runtimeSessionId, { ...binding });
    while (this.#bindings.size > MAX_BINDINGS) {
      const oldest = this.#bindings.keys().next();
      if (oldest.done === true) break;
      this.#bindings.delete(oldest.value);
      this.#dropTurn(oldest.value);
    }
  }

  /** Forgets everything held for one bot: its bindings and any draft in flight. Called when a bot's
   *  chat is cancelled (a deleted bot, a re-pinned session), so a draft can never outlive the thing
   *  it was drafting for. */
  forgetBot(name: string): void {
    for (const [runtimeId, binding] of [...this.#bindings]) {
      if (binding.bot !== name) continue;
      this.#bindings.delete(runtimeId);
      this.#dropTurn(runtimeId);
    }
  }

  /** Drops every draft in flight WITHOUT emitting anything, keeping the bindings. Called when the
   *  Hermes link leaves `online`: the buffer for a half-written reply is gone with the socket, and
   *  resuming it from a later fragment would show the user a reply missing its beginning. The turn
   *  itself is unaffected; its reply arrives over the poll as always. */
  reset(): void {
    for (const runtimeId of [...this.#turns.keys()]) this.#dropTurn(runtimeId);
  }

  /** Every Hermes event frame passes through here. Only the three `message.*` types are read. */
  handleEvent(event: HermesEvent): void {
    if (this.#closed) return;
    const runtimeId = event.sessionId;
    if (runtimeId === undefined) return;
    const binding = this.#bindings.get(runtimeId);
    if (binding === undefined) return;

    switch (event.type) {
      case MESSAGE_START:
        this.#startTurn(runtimeId);
        return;
      case MESSAGE_DELTA: {
        const chunk = textOf(event.payload);
        if (chunk === undefined || chunk.length === 0) return;
        const turn = this.#turnFor(runtimeId);
        // A delta after `message.complete` belongs to a turn the client has already been told is
        // over. Hermes has not been observed to send one, but the ordering is not ours to
        // guarantee, and reviving a retired draft is a visible bug where dropping the frame is not.
        if (turn.finished) return;
        // Past the ceiling the draft freezes: no growth, no further frames (M1 amplification cap).
        if (turn.text.length >= CHAT_DELTA_MAX_CHARS) return;
        turn.text = (turn.text + chunk).slice(0, CHAT_DELTA_MAX_CHARS);
        this.#schedule(runtimeId, binding, turn);
        return;
      }
      case MESSAGE_COMPLETE: {
        const turn = this.#turns.get(runtimeId);
        if (turn === undefined || turn.finished) return;
        turn.finished = true;
        this.#clearTimer(turn);
        // `message.complete` carries the whole assistant text. Preferred over the accumulation
        // whenever it is there, because it is what Hermes actually persisted: it closes any gap left
        // by a delta that arrived before the binding, or by a coalesced batch lost to a reconnect.
        const final = textOf(event.payload);
        if (final !== undefined && final.length > 0) turn.text = final;
        this.#emit(runtimeId, binding, turn, true);
        // The record is KEPT, marked finished, rather than deleted. Deleting it made a late delta
        // indistinguishable from the first delta of a new turn, so a stray frame after the handoff
        // would have opened a second draft under a second turn id. The next `bind` (every send
        // performs one, on both turn paths) or the next `message.start` clears it.
        return;
      }
      default:
        // Every other event type, `thinking.delta` and `reasoning.delta` among them. Not forwarded,
        // not buffered, not logged.
        return;
    }
  }

  close(): void {
    this.#closed = true;
    this.reset();
    this.#bindings.clear();
  }

  /** Test seam: is a draft in flight for this runtime session? A finished turn is not one. */
  drafting(runtimeSessionId: string): boolean {
    const turn = this.#turns.get(runtimeSessionId);
    return turn !== undefined && !turn.finished;
  }

  #startTurn(runtimeId: string): TurnState {
    this.#dropTurn(runtimeId);
    this.#turnSeq += 1;
    const turn: TurnState = {
      turnId: `${runtimeId}#${this.#now()}-${this.#turnSeq}`,
      text: "",
      seq: 0,
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

  /** The turn a delta belongs to, starting one implicitly when there is none. That happens when the
   *  bridge attached to a session mid-turn (a reconnect, a transport re-claim by the poll): the
   *  start event went somewhere else, and half a draft beats no draft, because the text is
   *  cumulative from here on and the canonical message lands regardless. */
  #turnFor(runtimeId: string): TurnState {
    return this.#turns.get(runtimeId) ?? this.#startTurn(runtimeId);
  }

  #schedule(runtimeId: string, binding: StreamBinding, turn: TurnState): void {
    if (turn.timer !== undefined) return;
    const waited = this.#now() - turn.lastEmitAt;
    if (waited >= this.#throttleMs) {
      this.#emit(runtimeId, binding, turn, false);
      return;
    }
    turn.timer = setTimeout(() => {
      turn.timer = undefined;
      // The turn may have been finished, replaced or dropped while this was pending.
      if (this.#closed || this.#turns.get(runtimeId) !== turn || turn.finished) return;
      this.#emit(runtimeId, binding, turn, false);
    }, this.#throttleMs - waited);
    turn.timer.unref?.();
  }

  #emit(runtimeId: string, binding: StreamBinding, turn: TurnState, done: boolean): void {
    // An unchanged draft is silent, except for the final frame: `done` is news even when the text
    // is exactly what the last frame carried.
    if (!done && turn.text === turn.emitted) return;
    turn.emitted = turn.text;
    turn.seq += 1;
    turn.lastEmitAt = this.#now();
    this.#broadcast({
      type: "bot_chat_delta",
      bot: binding.bot,
      sessionId: binding.sessionId,
      turnId: turn.turnId,
      text: turn.text,
      seq: turn.seq,
      updatedAt: turn.lastEmitAt,
      ...(done ? { done: true } : {}),
      ...(binding.room === undefined ? {} : { room: binding.room }),
    });
  }

  #dropTurn(runtimeId: string): void {
    const turn = this.#turns.get(runtimeId);
    if (turn === undefined) return;
    this.#clearTimer(turn);
    this.#turns.delete(runtimeId);
  }

  #clearTimer(turn: TurnState): void {
    if (turn.timer !== undefined) clearTimeout(turn.timer);
    turn.timer = undefined;
  }
}

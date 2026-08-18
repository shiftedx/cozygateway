import type { BotChatMessage, ServerFrame } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";
import { parseChatSnapshot, type ChatSnapshot } from "./chat-messages.ts";
import type { ChatStreamBinder } from "./chat-stream.ts";

/** Duplex over the canonical Bot Chat: read the history, submit a prompt, and deliver the reply.
 *
 *  The reply is consumed exactly the way the desktop consumes a group-chat member turn (dissection
 *  9.7): submit against the RUNTIME session id, then `session.resume` every 2 s until an assistant
 *  reply has landed AND the session reports neither `running` nor `inflight`, giving up after 180 s.
 *  Parity risk is zero because it is the same loop.
 *
 *  Hermes DOES push token events for the turn (`message.start` / `message.delta` /
 *  `message.complete`), and `chat-stream.ts` turns them into the live draft a client renders while
 *  it waits. That is decoration on top of this loop and never a replacement for it: the poll is what
 *  delivers the message, what reports the turn phase, and what re-claims the event transport when a
 *  Hermes desktop steals it (see `chat-stream.ts`). All this file owes the stream is the runtime
 *  session id, which it has to resolve to submit at all.
 *
 *  What is new here is that the loop runs server-side, so every device sees the turn: each poll
 *  that finds new messages broadcasts them as a `bot_chat` DELTA frame, and each change of turn
 *  state broadcasts a `bot_chat_state` frame. A phone that was backgrounded during the turn still
 *  gets the reply, because the gateway, not the app, is the thing holding the poll. */

/** The desktop's poll cadence and turn cap, verbatim (dissection 9.7). */
export const CHAT_POLL_MS = 2_000;
export const CHAT_TURN_TIMEOUT_MS = 180_000;

/** Consecutive failing polls tolerated before the turn is abandoned. A single hiccup during a
 *  three-minute turn must not lose the reply; a gateway that is simply gone must not be polled for
 *  the full cap. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Raised when `prompt.submit` cannot be addressed. `prompt.submit` takes the RUNTIME session id
 *  (dissection 1.2 row 11) and the stored id is a DIFFERENT value, so a send whose runtime id could
 *  not be established fails loudly here instead of submitting against the pin and answering 202 for
 *  a message that went nowhere. */
export class RuntimeSessionUnknown extends Error {
  constructor(name: string) {
    super(`hermes did not report a runtime session id for ${name}`);
    this.name = "RuntimeSessionUnknown";
  }
}

export interface ChatTurnsOptions {
  rpc: HermesRpc;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** Where the live draft of a reply is assembled. Optional: with no stream the turn behaves exactly
   *  as it always has, which is also what happens on a Hermes build that sends no `message.*`
   *  events. The poll below is unaffected either way and remains the source of the reply. */
  stream?: ChatStreamBinder;
  pollMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** What the caller knows about the chat that the turn loop cannot learn on its own. */
export interface SendOptions {
  /** The RUNTIME id `session.create` handed back, when this chat was created by this gateway and
   *  its kickoff has not persisted yet. That session has no row to resume, so the resume throws and
   *  this is the only id `prompt.submit` will accept. */
  runtimeId?: string;
  /** The sender's own id for this message, echoed back on the committed message and on the same
   *  message when the poll finds it. */
  clientId?: string;
}

interface ActiveTurn {
  sessionId: string;
  /** Message count before the prompt was submitted; the turn is done once an assistant reply has
   *  landed past it. */
  baseline: number;
  /** Extended, not replaced, when a second send lands mid-turn. */
  deadline: number;
  /** True once some poll saw Hermes report `running` or `inflight`. */
  sawActivity: boolean;
  /** Set when the bot's canonical session id changed under this poll: the loop then stops without
   *  broadcasting anything else for a chat the app has left. */
  cancelled: boolean;
  done: Promise<void>;
}

/** A message this gateway accepted and has not yet seen come back around the poll. */
interface PendingSend {
  clientId: string;
  text: string;
}

/** How far a bot's chat has been broadcast. Kept as the LAST BROADCAST MESSAGE ID rather than a
 *  count, because the canonical chat is the surface where `/new` is rerouted to `/compact`
 *  (dissection 5.5) and compaction SHRINKS the message list. A count-only mark can only move up,
 *  so one compaction silenced the bot forever. */
interface Watermark {
  sessionId: string;
  lastId: string | undefined;
  count: number;
}

export class BotChatTurns {
  readonly #rpc: HermesRpc;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #stream: ChatStreamBinder | undefined;

  /** One turn poll per bot at a time. A second send while a poll is running rides that poll
   *  rather than starting a competing one, which is what keeps `session.resume` traffic bounded
   *  no matter how fast a user taps send. */
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #watermarks = new Map<string, Watermark>();
  readonly #pending = new Map<string, PendingSend[]>();
  readonly #lastState = new Map<string, string>();
  #closed = false;

  constructor(opts: ChatTurnsOptions) {
    this.#rpc = opts.rpc;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#pollMs = opts.pollMs ?? CHAT_POLL_MS;
    this.#timeoutMs = opts.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
    this.#log = opts.log ?? (() => {});
    this.#stream = opts.stream;
  }

  /** Full history of a bot's canonical chat. Also re-bases the broadcast watermark, so the frames
   *  that follow a history read are deltas against exactly what the client just received. */
  async history(name: string, sessionId: string): Promise<ChatSnapshot> {
    const snapshot = await this.#resume(sessionId, name, false);
    this.#setWatermark(name, sessionId, snapshot.messages);
    return snapshot;
  }

  /** Submits `text` into the canonical chat and starts (or extends) the turn poll. Resolves as
   *  soon as Hermes has accepted the prompt: the reply arrives later, over `/ws`.
   *
   *  A failure from `prompt.submit` propagates verbatim, so the route can pass the Hermes error
   *  text through untouched. */
  async send(name: string, sessionId: string, text: string, opts: SendOptions = {}): Promise<BotChatMessage> {
    // The stored id pins the chat; `prompt.submit` only accepts the RUNTIME id, and the cheapest
    // way to learn it is an omit_messages resume, which doubles as the count baseline.
    let baseline = 0;
    let runtimeId: string | undefined;
    let running = false;
    let inflight = false;
    let resumeError: unknown;
    try {
      const snapshot = await this.#resume(sessionId, name, true);
      baseline = snapshot.messageCount;
      runtimeId = snapshot.runtimeId;
      running = snapshot.running;
      inflight = snapshot.inflight;
    } catch (err) {
      resumeError = err;
      this.#log(`resume before submit failed for ${name}: ${err instanceof Error ? err.message : "unknown"}`);
    }

    if (runtimeId === undefined) {
      // A session whose first prompt has not persisted has no row to resume (dissection 9.7), so
      // the id this gateway got back from `session.create` is the recovery. Falling back to the
      // STORED id here is the bug this guards: the route answered 202, the app rendered the user
      // bubble, and the prompt went to whatever the stored id addresses.
      runtimeId = opts.runtimeId;
    }
    if (runtimeId === undefined && resumeError !== undefined) {
      // One retry: the kickoff may have landed in the meantime, which turns the lazy session into
      // a resumable one and hands back the runtime id.
      try {
        const retry = await this.#resume(sessionId, name, true);
        baseline = retry.messageCount;
        runtimeId = retry.runtimeId;
        running = retry.running;
        inflight = retry.inflight;
      } catch {
        // Fall through to the loud failure below.
      }
    }
    if (runtimeId === undefined) {
      if (resumeError !== undefined) throw resumeError;
      throw new RuntimeSessionUnknown(name);
    }

    // Told BEFORE the submit, because the first `message.delta` can land before `prompt.submit`
    // answers, and an event whose session is not bound yet is dropped. This is also the only place
    // the runtime id (the id Hermes puts on its event frames) and the stored id (the id every bots
    // frame is keyed on) are both in hand.
    this.#stream?.bind(runtimeId, { bot: name, sessionId });

    await this.#rpc.request("prompt.submit", { session_id: runtimeId, text });

    const at = this.#now();
    const clientId = opts.clientId ?? `${sessionId}#local-${at}`;
    const queue = this.#pending.get(name) ?? [];
    queue.push({ clientId, text });
    this.#pending.set(name, queue);
    this.#startTurn(name, sessionId, baseline, running, inflight);
    return { id: `${sessionId}#local-${at}`, role: "user", text, at, clientId };
  }

  /** True while a turn poll is live for this bot. */
  polling(name: string): boolean {
    return this.#turns.has(name);
  }

  /** Resolves when the bot's current turn poll has finished. Test seam; nothing in the request
   *  path waits on a turn. */
  async settled(name: string): Promise<void> {
    await this.#turns.get(name)?.done;
  }

  /** Drops a bot's broadcast watermark. Prefer `cancel` for a deleted bot: dropping the watermark
   *  alone is a no-op whenever it matters, because a live turn's very next poll writes it straight
   *  back. */
  forget(name: string): void {
    this.#watermarks.delete(name);
  }

  /** Tears down everything this module holds for a bot whose profile is gone: the live turn poll is
   *  cancelled, and the watermark, pending sends and last broadcast state are dropped.
   *
   *  Cancelling is the load-bearing half. Leaving the poll to "clean up after itself" was wrong on
   *  both counts: it kept broadcasting `bot_chat` / `bot_chat_state` frames for a bot no longer on
   *  the roster (three failing polls, then a `failed` state frame), and each of those polls rewrote
   *  the watermark that `forget` had just deleted, so the drop never took. Cancelling cannot race
   *  the poll either: the loop checks the flag at every checkpoint and returns without broadcasting.
   *
   *  Ordering note: the caller only reaches this after Hermes CONFIRMED the delete, so there is no
   *  turn left that could legitimately still land. */
  cancel(name: string): void {
    const turn = this.#turns.get(name);
    if (turn !== undefined) {
      turn.cancelled = true;
      this.#turns.delete(name);
    }
    this.#watermarks.delete(name);
    this.#pending.delete(name);
    this.#lastState.delete(name);
    this.#stream?.forgetBot(name);
  }

  close(): void {
    this.#closed = true;
    for (const turn of this.#turns.values()) turn.cancelled = true;
    this.#turns.clear();
    this.#watermarks.clear();
    this.#lastState.clear();
    this.#pending.clear();
  }

  #startTurn(name: string, sessionId: string, baseline: number, running: boolean, inflight: boolean): void {
    const existing = this.#turns.get(name);
    if (existing !== undefined && existing.sessionId === sessionId) {
      // Single-flight: the live poll adopts the new turn by extending its own deadline. Its
      // completion test still requires an idle session, so it cannot declare the second turn done
      // while Hermes is mid-reply.
      existing.deadline = this.#now() + this.#timeoutMs;
      return;
    }
    // The bot's canonical session id changed under a live poll (a compaction re-pin, a desktop
    // clear, a pin writeback race). That poll is now broadcasting for a chat nobody is in, so it
    // is cancelled rather than left to run out its 180 s cap.
    if (existing !== undefined) existing.cancelled = true;

    const turn: ActiveTurn = {
      sessionId,
      baseline,
      deadline: this.#now() + this.#timeoutMs,
      sawActivity: running || inflight,
      cancelled: false,
      done: Promise.resolve(),
    };
    turn.done = this.#poll(name, turn, running, inflight).finally(() => {
      if (this.#turns.get(name) === turn) this.#turns.delete(name);
    });
    this.#turns.set(name, turn);
  }

  async #poll(name: string, turn: ActiveTurn, running: boolean, inflight: boolean): Promise<void> {
    // The opening frame carries the flags the pre-submit resume actually reported: `running` and
    // `inflight` are Hermes' own, and inventing `true` for both made the first frame of every turn
    // a lie the contract does not allow.
    this.#emitState(name, turn.sessionId, "polling", running, inflight);
    let failures = 0;

    while (!this.#closed && !turn.cancelled && this.#now() < turn.deadline) {
      await this.#sleep(this.#pollMs);
      if (this.#closed || turn.cancelled) return;

      let snapshot: ChatSnapshot;
      try {
        snapshot = await this.#resume(turn.sessionId, name, false);
        failures = 0;
      } catch (err) {
        failures += 1;
        this.#log(`turn poll failed for ${name}: ${err instanceof Error ? err.message : "unknown"}`);
        if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
          this.#emitState(name, turn.sessionId, "failed", false, false);
          return;
        }
        continue;
      }
      if (turn.cancelled) return;

      this.#emitMessages(name, turn.sessionId, snapshot.messages);
      if (snapshot.running || snapshot.inflight) turn.sawActivity = true;
      if (this.#settled(turn, snapshot)) {
        this.#emitState(name, turn.sessionId, "complete", false, false);
        return;
      }
      this.#emitState(name, turn.sessionId, "polling", snapshot.running, snapshot.inflight);
    }

    if (!this.#closed && !turn.cancelled) this.#emitState(name, turn.sessionId, "timeout", false, false);
  }

  /** Is the turn over? Growth alone is not enough: `prompt.submit` PERSISTS THE USER'S OWN MESSAGE,
   *  so the count is already past the baseline on the very first poll, 2 s after acceptance. If
   *  Hermes has not yet flipped `running`/`inflight` (a queued turn, a serial scheduler, a provider
   *  handshake) that read as "complete" and the loop returned, and since nothing ever polls again
   *  the assistant's reply was never delivered to any device.
   *
   *  So the turn is over only when the session is idle AND the conversation now ENDS on an
   *  assistant message. A transcript that still ends on the user's message means the reply is
   *  outstanding, whatever the flags say. The `sawActivity` leg covers a build that returns counts
   *  without message bodies: there the flags are the only signal there is. */
  #settled(turn: ActiveTurn, snapshot: ChatSnapshot): boolean {
    if (snapshot.running || snapshot.inflight) return false;
    const grew = Math.max(snapshot.messages.length, snapshot.messageCount) > turn.baseline;
    if (!grew) return false;
    const last = snapshot.messages.at(-1);
    if (last !== undefined) return last.role === "assistant";
    return turn.sawActivity;
  }

  /** Broadcasts whatever is past the watermark, keyed on message IDENTITY rather than on a count,
   *  and re-bases when the id it held is gone (a compaction rewrote the transcript) instead of
   *  going permanently silent. A session id change also re-bases, so switching chats replays the
   *  new chat's messages once rather than diffing across sessions. */
  #emitMessages(name: string, sessionId: string, messages: BotChatMessage[]): void {
    const mark = this.#watermarks.get(name);
    let seen = 0;
    if (mark !== undefined && mark.sessionId === sessionId && mark.lastId !== undefined) {
      const index = messages.findIndex((message) => message.id === mark.lastId);
      seen = index === -1 ? 0 : index + 1;
    }
    const fresh = messages.slice(seen).map((message) => this.#reconcile(name, message));
    this.#setWatermark(name, sessionId, messages);
    if (fresh.length === 0) return;
    this.#broadcast({
      type: "bot_chat",
      bot: name,
      sessionId,
      messages: fresh,
      updatedAt: this.#now(),
    });
  }

  /** Re-attaches the sender's `clientId` to the user message it accepted, once that message comes
   *  back around the poll carrying Hermes' own id. Without it the optimistic row the sender
   *  rendered from the 202 body and the row in the frame share nothing, and the documented
   *  key-on-id dedupe could never fire. */
  #reconcile(name: string, message: BotChatMessage): BotChatMessage {
    if (message.role !== "user") return message;
    const queue = this.#pending.get(name);
    if (queue === undefined || queue.length === 0) return message;
    const index = queue.findIndex((entry) => entry.text === message.text);
    if (index === -1) return message;
    const [entry] = queue.splice(index, 1);
    if (queue.length === 0) this.#pending.delete(name);
    return { ...message, clientId: entry!.clientId };
  }

  #setWatermark(name: string, sessionId: string, messages: BotChatMessage[]): void {
    this.#watermarks.set(name, { sessionId, lastId: messages.at(-1)?.id, count: messages.length });
  }

  /** State frames are edge-triggered: a poll that finds nothing changed is silent on the wire. */
  #emitState(
    name: string,
    sessionId: string,
    phase: "polling" | "complete" | "timeout" | "failed",
    running: boolean,
    inflight: boolean,
  ): void {
    const key = `${sessionId}|${phase}|${running}|${inflight}`;
    if (this.#lastState.get(name) === key) return;
    this.#lastState.set(name, key);
    this.#broadcast({
      type: "bot_chat_state",
      bot: name,
      sessionId,
      phase,
      running,
      inflight,
      updatedAt: this.#now(),
    });
  }

  async #resume(sessionId: string, profile: string, omitMessages: boolean): Promise<ChatSnapshot> {
    const result = await this.#rpc.request("session.resume", {
      session_id: sessionId,
      profile,
      omit_messages: omitMessages,
    });
    return parseChatSnapshot(result, sessionId);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

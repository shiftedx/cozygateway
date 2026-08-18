import type { BotChatMessage, ServerFrame } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";
import { parseChatSnapshot, type ChatSnapshot } from "./chat-messages.ts";

/** Duplex over the canonical Bot Chat: read the history, submit a prompt, and deliver the reply.
 *
 *  Hermes has no push stream for session messages in the dissected surface, so the reply is
 *  consumed exactly the way the desktop consumes a group-chat member turn (dissection 9.7): submit
 *  against the RUNTIME session id, then `session.resume` every 2 s until the message count grows
 *  AND the session reports neither `running` nor `inflight`, giving up after 180 s. Parity risk is
 *  zero because it is the same loop, and a streaming upgrade later changes only this file.
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

export interface ChatTurnsOptions {
  rpc: HermesRpc;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  pollMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface ActiveTurn {
  sessionId: string;
  /** Message count before the prompt was submitted; the turn is done once the count exceeds it. */
  baseline: number;
  /** Extended, not replaced, when a second send lands mid-turn. */
  deadline: number;
  done: Promise<void>;
}

export class BotChatTurns {
  readonly #rpc: HermesRpc;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;

  /** One turn poll per bot at a time. A second send while a poll is running rides that poll
   *  rather than starting a competing one, which is what keeps `session.resume` traffic bounded
   *  no matter how fast a user taps send. */
  readonly #turns = new Map<string, ActiveTurn>();
  /** How many messages of each bot's chat have already been broadcast, so a `bot_chat` frame
   *  carries only what is new. Keyed by bot name, and reset whenever the session id changes. */
  readonly #watermarks = new Map<string, { sessionId: string; count: number }>();
  #closed = false;

  constructor(opts: ChatTurnsOptions) {
    this.#rpc = opts.rpc;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#pollMs = opts.pollMs ?? CHAT_POLL_MS;
    this.#timeoutMs = opts.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
    this.#log = opts.log ?? (() => {});
  }

  /** Full history of a bot's canonical chat. Also re-bases the broadcast watermark, so the frames
   *  that follow a history read are deltas against exactly what the client just received. */
  async history(name: string, sessionId: string): Promise<ChatSnapshot> {
    const snapshot = await this.#resume(sessionId, name, false);
    this.#watermarks.set(name, { sessionId, count: snapshot.messages.length });
    return snapshot;
  }

  /** Submits `text` into the canonical chat and starts (or extends) the turn poll. Resolves as
   *  soon as Hermes has accepted the prompt: the reply arrives later, over `/ws`.
   *
   *  A failure from `prompt.submit` propagates verbatim, so the route can pass the Hermes error
   *  text through untouched. */
  async send(name: string, sessionId: string, text: string): Promise<BotChatMessage> {
    // The stored id pins the chat; `prompt.submit` only accepts the RUNTIME id, and the cheapest
    // way to learn it is an omit_messages resume, which doubles as the count baseline. A session
    // whose first prompt has not landed yet has no row to resume, and throws: that is expected,
    // and the stored id is the right fallback there.
    let baseline = 0;
    let runtimeId = sessionId;
    try {
      const snapshot = await this.#resume(sessionId, name, true);
      baseline = snapshot.messageCount;
      if (snapshot.runtimeId !== undefined) runtimeId = snapshot.runtimeId;
    } catch (err) {
      this.#log(`resume before submit failed for ${name}: ${err instanceof Error ? err.message : "unknown"}`);
    }

    await this.#rpc.request("prompt.submit", { session_id: runtimeId, text });

    const at = this.#now();
    this.#startTurn(name, sessionId, baseline);
    return { id: `${sessionId}#local-${at}`, role: "user", text, at };
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

  close(): void {
    this.#closed = true;
  }

  #startTurn(name: string, sessionId: string, baseline: number): void {
    const existing = this.#turns.get(name);
    if (existing !== undefined && existing.sessionId === sessionId) {
      // Single-flight: the live poll adopts the new turn by extending its own deadline. Its
      // completion test still requires an idle session, so it cannot declare the second turn done
      // while Hermes is mid-reply.
      existing.deadline = this.#now() + this.#timeoutMs;
      return;
    }

    const turn: ActiveTurn = {
      sessionId,
      baseline,
      deadline: this.#now() + this.#timeoutMs,
      done: Promise.resolve(),
    };
    turn.done = this.#poll(name, turn).finally(() => {
      if (this.#turns.get(name) === turn) this.#turns.delete(name);
    });
    this.#turns.set(name, turn);
  }

  async #poll(name: string, turn: ActiveTurn): Promise<void> {
    this.#emitState(name, turn.sessionId, "polling", true, true);
    let failures = 0;

    while (!this.#closed && this.#now() < turn.deadline) {
      await this.#sleep(this.#pollMs);
      if (this.#closed) return;

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

      this.#emitMessages(name, turn.sessionId, snapshot.messages);
      const grew = Math.max(snapshot.messages.length, snapshot.messageCount) > turn.baseline;
      if (grew && !snapshot.running && !snapshot.inflight) {
        this.#emitState(name, turn.sessionId, "complete", false, false);
        return;
      }
      this.#emitState(name, turn.sessionId, "polling", snapshot.running, snapshot.inflight);
    }

    if (!this.#closed) this.#emitState(name, turn.sessionId, "timeout", false, false);
  }

  /** Broadcasts whatever is past the watermark. A session id change resets the watermark, so
   *  switching chats replays the new chat's messages once rather than diffing across sessions. */
  #emitMessages(name: string, sessionId: string, messages: BotChatMessage[]): void {
    const mark = this.#watermarks.get(name);
    const seen = mark !== undefined && mark.sessionId === sessionId ? mark.count : 0;
    if (messages.length <= seen) return;
    const fresh = messages.slice(seen);
    this.#watermarks.set(name, { sessionId, count: messages.length });
    this.#broadcast({
      type: "bot_chat",
      bot: name,
      sessionId,
      messages: fresh,
      updatedAt: this.#now(),
    });
  }

  #lastState = new Map<string, string>();

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

import type { AttachmentBlock, BotChatMessage, ServerFrame } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";
import { chatRowFingerprint, ChatIdentityLedger } from "./chat-identity.ts";
import {
  isContextCompactionMarker,
  parseChatSnapshot,
  stripImageDirectives,
  type ChatSnapshot,
} from "./chat-messages.ts";
import type { ChatStreamBinder } from "./chat-stream.ts";
import { PhotoAttachFailed } from "./photos.ts";
import {
  ASSISTANT_MEDIA_MAX_PER_MESSAGE,
  assistantMediaDirectives,
  stripAssistantMediaDirectives,
} from "./assistant-media.ts";

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

/** Where photos this gateway stored are bound to the transcript rows they were sent with, and read
 *  back again (capability 9). An interface rather than the `Storage` class so the turn loop keeps
 *  knowing nothing about SQL, and so a test can pin the ordering with a map.
 *
 *  The binding is the durable half of the feature. Matching a send to its persisted row is single
 *  use and lives only in this process's pending queue; without writing the result down, a photo would
 *  decorate exactly one live frame and then be absent from every later history read. */
export interface ChatAttachmentStore {
  /** Called once, when the row a photo was sent with is first seen. */
  bind(fileId: string, messageId: string): void;
  /** The blocks belonging to a row, or an empty array, which is the answer for almost every row. */
  forMessage(sessionId: string, messageId: string): AttachmentBlock[];
  /** Successful assistant directive keys for later history reads. */
  assistantMediaKeys?(sessionId: string, messageId: string): string[];
}

export interface AssistantMediaStore {
  /** Fetches, validates and stores one directive already bound to its assistant row. Rejects on any
   *  failure, which deliberately leaves the directive visible as text. */
  ingest(input: {
    bot: string;
    sessionId: string;
    messageId: string;
    path: string;
    sourceKey: string;
  }): Promise<void>;
}

export interface ChatTurnsOptions {
  rpc: HermesRpc;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** Optional: with no store, photo sends are unavailable and every message goes out undecorated,
   *  which is exactly how this module behaved before capability 9. */
  attachments?: ChatAttachmentStore;
  assistantMedia?: AssistantMediaStore;
  /** Where the live draft of a reply is assembled. Optional: with no stream the turn behaves exactly
   *  as it always has, which is also what happens on a Hermes build that sends no `message.*`
   *  events. The poll below is unaffected either way and remains the source of the reply. */
  stream?: ChatStreamBinder;
  pollMs?: number;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Raised once when an idle terminal assistant row settles the turn. The caller owns any
   *  out-of-band work and must not throw; the frame and complete state are emitted first. */
  onSettledAssistantMessage?: (event: {
    bot: string;
    chatSessionId: string;
    messageId: string;
  }) => void;
}

/** What the caller knows about the chat that the turn loop cannot learn on its own. */
export interface SendOptions {
  /** The RUNTIME id `session.create` handed back, when this chat was created by this gateway and
   *  nobody has written in it yet. That session has no persisted row to resume, so the resume throws
   *  and this is the only id `prompt.submit` will accept. Since ext-bots capability 11 the gateway
   *  submits no opener of its own, so EVERY chat is in that state until this very send. */
  runtimeId?: string;
  /** The sender's own id for this message, echoed back on the committed message and on the same
   *  message when the poll finds it. */
  clientId?: string;
  /** One photo to attach to this turn (capability 9). The gateway has already stored its own copy
   *  under `fileId` and has already decided the bytes are an image it will accept; what is left is
   *  the RPC pair, and the order of that pair is the whole contract of this option. */
  photo?: SendPhoto;
}

/** A photo riding one send. `block` is the wire shape the message will carry, built by the caller so
 *  the turn loop never invents contract objects. */
export interface SendPhoto {
  fileId: string;
  contentBase64: string;
  filename: string;
  block: AttachmentBlock;
}

interface ActiveTurn {
  sessionId: string;
  /** Which turn this is, monotonic per process. A pending send belongs to exactly one of these, and
   *  a send that opens a NEW turn proves every entry left from an older one will never be matched
   *  (see `PendingSend`). */
  id: number;
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
  /** Assistant content delivered during THIS turn, after every wire-visible text rewrite. A later
   *  segment with the same fingerprint is the same utterance; a later turn starts with an empty
   *  map, so genuinely repeated replies remain distinct. */
  deliveredAssistant: Map<string, { id: string; wire: string }>;
  done: Promise<void>;
}

/** A message this gateway accepted and has not yet seen come back around the poll.
 *
 *  The queue is FIFO and an entry is usable EXACTLY ONCE: two sends of the same words are two
 *  different lines of the transcript, and the app keys its rows on what it is handed, so an entry
 *  that gets reused (or that outlives its own turn and is then claimed by a later identical send)
 *  collapses two rows into one and a user bubble disappears (cozychat#38). */
interface PendingSend {
  clientId: string;
  /** The text as the PERSISTED ROW WILL DECODE, which is not always the text that was submitted.
   *
   *  The row a send comes back as is matched by its text, and every user row now has its image
   *  directive lines stripped on the way out (`stripImageDirectives`). So a send whose own text
   *  contains a directive-shaped line (a caption reading `look at this\n[screenshot]`, or a plain
   *  text send that pastes a hermes transcript) is persisted, stripped, and then no longer equals
   *  what was typed. Holding the raw text here made that send unmatchable: its clientId never joined,
   *  so the sender saw its own words twice (the cozychat#38 shape, from the other direction), and a
   *  photo on that send never bound to its row and vanished from every read after the 202.
   *
   *  Normalizing HERE rather than normalizing what is submitted is the deliberate half: the model
   *  still receives exactly what the user wrote, and only the join key is canonicalized. */
  text: string;
  /** The turn that carried this send. A send that opens a NEW turn is proof that every entry from
   *  an older one is dead: that turn's poll has already ended, so the row it was waiting for is
   *  either delivered or never coming. Dropping them there is what keeps a clientId from crossing
   *  a turn boundary onto a later send of the very same words. */
  turn: number;
  /** When the send was accepted. Fixes the queue order, and expires an entry whose message never
   *  came back around the poll at all, inside a turn long enough that no newer turn has started. */
  at: number;
  /** The photo this send carried, when it carried one. Rides the SAME entry as the clientId, and
   *  deliberately so: a photo belongs to exactly one line of the transcript, which is the identical
   *  claim the clientId makes, and duplicating the matching logic would be two chances to disagree
   *  about which row a send became. */
  photo?: SendPhoto;
}

/** How far a bot's chat has been broadcast: the SET of message ids already handed out for this
 *  session, and nothing positional at all.
 *
 *  Position cannot be the mark here. The canonical chat is the surface where `/new` is rerouted to
 *  `/compact` (dissection 5.5), and compaction REPLACES the message list: a count-only mark could
 *  only move up, so one compaction silenced the bot forever, and a mark that held the last id
 *  re-based to the START of the compacted transcript and broadcast the whole of it again
 *  (cozygateway#87). Ids survive a compaction now (`chat-identity.ts`), so asking "has this row been
 *  delivered" of each row answers both: a re-based transcript delivers only what is genuinely new,
 *  in whatever position it turns up. */
interface Watermark {
  sessionId: string;
  /** Every message id this bot's chat has already handed out for this session. Also read on the way
   *  out: a row the client already has must never be stamped with the clientId of a send still in
   *  flight, which is the same collapse the FIFO queue exists to prevent, arriving from the other
   *  direction. Bounded, so a long chat cannot grow this without limit. */
  seen: Set<string>;
}

/** How many message ids a watermark remembers: every row delivered for the session, up to this many.
 *  Small enough that the set is never a memory concern, and past it a chat this long has to give
 *  something up. What it gives up is the oldest id whose row is still in the transcript, which can
 *  then be delivered a second time; the trim below spends the rows that are already GONE first, so
 *  that is a corner a compacting session does not usually reach. */
const MAX_SEEN_IDS = 1_000;

const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

export class BotChatTurns {
  readonly #rpc: HermesRpc;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #stream: ChatStreamBinder | undefined;
  readonly #attachments: ChatAttachmentStore | undefined;
  readonly #assistantMedia: AssistantMediaStore | undefined;
  readonly #onSettledAssistantMessage: ChatTurnsOptions["onSettledAssistantMessage"];

  /** One send at a time per bot, held across the attach-and-submit pair.
   *
   *  Hermes queues an attached image on the SESSION and the next `prompt.submit` consumes and clears
   *  the whole queue (`tui_gateway/server.py:10495`). So attach-then-submit is two RPCs over a
   *  process-global per-session queue, and anything that submits in between takes the photo with it:
   *  two photo sends racing hand one turn both pictures and the other none, and an ordinary TEXT send
   *  racing a photo send steals the picture outright and attaches it to words that were not about it.
   *  Serializing the pair closes both, and every send takes the lock rather than only the photo ones,
   *  because the text-steals-the-photo case is the one a user hits by tapping send while a photo is
   *  uploading. */
  readonly #submitLocks = new Map<string, Promise<void>>();

  /** One turn poll per bot at a time. A second send while a poll is running rides that poll
   *  rather than starting a competing one, which is what keeps `session.resume` traffic bounded
   *  no matter how fast a user taps send. */
  readonly #turns = new Map<string, ActiveTurn>();
  readonly #watermarks = new Map<string, Watermark>();
  /** Message identity that survives a transcript the backend re-based under us (cozygateway#87).
   *  Keyed on the STORED session id, and shared by the turn poll and the history read so the two
   *  can never disagree about which row is which. */
  readonly #identity = new ChatIdentityLedger();
  readonly #pending = new Map<string, PendingSend[]>();
  readonly #lastState = new Map<string, string>();
  #nextTurnId = 0;
  #closed = false;

  constructor(opts: ChatTurnsOptions) {
    this.#rpc = opts.rpc;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#pollMs = opts.pollMs ?? CHAT_POLL_MS;
    this.#timeoutMs = opts.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
    this.#log = opts.log ?? (() => {});
    this.#stream = opts.stream;
    this.#attachments = opts.attachments;
    this.#assistantMedia = opts.assistantMedia;
    this.#onSettledAssistantMessage = opts.onSettledAssistantMessage;
  }

  /** Asks hermes to drop ONE queued image, by the path it told us it wrote, swallowing every failure.
   *
   *  Called on exactly one path: an attach that landed followed by a submit that did not. It is a
   *  cleanup, so it must not be able to fail the operation it is cleaning up after, and it must not
   *  be able to hang the send behind it either. Still inside the send lock, deliberately: an unwind
   *  that raced the next send would be racing for the very queue it is trying to empty.
   *
   *  `path` is REQUIRED by hermes and is not a nicety we can skip: `image.detach` reads
   *  `params["path"]`, rejects an empty one with `4015 path required`, and removes exactly that entry
   *  from the session's `attached_images` list. A detach sent without it fails, and because this
   *  method swallows failures by design that failure is invisible: the unwind looks like it happened
   *  and the stranded image rides the user's next turn anyway. A best-effort cleanup that cannot
   *  succeed is worse than none, because it reads as protection.
   *
   *  Removing by path rather than clearing the queue is also the correct scope. The queue is
   *  process-global per session, so a blanket clear would throw away an image somebody else attached
   *  in the same window; this removes the one entry this send put there and nothing else.
   *
   *  The path is an absolute location on the hermes host. It stays in memory: it is never logged,
   *  never stored, and never reaches a device. That is the same rule the transcript strip and the
   *  error redaction enforce, applied to the one place the gateway legitimately holds one. */
  async #detachQuietly(runtimeId: string, path: string): Promise<void> {
    try {
      const result = await this.#rpc.request("image.detach", { session_id: runtimeId, path });
      // Hermes answers `detached: false` when the path was not on the queue, which is a successful
      // call that did nothing. Worth a line, because the interesting case is a turn having already
      // spent the image (the submit failed on our side but landed on theirs).
      const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
      if (record["detached"] !== true) {
        this.#log("the photo unwind removed nothing; hermes no longer had it queued");
      }
    } catch (err) {
      this.#log(
        `could not unwind the attached photo after a failed submit: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  }

  /** Runs `fn` with this bot's send lock held. FIFO, because the waiters chain off each other rather
   *  than racing a flag, and a failure inside `fn` releases the lock exactly as a success does. */
  async #withSubmitLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#submitLocks.get(name) ?? Promise.resolve();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(
      () => held,
      () => held,
    );
    this.#submitLocks.set(name, chained);
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      // Only when this call is still the tail of the chain: a send that queued behind this one owns
      // the entry now, and deleting it would let a third send skip the line.
      if (this.#submitLocks.get(name) === chained) this.#submitLocks.delete(name);
    }
  }

  /** Full history of a bot's canonical chat. Also re-bases the broadcast watermark, so the frames
   *  that follow a history read are deltas against exactly what the client just received. */
  async history(name: string, sessionId: string): Promise<ChatSnapshot> {
    const snapshot = await this.#resume(sessionId, name, false);
    this.#spendPending(name, sessionId, snapshot.messages);
    this.#setWatermark(name, sessionId, snapshot.messages);
    // Decorated AFTER the spend, because the spend is what binds a just-sent photo to the row it
    // became: a history read can be the first thing that sees the row, and a photo that was bound a
    // line later would be missing from the very response that told the client the row exists.
    return { ...snapshot, messages: snapshot.messages.map((message) => this.#decorate(sessionId, message)) };
  }

  /** Hangs stored attachments off either conversational role. For an assistant row, the keys stored
   *  with successful capability-15 ingests also remove exactly those directive lines on history. */
  #decorate(sessionId: string, message: BotChatMessage): BotChatMessage {
    if (this.#attachments === undefined) return message;
    const blocks = this.#attachments.forMessage(sessionId, message.id);
    const keys =
      message.role === "assistant" ? new Set(this.#attachments.assistantMediaKeys?.(sessionId, message.id) ?? []) : undefined;
    const text = keys === undefined ? message.text : stripAssistantMediaDirectives(message.text, keys);
    if (blocks.length === 0 && text === message.text) return message;
    return { ...message, text, ...(blocks.length === 0 ? {} : { attachments: blocks }) };
  }

  async #extractAssistantMedia(
    name: string,
    sessionId: string,
    message: BotChatMessage,
    turn: ActiveTurn,
  ): Promise<BotChatMessage> {
    if (message.role !== "assistant" || this.#assistantMedia === undefined) return this.#decorate(sessionId, message);
    const directives = assistantMediaDirectives(message.text).slice(0, ASSISTANT_MEDIA_MAX_PER_MESSAGE);
    let target = message;
    const projectedKeys = new Set(directives.map((directive) => directive.key));
    const projectedText = stripAssistantMediaDirectives(message.text, projectedKeys);
    const projected = turn.deliveredAssistant.get(chatRowFingerprint(message.role, projectedText));
    if (projected !== undefined && projected.id !== message.id) {
      const id = this.#identity.coalesce(sessionId, message.id, projected.id);
      target = { ...message, id };
    }
    const successful = new Set(this.#attachments?.assistantMediaKeys?.(sessionId, target.id) ?? []);
    for (const directive of directives) {
      if (successful.has(directive.key)) continue;
      try {
        await this.#assistantMedia.ingest({
          bot: name,
          sessionId,
          messageId: target.id,
          path: directive.path,
          sourceKey: directive.key,
        });
        successful.add(directive.key);
      } catch {
        // Failure is intentionally represented by keeping the original line in the text.
      }
    }
    return this.#decorate(sessionId, { ...target, text: stripAssistantMediaDirectives(message.text, successful) });
  }

  /** A history read hands the client every row it returns AND re-bases the delta watermark past
   *  them, so none of those rows is ever coming back around the poll. A pending entry waiting for
   *  one of them is dead the moment the read happens, and leaving it in the queue is what let the
   *  NEXT identical send collect a clientId that belonged to an earlier one. The turn boundary does
   *  not save that case: a repeat sent while the bot is still replying JOINS the live turn, so no
   *  boundary is crossed at all (review G1).
   *
   *  Right even though the watermark, and therefore this re-base, is SHARED across devices: it is
   *  precisely because someone else's refresh moved the mark past the row that the sender's own
   *  frame is never coming. The entry is dead whoever read the history.
   *
   *  The returned rows are NOT stamped on the way out. The 202 body already carried the clientId to
   *  the sender, the history route has never carried one (section 3), and minting one into a
   *  response that another device asked for would be putting one device's join key in another's
   *  hands. */
  #spendPending(name: string, sessionId: string, messages: BotChatMessage[]): void {
    const queue = this.#pending.get(name);
    if (queue === undefined || queue.length === 0) return;
    const mark = this.#watermarks.get(name);
    const delivered = mark !== undefined && mark.sessionId === sessionId ? mark.seen : EMPTY_IDS;
    for (const message of messages) {
      if (message.role !== "user") continue;
      // The same guard `#reconcile` has, and for the same reason. A row this client has ALREADY
      // been given is not the row any pending send is waiting for, so spending an entry against it
      // eats a send that is still perfectly in flight: the frame that follows carries no clientId,
      // the sender's optimistic bubble is never joined, and the user looks at their own line twice
      // until the turn settles. The refresh that does this is most often the SENDER'S own, moments
      // after tapping send.
      if (delivered.has(message.id)) continue;
      const index = queue.findIndex((entry) => entry.text === message.text);
      if (index === -1) continue;
      // Same consumption rule as `#reconcile`: FIFO, one entry per row, and everything ahead of the
      // match goes with it.
      const consumed = queue.splice(0, index + 1);
      // The clientId is deliberately NOT stamped here (see the doc comment), but the PHOTO is bound,
      // and the difference is not an inconsistency. A clientId is a join key for the device that sent
      // the message and belongs to that device's response; a photo is a fact about the row itself,
      // true for every device, and binding it here is the only chance this read has to record it.
      // Skipping the bind would leave the bytes orphaned in the database forever.
      const photo = consumed[consumed.length - 1]?.photo;
      if (photo !== undefined) this.#attachments?.bind(photo.fileId, message.id);
      if (queue.length === 0) break;
    }
    if (queue.length === 0) this.#pending.delete(name);
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
      // One retry: another device's message may have landed in the meantime, which persists the
      // session and hands back the runtime id the first resume could not produce.
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

    const submitId = runtimeId;
    await this.#withSubmitLock(name, async () => {
      // Told BEFORE the submit, because the first `message.delta` can land before `prompt.submit`
      // answers, and an event whose session is not bound yet is dropped. This is also the only place
      // the runtime id (the id Hermes puts on its event frames) and the stored id (the id every bots
      // frame is keyed on) are both in hand.
      this.#stream?.bind(submitId, { bot: name, sessionId });

      // The photo goes in BEFORE the prompt, and a failure here fails the whole send. That order is
      // the feature: hermes holds attached images on the session and the next submit spends them, so
      // submitting first would send a caption with no picture and then leave the picture queued for
      // whatever the user says next. Failing loudly instead means a photo send either delivers both
      // halves or neither, and the route can answer 502 for something that genuinely did not happen.
      let attached = false;
      let attachedPath: string | undefined;
      if (opts.photo !== undefined) {
        const result = await this.#rpc.request("image.attach_bytes", {
          session_id: submitId,
          content_base64: opts.photo.contentBase64,
          filename: opts.photo.filename,
        });
        // A refusal arrives two ways: as an RPC error (which propagated above) or as a perfectly
        // successful call whose result simply does not say `attached`. Both mean there are no pixels
        // on the session, so both must stop the submit.
        const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
        if (record["attached"] !== true) {
          throw new PhotoAttachFailed(
            `hermes did not attach the photo: ${JSON.stringify(result).slice(0, 200)}`,
          );
        }
        attached = true;
        // The absolute host path hermes wrote the bytes to, which is the ONLY handle `image.detach`
        // accepts. Captured here because here is the only place it is ever offered; it is held for
        // the length of this send and never leaves the process.
        const reported = record["path"];
        attachedPath = typeof reported === "string" && reported.length > 0 ? reported : undefined;
      }

      try {
        await this.#rpc.request("prompt.submit", { session_id: submitId, text });
      } catch (err) {
        // The attach LANDED and the submit did not. Hermes now holds an image on the session's queue
        // that no turn of ours will ever spend, and that queue is consumed by the NEXT
        // `prompt.submit` whatever it is: the user shrugs at the 502, types something unrelated, and
        // that turn silently carries the orphaned photo into the model's context, about a picture the
        // transcript does not show (this gateway has already deleted its own copy). A retry of the
        // photo would put it in twice.
        //
        // So the queue is unwound before the failure is reported. Best effort by construction: if the
        // detach itself fails there is nothing further to do from here, and reporting a detach
        // failure instead of the submit failure would replace the true cause with a consequence. The
        // contract says exactly this rather than promising more than this can deliver.
        if (attachedPath !== undefined) await this.#detachQuietly(submitId, attachedPath);
        else if (attached) {
          // Hermes reported an attach with no path, so there is no handle to unwind with: the only
          // thing `image.detach` accepts is the exact path. Said out loud rather than silently
          // skipped, because the consequence is real (the next turn spends the image) and an operator
          // reading this line knows why.
          this.#log("hermes attached the photo but reported no path, so the failed send could not be unwound");
        }
        throw err;
      }
    });

    const at = this.#now();
    const clientId = opts.clientId ?? `${sessionId}#local-${at}`;
    const turnId = this.#startTurn(name, sessionId, baseline, running, inflight);
    // Entries from a turn that is over, or that have outlived a whole turn cap inside a live one,
    // belong to a message that is never coming back around the poll (a history read re-based the
    // watermark past it, hermes dropped it, the turn was abandoned). Leaving them in the queue is
    // what let a later send of the SAME words claim one and hand the app a duplicate id
    // (cozychat#38). Entries from THIS turn stay: two quick taps are two live sends, and each still
    // owes its own row a clientId.
    const queue = (this.#pending.get(name) ?? []).filter(
      (entry) => entry.turn === turnId && entry.at > at - this.#timeoutMs,
    );
    queue.push({
      clientId,
      // The join key, canonicalized to what the transcript will hand back. See `PendingSend.text`.
      text: stripImageDirectives(text),
      turn: turnId,
      at,
      ...(opts.photo === undefined ? {} : { photo: opts.photo }),
    });
    this.#pending.set(name, queue);
    return {
      id: `${sessionId}#local-${at}`,
      role: "user",
      text,
      at,
      clientId,
      // The committed message carries the photo straight away, so the 202 body a sender renders its
      // optimistic bubble from already has the picture in it and does not have to wait for the poll.
      ...(opts.photo === undefined ? {} : { attachments: [opts.photo.block] }),
    };
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
    this.#identity.clear();
    this.#lastState.clear();
    this.#pending.clear();
    // Safe only because the process is going away: a lock dropped while a send holds it would let the
    // next send skip the line, and skipping the line is what loses a photo.
    this.#submitLocks.clear();
  }

  /** Opens (or joins) the poll for a send, and answers which turn the send belongs to. */
  #startTurn(name: string, sessionId: string, baseline: number, running: boolean, inflight: boolean): number {
    const existing = this.#turns.get(name);
    if (existing !== undefined && existing.sessionId === sessionId) {
      // Single-flight: the live poll adopts the new turn by extending its own deadline. Its
      // completion test still requires an idle session, so it cannot declare the second turn done
      // while Hermes is mid-reply.
      existing.deadline = this.#now() + this.#timeoutMs;
      return existing.id;
    }
    // The bot's canonical session id changed under a live poll (a compaction re-pin, a desktop
    // clear, a pin writeback race). That poll is now broadcasting for a chat nobody is in, so it
    // is cancelled rather than left to run out its 180 s cap.
    if (existing !== undefined) existing.cancelled = true;

    const turn: ActiveTurn = {
      sessionId,
      id: (this.#nextTurnId += 1),
      baseline,
      deadline: this.#now() + this.#timeoutMs,
      sawActivity: running || inflight,
      cancelled: false,
      deliveredAssistant: new Map(),
      done: Promise.resolve(),
    };
    turn.done = this.#poll(name, turn, running, inflight).finally(() => {
      if (this.#turns.get(name) === turn) this.#turns.delete(name);
    });
    this.#turns.set(name, turn);
    return turn.id;
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

      const settled = this.#settled(turn, snapshot);
      let messages = snapshot.messages;
      if (settled && this.#assistantMedia !== undefined) {
        const mark = this.#watermarks.get(name);
        const already = mark !== undefined && mark.sessionId === turn.sessionId ? mark.seen : EMPTY_IDS;
        messages = await Promise.all(
          messages.map((message) =>
            already.has(message.id) ? message : this.#extractAssistantMedia(name, turn.sessionId, message, turn),
          ),
        );
      }
      messages = this.#emitMessages(name, turn, messages, settled);
      if (snapshot.running || snapshot.inflight) turn.sawActivity = true;
      if (settled) {
        this.#emitState(name, turn.sessionId, "complete", false, false);
        const assistant = messages.at(-1);
        if (
          assistant?.role === "assistant" &&
          !isContextCompactionMarker(assistant) &&
          this.#onSettledAssistantMessage !== undefined
        ) {
          try {
            this.#onSettledAssistantMessage({
              bot: name,
              chatSessionId: turn.sessionId,
              messageId: assistant.id,
            });
          } catch (err) {
            this.#log(
              `settled assistant callback failed for ${name}: ${err instanceof Error ? err.message : "unknown"}`,
            );
          }
        }
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
    if (last !== undefined) return last.role === "assistant" && !isContextCompactionMarker(last);
    return turn.sawActivity;
  }

  /** Broadcasts every row this session has not been handed yet, keyed on message IDENTITY and never
   *  on a position. A compaction that re-bases the transcript therefore costs exactly the rows it
   *  added (the summary it wrote, and whatever landed after it) rather than the whole transcript
   *  under fresh ids, which is what a client renders as a doubled conversation (cozygateway#87). A
   *  session id change starts a new mark, so switching chats replays the new chat's messages once
   *  rather than diffing across sessions. */
  #emitMessages(name: string, turn: ActiveTurn, messages: BotChatMessage[], settled = true): BotChatMessage[] {
    const sessionId = turn.sessionId;
    const mark = this.#watermarks.get(name);
    const already = mark !== undefined && mark.sessionId === sessionId ? mark.seen : EMPTY_IDS;
    const visible = messages
      .filter(
        (message) =>
        settled ||
        this.#assistantMedia === undefined ||
        message.role !== "assistant" ||
        assistantMediaDirectives(message.text).length === 0,
      )
      .map((message) => this.#decorate(sessionId, this.#reconcile(name, message, already)));
    const canonical: BotChatMessage[] = [];
    const fresh: BotChatMessage[] = [];
    for (const message of visible) {
      if (message.role !== "assistant") {
        canonical.push(message);
        if (!already.has(message.id)) fresh.push(message);
        continue;
      }

      // Fingerprint the text the device will receive. #97 compaction replacement has already run
      // in decode, and #96 successful MEDIA lines have already been stripped by extraction and
      // decoration. Comparing either raw form here would let settle-time rewriting mint a second
      // row for text that is identical on the wire.
      const fingerprint = chatRowFingerprint(message.role, message.text);
      const wire = JSON.stringify([message.text, message.attachments ?? []]);
      const delivered = turn.deliveredAssistant.get(fingerprint);
      if (delivered !== undefined) {
        const id = this.#identity.coalesce(sessionId, message.id, delivered.id);
        const aliased = id === message.id ? message : { ...message, id };
        canonical.push(aliased);
        // A settle-time media extraction may add attachments to the already visible utterance.
        // Send that as an update under the SAME id, while an exact segment replay stays silent.
        if (wire !== delivered.wire) {
          fresh.push(aliased);
          turn.deliveredAssistant.set(fingerprint, { id, wire });
        }
        continue;
      }

      canonical.push(message);
      if (!already.has(message.id)) {
        fresh.push(message);
        turn.deliveredAssistant.set(fingerprint, { id: message.id, wire });
      }
    }
    this.#setWatermark(name, sessionId, canonical);
    if (fresh.length > 0) {
      this.#broadcast({
        type: "bot_chat",
        bot: name,
        sessionId,
        messages: fresh,
        updatedAt: this.#now(),
      });
    }
    const unique = new Set<string>();
    return canonical.filter((message) => {
      if (unique.has(message.id)) return false;
      unique.add(message.id);
      return true;
    });
  }

  /** Re-attaches the sender's `clientId` to the user message it accepted, once that message comes
   *  back around the poll carrying Hermes' own id. Without it the optimistic row the sender
   *  rendered from the 202 body and the row in the frame share nothing, and the documented
   *  key-on-id dedupe could never fire.
   *
   *  Text alone cannot say WHICH send a row is: a user who asks the same thing twice produces two
   *  rows with identical text, and matching the first entry that happens to hold those words let a
   *  clientId cross a turn boundary. The app then held two transcript rows with one id, and SwiftUI
   *  dropped one of them without a word (cozychat#38). So the match is ordered and single use:
   *
   *   • a row this session has ALREADY broadcast is never stamped. It is a replay off a re-based
   *     watermark, the client has it, and the send in flight is not it.
   *   • the queue is FIFO and the first entry holding this text wins, since hermes persists sends
   *     in the order it accepted them and the poll reads them back in that order.
   *   • everything AHEAD of the match is dropped with it. A newer entry matching first is proof
   *     those older ones will never be matched at all, and leaving them is what let the next
   *     identical send collect a dead clientId.
   *   • an entry is consumed exactly once, so a second row can never be handed the same id. */
  #reconcile(name: string, message: BotChatMessage, alreadyBroadcast: ReadonlySet<string>): BotChatMessage {
    if (message.role !== "user") return message;
    if (alreadyBroadcast.has(message.id)) return message;
    const queue = this.#pending.get(name);
    if (queue === undefined || queue.length === 0) return message;
    const index = queue.findIndex((entry) => entry.text === message.text);
    if (index === -1) return message;
    const consumed = queue.splice(0, index + 1);
    if (queue.length === 0) this.#pending.delete(name);
    const entry = consumed[consumed.length - 1]!;
    // The row this send became is now known, so the photo it carried is written down against it. The
    // `#decorate` pass that follows reads it straight back, which is what makes the frame and every
    // later history read agree without either of them holding the pending queue's single-use state.
    if (entry.photo !== undefined) this.#attachments?.bind(entry.photo.fileId, message.id);
    return { ...message, clientId: entry.clientId };
  }

  #setWatermark(name: string, sessionId: string, messages: BotChatMessage[]): void {
    const previous = this.#watermarks.get(name);
    // A different session is a different transcript, so its ids carry nothing over.
    const seen = previous !== undefined && previous.sessionId === sessionId ? previous.seen : new Set<string>();
    for (const message of messages) seen.add(message.id);
    if (seen.size > MAX_SEEN_IDS) {
      // Trimmed in two passes, and the order matters now that the mark is the only thing standing
      // between a client and a re-delivery. Ids no longer IN the transcript go first: hermes cannot
      // hand those rows back, so forgetting them costs nothing. Only if that is not enough does the
      // oldest live id go, and forgetting one of those does mean it can be delivered twice.
      const live = new Set(messages.map((message) => message.id));
      for (const id of seen) {
        if (seen.size <= MAX_SEEN_IDS) break;
        if (!live.has(id)) seen.delete(id);
      }
      for (const id of seen) {
        if (seen.size <= MAX_SEEN_IDS) break;
        seen.delete(id);
      }
    }
    this.#watermarks.set(name, { sessionId, seen });
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
    return parseChatSnapshot(result, sessionId, this.#identity);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

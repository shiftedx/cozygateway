import type { BotChatDeltaFrame, BotGroup, BotGroupDetail, BotGroupMessage, BotGroupNote, ServerFrame } from "cozygateway-contract";

import type { Storage, BotGroupLogRow, BotGroupRow, BotGroupTurnRow } from "../storage.ts";
import type { AttachV1EventFrame } from "../adapters/attach/protocol-v1.ts";
import { normalizeProfileName } from "./crud.ts";
import {
  GROUP_LOG_LIMIT,
  GROUP_MAX_MEMBERS,
  GROUP_MAX_MESSAGES,
  GROUP_MAX_ROUNDS,
  GROUP_MIN_MEMBERS,
  GROUP_NAME_MAX,
  GROUP_USER_LABEL,
  buildTurnPrompt,
  deltaSince,
  highestSeq,
  isPassText,
  mentionsUser,
  resolveResponders,
  rotateSpeakers,
  type GroupLogEntry,
  type GroupMember,
} from "./group-protocol.ts";
import { blocksToText } from "../adapters/attach/blocks-to-text.ts";
import { settledGroupTurn, startNativeMemberTurn, type GroupTurnResult, type NativeGroupTurnEndpoint } from "./group-turn.ts";

/** Server-side group chats: durable rooms whose deliberation rounds run HERE rather than in a
 *  client (spec section 4, the one deliberate deviation from the Hermes desktop).
 *
 *  The desktop runs the identical protocol in its renderer, so a room dies when the window closes
 *  and its log never leaves that machine. Hosting it in the gateway buys three things a phone needs:
 *  a round that keeps going while the app is backgrounded, a transcript every paired device sees,
 *  and a room that survives a restart because it lives in SQLite.
 *
 *  The price, stated plainly because a user can observe it: these rooms are GATEWAY-LOCAL. The
 *  member turn threads are gateway-owned attach identities, not Dashboard chat sessions.
 *
 *  Everything about how a room behaves (who speaks, in what order, what they are asked, when it
 *  stops) is `group-protocol.ts`, verbatim from the desktop. This module is the state machine and
 *  the plumbing around those rules. */

/** Room names that would be shadowed by a per-bot route of the same shape. `/bots/groups/:name` and
 *  `/bots/:name/<suffix>` are both three segments, so a room named `profile` would sit exactly where
 *  a bot named `groups` keeps its profile. The per-bot routes are registered first (a bot is the
 *  older, likelier thing to be named `groups`), and these names are refused at create so no room can
 *  ever exist at an address that does not reach it. */
export const RESERVED_GROUP_NAMES: ReadonlySet<string> = new Set([
  "profile",
  "chat",
  "sessions",
  "inbox",
  "messages",
  "catalog",
  "focus",
]);

/** True when a room name is hostile to the address it lives at. A room is addressed as
 *  `/bots/groups/<name>`, so a `/` or a backslash splits the path, a `%` opens percent-decoding,
 *  and `?`/`#` end the segment; control characters have no business in a path, a header or a log
 *  line either. Checked by code point rather than by a regexp literal so the rule reads the same
 *  in source as it behaves. */
function isHostileGroupName(name: string): boolean {
  for (const character of name) {
    if ("/\\?#%".includes(character)) return true;
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** How long a superseding drive waits before taking over, the desktop's own 250 ms
 *  (dissection 9.3). */
export const GROUP_CHAIN_DELAY_MS = 250;

export class GroupNotFound extends Error {
  constructor(name: string) {
    super(`no group chat named "${name}"`);
    this.name = "GroupNotFound";
  }
}

export class GroupExists extends Error {
  constructor(name: string) {
    super(`a group chat named "${name}" already exists`);
    this.name = "GroupExists";
  }
}

export class GroupInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupInvalid";
  }
}

export interface GroupRoomsOptions {
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** The bot's handle and display title, from the bridge's roster view. Always answers: a member
   *  the roster cache has not seen yet is derived from its profile name rather than dropped, so a
   *  cold cache cannot silently shrink a room. */
  memberInfo: (name: string) => GroupMember;
  /** Which of these names are NOT bots on this gateway, answered from a FRESH read rather than a
   *  cached snapshot. Used at create: membership is validated once, when the room is made, and the
   *  room then outlives the answer. */
  missingMembers: (names: string[]) => Promise<string[]>;
  /** Cache-only, synchronous "is this still a bot?", read at every member boundary so a member
   *  deleted after the room was created is skipped with a note instead of burning a whole failed
   *  turn per round forever. Answers `undefined` when the roster cache cannot tell (a cold cache),
   *  which reads as "assume it is still there": a cold cache must never shrink a room.
   *
   *  It is a HINT and never the last word. A `false` here only nominates a member for the
   *  authoritative `memberExists` check below, because the cache this reads is filtered (hidden
   *  bots are not in it at all) and a member it cannot see is not the same thing as a member that
   *  is not there. */
  memberKnown?: (name: string) => boolean | undefined;
  /** Authoritative "is this still a bot?", answered from a FRESH read. Asked in exactly two places,
   *  both of which cost a round trip only when something is actually at stake:
   *
   *  - when the cheap `memberKnown` gate says `false`, to confirm the news before a member is
   *    skipped for the rest of the room's life; and
   *  - before an attach turn is queued, when a stale cache says a member disappeared.
   *
   *  A member whose session already resolves therefore costs nothing, which is the whole point: the
   *  earlier shape of this guard asked once per member per round and burned a `profiles.list` on
   *  every healthy turn. It must not throw, and must answer `true` when it cannot tell: a gateway
   *  that cannot reach Hermes has learned nothing about who is still a bot. */
  memberExists?: (name: string) => Promise<boolean>;
  /** Called when a member's reply mentions `@user`, i.e. the room needs the human. The room has
   *  already set its durable `needs you` state and emitted its frame by then; this is the OUT OF
   *  BAND leg, for a phone that is not holding a socket open (spec section 4). Fire-and-forget by
   *  contract: it must not throw and must not block the round. */
  escalate?: (event: { group: string; member: string; displayName: string; text: string }) => void;
  /** Existing attach-v1 turn transport, injected after the ingress exists. */
  nativeTurns?: NativeGroupTurnEndpoint;
  pollMs?: number;
  turnTimeoutMs?: number;
  chainDelayMs?: number;
  log?: (message: string) => void;
}

export class GroupRooms {
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #memberInfo: (name: string) => GroupMember;
  readonly #missingMembers: (names: string[]) => Promise<string[]>;
  readonly #memberKnown: (name: string) => boolean | undefined;
  readonly #memberExists: (name: string) => Promise<boolean>;
  readonly #escalate: (event: { group: string; member: string; displayName: string; text: string }) => void;
  #nativeTurns: NativeGroupTurnEndpoint | undefined;
  readonly #pollMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #chainDelayMs: number;
  readonly #log: (message: string) => void;
  readonly #waiters = new Map<string, () => void>();
  /** Live-draft sequence per member turn, from 1. In memory on purpose: a draft is ephemeral, and a
   *  turn that outlives this process resumes from its durable commit rather than its half-typed
   *  text. */
  readonly #draftSeq = new Map<string, number>();

  /** The drive currently holding a room, by room key, tagged with the room GENERATION it was
   *  started for. Present means "a round loop is live", which is the room's only piece of
   *  non-durable state.
   *
   *  The generation tag is load-bearing and the entry is deliberately NOT dropped when the room is
   *  deleted. Dropping it left a running drive with nothing chained behind it, so a room recreated
   *  under the same key started a second drive immediately, and because a fresh room's epoch counts
   *  from the same place the dead drive's `startEpoch` could match it again: two drives against one
   *  room, which is exactly the thing the serialization rule exists to prevent. Keeping the handle
   *  means the successor chains behind the corpse, and the generation means the corpse can tell
   *  that the room it was driving is gone even though a room of the same name is back. */
  readonly #drives = new Map<string, { promise: Promise<void>; generation: number }>();
  /** Bumped every time a room key is deleted. In memory on purpose: it only has to outlive the
   *  drives of THIS process, and a restart has no drives to disambiguate. */
  readonly #generations = new Map<string, number>();
  #closed = false;

  constructor(opts: GroupRoomsOptions) {
    this.#storage = opts.storage;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#memberInfo = opts.memberInfo;
    this.#missingMembers = opts.missingMembers;
    this.#memberKnown = opts.memberKnown ?? ((): boolean | undefined => undefined);
    this.#memberExists = opts.memberExists ?? ((): Promise<boolean> => Promise.resolve(true));
    this.#escalate = opts.escalate ?? ((): void => {});
    this.#nativeTurns = opts.nativeTurns;
    this.#pollMs = opts.pollMs;
    this.#turnTimeoutMs = opts.turnTimeoutMs;
    this.#chainDelayMs = opts.chainDelayMs ?? GROUP_CHAIN_DELAY_MS;
    this.#log = opts.log ?? ((): void => {});
  }

  /** The ingress is assembled after the bridge, so wiring is deliberately explicit rather than a
   * hidden global. Commands already persisted while the socket was away replay through this sink. */
  setNativeTurns(endpoint: NativeGroupTurnEndpoint): void {
    this.#nativeTurns = endpoint;
  }

  canAcceptAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (!("threadId" in event) || !("turnId" in event)) return false;
    return this.#storage.botGroupTurnForAttach(agentId, event.threadId, event.turnId) !== undefined;
  }

  /** Projects only events whose target is a durable group-member turn. Other attach consumers
   * retain their own ownership routes even when they share this profile token. */
  handleAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (!("threadId" in event) || !("turnId" in event)) return false;
    const owned = this.#storage.botGroupTurnForAttach(agentId, event.threadId, event.turnId);
    if (owned === undefined) return false;
    let settled: BotGroupTurnRow | undefined;
    if (event.kind === "commit") {
      settled = this.#storage.completeBotGroupTurn(agentId, event.threadId, event.turnId, "commit", blocksToText(event.blocks), undefined, this.#now());
    } else if (event.kind === "failed") {
      settled = this.#storage.completeBotGroupTurn(agentId, event.threadId, event.turnId, "failed", undefined, event.message, this.#now());
    } else if (event.kind === "cancelled" || event.kind === "interrupted") {
      settled = this.#storage.completeBotGroupTurn(agentId, event.threadId, event.turnId, event.kind, undefined, undefined, this.#now());
    } else if (event.kind === "draft") {
      // Capability 46. The contract already reserved `BotChatDeltaFrame.room` for exactly this, so
      // a member composing its reply streams into the room the same way a 1:1 bot streams into a
      // chat: same frame, same accumulate-by-`turnId` rule, plus the room name that tells a client
      // which transcript the bubble belongs above.
      this.#emitDraft(owned, blocksToText(event.blocks));
      return true;
    } else {
      // Tool, thinking, and interaction events still belong to this already-authorized turn. The
      // room has no wire projection for them in this capability, but declining would dead-letter
      // an otherwise valid at-least-once stream.
      return true;
    }
    if (settled === undefined) return false;
    // The live bubble is over: its sequence is per-turn, and the turn is terminal.
    this.#draftSeq.delete(event.turnId);
    const wake = this.#waiters.get(event.turnId);
    if (wake !== undefined) wake();
    else this.#recoverSettledTurn(settled);
    return true;
  }

  list(): BotGroup[] {
    return this.#storage.botGroups().map((room) => this.#view(room));
  }

  /** Creates a room. Membership is validated against a FRESH profile list BEFORE anything is
   *  written, so a room can never exist naming a bot that does not, and the caller gets one 400
   *  naming every member that is missing instead of a room that fails on its first round. */
  async create(rawName: string, rawMembers: string[]): Promise<BotGroup> {
    const name = rawName.trim();
    if (name.length === 0) throw new GroupInvalid("a group name is required");
    if (name.length > GROUP_NAME_MAX) {
      throw new GroupInvalid(`a group name must be at most ${GROUP_NAME_MAX} characters`);
    }
    if (isHostileGroupName(name)) {
      throw new GroupInvalid(
        "a group name cannot contain /, \\, ?, #, % or control characters: the name IS the address the room lives at",
      );
    }
    const key = name.toLowerCase();
    if (RESERVED_GROUP_NAMES.has(key)) {
      throw new GroupInvalid(`"${name}" is reserved by this API and cannot name a group`);
    }

    const members: string[] = [];
    for (const raw of rawMembers) {
      // The same canonicalization every `/bots/:name` route applies, so a room created with `Scout`
      // and a bot addressed as `scout` are the same bot.
      const member = normalizeProfileName(raw);
      if (!members.includes(member)) members.push(member);
    }
    if (members.length < GROUP_MIN_MEMBERS || members.length > GROUP_MAX_MEMBERS) {
      throw new GroupInvalid(
        `a group needs between ${GROUP_MIN_MEMBERS} and ${GROUP_MAX_MEMBERS} distinct members, got ${members.length}`,
      );
    }
    // One FRESH read for the whole membership, and every missing name comes back at once.
    //
    // Cache-first would be cheaper and was what this did, and it is what let the bug in: the roster
    // snapshot still listed a bot that had just been deleted, the room was written naming it, and
    // the first round addressed that name. A room is
    // durable and its membership is fixed at create, so this is the one place where paying for a
    // fresh answer is obviously right.
    const missing = await this.#missingMembers(members);
    if (missing.length > 0) {
      throw new GroupInvalid(
        `not a bot on this gateway: ${missing.join(", ")}. A room can only name bots that exist here.`,
      );
    }

    if (!this.#storage.createBotGroup({ key, name, members, createdAt: this.#now() })) {
      throw new GroupExists(name);
    }
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(name);
    return this.#view(room);
  }

  /** Deletes a room while retaining terminal turn tombstones so late attach events are harmless.
   * A recreated room gets fresh gateway-owned member threads. */
  remove(rawName: string): void {
    const key = this.#key(rawName);
    if (!this.#storage.deleteBotGroup(key)) throw new GroupNotFound(rawName.trim());
    // The generation bump is the kill signal, and it is what a drive started for the OLD room
    // checks at every boundary. The drive HANDLE stays in the map until the drive itself clears it,
    // so a room recreated under this key chains behind the dying drive rather than racing it.
    // `remove` is synchronous by contract (the route answers 204 without waiting on a member turn),
    // so it cannot await the drive; it makes the drive unable to do any further harm instead.
    this.#generations.set(key, this.#generation(key) + 1);
  }

  /** The room plus its transcript. Reading a room CLEARS its `needs you` badge, which is the
   *  desktop's rule (dissection 9.9): the escalation has been seen. Other devices are told, so the
   *  badge drops everywhere rather than only where it was read. */
  detail(rawName: string): BotGroupDetail {
    const key = this.#key(rawName);
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());
    const messages = this.#storage.botGroupLog(key).map(toWireMessage);
    if (room.needsYou) {
      this.#storage.setBotGroupNeedsYou(key, false);
      room.needsYou = false;
      this.#emitState(room, this.#driving(key) ? "running" : "settled", 0);
    }
    return { ...this.#view(room), messages };
  }

  /** Accepts a user message into a room and starts (or supersedes) the deliberation behind it.
   *  Resolves as soon as the message is durable: every reply arrives later, over `/ws`. */
  send(rawName: string, text: string, opts: { clientId?: string } = {}): BotGroupMessage {
    const key = this.#key(rawName);
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());

    // Cleared BEFORE the message lands, so the badge cannot survive the very message that answers
    // the escalation.
    this.#storage.setBotGroupNeedsYou(key, false);
    const entry = this.#append(key, {
      kind: "user",
      name: GROUP_USER_LABEL,
      displayName: GROUP_USER_LABEL,
      text,
      at: this.#now(),
      ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
    });
    // The epoch bump is the supersession signal: any loop still running for the previous message
    // sees it at its next member boundary and abandons the rest of its rounds.
    const epoch = this.#storage.bumpBotGroupEpoch(key);
    this.#startDrive(key, epoch);
    return toWireMessage(entry);
  }

  /** True while a round loop holds the room. Test seam. */
  running(rawName: string): boolean {
    return this.#driving(this.#key(rawName));
  }

  /** Resolves when the room's current drive has finished. Test seam; no request path waits on one.
   *  Awaits whatever drive holds the key, INCLUDING one left over from a deleted room, which is
   *  what makes the delete/recreate race testable rather than timing-dependent. */
  async settled(rawName: string): Promise<void> {
    await this.#drives.get(this.#key(rawName))?.promise.catch(() => {});
  }

  /** Shuts the orchestrator down and WAITS for the drives to notice. Awaiting matters: the caller
   *  closes the database next, and a drive still inside a member turn would come back to a closed
   *  handle. `#closed` makes every drive stop at its next boundary, and each one is checked before
   *  any storage read, so this resolves in about one poll rather than in one turn cap. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const wake of this.#waiters.values()) wake();
    this.#waiters.clear();
    const running = [...this.#drives.values()].map((entry) => entry.promise.catch(() => {}));
    this.#drives.clear();
    await Promise.all(running);
  }

  // --- internals ---------------------------------------------------------------------------------

  #key(rawName: string): string {
    return rawName.trim().toLowerCase();
  }

  /** Which incarnation of this room key is the live one. */
  #generation(key: string): number {
    return this.#generations.get(key) ?? 0;
  }

  /** True when a drive for the room CURRENTLY at this key is live. A drive left over from a
   *  deleted room is winding down, not driving, so it must not make a recreated room read
   *  `running`. */
  #driving(key: string): boolean {
    return this.#drives.get(key)?.generation === this.#generation(key);
  }

  #view(room: BotGroupRow): BotGroup {
    const log = this.#storage.botGroupLog(room.key);
    const state = this.#driving(room.key) ? "running" : room.needsYou ? "needs_you" : "settled";
    return {
      name: room.name,
      members: room.members,
      createdAt: room.createdAt,
      state,
      needsYou: room.needsYou,
      epoch: room.epoch,
      updatedAt: log.at(-1)?.at ?? room.createdAt,
    };
  }

  #append(key: string, entry: Omit<BotGroupLogRow, "seq">): BotGroupLogRow {
    const row = this.#storage.appendBotGroupMessage(key, entry);
    this.#storage.trimBotGroupLog(key, GROUP_LOG_LIMIT);
    const room = this.#storage.botGroup(key);
    this.#broadcast({
      type: "bot_group",
      group: room?.name ?? key,
      messages: [toWireMessage(row)],
      updatedAt: this.#now(),
    });
    return row;
  }

  /** Starts a drive, chained behind whatever drive is already holding the room.
   *
   *  The desktop fires the replacement loop on a 250 ms timer and lets the two overlap for one
   *  member turn. This waits for the superseded drive to reach its next boundary and stop, keeping
   *  the 250 ms floor. Observably identical (the old loop was going to bail at that boundary either
   *  way), and it preserves the property the protocol is built on: member turns are SERIAL, never
   *  two bots prompted at once. */
  #startDrive(key: string, epoch: number): void {
    if (this.#closed) return;
    const generation = this.#generation(key);
    // Chained behind whatever holds the key, and a drive for a DELETED room still holds it. That
    // is the whole point: a room deleted and recreated inside one turn window must not run two
    // drives at once, and the successor's chain is the only place that can be guaranteed.
    const previous = this.#drives.get(key)?.promise;
    const run: Promise<void> = (async () => {
      if (previous !== undefined) {
        await Promise.all([previous.catch(() => {}), sleep(this.#chainDelayMs)]);
      }
      if (this.#closed || this.#generation(key) !== generation) return;
      await this.#runRounds(key, epoch, generation);
    })()
      // Belt and braces on top of the guards inside the loop. NOTHING awaits this promise on a
      // request path, so any rejection that reached here would be an UNHANDLED rejection, and the
      // gateway registers no `unhandledRejection` handler: Node's default is to exit. A room
      // orchestrator must not be able to take the process down, so a drive that fails says so in
      // the log and dies quietly, whatever the failure turns out to be.
      .catch((err: unknown) => {
        this.#log(`group drive for "${key}" failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (this.#drives.get(key)?.promise === run) this.#drives.delete(key);
      });
    this.#drives.set(key, { promise: run, generation });
  }

  /** The round loop (dissection 9.3). Serial members, at most three rounds, at most ten posted
   *  messages per user send, stopping early the moment a whole round passes. */
  async #runRounds(key: string, startEpoch: number, startGeneration: number): Promise<void> {
    let room = this.#storage.botGroup(key);
    if (room === undefined || this.#generation(key) !== startGeneration) return;
    let round = 0;
    let posted = 0;
    this.#emitState(room, "running", round, undefined, startEpoch);
    try {
      for (; round < GROUP_MAX_ROUNDS; round += 1) {
        room = this.#storage.botGroup(key);
        if (room === undefined || room.epoch !== startEpoch || this.#closed) return;
        if (this.#generation(key) !== startGeneration) return;
        const members = room.members.map((name) => this.#memberInfo(name));
        const responders = rotateSpeakers(resolveResponders(this.#entries(key), members), round);
        let spoke = 0;

        for (const member of responders) {
          const current = this.#storage.botGroup(key);
          // Checked at every member boundary, which is exactly where the desktop checks: a newer
          // user message, a deleted room, or the message cap all stop the loop here. The
          // GENERATION check is the one the desktop has no need of: it catches a room that was
          // deleted and remade under the same name while this drive was inside a member turn, which
          // the epoch cannot see because a remade room's epoch counts from the start again.
          if (current === undefined || current.epoch !== startEpoch || this.#closed) return;
          if (this.#generation(key) !== startGeneration) return;
          if (posted >= GROUP_MAX_MESSAGES) {
            // Said out loud rather than returned silently: a room that stopped because it hit its
            // cap looks exactly like a room where everybody passed, and those mean opposite things
            // to a reader deciding whether to send again.
            this.#emitState(current, "running", round, {
              member: member.name,
              reason: "capped",
              detail: `the room posted its ${GROUP_MAX_MESSAGES}-message limit for this send and stopped early`,
            }, startEpoch);
            return;
          }
          // A member deleted after the room was created is not a turn worth spending: the profile
          // is gone, the session cannot resolve, and without this the room burns one failed turn on
          // it every round, forever.
          //
          // The cache alone must NOT be allowed to end a member's participation, though, and this
          // is the ordering that bug taught: the roster cache is built FILTERED, so a bot the
          // gateway hides is absent from it while being perfectly real in Hermes. Left to itself
          // this gate answered `false` for such a member every round and reported it gone forever,
          // which is precisely the silent shrinking the gate exists to prevent. So a negative cache
          // answer only buys the round trip: the fresh read is what decides.
          if (this.#memberKnown(member.name) === false && !(await this.#memberExists(member.name))) {
            // The gate now awaits, so the room it emits against has to be re-read: the same
            // boundary conditions the top of this loop checks can all have happened meanwhile.
            if (this.#closed || this.#generation(key) !== startGeneration) return;
            const live = this.#storage.botGroup(key);
            if (live === undefined || live.epoch !== startEpoch) return;
            this.#emitState(live, "running", round, goneNote(member), startEpoch);
            continue;
          }

          const log = this.#entries(key);
          const state = this.#storage.botGroupMembers(key).get(member.name);
          const watermark = state?.watermark ?? 0;
          const delta = deltaSince(log, watermark);
          // Nothing new since this member last spoke or passed: it has nothing to react to.
          if (delta.length === 0) continue;

          const result = await this.#turn({
            key,
            groupName: current.name,
            member,
            members,
            delta,
            startEpoch,
            startGeneration,
            ...(state?.sessionId == null ? {} : { storedId: state.sessionId }),
          });
          // A room DELETED while this turn was in flight gets nothing written to it: the rows are
          // gone and the reply belongs to a conversation that no longer exists. A room merely
          // SUPERSEDED does get the reply, which is the contract's own rule; the loop stops at the
          // next boundary either way.
          // `#closed` FIRST: a closed bridge has a closed database behind it, and reading the room
          // to decide whether to write would be the read that throws.
          if (this.#closed || this.#generation(key) !== startGeneration) return;
          if (this.#storage.botGroup(key) === undefined) return;
          // The member was deleted while this round was running, and the turn stopped at the
          // boundary before it could have minted anything. Same news, same note and same skip as the
          // pre-round gate above, and deliberately BEFORE the watermark write: a member that was
          // never asked has not read the room, so if it ever comes back it starts from where it was.
          if (result.outcome === "gone") {
            const live = this.#storage.botGroup(key);
            if (live !== undefined) this.#emitState(live, "running", round, goneNote(member), startEpoch);
            continue;
          }
          // Marked as having seen everything that existed BEFORE its reply, whatever the outcome,
          // so a member that failed or passed is not asked about the same delta forever.
          this.#storage.setBotGroupWatermark(key, member.name, highestSeq(log, watermark));

          if (result.outcome === "spoke") {
            const entry = this.#append(key, {
              kind: "member",
              name: member.name,
              displayName: member.displayName,
              text: result.text,
              at: this.#now(),
            });
            this.#storage.setBotGroupWatermark(key, member.name, entry.seq);
            posted += 1;
            spoke += 1;
            if (mentionsUser(result.text)) {
              this.#storage.setBotGroupNeedsYou(key, true);
              // The out-of-band leg (spec section 4). Durable state and the frame have already
              // happened; this reaches a device that is not holding a socket. Guarded because a
              // notifier failure must never take a round down with it.
              try {
                this.#escalate({
                  group: current.name,
                  member: member.name,
                  displayName: member.displayName,
                  text: result.text,
                });
              } catch (err) {
                this.#log(
                  `group ${current.name}: escalation for ${member.name} failed: ${err instanceof Error ? err.message : "unknown failure"}`,
                );
              }
            }
          } else if (result.outcome !== "pass") {
            // Failure honesty: the room is told the member did not answer, and by whom and why. It
            // is NEVER told something the member did not say.
            const note: BotGroupNote = { member: member.name, reason: result.outcome, detail: result.detail };
            const live = this.#storage.botGroup(key);
            if (live !== undefined) this.#emitState(live, "running", round, note, startEpoch);
          }
        }

        // A whole round in which nobody had anything to add: the conversation has settled, and
        // running further rounds would only ask the same members about the same log.
        if (spoke === 0) return;
      }
    } finally {
      // Checked BEFORE the read, not inside the condition below: a closed bridge has a closed
      // database, and `botGroup` would be the call that throws out of a `finally`.
      const final =
        this.#closed || this.#generation(key) !== startGeneration ? undefined : this.#storage.botGroup(key);
      // A drive that was superseded says nothing: the drive that replaced it owns the room's state
      // now, and a `settled` from the loser would clear a badge the winner is still filling in.
      if (final !== undefined && final.epoch === startEpoch) {
        this.#emitState(final, final.needsYou ? "needs_you" : "settled", round, undefined, startEpoch);
      }
    }
  }

  /** One member's turn is an attach-v1 command/event round trip. No Dashboard session is resolved
   * or polled here: `threadId` is a gateway-owned durable identity for this room member. */
  async #turn(args: {
    key: string;
    groupName: string;
    member: GroupMember;
    members: GroupMember[];
    delta: GroupLogEntry[];
    startEpoch: number;
    startGeneration: number;
    storedId?: string;
  }): Promise<GroupTurnResult> {
    const { key, groupName, member, members, delta, startEpoch, startGeneration, storedId } = args;
    if (this.#closed || this.#generation(key) !== startGeneration) return { outcome: "pass" };
    if (this.#storage.botGroup(key) === undefined) return { outcome: "pass" };
    const prompt = buildTurnPrompt(groupName, members, member, delta);
    const endpoint = this.#nativeTurns;
    if (endpoint === undefined) return { outcome: "failed", detail: "native attach-v1 group transport is not configured" };
    const watermark = this.#storage.botGroupMembers(key).get(member.name)?.watermark ?? 0;
    const threadId = storedId ?? this.#storage.ensureBotGroupThread(key, member.name);
    if (storedId === undefined) this.#storage.setBotGroupSession(key, member.name, threadId);
    const started = startNativeMemberTurn({ storage: this.#storage, endpoint, key, member: member.name,
      agentId: member.name, threadId, epoch: startEpoch, watermark, prompt, now: this.#now });
    if ("outcome" in started) return started;
    const result = await this.#waitForTurn(key, started.turnId, startGeneration);
    // `(pass)` in any of its shapes is a pass, and so is a blank reply. Turning a spoken `(pass)`
    // into a room message would show the protocol's own plumbing to the user.
    if (result.outcome === "spoke" && isPassText(result.text)) return { outcome: "pass" };
    return result;
  }

  async #waitForTurn(key: string, turnId: string, generation: number): Promise<GroupTurnResult> {
    const timeoutMs = this.#turnTimeoutMs ?? 180_000;
    const deadline = this.#now() + timeoutMs;
    while (!this.#closed && this.#generation(key) === generation) {
      const row = this.#storage.botGroupTurn(key, turnId);
      if (row !== undefined) {
        const result = settledGroupTurn(row);
        if (result !== undefined) {
          this.#storage.consumeBotGroupTurn(key, turnId, this.#now());
          return result;
        }
      }
      if (this.#now() >= deadline) {
        const detail = `no reply within ${Math.round(timeoutMs / 1000)}s`;
        this.#storage.timeoutBotGroupTurn(key, turnId, detail, this.#now());
        return { outcome: "timeout", detail };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.#waiters.delete(turnId); resolve(); }, this.#pollMs ?? 50);
        timer.unref?.();
        this.#waiters.set(turnId, () => { clearTimeout(timer); this.#waiters.delete(turnId); resolve(); });
      });
    }
    return { outcome: "pass" };
  }

  #recoverSettledTurn(turn: BotGroupTurnRow): void {
    const claimed = this.#storage.consumeBotGroupTurn(turn.key, turn.turnId, this.#now());
    if (claimed === undefined || this.#closed) return;
    const room = this.#storage.botGroup(claimed.key);
    if (room === undefined || room.epoch !== claimed.epoch) return;
    const result = settledGroupTurn(claimed);
    if (result?.outcome === "spoke" && !isPassText(result.text)) {
      const member = this.#memberInfo(claimed.member);
      const entry = this.#append(claimed.key, { kind: "member", name: member.name, displayName: member.displayName, text: result.text, at: this.#now() });
      this.#storage.setBotGroupWatermark(claimed.key, claimed.member, entry.seq);
      if (mentionsUser(result.text)) {
        this.#storage.setBotGroupNeedsYou(claimed.key, true);
        this.#emitState(room, "needs_you", 0, undefined, room.epoch);
        try {
          this.#escalate({ group: room.name, member: member.name, displayName: member.displayName, text: result.text });
        } catch (err) {
          this.#log(`group ${room.name}: recovered escalation for ${member.name} failed: ${err instanceof Error ? err.message : "unknown failure"}`);
        }
      }
    } else {
      this.#storage.setBotGroupWatermark(claimed.key, claimed.member, highestSeq(this.#entries(claimed.key), claimed.watermark));
    }
    // The previous process cannot retain its loop. Resume from durable watermarks; one serial
    // drive owns any remaining responders and the outbox already owns the command replay.
    this.#startDrive(claimed.key, room.epoch);
  }

  /** One live draft of a member turn, as the 1:1 chat frame plus `room`.
   *
   *  `bot` is the member and `sessionId` is its gateway-owned group thread, which is the identity
   *  the room already dispatches on: a client that keys live text by bot and session therefore
   *  needs no new keying to render this, and the `room` field is what stops it being mistaken for
   *  the member's 1:1 conversation. Dropped silently for a room that is already gone, because a
   *  draft is not worth resurrecting a deleted transcript for. */
  #emitDraft(turn: BotGroupTurnRow, text: string): void {
    const room = this.#storage.botGroup(turn.key);
    if (room === undefined) return;
    const seq = (this.#draftSeq.get(turn.turnId) ?? 0) + 1;
    this.#draftSeq.set(turn.turnId, seq);
    const delta: BotChatDeltaFrame = {
      type: "bot_chat_delta",
      bot: turn.member,
      sessionId: turn.threadId,
      turnId: turn.turnId,
      text,
      seq,
      updatedAt: this.#now(),
      room: room.name,
    };
    this.#broadcast(delta);
  }

  #entries(key: string): GroupLogEntry[] {
    return this.#storage.botGroupLog(key).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      name: row.name,
      displayName: row.displayName,
      text: row.text,
      at: row.at,
    }));
  }

  #emitState(
    room: BotGroupRow,
    state: "running" | "settled" | "needs_you",
    round: number,
    note?: BotGroupNote,
    epoch?: number,
  ): void {
    this.#broadcast({
      type: "bot_group_state",
      group: room.name,
      state,
      round,
      epoch: epoch ?? room.epoch,
      ...(note === undefined ? {} : { note }),
      updatedAt: this.#now(),
    });
  }
}

/** What a room says about a member that is no longer a bot here. One wording for both places that
 *  can discover it (the cache gate at the top of a member's slot, once its fresh read confirms the
 *  news, and `ensureGroupSession`'s create arm), because to a reader they are the same event.
 *
 *  `failed` is the reason because the contract's note has three (`timeout`, `failed`, `capped`) and
 *  this is not a timeout or a cap. The detail is what carries the meaning. */
function goneNote(member: GroupMember): BotGroupNote {
  return {
    member: member.name,
    reason: "failed",
    detail: `${member.displayName} is no longer a bot on this gateway`,
  };
}

function toWireMessage(row: BotGroupLogRow): BotGroupMessage {
  return {
    seq: row.seq,
    from: { kind: row.kind, name: row.name, displayName: row.displayName },
    text: row.text,
    at: row.at,
    ...(row.clientId === undefined ? {} : { clientId: row.clientId }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

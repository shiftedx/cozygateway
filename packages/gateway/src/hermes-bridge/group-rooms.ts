import { randomUUID } from "node:crypto";

import type {
  BotApprovalScope,
  BotChatDeltaFrame,
  BotGroup,
  BotGroupDetail,
  BotGroupMessage,
  BotGroupNote,
  BotGroupPatchRequest,
  BotGroupPendingInteraction,
  BotGroupStateFrame,
  BotSummary,
  BotToolStep,
  ServerFrame,
} from "cozygateway-contract";

import type { Storage, BotGroupCause, BotGroupLogRow, BotGroupMeta, BotGroupRow, BotGroupTurnRow } from "../storage.ts";
import { sanitizeApprovalDetail, sanitizeApprovalRepair, sanitizeApprovalScope, type AttachV1EventFrame, type AttachV1TurnContext } from "../adapters/attach/protocol-v1.ts";
import { normalizeProfileName } from "./crud.ts";
import { botDisplayName, botHandle } from "./roster.ts";
import {
  GROUP_LOG_LIMIT,
  GROUP_MAX_MEMBERS,
  GROUP_MAX_MESSAGES,
  GROUP_MAX_ROUNDS,
  GROUP_MIN_MEMBERS,
  GROUP_NAME_MAX,
  GROUP_USER_LABEL,
  USER_MENTION,
  applyHoldDirective,
  buildTurnPrompt,
  heldSeqs,
  isSlashCommand,
  parseMentions,
  threadOf,
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
import type { ObservationRing } from "../observe/ring.ts";

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
  "picture",
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

/** The 1:1 lane's live-frame window, to the millisecond (`LIVE_TURN_FLUSH_MS`). A room draft is
 *  the same kind of frame carrying the same full-replacement text, so it gets the same treatment:
 *  the leading frame goes out at once and every later one inside the window is collapsed to the
 *  latest. A member typing token by token would otherwise put one broadcast per token on every
 *  connected socket. */
export const ROOM_DRAFT_FLUSH_MS = 100;

/** One member turn's live bubble. In memory on purpose: a draft is ephemeral, and a turn that
 *  outlives this process resumes from its durable commit rather than its half-typed text. */
interface RoomDraft {
  /** Monotonic within the turn, from 1, and the terminal `done` frame takes the next one. */
  seq: number;
  /** Live while a coalescing window is open. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The latest frame built inside the open window, waiting for it to close. */
  pending: BotChatDeltaFrame | undefined;
  /** The most recent frame built, whether or not it went out. The terminal frame is this one
   *  emptied, which is how `bot`, `sessionId` and `room` stay right without being re-derived from
   *  a room that may since have been deleted. */
  last: BotChatDeltaFrame;
}

/** What a member turn is DOING and what it is BLOCKED on, in memory for the life of the turn.
 *
 *  Capability 51. An entry exists only for a turn that has actually raised something, so a member
 *  that just talks costs nothing, exactly like `RoomDraft`. It carries the turn's identity because
 *  the settlement paths that seal it (`#endTurnActivity`) are reached with a turn id and nothing
 *  else, and by then the durable turn row may already have been consumed.
 *
 *  The tool steps are EPHEMERAL on purpose: the 1:1 lane persists a turn's steps because a chat has
 *  a history screen to rebuild, and a room has none. A room's record is its transcript, and
 *  capability 51 adds nothing to it. */
interface RoomTurnActivity {
  key: string;
  roomName: string;
  member: string;
  threadId: string;
  /** Monotonic within the turn, from 1, on the `bot_tool_activity` FRAME. */
  seq: number;
  /** Every step of the turn so far, by attach `callId`, in the order they started. */
  steps: Map<string, BotToolStep>;
  /** True once a tool frame has gone out, so the sealing `done` frame is sent only for a turn that
   *  actually opened a card. A turn that only asked for an approval opened none. */
  emitted: boolean;
}

/** The interaction bookkeeping a room borrows from the native data plane (capability 51).
 *
 *  A room interaction IS an ordinary interaction row, so it must expire on the same timer wheel as
 *  every other one and settle by the same rule when its turn ends. Injected rather than
 *  reimplemented: a second copy of "expire what this turn was blocked on" would be a second place
 *  for that rule to drift, and the room already has no business owning it. Absent in a gateway
 *  assembled without the native plane, which is exactly the gateway that has no runtime members. */
export interface RoomInteractionExpiry {
  /** Arms the deadline for one just-recorded pending interaction. A row with no `expiresAt` is a
   *  no-op, so callers hand over every record without deciding. */
  schedule(pending: {
    bot: string;
    kind: "approval" | "clarify";
    interactionId: string;
    sessionId: string;
    turnId: string;
    payload: unknown;
    expiresAt: number | null;
    updatedAt: number;
  }): void;
  /** Expires everything this (bot, thread, turn) is still blocked on, emitting the terminal frames.
   *  Answers whether anything actually changed. */
  expireTurn(bot: string, sessionId: string, turnId: string): boolean;
  /** Capability 66, F4. Does a standing grant already cover this ask, and if it is a single-use
   *  one, spend it? Answers the grant id, or `undefined` for an ask nothing covers. The room hands
   *  over the raw ingredients rather than a binding, so the DERIVATION for a plain ask (the rule
   *  name plus the capability-56 sentence) is the data plane's one implementation and the two lanes
   *  cannot drift. Optional: a gateway assembled without the native plane raises every room ask to
   *  the person, which is the safe direction. */
  claimApprovalGrant?(input: {
    bot: string;
    sessionId: string;
    turnId: string;
    approvalId: string;
    name: string;
    detail?: string;
    scope?: BotApprovalScope;
  }): string | undefined;
  /** Capability 66, F4. Name the grant on the durable record and settle the ask through the very
   *  same `resolve_approval` relay a tapped card sends. Called AFTER the card has gone out, so the
   *  person sees what a grant is answering for them rather than a card that resolves itself. */
  honorApprovalGrant?(input: {
    bot: string;
    sessionId: string;
    turnId: string;
    approvalId: string;
    grantId: string;
  }): void;
}

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

/** Capability 84. The room is mid-deliberation and cannot take this action now (409). */
export class GroupBusy extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupBusy";
  }
}

/** Capability 84. A room picture is a small image data URL. */
const PICTURE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const PICTURE_MAX = 24_000;
const COMPRESS_TIMEOUT_MS = 660_000;

export interface GroupRoomsOptions {
  storage: Storage;
  observe?: ObservationRing;
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
  /** True when this member is served by a non-Hermes runtime peer (capability 45). Capability 51
   *  projects a room turn's approvals, clarifications and tool steps for such a member ONLY: a
   *  Hermes-backed member's room turn drops those events exactly as it did before, because the
   *  Hermes plugin has never been asked to raise one inside a room and a half-projected lane is
   *  worse than none. Defaults to "nobody", which is the pre-51 behaviour for every member. */
  isRuntimeMember?: (name: string) => boolean;
  /** Existing attach-v1 turn transport, injected after the ingress exists. */
  nativeTurns?: NativeGroupTurnEndpoint;
  /** Capability 51 interaction bookkeeping, injected after the native data plane exists. */
  interactionExpiry?: RoomInteractionExpiry;
  pollMs?: number;
  turnTimeoutMs?: number;
  chainDelayMs?: number;
  /** Live-draft coalescing window. Test seam; defaults to `ROOM_DRAFT_FLUSH_MS`. */
  draftFlushMs?: number;
  log?: (message: string) => void;
}

export class GroupRooms {
  readonly #storage: Storage;
  readonly #observe: ObservationRing | undefined;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #memberInfo: (name: string) => GroupMember;
  readonly #missingMembers: (names: string[]) => Promise<string[]>;
  readonly #memberKnown: (name: string) => boolean | undefined;
  readonly #memberExists: (name: string) => Promise<boolean>;
  readonly #escalate: (event: { group: string; member: string; displayName: string; text: string }) => void;
  readonly #isRuntimeMember: (name: string) => boolean;
  #nativeTurns: NativeGroupTurnEndpoint | undefined;
  #interactionExpiry: RoomInteractionExpiry | undefined;
  readonly #pollMs: number | undefined;
  readonly #turnTimeoutMs: number | undefined;
  readonly #chainDelayMs: number;
  readonly #draftFlushMs: number;
  readonly #log: (message: string) => void;
  readonly #waiters = new Map<string, () => void>();
  /** Open live bubbles, by member turn id. An entry exists only for a turn that has actually
   *  streamed something, so a peer that never drafts costs nothing and gets no frames. */
  readonly #drafts = new Map<string, RoomDraft>();

  /** Capability 51. Live tool steps and blocked-on state, by member turn id. */
  readonly #activity = new Map<string, RoomTurnActivity>();

  /** The round the live drive is on, by room key. In memory with the drive it describes: an
   *  out-of-band state frame (capability 51's badge) must report the round the room is ACTUALLY
   *  on, and a round is a fact about a running loop, not about the durable room. */
  readonly #rounds = new Map<string, number>();

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
  readonly #drives = new Map<string, { promise: Promise<void>; generation: number; epoch: number }>();
  /** Capability 84. Threads queued behind the live drive (or a compress), by room key. Mirrored
   *  into the room's `meta.queue` so a restart still drives them. */
  readonly #queues = new Map<string, string[]>();
  /** Capability 84. Rooms whose compress turn holds the room's one pending-turn slot. */
  readonly #compressing = new Set<string>();
  /** Bumped every time a room key is deleted. In memory on purpose: it only has to outlive the
   *  drives of THIS process, and a restart has no drives to disambiguate. */
  readonly #generations = new Map<string, number>();
  #closed = false;

  constructor(opts: GroupRoomsOptions) {
    this.#storage = opts.storage;
    this.#observe = opts.observe?.enabled === true ? opts.observe : undefined;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#memberInfo = opts.memberInfo;
    this.#missingMembers = opts.missingMembers;
    this.#memberKnown = opts.memberKnown ?? ((): boolean | undefined => undefined);
    this.#memberExists = opts.memberExists ?? ((): Promise<boolean> => Promise.resolve(true));
    this.#escalate = opts.escalate ?? ((): void => {});
    this.#isRuntimeMember = opts.isRuntimeMember ?? ((): boolean => false);
    this.#nativeTurns = opts.nativeTurns;
    this.#interactionExpiry = opts.interactionExpiry;
    this.#pollMs = opts.pollMs;
    this.#turnTimeoutMs = opts.turnTimeoutMs;
    this.#chainDelayMs = opts.chainDelayMs ?? GROUP_CHAIN_DELAY_MS;
    this.#draftFlushMs = opts.draftFlushMs ?? ROOM_DRAFT_FLUSH_MS;
    this.#log = opts.log ?? ((): void => {});
  }

  /** The ingress is assembled after the bridge, so wiring is deliberately explicit rather than a
   * hidden global. Commands already persisted while the socket was away replay through this sink. */
  setNativeTurns(endpoint: NativeGroupTurnEndpoint): void {
    this.#nativeTurns = endpoint;
  }

  /** Wired for the same reason `setNativeTurns` is: the native data plane is assembled after the
   *  bridge that owns these rooms. */
  setInteractionExpiry(expiry: RoomInteractionExpiry): void {
    this.#interactionExpiry = expiry;
  }

  canAcceptAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (!("threadId" in event) || !("turnId" in event)) return false;
    return this.#storage.botGroupTurnForAttach(agentId, event.threadId, event.turnId) !== undefined
      || this.#externalTarget(agentId, frame) !== undefined;
  }

  /** Capability 84. The room member whose own thread received a commit no room turn owns. */
  #externalTarget(agentId: string, frame: AttachV1EventFrame): { key: string; member: string } | undefined {
    const event = frame.event;
    if (event.kind !== "commit") return undefined;
    if (this.#storage.botGroupTurnForAttach(agentId, event.threadId, event.turnId) !== undefined) return undefined;
    const owner = this.#storage.botGroupMemberBySession(event.threadId);
    if (owner === undefined || owner.member !== agentId || this.#storage.botGroup(owner.key) === undefined) return undefined;
    return owner;
  }

  /** Capability 84. Mirror an external write once, as the member, into its latest thread. */
  #mirrorExternal(target: { key: string; member: string }, event: Extract<AttachV1EventFrame["event"], { kind: "commit" }>): void {
    const messageId = `ext:${event.turnId}:${event.messageId}`;
    const log = this.#storage.botGroupLog(target.key);
    if (log.some((row) => row.messageId === messageId)) return;
    const text = blocksToText(event.blocks).trim();
    if (text.length === 0) return;
    const own = log.filter((row) => row.kind === "member" && row.name === target.member).at(-1);
    const threadId = own?.threadId ?? log.at(-1)?.threadId;
    const member = this.#memberInfo(target.member);
    const entry = this.#append(target.key, {
      kind: "member", name: member.name, displayName: member.displayName, text, at: this.#now(),
      messageId, external: true, ...(threadId === undefined ? {} : { threadId }),
    });
    this.#setMark(target.key, threadId ?? "", target.member, entry.seq);
  }

  /** Projects only events whose target is a durable group-member turn. Other attach consumers
   * retain their own ownership routes even when they share this profile token. */
  handleAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    const event = frame.event;
    if (!("threadId" in event) || !("turnId" in event)) return false;
    const owned = this.#storage.botGroupTurnForAttach(agentId, event.threadId, event.turnId);
    if (owned === undefined) {
      const external = this.#externalTarget(agentId, frame);
      if (external === undefined || event.kind !== "commit") return false;
      this.#mirrorExternal(external, event);
      return true;
    }
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
    } else if (event.kind === "tool" && this.#isRuntimeMember(owned.member)) {
      // Capability 51.
      this.#emitToolActivity(owned, event);
      return true;
    } else if (event.kind === "approval" && this.#isRuntimeMember(owned.member)) {
      return this.#roomApproval(owned, event);
    } else if (event.kind === "clarify" && this.#isRuntimeMember(owned.member)) {
      return this.#roomClarify(owned, event);
    } else {
      // Thinking and delegation events, and every event of a Hermes-backed member, still belong to
      // this already-authorized turn. The room has no wire projection for them, but declining would
      // dead-letter an otherwise valid at-least-once stream.
      return true;
    }
    if (settled === undefined) return false;
    this.#endDraft(event.turnId);
    this.#endTurnActivity(event.turnId, settled.state === "commit" ? "ok" : "error");
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
  async create(rawName: string, rawMembers: string[], owningHost?: string): Promise<BotGroup> {
    const name = validGroupName(rawName);
    const canonical = name.toLowerCase();
    if (this.#storage.botGroupKeyByName(name) !== undefined) throw new GroupExists(name);
    // Capability 84: a renamed room keeps its key, so a new room may need a fresh one.
    let key = canonical;
    for (let n = 2; this.#storage.botGroup(key) !== undefined; n += 1) key = `${canonical}~${n}`;

    const members = validGroupMembers(rawMembers);
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

    if (!this.#storage.createBotGroup({ key, name, members, ...(owningHost === undefined ? {} : { owningHost }), createdAt: this.#now() })) {
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
  send(rawName: string, text: string, opts: { clientId?: string; threadId?: string } = {}): BotGroupMessage {
    const key = this.#key(rawName);
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());
    if (isSlashCommand(text)) throw new GroupInvalid("Slash commands do not run in rooms.");

    // Cleared BEFORE the message lands, so the badge cannot survive the very message that answers
    // the escalation.
    this.#storage.setBotGroupNeedsYou(key, false);
    // Capability 84: a send while a drive is live QUEUES its thread behind it under the same epoch;
    // otherwise the epoch bump opens a new drive, stamped before the append as before.
    // A compress turn holds the room's one pending-turn slot too, so a send behind it queues.
    const live = this.#driving(key) || this.#compressing.has(key);
    const epoch = live ? room.epoch : this.#storage.bumpBotGroupEpoch(key);
    const messageId = randomUUID();
    const threadId = opts.threadId ?? messageId;
    const entry = this.#append(key, {
      kind: "user",
      name: GROUP_USER_LABEL,
      displayName: GROUP_USER_LABEL,
      text,
      at: this.#now(),
      messageId,
      epoch,
      threadId,
      ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
    });
    this.#applyHolds(key, text, entry);
    if (live) {
      const queue = this.#queue(key);
      if (!queue.includes(threadId)) queue.push(threadId);
      this.#saveQueue(key);
    } else {
      this.#startDrive(key, epoch, threadId);
    }
    return toWireMessage(entry);
  }

  /** Capability 84. Rename (the key stays), members, picture and stop-directive detection. */
  async update(rawName: string, patch: BotGroupPatchRequest): Promise<BotGroup> {
    const key = this.#key(rawName);
    if (this.#storage.botGroup(key) === undefined) throw new GroupNotFound(rawName.trim());
    const name = patch.name === undefined ? undefined : validGroupName(patch.name);
    if (name !== undefined) {
      const holder = this.#storage.botGroupKeyByName(name);
      if (holder !== undefined && holder !== key) throw new GroupExists(name);
    }
    if (patch.picture != null && (patch.picture.length > PICTURE_MAX || !PICTURE_PATTERN.test(patch.picture))) {
      throw new GroupInvalid("a room picture must be a png, jpeg or webp data URL of at most 24000 characters");
    }
    const members = patch.members === undefined ? undefined : validGroupMembers(patch.members);
    if (members !== undefined) {
      const missing = await this.#missingMembers(members);
      if (missing.length > 0) {
        throw new GroupInvalid(`not a bot on this gateway: ${missing.join(", ")}. A room can only name bots that exist here.`);
      }
    }
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());
    // Checked again after the members await: another rename may have taken the name meanwhile.
    if (name !== undefined) {
      const holder = this.#storage.botGroupKeyByName(name);
      if (holder !== undefined && holder !== key) throw new GroupExists(name);
    }
    const meta: BotGroupMeta = { ...room.meta };
    if (patch.picture === null) delete meta.picture;
    else if (patch.picture !== undefined) meta.picture = patch.picture;
    if (patch.holdDetection !== undefined) {
      meta.holdDetection = patch.holdDetection;
      if (!patch.holdDetection) delete meta.holds;
    }
    if (members !== undefined) {
      this.#storage.setBotGroupMembers(key, members);
      if (meta.holds !== undefined) {
        meta.holds = Object.fromEntries(Object.entries(meta.holds).filter(([member]) => members.includes(member)));
      }
    }
    this.#storage.setBotGroupMeta(key, meta);
    const renamed = name !== undefined && name !== room.name;
    if (renamed) this.#storage.renameBotGroup(key, name);
    return this.#emitRoom(key, renamed ? room.name : undefined);
  }

  /** A member's bot was renamed and storage has already moved its membership
   *  (`Storage.renameBotState`): re-announce each changed room so clients re-seat the member. */
  announceRooms(keys: readonly string[]): void {
    for (const key of keys) if (this.#storage.botGroup(key) !== undefined) this.#emitRoom(key);
  }

  /** Capability 84. Stop: supersede the drive, drop the queue, cancel and interrupt the member on
   *  turn, and hold everyone when stop directives are on. */
  stop(rawName: string): BotGroup {
    const key = this.#key(rawName);
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());
    this.#storage.bumpBotGroupEpoch(key);
    this.#queues.set(key, []);
    for (const turn of this.#storage.cancelPendingBotGroupTurns(key, "stopped", this.#now())) {
      this.#nativeTurns?.sendInterrupt?.(turn.agentId, { threadId: turn.threadId, turnId: turn.turnId });
      this.#endDraft(turn.turnId);
      this.#endTurnActivity(turn.turnId, "error");
      this.#waiters.get(turn.turnId)?.();
    }
    if (room.meta.holdDetection !== false) {
      const holds = { ...room.meta.holds };
      for (const member of room.members) holds[member] ??= { at: this.#now() };
      this.#storage.setBotGroupMeta(key, { ...room.meta, holds });
    }
    this.#saveQueue(key);
    return this.#emitRoom(key, undefined, { member: GROUP_USER_LABEL, kind: "stopped" });
  }

  /** Capability 84. `/compress` in one member's room thread, as a Hermes slash command. */
  async compress(rawName: string, rawMember: string): Promise<{ member: string; text: string }> {
    const key = this.#key(rawName);
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(rawName.trim());
    const member = normalizeProfileName(rawMember);
    if (!room.members.includes(member)) throw new GroupInvalid(`${member} is not a member of ${room.name}`);
    if (this.#driving(key) || this.#compressing.has(key)) {
      throw new GroupBusy("the room is still talking; stop it or wait for it to settle");
    }
    const endpoint = this.#nativeTurns;
    if (endpoint === undefined) throw new GroupInvalid("native attach-v1 group transport is not configured");
    const members = this.#storage.botGroupMembers(key);
    const started = startNativeMemberTurn({
      storage: this.#storage, endpoint, key, member, agentId: member,
      threadId: this.#storage.ensureBotGroupThread(key, member), epoch: room.epoch,
      watermark: members.get(member)?.watermark ?? 0, prompt: "/compress", now: this.#now, purpose: "compress",
    });
    if ("outcome" in started) {
      if (started.outcome === "failed" && started.detail.includes("already pending")) throw new GroupBusy(started.detail);
      throw new GroupInvalid("detail" in started ? started.detail : "compress could not start");
    }
    // Upstream's focused-chat /compress budget: a summary can legitimately take minutes. Sends made
    // meanwhile queue (see `send`) and drive once the compress turn has let go of the room.
    this.#compressing.add(key);
    try {
      const result = await this.#waitForTurn(key, started.turnId, this.#generation(key), COMPRESS_TIMEOUT_MS);
      return { member, text: result.outcome === "spoke" ? result.text : "detail" in result ? result.detail : "Compressed." };
    } finally {
      this.#compressing.delete(key);
      if (!this.#closed && !this.#driving(key) && this.#storage.botGroup(key) !== undefined) {
        const next = this.#queue(key).shift();
        this.#saveQueue(key);
        if (next !== undefined) this.#startDrive(key, this.#storage.bumpBotGroupEpoch(key), next);
      }
    }
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
    // Timers only, no frames: the sockets these would reach are going away with this bridge, and a
    // broadcast during shutdown is a write into a hub that is being torn down.
    for (const open of this.#drafts.values()) {
      if (open.timer !== undefined) clearTimeout(open.timer);
    }
    this.#drafts.clear();
    this.#activity.clear();
    this.#rounds.clear();
    for (const wake of this.#waiters.values()) wake();
    this.#waiters.clear();
    const running = [...this.#drives.values()].map((entry) => entry.promise.catch(() => {}));
    this.#drives.clear();
    await Promise.all(running);
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Capability 84. The room's queued threads, hydrated from `meta.queue` after a restart. */
  #queue(key: string): string[] {
    let queue = this.#queues.get(key);
    if (queue === undefined) {
      queue = [...(this.#storage.botGroup(key)?.meta.queue ?? [])];
      this.#queues.set(key, queue);
    }
    return queue;
  }

  #saveQueue(key: string): void {
    const room = this.#storage.botGroup(key);
    if (room === undefined) return;
    const queue = this.#queues.get(key) ?? [];
    const meta: BotGroupMeta = { ...room.meta };
    if (queue.length > 0) meta.queue = [...queue];
    else delete meta.queue;
    this.#storage.setBotGroupMeta(key, meta);
  }

  /** Capability 84: a room is found by its DISPLAYED name first, since a rename keeps the key. */
  #key(rawName: string): string {
    return this.#storage.botGroupKeyByName(rawName) ?? rawName.trim().toLowerCase();
  }

  /** Which incarnation of this room key is the live one. */
  #generation(key: string): number {
    return this.#generations.get(key) ?? 0;
  }

  /** True when a drive for the room CURRENTLY at this key is live. A drive left over from a
   *  deleted room is winding down, not driving, so it must not make a recreated room read
   *  `running`. */
  #driving(key: string): boolean {
    const drive = this.#drives.get(key);
    // A drive a Stop superseded is winding down, not driving (capability 84).
    return drive?.generation === this.#generation(key) && drive.epoch === this.#storage.botGroup(key)?.epoch;
  }

  #view(room: BotGroupRow): BotGroup {
    const log = this.#storage.botGroupLog(room.key);
    const state = this.#driving(room.key) ? "running" : room.needsYou ? "needs_you" : "settled";
    return {
      id: room.key,
      name: room.name,
      members: room.members,
      createdAt: room.createdAt,
      state,
      needsYou: room.needsYou,
      epoch: room.epoch,
      updatedAt: log.at(-1)?.at ?? room.createdAt,
      // Capability 51. Omitted rather than empty: a room that blocks on nothing is the room every
      // client below 51 already renders.
      ...this.#pendingInteractions(room.key),
      ...(room.meta.picture === undefined ? {} : { picture: room.meta.picture }),
      holdDetection: room.meta.holdDetection !== false,
      ...(Object.keys(room.meta.holds ?? {}).length === 0 ? {} : { holds: Object.keys(room.meta.holds!) }),
    };
  }

  // --- capability 84 helpers -----------------------------------------------------------------------

  /** Highest seq this member has been shown in this thread. The legacy thread keeps the per-member
   *  watermark it always had. */
  #mark(room: BotGroupRow, thread: string, member: string): number {
    if (thread === "") return this.#storage.botGroupMembers(room.key).get(member)?.watermark ?? 0;
    return room.meta.marks?.[thread]?.[member] ?? 0;
  }

  /** Advances a (thread, member) mark and the legacy per-member watermark; prunes marks for threads
   *  the retained log no longer carries. */
  #setMark(key: string, thread: string, member: string, seq: number): void {
    const current = this.#storage.botGroupMembers(key).get(member)?.watermark ?? 0;
    if (thread === "" || seq > current) this.#storage.setBotGroupWatermark(key, member, seq);
    if (thread === "") return;
    const room = this.#storage.botGroup(key);
    if (room === undefined) return;
    const live = new Set(this.#storage.botGroupLog(key).map((row) => row.threadId));
    const marks: NonNullable<BotGroupMeta["marks"]> = {};
    for (const [id, byMember] of Object.entries(room.meta.marks ?? {})) if (live.has(id)) marks[id] = byMember;
    marks[thread] = { ...marks[thread], [member]: Math.max(seq, marks[thread]?.[member] ?? 0) };
    this.#storage.setBotGroupMeta(key, { ...room.meta, marks });
  }

  /** A user send's stop directive, applied to the room's holds (upstream #93129). */
  #applyHolds(key: string, text: string, entry: BotGroupLogRow): void {
    const room = this.#storage.botGroup(key);
    if (room === undefined || room.meta.holdDetection === false) return;
    const prior = room.meta.holds ?? {};
    const next = applyHoldDirective(
      prior,
      parseMentions(text, room.members.map((name) => this.#memberInfo(name))),
      text,
      { at: entry.at, seq: entry.seq, ...(entry.threadId === undefined ? {} : { thread: entry.threadId }) },
      room.members,
    );
    if (next === prior) return;
    this.#storage.setBotGroupMeta(key, { ...room.meta, holds: next });
    this.#emitRoom(key);
  }

  /** Re-announces the whole room after a settings or hold change. */
  #emitRoom(key: string, renamedFrom?: string, activity?: BotGroupStateFrame["activity"]): BotGroup {
    const room = this.#storage.botGroup(key);
    if (room === undefined) throw new GroupNotFound(key);
    const view = this.#view(room);
    this.#emitState(room, view.state, this.#rounds.get(key) ?? 0, undefined, undefined, {
      room: view,
      ...(renamedFrom === undefined ? {} : { renamedFrom }),
      ...(activity === undefined ? {} : { activity }),
    });
    return view;
  }

  #announce(key: string, member: string, kind: NonNullable<BotGroupStateFrame["activity"]>["kind"], thread: string, epoch: number): void {
    const room = this.#storage.botGroup(key);
    if (room === undefined) return;
    this.#emitState(room, "running", this.#rounds.get(key) ?? 0, undefined, epoch, {
      activity: { member, kind, ...(thread === "" ? {} : { threadId: thread }) },
    });
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
  #startDrive(key: string, epoch: number, thread: string): void {
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
      await this.#drive(key, epoch, generation, thread);
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
        if (this.#drives.get(key)?.promise !== run) return;
        this.#drives.delete(key);
        // A thread queued in the instant the drive was exiting still gets its drive.
        const next = this.#closed ? undefined : this.#queue(key).shift();
        if (next !== undefined) this.#saveQueue(key);
        const room = next === undefined || this.#closed ? undefined : this.#storage.botGroup(key);
        if (next !== undefined && room !== undefined) this.#startDrive(key, room.epoch, next);
      });
    this.#drives.set(key, { promise: run, generation, epoch });
  }

  /** Capability 84. One drive runs its first thread, then every thread queued behind it, and only
   *  its final exit reports settled / needs_you. */
  async #drive(key: string, epoch: number, generation: number, first: string): Promise<void> {
    let round = 0;
    let thread: string | undefined = first;
    try {
      while (thread !== undefined) {
        round = await this.#runRounds(key, epoch, generation, thread);
        if (this.#closed || this.#generation(key) !== generation) return;
        if (this.#storage.botGroup(key)?.epoch !== epoch) return;
        thread = this.#queue(key).shift();
        if (thread !== undefined) this.#saveQueue(key);
      }
    } finally {
      // Checked BEFORE the read: a closed bridge has a closed database.
      const final =
        this.#closed || this.#generation(key) !== generation ? undefined : this.#storage.botGroup(key);
      // A superseded (stopped) drive says nothing: Stop already reported the room.
      if (final !== undefined && final.epoch === epoch) {
        this.#emitState(final, final.needsYou ? "needs_you" : "settled", round, undefined, epoch);
      }
      this.#rounds.delete(key);
    }
  }

  /** The round loop (dissection 9.3) for ONE thread. Serial members, at most three rounds, at most
   *  ten posted messages, stopping early the moment a whole round passes. Answers the round reached. */
  async #runRounds(key: string, startEpoch: number, startGeneration: number, thread: string): Promise<number> {
    let room = this.#storage.botGroup(key);
    if (room === undefined || this.#generation(key) !== startGeneration) return 0;
    let round = 0;
    let posted = 0;
    this.#rounds.set(key, round);
    this.#emitState(room, "running", round, undefined, startEpoch);
    for (; round < GROUP_MAX_ROUNDS; round += 1) {
      this.#rounds.set(key, round);
      room = this.#storage.botGroup(key);
      if (room === undefined || room.epoch !== startEpoch || this.#closed) return round;
      if (this.#generation(key) !== startGeneration) return round;
      const members = room.members.map((name) => this.#memberInfo(name));
      const threadLog = () => this.#entries(key).filter((entry) => threadOf(entry) === thread);
      const responders = rotateSpeakers(resolveResponders(threadLog(), members), round);
      let spoke = 0;

      for (const member of responders) {
        const current = this.#storage.botGroup(key);
        // Checked at every member boundary: a Stop, a deleted room, or the message cap end the loop.
        // The GENERATION check catches a room deleted and remade under the same name mid-turn.
        if (current === undefined || current.epoch !== startEpoch || this.#closed) return round;
        if (this.#generation(key) !== startGeneration) return round;
        if (posted >= GROUP_MAX_MESSAGES) {
          // Said out loud: a capped room otherwise looks exactly like one where everybody passed.
          this.#emitState(current, "running", round, {
            member: member.name,
            reason: "capped",
            detail: `the room posted its ${GROUP_MAX_MESSAGES}-message limit for this send and stopped early`,
          }, startEpoch);
          return round;
        }
        // A negative cache answer only buys the fresh read; the fresh read decides (hidden bots are
        // absent from the filtered cache while perfectly real in Hermes).
        if (this.#memberKnown(member.name) === false && !(await this.#memberExists(member.name))) {
          if (this.#closed || this.#generation(key) !== startGeneration) return round;
          const live = this.#storage.botGroup(key);
          if (live === undefined || live.epoch !== startEpoch) return round;
          this.#emitState(live, "running", round, goneNote(member), startEpoch);
          continue;
        }

        const log = threadLog();
        const mark = this.#mark(current, thread, member.name);
        const delta = deltaSince(log, mark);
        // Nothing new in this thread since this member last spoke or passed.
        if (delta.length === 0) continue;

        // Capability 84: a HELD member consumes its delta exactly once and is remembered for replay.
        const hold = current.meta.holds?.[member.name];
        if (hold !== undefined) {
          this.#setMark(key, thread, member.name, highestSeq(log, mark));
          const after = this.#storage.botGroup(key)!;
          this.#storage.setBotGroupMeta(key, {
            ...after.meta,
            held: { ...after.meta.held, [member.name]: heldSeqs(after.meta.held?.[member.name], delta.map((entry) => entry.seq)) },
            holds: { ...after.meta.holds, [member.name]: { ...hold, noted: true } },
          });
          if (hold.noted !== true) this.#announce(key, member.name, "held", thread, startEpoch);
          continue;
        }
        // Released: the entries it missed while held replay ahead of its new delta.
        const replaySeqs = current.meta.held?.[member.name] ?? [];
        const replay = replaySeqs.length === 0
          ? []
          : this.#entries(key).filter((entry) => replaySeqs.includes(entry.seq) && !delta.some((row) => row.seq === entry.seq));
        const visible = [...replay, ...delta].sort((left, right) => left.seq - right.seq);

        this.#announce(key, member.name, "working", thread, startEpoch);
        const state = this.#storage.botGroupMembers(key).get(member.name);
        const result = await this.#turn({
          key,
          groupName: current.name,
          member,
          members,
          delta: visible,
          startEpoch,
          startGeneration,
          ...(state?.sessionId == null ? {} : { storedId: state.sessionId }),
        });
        // `#closed` FIRST: a closed bridge has a closed database behind it.
        if (this.#closed || this.#generation(key) !== startGeneration) return round;
        const after = this.#storage.botGroup(key);
        if (after === undefined) return round;
        // A turn cut short by Stop leaves no note; a reply that still landed is kept.
        if (after.epoch !== startEpoch && result.outcome !== "spoke") return round;
        if (result.outcome === "gone") {
          this.#emitState(after, "running", round, goneNote(member), startEpoch);
          continue;
        }
        // Marked as having seen everything that existed BEFORE its reply, whatever the outcome.
        this.#setMark(key, thread, member.name, highestSeq(log, mark));
        if (replaySeqs.length > 0) {
          const now = this.#storage.botGroup(key)!;
          const held = { ...now.meta.held };
          delete held[member.name];
          this.#storage.setBotGroupMeta(key, { ...now.meta, held });
        }

        if (result.outcome === "spoke") {
          const entry = this.#append(key, {
            kind: "member",
            name: member.name,
            displayName: member.displayName,
            text: result.text,
            at: this.#now(),
            ...(thread === "" ? {} : { threadId: thread }),
            ...provenance(result.turnId === undefined ? undefined : this.#storage.botGroupTurn(key, result.turnId)),
          });
          this.#setMark(key, thread, member.name, entry.seq);
          this.#announce(key, member.name, "replied", thread, startEpoch);
          posted += 1;
          spoke += 1;
          if (mentionsUser(result.text)) {
            this.#storage.setBotGroupNeedsYou(key, true);
            // The out-of-band leg (spec section 4); a notifier failure must never take a round down.
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
        } else if (result.outcome === "pass") {
          this.#announce(key, member.name, "passed", thread, startEpoch);
        } else {
          // Failure honesty: the room is told the member did not answer, and why.
          const note: BotGroupNote = {
            member: member.name, reason: result.outcome, detail: result.detail,
            ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
          };
          const live = this.#storage.botGroup(key);
          if (live !== undefined) this.#emitState(live, "running", round, note, startEpoch);
        }
      }

      // A whole round in which nobody had anything to add: the thread has settled.
      if (spoke === 0) return round;
    }
    return round;
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
  }): Promise<GroupTurnResult & { turnId?: string }> {
    const { key, groupName, member, members, delta, startEpoch, startGeneration, storedId } = args;
    if (this.#closed || this.#generation(key) !== startGeneration) return { outcome: "pass" };
    if (this.#storage.botGroup(key) === undefined) return { outcome: "pass" };
    const prompt = buildTurnPrompt(groupName, members, member, delta);
    const endpoint = this.#nativeTurns;
    if (endpoint === undefined) return { outcome: "failed", detail: "native attach-v1 group transport is not configured" };
    const watermark = this.#storage.botGroupMembers(key).get(member.name)?.watermark ?? 0;
    const threadId = storedId ?? this.#storage.ensureBotGroupThread(key, member.name);
    if (storedId === undefined) this.#storage.setBotGroupSession(key, member.name, threadId);
    // What the member is being asked about: the newest entry in the delta it is shown. Recorded
    // now rather than at settlement, because by the time a reply lands the room may have moved on
    // and the honest causation is the one that was true when the member was asked.
    const last = args.delta.at(-1);
    const cause: BotGroupCause | undefined =
      last === undefined ? undefined : { kind: last.kind, seq: last.seq };
    const started = startNativeMemberTurn({ storage: this.#storage, endpoint, key, member: member.name,
      agentId: member.name, threadId, epoch: startEpoch, watermark, prompt,
      ...(cause === undefined ? {} : { cause }),
      context: turnContext(key, groupName, members, startEpoch, cause),
      now: this.#now });
    if ("outcome" in started) return started;
    const result = await this.#waitForTurn(key, started.turnId, startGeneration);
    // `(pass)` in any of its shapes is a pass, and so is a blank reply. Turning a spoken `(pass)`
    // into a room message would show the protocol's own plumbing to the user.
    if (result.outcome === "spoke" && isPassText(result.text)) return { outcome: "pass", turnId: started.turnId };
    return { ...result, turnId: started.turnId };
  }

  async #waitForTurn(key: string, turnId: string, generation: number, timeoutOverride?: number): Promise<GroupTurnResult> {
    const timeoutMs = timeoutOverride ?? this.#turnTimeoutMs ?? 180_000;
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
      if (this.#now() >= deadline + (row === undefined ? 0 : this.#storage.tasks.suspended(row.agentId, turnId, deadline - timeoutMs, this.#now()))) {
        const detail = `no reply within ${Math.round(timeoutMs / 1000)}s`;
        this.#storage.timeoutBotGroupTurn(key, turnId, detail, this.#now());
        // The member stopped mid-sentence. Nothing is coming to close its bubble, so the gateway
        // closes it: this is the settlement no attach event will ever announce.
        this.#endDraft(turnId);
        this.#endTurnActivity(turnId, "error");
        return { outcome: "timeout", detail };
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { this.#waiters.delete(turnId); resolve(); }, this.#pollMs ?? 50);
        timer.unref?.();
        this.#waiters.set(turnId, () => { clearTimeout(timer); this.#waiters.delete(turnId); resolve(); });
      });
    }
    // Abandoned: the bridge closed or the room was deleted and remade under this drive's feet. The
    // turn will never settle for this loop, so its bubble is closed here rather than left open.
    this.#endDraft(turnId);
    this.#endTurnActivity(turnId, "error");
    return { outcome: "pass" };
  }

  #recoverSettledTurn(turn: BotGroupTurnRow): void {
    const claimed = this.#storage.consumeBotGroupTurn(turn.key, turn.turnId, this.#now());
    if (claimed === undefined || this.#closed) return;
    // A compress turn (capability 84) is maintenance, never a room message.
    if (claimed.messageId.endsWith(":compress")) return;
    const room = this.#storage.botGroup(claimed.key);
    if (room === undefined || room.epoch !== claimed.epoch) return;
    const result = settledGroupTurn(claimed);
    // The thread the member was answering, read off the entry that caused its turn.
    const thread = claimed.cause === undefined
      ? ""
      : threadOf(this.#storage.botGroupLog(claimed.key).find((row) => row.seq === claimed.cause!.seq) ?? {});
    if (result?.outcome === "spoke" && !isPassText(result.text)) {
      const member = this.#memberInfo(claimed.member);
      const entry = this.#append(claimed.key, {
        kind: "member", name: member.name, displayName: member.displayName, text: result.text, at: this.#now(),
        ...(thread === "" ? {} : { threadId: thread }), ...provenance(claimed),
      });
      this.#setMark(claimed.key, thread, claimed.member, entry.seq);
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
      this.#setMark(claimed.key, thread, claimed.member,
        highestSeq(this.#entries(claimed.key).filter((entry) => threadOf(entry) === thread), claimed.watermark));
    }
    // The previous process cannot retain its loop. Resume from durable watermarks; one serial
    // drive owns any remaining responders and the outbox already owns the command replay.
    this.#startDrive(claimed.key, room.epoch, thread);
  }

  /** One live draft of a member turn, as the 1:1 chat frame plus `room`.
   *
   *  `bot` is the member and `sessionId` is its gateway-owned group thread, which is the identity
   *  the room already dispatches on: a client that keys live text by bot and session therefore
   *  needs no new keying to render this, and the `room` field is what stops it being mistaken for
   *  the member's 1:1 conversation.
   *
   *  Three things are refused rather than streamed, and each one is a lie the wire would otherwise
   *  tell:
   *
   *  - a draft that reads as a pass. The transcript hides `(pass)` because it is the protocol's own
   *    plumbing (`#turn` turns a spoken pass back into `{ outcome: "pass" }`), so streaming it live
   *    would show in the bubble exactly what the room is about to hide in the log.
   *  - a draft for a turn that is no longer pending. An at-least-once replay can land a draft after
   *    the turn timed out or failed, and a bubble reopened after its own `done` never closes again.
   *  - a draft whose room has moved on: deleted, or superseded by a newer user message. The reply
   *    belongs to a conversation the reader is no longer looking at.
   *
   *  What survives those goes out on the 1:1 lane's coalescing rule: leading frame immediately,
   *  latest-only for each window after it. */
  #emitDraft(turn: BotGroupTurnRow, text: string): void {
    if (isPassDraft(text) || turn.messageId.endsWith(":compress")) return;
    if (turn.state !== "pending") return;
    const room = this.#storage.botGroup(turn.key);
    if (room === undefined || room.epoch !== turn.epoch) return;
    const open = this.#drafts.get(turn.turnId);
    const seq = (open?.seq ?? 0) + 1;
    const frame: BotChatDeltaFrame = {
      type: "bot_chat_delta",
      bot: turn.member,
      sessionId: turn.threadId,
      turnId: turn.turnId,
      text,
      seq,
      updatedAt: this.#now(),
      room: room.name,
    };
    if (open !== undefined) {
      open.seq = seq;
      open.last = frame;
      // Inside an open window: the frame carries the WHOLE text so far, so keeping only the latest
      // loses nothing a reader can see.
      if (open.timer !== undefined) {
        open.pending = frame;
        return;
      }
      open.timer = this.#draftTimer(turn.turnId);
      this.#broadcast(frame);
      return;
    }
    this.#drafts.set(turn.turnId, {
      seq,
      timer: this.#draftTimer(turn.turnId),
      pending: undefined,
      last: frame,
    });
    this.#broadcast(frame);
  }

  #draftTimer(turnId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.#tickDraft(turnId), this.#draftFlushMs);
    timer.unref?.();
    return timer;
  }

  /** Closes one coalescing window: the latest frame it collected goes out and the next window
   *  opens behind it. A window that collected nothing simply closes, so an idle turn holds no
   *  timer. */
  #tickDraft(turnId: string): void {
    const open = this.#drafts.get(turnId);
    if (open === undefined) return;
    const pending = open.pending;
    open.pending = undefined;
    if (pending === undefined) {
      open.timer = undefined;
      return;
    }
    open.timer = this.#draftTimer(turnId);
    this.#broadcast(pending);
  }

  /** Ends a member turn's live bubble: whatever the last window was still holding, then one empty
   *  `done` frame.
   *
   *  Called at EVERY settlement a turn can reach, which is the point. A bubble is opened by the
   *  gateway and only the gateway can close it, so a turn that timed out, was abandoned by a
   *  superseded drive, or died with its room would otherwise leave a reader watching text that will
   *  never finish, and leave this map holding the turn's sequence forever.
   *
   *  A turn that never streamed has no bubble and gets no frame: there is nothing open to close,
   *  and inventing a `done` for every silent member would put a frame on the wire for every turn of
   *  every room. */
  #endDraft(turnId: string): void {
    const open = this.#drafts.get(turnId);
    if (open === undefined) return;
    this.#drafts.delete(turnId);
    if (open.timer !== undefined) clearTimeout(open.timer);
    if (open.pending !== undefined) this.#broadcast(open.pending);
    this.#broadcast({
      ...open.last,
      text: "",
      seq: open.seq + 1,
      updatedAt: this.#now(),
      done: true,
    });
  }

  // --- capability 51: what a room turn is asking for, and what it is doing -----------------------

  /** The room's blocked-on pointers, in the shape `BotGroup` and `bot_group_state` both carry.
   *  Empty is ABSENT rather than `[]`: a room that blocks on nothing must be byte-identical to the
   *  room every client below 51 already renders. */
  #pendingInteractions(key: string): { pendingInteractions?: BotGroupPendingInteraction[] } {
    const pending = this.#storage.botGroupPendingInteractions(key);
    return pending.length === 0 ? {} : { pendingInteractions: pending };
  }

  /** Re-announces a room because its blocked-on set changed. The room's own state is unchanged by
   *  an approval (a drive is still holding it, or was never holding it), so this deliberately
   *  re-derives rather than invents one, exactly as `detail()` does when it clears a badge.
   *
   *  The ROUND is the one the live drive is actually on, not a placeholder: a client folds this
   *  frame into the same state it folds every other one into, and a badge frame that reset the
   *  round to zero would make a room in its third round read as if it had just started. A room with
   *  no drive reports 0, which is what a settled room's own frame reports. */
  #emitPendingChanged(key: string): void {
    const room = this.#storage.botGroup(key);
    if (room === undefined) return;
    this.#emitState(
      room,
      this.#driving(key) ? "running" : room.needsYou ? "needs_you" : "settled",
      this.#rounds.get(key) ?? 0,
    );
  }

  /** The live activity record for a turn, created on first use. Holding the turn's identity here
   *  is what lets `#endTurnActivity` seal a turn whose durable row has already been consumed. */
  #trackActivity(turn: BotGroupTurnRow, roomName: string): RoomTurnActivity {
    const open = this.#activity.get(turn.turnId);
    if (open !== undefined) return open;
    const fresh: RoomTurnActivity = {
      key: turn.key,
      roomName,
      member: turn.member,
      threadId: turn.threadId,
      seq: 0,
      steps: new Map<string, BotToolStep>(),
      emitted: false,
    };
    this.#activity.set(turn.turnId, fresh);
    return fresh;
  }

  /** A member turn asked for an approval. It is recorded in the SAME durable interaction table a
   *  1:1 chat writes, keyed by the member bot and the attach approval id, with `sessionId` set to
   *  the gateway-owned member thread and `turnId` to the room turn. That is the whole trick: the
   *  inbox read, the expiry sweep, the retention trim, `POST /bots/:member/approvals/:id/approve`
   *  and the `resolve_approval` command it enqueues all address this row without knowing a room
   *  exists. The room name rides the payload, so the card can be rendered above the right
   *  transcript and the room can badge itself.
   *
   *  Every refusal below is an ACKNOWLEDGEMENT. The event is real and already authorized against a
   *  durable turn row; declining it would dead-letter the member's whole stream behind something no
   *  retry could ever apply (issue #193). */
  #roomApproval(
    turn: BotGroupTurnRow,
    event: Extract<AttachV1EventFrame["event"], { kind: "approval" }>,
  ): boolean {
    const room = this.#storage.botGroup(turn.key);
    if (room === undefined) {
      this.#log(`dropping room approval for "${turn.member}": the room is gone`);
      return true;
    }
    const outcome =
      event.status === "approved" ? "approved"
      : event.status === "denied" ? "denied"
      : event.status === "pending" ? undefined
      : "expired";
    const binding = outcome === undefined
      ? undefined
      : this.#storage.nativeInteraction(turn.member, "approval", event.approvalId);
    if (binding !== undefined && (binding.sessionId !== turn.threadId || binding.turnId !== turn.turnId)) {
      this.#log(`dropping room approval for "${turn.member}": approval id is bound to another turn`);
      return true;
    }
    // Capability 56. Sanitized once, up front, exactly as the 1:1 lane does: the same sentence is
    // stored on the durable row, carried on the expiry payload, and broadcast on the live frame.
    const detail = event.detail === undefined ? undefined : sanitizeApprovalDetail(event.detail);
    // Capability 62. The repair block too: validated once here, carried on the same three surfaces,
    // dropped (never the approval) when it fails. A room card reads exactly like a 1:1 card.
    const repair = sanitizeApprovalRepair(event.repair);
    if (event.repair !== undefined && repair === undefined)
      this.#log(`dropping repair block on room approval for "${turn.member}": failed validation`);
    // Capability 66. And the scoped-approval block, on the same terms. A room approval is the same
    // durable row the 1:1 lane writes, so carrying the block here is all it takes for the decision
    // routes, the optional decision body, the grant rules and the revocation view to answer for a
    // room ask without knowing a room exists. A block that fails validation is DROPPED and the
    // approval kept, which fails closed: a plain ask can leave no standing grant behind.
    const scope = sanitizeApprovalScope(event.scope);
    if (event.scope !== undefined && scope === undefined)
      this.#log(`dropping scope block on room approval for "${turn.member}": failed validation`);
    const change = this.#storage.recordNativeInteraction({
      bot: turn.member,
      kind: "approval",
      interactionId: event.approvalId,
      sessionId: turn.threadId,
      turnId: turn.turnId,
      payload: {
        name: event.name,
        room: { key: turn.key, name: room.name },
        ...(detail === undefined ? {} : { detail }),
        ...(repair === undefined ? {} : { repair }),
        ...(scope === undefined ? {} : { scope }),
      },
      status: outcome ?? "pending",
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      updatedAt: this.#now(),
    });
    if (change === "duplicate") return true;
    if (change === "conflict") {
      this.#log(`dropping room approval for "${turn.member}": approval id is bound to another turn`);
      return true;
    }
    this.#trackActivity(turn, room.name);
    if (outcome === undefined) {
      // The deadline goes on the same timer wheel every 1:1 interaction uses, so a room card
      // expires on its own clock rather than waiting for its member turn to seal.
      this.#interactionExpiry?.schedule({
        bot: turn.member,
        kind: "approval",
        interactionId: event.approvalId,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        payload: {
          name: event.name,
          room: { key: turn.key, name: room.name },
          ...(detail === undefined ? {} : { detail }),
          ...(repair === undefined ? {} : { repair }),
          ...(scope === undefined ? {} : { scope }),
        },
        expiresAt: event.expiresAt ?? null,
        updatedAt: this.#now(),
      });
      // Capability 66, F4. Consult the standing grants BEFORE the card goes out, so the frame says
      // which grant is settling this ask rather than the app watching a room card resolve itself
      // for no stated reason. This is the SAME consult the 1:1 lane runs, reached through the
      // native plane's seam: the derivation for a plain ask, the always-require exclusion and the
      // single-use rules all have one implementation, and a room cannot drift from a chat.
      // Consulting is not executing: the decision still travels as the ordinary `resolve_approval`.
      const grantId = this.#interactionExpiry?.claimApprovalGrant?.({
        bot: turn.member,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        approvalId: event.approvalId,
        name: event.name,
        ...(detail === undefined ? {} : { detail }),
        ...(scope === undefined ? {} : { scope }),
      });
      this.#observe?.event("approval_raised", turn.member, event.approvalId, {
        ...(grantId === undefined ? {} : { grant: this.#observe.identify(grantId) }),
      });
      if (repair !== undefined)
        this.#observe?.event("repair_proposed", turn.member, event.approvalId, { attempts: 1 });
      this.#broadcast({
        type: "bot_approval_pending",
        bot: turn.member,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        toolCallId: event.approvalId,
        name: event.name,
        updatedAt: this.#now(),
        room: room.name,
        ...(turn.cause === undefined ? {} : { cause: turn.cause }),
        ...(detail === undefined ? {} : { detail }),
        ...(repair === undefined ? {} : { repair }),
        ...(scope === undefined ? {} : { scope }),
        ...(grantId === undefined ? {} : { grantId }),
      });
      // The grant is named on the durable record and the ask settled from it, in that order, so a
      // reconnect between the two still shows the person what answered their card.
      if (grantId !== undefined) {
        this.#interactionExpiry?.honorApprovalGrant?.({
          bot: turn.member,
          sessionId: turn.threadId,
          turnId: turn.turnId,
          approvalId: event.approvalId,
          grantId,
        });
      }
    } else {
      this.#observe?.event("approval_resolved", turn.member, event.approvalId, { decision: outcome });
      this.#broadcast({
        type: "bot_approval_resolved",
        bot: turn.member,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        toolCallId: event.approvalId,
        outcome,
        updatedAt: this.#now(),
        room: room.name,
      });
    }
    this.#emitPendingChanged(turn.key);
    return true;
  }

  /** A member turn asked the human to choose. The approval arm's reasoning applies field for
   *  field; the one extra rule is the 1:1 lane's own: a selection naming an option the DURABLE
   *  list never had can never be applied, so it is acknowledged rather than retried forever. */
  #roomClarify(
    turn: BotGroupTurnRow,
    event: Extract<AttachV1EventFrame["event"], { kind: "clarify" }>,
  ): boolean {
    const room = this.#storage.botGroup(turn.key);
    if (room === undefined) {
      this.#log(`dropping room clarify for "${turn.member}": the room is gone`);
      return true;
    }
    const outcome =
      event.status === "resolved" ? "selected"
      : event.status === "pending" ? undefined
      : event.status;
    const binding = outcome === undefined
      ? undefined
      : this.#storage.nativeInteraction(turn.member, "clarify", event.clarifyId);
    if (binding !== undefined && (binding.sessionId !== turn.threadId || binding.turnId !== turn.turnId)) {
      this.#log(`dropping room clarify for "${turn.member}": clarify id is bound to another turn`);
      return true;
    }
    const options = binding === undefined
      ? event.options
      : (binding.payload as { options: Array<{ id: string; label: string }> }).options;
    if (
      outcome === "selected" &&
      event.selectedOptionId !== undefined &&
      !options.some((option) => option.id === event.selectedOptionId)
    ) {
      this.#log(`dropping room clarify for "${turn.member}": selected option is not in the durable option list`);
      return true;
    }
    const change = this.#storage.recordNativeInteraction({
      bot: turn.member,
      kind: "clarify",
      interactionId: event.clarifyId,
      sessionId: turn.threadId,
      turnId: turn.turnId,
      payload: { prompt: event.prompt, options: event.options, room: { key: turn.key, name: room.name } },
      status: outcome ?? "pending",
      ...(event.selectedOptionId === undefined ? {} : { selectedOptionId: event.selectedOptionId }),
      ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
      updatedAt: this.#now(),
    });
    if (change === "duplicate") return true;
    if (change === "conflict") {
      this.#log(`dropping room clarify for "${turn.member}": clarify id is bound to another turn`);
      return true;
    }
    this.#trackActivity(turn, room.name);
    if (outcome === undefined) {
      this.#interactionExpiry?.schedule({
        bot: turn.member,
        kind: "clarify",
        interactionId: event.clarifyId,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        payload: { prompt: event.prompt, options: event.options, room: { key: turn.key, name: room.name } },
        expiresAt: event.expiresAt ?? null,
        updatedAt: this.#now(),
      });
      this.#broadcast({
        type: "bot_clarify_pending",
        bot: turn.member,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        clarifyId: event.clarifyId,
        prompt: event.prompt,
        options: event.options,
        ...(event.expiresAt === undefined ? {} : { expiresAt: event.expiresAt }),
        updatedAt: this.#now(),
        room: room.name,
      });
    } else {
      this.#broadcast({
        type: "bot_clarify_resolved",
        bot: turn.member,
        sessionId: turn.threadId,
        turnId: turn.turnId,
        clarifyId: event.clarifyId,
        outcome,
        ...(event.selectedOptionId === undefined ? {} : { selectedOptionId: event.selectedOptionId }),
        updatedAt: this.#now(),
        room: room.name,
      });
    }
    this.#emitPendingChanged(turn.key);
    return true;
  }

  /** One tool step inside a member turn, published as the 1:1 activity card carrying `room`.
   *
   *  Two deliberate differences from the 1:1 lane. It is NEVER persisted: a chat rebuilds its
   *  steps for a history screen, a room has no such screen, and the room's record is its
   *  transcript. And it carries `name` and `status` only: the 1:1 card may carry the plugin's
   *  bounded `detail`, and a room is a place where several bots and a human read each other's
   *  activity, so this projection stays at the narrowest thing that is still useful. Arguments and
   *  results were never on this wire and are not now.
   *
   *  Silently skipped, never declined, for a turn the room has moved past: a replayed tool event is
   *  rendering state, and an unrenderable one must not block the stream behind it. */
  #emitToolActivity(
    turn: BotGroupTurnRow,
    event: Extract<AttachV1EventFrame["event"], { kind: "tool" }>,
  ): void {
    if (turn.state !== "pending") return;
    const room = this.#storage.botGroup(turn.key);
    if (room === undefined || room.epoch !== turn.epoch) return;
    const current = this.#trackActivity(turn, room.name);
    const prior = current.steps.get(event.callId);
    // At-least-once: a retried lifecycle state carries no new user-visible fact.
    if (prior !== undefined && prior.name === event.name && prior.status === event.status) return;
    const now = this.#now();
    current.steps.set(event.callId, {
      stepId: event.callId,
      seq: prior?.seq ?? current.steps.size + 1,
      name: event.name,
      status: event.status,
      startedAt: prior?.startedAt ?? now,
      ...(event.status === "running" ? {} : { endedAt: now }),
    });
    current.seq += 1;
    current.emitted = true;
    this.#broadcast({
      type: "bot_tool_activity",
      bot: current.member,
      sessionId: current.threadId,
      turnId: turn.turnId,
      steps: [...current.steps.values()],
      seq: current.seq,
      updatedAt: now,
      room: current.roomName,
    });
  }

  /** Ends a member turn's activity, at every settlement the turn can reach, for the same reason
   *  `#endDraft` exists: the gateway opened these, so only the gateway can close them.
   *
   *  A step still `running` at settlement is sealed rather than left spinning, and a pending
   *  approval or clarification is EXPIRED: the turn that was blocked on it is over, so a card the
   *  user could still tap would resolve into a turn that no longer exists. This mirrors what the
   *  1:1 lane does at its own turn terminal. A turn that raised nothing has no entry here and
   *  costs nothing. */
  #endTurnActivity(turnId: string, seal: "ok" | "error"): void {
    const open = this.#activity.get(turnId);
    if (open === undefined) return;
    this.#activity.delete(turnId);
    if (open.emitted) {
      const now = this.#now();
      for (const [stepId, step] of open.steps) {
        if (step.status !== "running") continue;
        open.steps.set(stepId, { ...step, status: seal, endedAt: now });
      }
      this.#broadcast({
        type: "bot_tool_activity",
        bot: open.member,
        sessionId: open.threadId,
        turnId,
        steps: [...open.steps.values()],
        seq: open.seq + 1,
        updatedAt: now,
        done: true,
        room: open.roomName,
      });
    }
    // The native plane's own rule, borrowed rather than copied: it clears the deadline timer,
    // emits the terminal frames (which carry `room`, read off the durable payload), and says
    // whether anything actually changed.
    if (this.#interactionExpiry?.expireTurn(open.member, open.threadId, turnId) === true) {
      this.#emitPendingChanged(open.key);
    }
  }

  #entries(key: string): GroupLogEntry[] {
    return this.#storage.botGroupLog(key).map((row) => ({
      seq: row.seq,
      kind: row.kind,
      name: row.name,
      displayName: row.displayName,
      text: row.text,
      at: row.at,
      ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
    }));
  }

  #emitState(
    room: BotGroupRow,
    state: "running" | "settled" | "needs_you",
    round: number,
    note?: BotGroupNote,
    epoch?: number,
    extra: Pick<BotGroupStateFrame, "activity" | "room" | "renamedFrom"> = {},
  ): void {
    this.#broadcast({
      type: "bot_group_state",
      group: room.name,
      state,
      round,
      epoch: epoch ?? room.epoch,
      ...(note === undefined ? {} : { note }),
      updatedAt: this.#now(),
      ...this.#pendingInteractions(room.key),
      ...extra,
    });
  }
}

/** The name rules a room's address imposes, shared by create and rename. */
function validGroupName(rawName: string): string {
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
  if (RESERVED_GROUP_NAMES.has(name.toLowerCase())) {
    throw new GroupInvalid(`"${name}" is reserved by this API and cannot name a group`);
  }
  return name;
}

/** Canonical, distinct, 2 to 6 members, shared by create and a members edit. */
function validGroupMembers(rawMembers: string[]): string[] {
  const members: string[] = [];
  for (const raw of rawMembers) {
    // The same canonicalization every `/bots/:name` route applies.
    const member = normalizeProfileName(raw);
    if (!members.includes(member)) members.push(member);
  }
  if (members.length < GROUP_MIN_MEMBERS || members.length > GROUP_MAX_MEMBERS) {
    throw new GroupInvalid(
      `a group needs between ${GROUP_MIN_MEMBERS} and ${GROUP_MAX_MEMBERS} distinct members, got ${members.length}`,
    );
  }
  return members;
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

/** True when a live draft is on its way to being a pass, and so must not be shown.
 *
 *  `isPassText` is the settlement rule and matches the WHOLE reply; a draft is a prefix of one, so
 *  the parenthesized form is matched as a prefix too. Deliberately not a bare `pass` prefix: "pass
 *  the build to Luna" is an ordinary sentence, and suppressing it would hide a real reply. An empty
 *  draft is suppressed as well, because there is nothing yet to look at. */
function isPassDraft(text: string): boolean {
  const trimmed = text.trim();
  return isPassText(trimmed) || /^\(\s*pass\s*\)/i.test(trimmed);
}

function toWireMessage(row: BotGroupLogRow): BotGroupMessage {
  return {
    seq: row.seq,
    from: { kind: row.kind, name: row.name, displayName: row.displayName },
    text: row.text,
    at: row.at,
    ...(row.clientId === undefined ? {} : { clientId: row.clientId }),
    // Capability 47. Spread rather than defaulted: a row written before 47 has none of these, and
    // an invented id would be worse than an absent one.
    ...(row.messageId === undefined ? {} : { messageId: row.messageId }),
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    ...(row.epoch === undefined ? {} : { epoch: row.epoch }),
    ...(row.cause === undefined ? {} : { cause: row.cause }),
    ...(row.attachTurn === undefined ? {} : { attachTurn: row.attachTurn }),
    ...(row.threadId === undefined ? {} : { threadId: row.threadId }),
    ...(row.external === true ? { external: true } : {}),
  };
}

/** The auditable identity a member's room message inherits from the turn that produced it. Both
 *  settlement paths (the live round loop and the post-restart recovery) read the SAME durable turn
 *  row, so a reply recovered after a restart carries exactly the provenance it would have carried
 *  had the gateway never stopped. A missing turn row yields a fresh message id and nothing else:
 *  the message is real, and the ids it cannot prove stay absent. */
function provenance(turn: BotGroupTurnRow | undefined): Partial<BotGroupLogRow> {
  if (turn === undefined) return { messageId: randomUUID() };
  return {
    messageId: randomUUID(),
    turnId: turn.turnId,
    epoch: turn.epoch,
    ...(turn.cause === undefined ? {} : { cause: turn.cause }),
    attachTurn: { threadId: turn.threadId, turnId: turn.turnId },
  };
}

/** Typed room provenance for the attach `turn` command (capability 47). The prompt already names
 *  the room, its peers and the human in prose; this is the same facts in a shape a peer can read
 *  without parsing English. The human is an actor too, addressed by the `@user` token the protocol
 *  reserves, because a peer deciding who to answer needs to know the human is in the room. */
function turnContext(
  key: string,
  groupName: string,
  members: GroupMember[],
  epoch: number,
  cause: BotGroupCause | undefined,
): AttachV1TurnContext {
  return {
    room: { key, name: groupName, epoch, ...(cause === undefined ? {} : { seq: cause.seq }) },
    actors: [
      ...members.map((member) => ({
        name: member.name, handle: member.handle, displayName: member.displayName, kind: "member" as const,
      })),
      { name: GROUP_USER_LABEL, handle: USER_MENTION, displayName: GROUP_USER_LABEL, kind: "user" as const },
    ],
    ...(cause === undefined ? {} : { cause }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Rooms on a gateway that has NO Hermes endpoint at all (capability 46 and 52, finding V1-F1).
 *
 *  A room is a gateway-owned attach-v1 conversation (contract, "Group rooms are gateway-owned
 *  attach-v1 conversations too"), so nothing about one needs a Dashboard. It needed a HOST though,
 *  and the only host was `HermesBridge`: with zero endpoints the control surface is the federated
 *  one, whose group methods refuse every call as cross-endpoint. That refusal is right for a room
 *  spanning two Hermes endpoints and wrong for the absence of an endpoint, which is what this class
 *  fixes by owning the same `GroupRooms` the bridge owns.
 *
 *  The member callbacks are the Hermes-free half of the bridge's: with no endpoint configured every
 *  bot on this gateway is a runtime bot, so membership, existence and display identity are answered
 *  from the runtime set and the roster overlay with no RPC anywhere. */
/** Whatever holds a room's `GroupRooms`: a Hermes endpoint's own `HermesBridge`, or the gateway's
 *  `GatewayRoomHost` below. A gateway with two or more endpoints has several of these at once and
 *  hosts each room on exactly one of them (F8), so the server and the federated control surface
 *  both need to name the type rather than test for `instanceof HermesBridge`. */
export interface RoomHost {
  groups(): BotGroup[];
  createGroup(name: string, members: string[], owningHost?: string): Promise<BotGroup>;
  deleteGroup(name: string): void;
  groupDetail(name: string): BotGroupDetail;
  sendGroupMessage(name: string, text: string, opts?: { clientId?: string; threadId?: string }): BotGroupMessage;
  /** Capability 84. */
  updateGroup(name: string, patch: BotGroupPatchRequest): Promise<BotGroup>;
  stopGroup(name: string): BotGroup;
  compressGroupMember(name: string, member: string): Promise<{ member: string; text: string }>;
  setGroupNativeTurns(endpoint: NativeGroupTurnEndpoint): void;
  setGroupInteractionExpiry(expiry: RoomInteractionExpiry): void;
  canAcceptGroupAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean;
  handleGroupAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean;
}

export interface GatewayRoomHostOptions {
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** The gateway's own runtime bots, read live so a bot created from the app joins a room without
   *  a restart. The only source of membership here: there is no `profiles.list` to ask. */
  runtimeBotNames: () => ReadonlySet<string>;
  /** The roster rows a member's display name and handle come from, overlay applied. */
  rosterBots: () => readonly BotSummary[];
  escalate?: (event: { group: string; member: string; displayName: string; text: string }) => void;
}

export class GatewayRoomHost implements RoomHost {
  readonly #rooms: GroupRooms;
  readonly #runtime: () => ReadonlySet<string>;
  constructor(opts: GatewayRoomHostOptions) {
    this.#runtime = opts.runtimeBotNames;
    this.#rooms = new GroupRooms({
      storage: opts.storage,
      broadcast: opts.broadcast,
      now: opts.now,
      memberInfo: (name) => {
        const row = opts.rosterBots().find((bot) => bot.name === name);
        return {
          name,
          handle: row?.handle ?? botHandle(name),
          displayName: row?.displayName ?? botDisplayName(name, null),
        };
      },
      // A runtime bot is present by construction: its row and its attach identity are this
      // gateway's own. A name that is not one is not a bot here, and there is nobody else to ask.
      missingMembers: (names) => Promise.resolve(names.filter((name) => !this.#runtime().has(name))),
      memberKnown: (name) => this.#runtime().has(name),
      memberExists: (name) => Promise.resolve(this.#runtime().has(name)),
      isRuntimeMember: (name) => this.#runtime().has(name),
      ...(opts.escalate === undefined ? {} : { escalate: opts.escalate }),
    });
  }
  groups(): BotGroup[] {
    return this.#rooms.list();
  }
  createGroup(name: string, members: string[], owningHost?: string): Promise<BotGroup> {
    return this.#rooms.create(name, members, owningHost);
  }
  deleteGroup(name: string): void {
    this.#rooms.remove(name);
  }
  groupDetail(name: string): BotGroupDetail {
    return this.#rooms.detail(name);
  }
  sendGroupMessage(name: string, text: string, opts: { clientId?: string; threadId?: string } = {}): BotGroupMessage {
    return this.#rooms.send(name, text, opts);
  }
  updateGroup(name: string, patch: BotGroupPatchRequest): Promise<BotGroup> {
    return this.#rooms.update(name, patch);
  }
  stopGroup(name: string): BotGroup {
    return this.#rooms.stop(name);
  }
  compressGroupMember(name: string, member: string): Promise<{ member: string; text: string }> {
    return this.#rooms.compress(name, member);
  }
  setGroupNativeTurns(endpoint: NativeGroupTurnEndpoint): void {
    this.#rooms.setNativeTurns(endpoint);
  }
  setGroupInteractionExpiry(expiry: RoomInteractionExpiry): void {
    this.#rooms.setInteractionExpiry(expiry);
  }
  canAcceptGroupAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    return this.#rooms.canAcceptAttachEvent(agentId, frame);
  }
  handleGroupAttachEvent(agentId: string, frame: AttachV1EventFrame): boolean {
    return this.#rooms.handleAttachEvent(agentId, frame);
  }
  async close(): Promise<void> {
    await this.#rooms.close();
  }
}

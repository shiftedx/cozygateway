import type { BotChatMessage } from "cozygateway-contract";

import type { HermesRpc } from "./canonical-chat.ts";
import { isContextCompactionMarker, parseChatSnapshot } from "./chat-messages.ts";
import type { ChatStreamBinder } from "./chat-stream.ts";
import { CHAT_POLL_MS, CHAT_TURN_TIMEOUT_MS } from "./chat-turns.ts";
import { groupSessionTitle } from "./group-protocol.ts";

/** One member's turn in a room: resolve that member's persistent `Group: <name>` session, submit
 *  the turn prompt into it, and wait for the reply.
 *
 *  The waiting half is deliberately the SAME loop the canonical chat already runs
 *  (`chat-turns.ts`): submit against the RUNTIME session id, then `session.resume` every 2 s until
 *  the message count has grown past the baseline AND Hermes reports neither `running` nor
 *  `inflight`, giving up at 180 s. The cadence and the cap are imported from that module rather than
 *  restated, so the two paths can never drift apart, and `parseChatSnapshot` does the decoding, so
 *  the three content shapes a Hermes build may use (string, parts array, `msg.text`) are handled
 *  once (dissection 9.7).
 *
 *  What is different from the 1:1 path is what happens with the answer: nothing is broadcast from
 *  here and no watermark is kept. A member turn produces a STRING or it produces nothing, and the
 *  room orchestrator decides what that means. */

/** Consecutive failing polls tolerated before the turn is abandoned, matching `chat-turns.ts`. */
const MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** How many polls a session THIS TURN created may answer "session not found" for before those
 *  polls start counting against the failure budget.
 *
 *  `session.create` persists no database row until the first prompt lands (dissection 14.5), so the
 *  stored id it handed back is unresumable for as long as that write takes. That is not a failing
 *  gateway, it is a session that does not exist yet, and counting it as a failure is what killed the
 *  first turn of every room: three polls, six seconds, and a member that had already replied was
 *  reported as failed. Observed persistence lag on a live 0.20.4 dashboard is under five seconds;
 *  fifteen polls is 30 s at the production cadence.
 *
 *  Counted in POLLS rather than milliseconds so it scales with `pollMs` exactly as the turn cap
 *  does: a test that runs the loop at 10 ms gets a 150 ms grace, not a 30 s one. */
const CREATED_SESSION_PERSIST_GRACE_POLLS = 15;

/** What a member's turn produced.
 *
 *  `pass` is the healthy outcome and covers both the literal `(pass)` and a reply with no text at
 *  all. `timeout` and `failed` are the honest ones: the member said nothing because its turn did not
 *  complete, which the room reports as a note and never as a message it invented on the member's
 *  behalf.
 *
 *  `gone` is the turn that never started: the member is no longer a bot on this gateway, so there
 *  was nothing to ask and nothing was asked. It is separate from `failed` because nothing failed,
 *  and separate from `pass` because a vanished member must not have its watermark advanced as though
 *  it had read the room. */
export type GroupTurnResult =
  | { outcome: "spoke"; text: string }
  | { outcome: "pass" }
  | { outcome: "gone" }
  | { outcome: "timeout"; detail: string }
  | { outcome: "failed"; detail: string };

/** The two ids a member's room session is addressed by. The split is STRICT, and live-proven
 *  against a 0.20.4 dashboard: `session.resume` answers ONLY on the stored id (it rejects a runtime
 *  id with "session not found"), and `prompt.submit` accepts ONLY the runtime id (it rejects a
 *  stored id with the same error). Neither call will take the other's id, ever.
 *
 *  The runtime id is also EPHEMERAL: every `session.resume` hands back a fresh one for the same
 *  stored session, so a runtime id is good for the submit that immediately follows the resolve that
 *  produced it and for nothing else. It is never a poll target and never persisted. */
export interface GroupSession {
  /** The durable handle. Persisted by the room, and the ONLY id `session.resume` accepts. */
  storedId: string;
  /** The submit-only handle from the resolve that produced this session. Single use. */
  runtimeId: string;
  /** RAW transcript rows Hermes reported when the session was resolved, i.e. `message_count`.
   *
   *  This number lives in HERMES' coordinate space, which counts every row: `system` prompts,
   *  `tool` results and tool-call-only assistant turns included. It is therefore only ever
   *  compared against another RAW count (the "did the transcript grow at all" check) and MUST NOT
   *  be used to index `snapshot.messages`, which is the FILTERED render list the decoder
   *  produces. Mixing the two is what made every member turn time out for any bot whose transcript
   *  had ever carried a dropped row. */
  messageCount: number;
  /** RENDERED messages already in the session when it was resolved: the baseline in the SAME
   *  coordinate space as `snapshot.messages`, and the only offset a reply slice is taken at. */
  renderedCount: number;
  /** Id of the last rendered message at resolve time, when there was one. The primary anchor: a
   *  count can be shifted out from under a turn, an identity match cannot. */
  lastRenderedId?: string;
  /** That same message's text. Carried because an id alone cannot prove it names the same row: a
   *  row that carries none of its own is given a synthesized id, and two rows can be given the same
   *  one when their words and their role are identical. The text is what tells a real anchor from a
   *  coincidence. */
  lastRenderedText?: string;
  /** True when this call created the session, so the caller knows to persist the stored id. */
  created: boolean;
}

/** The baseline anchor's position in `messages`, or -1 when the anchor does not hold.
 *
 *  It does not hold when the id is gone, and it does not hold when the id matches a row whose text
 *  is not the text the anchor was taken from: that is a renumbered synthetic id, not the message. */
function anchorIndexOf(
  messages: readonly BotChatMessage[],
  session: Pick<GroupSession, "lastRenderedId" | "lastRenderedText">,
): number {
  if (session.lastRenderedId === undefined) return -1;
  const index = messages.findIndex((message) => message.id === session.lastRenderedId);
  if (index === -1) return -1;
  if (session.lastRenderedText !== undefined && messages[index]?.text !== session.lastRenderedText) return -1;
  return index;
}

/** True when the transcript was REWRITTEN under this turn, i.e. the baseline describes a list that
 *  no longer exists.
 *
 *  Hermes compacts sessions, and a compaction that lands inside a turn window invalidates both
 *  anchors at once: the count is too high for the list that is there, and the position it names is
 *  somebody else's. The 1:1 chat path has always handled this hazard explicitly (`chat-turns.ts`
 *  re-bases when the id it held is gone rather than going permanently silent) and the group path
 *  now handles it the same way. Without it a compaction reproduces exactly the symptom the mixed
 *  index spaces produced: an empty window, no reply ever found, and the turn burning the 180 s cap. */
export function transcriptRewritten(
  messages: readonly BotChatMessage[],
  session: Pick<GroupSession, "renderedCount" | "lastRenderedId" | "lastRenderedText">,
): boolean {
  if (session.lastRenderedId !== undefined && anchorIndexOf(messages, session) === -1) return true;
  return messages.length < session.renderedCount;
}

/** The newest assistant message strictly AFTER the baseline this turn started from.
 *
 *  Anchored on the id (and text) of the last rendered message seen before submit, falling back to
 *  the rendered COUNT when there was no anchor to take. Both live in the filtered render space,
 *  which is the space `messages` is in; the raw `message_count` never enters here.
 *
 *  Walking back from the end (rather than the desktop's walk over the whole transcript) is what
 *  makes a stale reply unrepresentable: the previous turn's answer sits BEFORE the baseline and is
 *  never a candidate. The one case where the walk DOES cover the whole transcript is a rewritten
 *  one: after a compaction there is no baseline left to respect, and the desktop's answer (the
 *  newest assistant message) beats silence. */
export function findFreshReply(
  messages: readonly BotChatMessage[],
  session: Pick<GroupSession, "renderedCount" | "lastRenderedId" | "lastRenderedText">,
): BotChatMessage | undefined {
  const anchor = anchorIndexOf(messages, session);
  const baseline = transcriptRewritten(messages, session)
    ? 0
    : anchor !== -1
      ? anchor + 1
      : Math.min(session.renderedCount, messages.length);
  for (let index = messages.length - 1; index >= baseline; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && !isContextCompactionMarker(message)) return message;
  }
  return undefined;
}

/** Thrown by `ensureGroupSession` when the member is no longer a bot on this gateway, discovered at
 *  the only boundary where it matters: the instant before `session.create`. Its own type rather than
 *  a plain `Error` because the room reads it as news (`gone`) rather than as a failed turn, and the
 *  two get different wording, different watermark handling and different notes. */
export class MemberGone extends Error {
  readonly member: string;
  constructor(member: string) {
    super(`${member} is no longer a bot on this gateway`);
    this.name = "MemberGone";
    this.member = member;
  }
}

export interface GroupSessionOptions {
  /** The stored id this room remembers for the member, when it has one. */
  storedId?: string;
  /** Room sessions are born hidden by the same rule canonical chats are. */
  hidden: boolean;
  /** Throws `MemberGone` when the member is no longer a profile on this gateway, checked FRESH.
   *  Called on the CREATE arm only, immediately before `session.create`, which is the same place
   *  and for the same reason as `CanonicalChatDeps.assertStillExists`: an unknown name is a 404
   *  everywhere else, but `session.create` in Hermes 0.20.x AUTO-CREATES a profile for it, so a
   *  deleted bot comes back as a bare profile that no later refresh can tell from a real one.
   *
   *  Here rather than at the top of the turn so a room pays the round trip once per NEW session
   *  instead of once per member per round, and so the window between the answer and the create is
   *  the two statements between them rather than the whole of the resume path. The resume arms need
   *  nothing: they address a session that already exists, which a Hermes that has neither refuses
   *  rather than invents. */
  assertStillExists?: () => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function detailOf(err: unknown): string {
  return err instanceof Error ? err.message : "unknown failure";
}

/** Resolves the member's `Group: <name>` session, creating it only when neither lookup lands
 *  (dissection 9.6).
 *
 *  Two lookups, in order: the stored id this room remembers, then the session TITLE ITSELF in the
 *  `session_id` slot. The title lookup is BEST EFFORT and nothing may depend on it: a live 0.20.4
 *  dashboard answers "session not found" for a title in that slot, so on that build a room that
 *  lost its stored ids mints a fresh session per member rather than rehydrating. It is kept because
 *  it is free (one failed call on a path that was going to create anyway) and because builds that
 *  do resolve a title there rehydrate for nothing.
 *
 *  Whatever lookup lands, the ids are read the same way: `session_id` is the RUNTIME (submit-only,
 *  single-use) handle and `session_key` is the STORED (resume-only, durable) one.
 *
 *  The create arm, and only the create arm, first asks `opts.assertStillExists` whether the member
 *  is still a bot here, and throws `MemberGone` when it is not. */
export async function ensureGroupSession(
  rpc: HermesRpc,
  member: string,
  group: string,
  opts: GroupSessionOptions,
): Promise<GroupSession> {
  const title = groupSessionTitle(group);
  const targets = opts.storedId === undefined ? [title] : [opts.storedId, title];
  for (const target of targets) {
    try {
      // Messages are ASKED FOR here, unlike the 1:1 path's cheap probe: the turn's baseline has to
      // be the RENDERED length, and `omit_messages: true` can only ever answer with the raw count.
      // One extra transcript read per member turn is the price of a baseline that indexes the list
      // it is actually used against.
      const raw = asRecord(await rpc.request("session.resume", {
        session_id: target,
        profile: member,
        omit_messages: false,
      }));
      const runtimeId = asId(raw?.["session_id"]);
      if (runtimeId === undefined) continue;
      const storedId = asId(raw?.["session_key"]) ?? (target === title ? runtimeId : target);
      // Parsed under the STORED id, and so is every poll below, so the ids synthesized for rows
      // carrying none of their own are comparable across the two reads. Parsing each read under
      // whatever id it was addressed by would make the anchor miss on the first poll and silently
      // drop back to the count.
      const snapshot = parseChatSnapshot(raw, storedId);
      const lastRendered = snapshot.messages.at(-1);
      return {
        storedId,
        runtimeId,
        messageCount: snapshot.messageCount,
        renderedCount: snapshot.messages.length,
        ...(lastRendered === undefined
          ? {}
          : { lastRenderedId: lastRendered.id, lastRenderedText: lastRendered.text }),
        created: false,
      };
    } catch {
      // A session that does not exist under this key is the ordinary case for the first turn of a
      // new room. Fall through to the next key, and then to creation.
    }
  }

  await opts.assertStillExists?.();
  const created = asRecord(
    await rpc.request("session.create", {
      profile: member,
      title,
      ...(opts.hidden ? { hidden: true } : {}),
    }),
  );
  const runtimeId = asId(created?.["session_id"]);
  const storedId = asId(created?.["stored_session_id"]) ?? runtimeId;
  if (runtimeId === undefined || storedId === undefined) {
    throw new Error(`hermes session.create returned no session ids for ${member}`);
  }
  return { storedId, runtimeId, messageCount: 0, renderedCount: 0, created: true };
}

export interface MemberTurnOptions {
  rpc: HermesRpc;
  member: string;
  group: string;
  prompt: string;
  session: GroupSession;
  now: () => number;
  pollMs?: number;
  timeoutMs?: number;
  /** True while this turn is still the room's business. A superseding user message flips it, and
   *  the poll then stops rather than spending the rest of the 180 s cap on an answer nobody wants.
   *  It stops with ONE last read (`harvest`), so an answer that already landed is not discarded. */
  live?: () => boolean;
  /** Where this member's reply is drafted while it is being written. The room's own transcript is
   *  still assembled from the poll below and nothing else; the draft is a `bot_chat_delta` frame
   *  carrying `room` alongside the member name, so a client can show the member typing in the room
   *  it belongs to. Optional, exactly as on the 1:1 path. */
  stream?: ChatStreamBinder;
  log?: (message: string) => void;
}

/** Runs one member turn to completion. Never throws: every failure becomes an outcome, because a
 *  room where one member's broken turn aborts the round is strictly worse than one where the others
 *  carry on without it. */
export async function runMemberTurn(opts: MemberTurnOptions): Promise<GroupTurnResult> {
  const { rpc, member, session, prompt } = opts;
  const pollMs = opts.pollMs ?? CHAT_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? CHAT_TURN_TIMEOUT_MS;
  const live = opts.live ?? (() => true);
  const log = opts.log ?? ((): void => {});

  // Bound before the submit for the same reason the 1:1 path binds before its submit: the first
  // token event can beat the submit's own reply, and an unbound session's events are dropped.
  opts.stream?.bind(session.runtimeId, { bot: member, sessionId: session.storedId, room: opts.group });

  try {
    await rpc.request("prompt.submit", { session_id: session.runtimeId, text: prompt });
  } catch (err) {
    const detail = detailOf(err);
    log(`group turn submit failed for ${member}: ${detail}`);
    return { outcome: "failed", detail };
  }

  const deadline = opts.now() + timeoutMs;
  // The STORED id, always. The runtime id `session.create` handed back is a submit handle and
  // nothing else: `session.resume` rejects it with "session not found" on every build we have
  // measured, so polling it (which is what the created path used to do) could only ever fail, and
  // the old recovery could only ever move TOWARDS it. A session this turn created is simply not
  // resumable until its prompt persists, which is what the grace below waits out.
  const resumeId = session.storedId;
  // False only for a session this turn created that has not answered a resume yet.
  let persisted = !session.created;
  let waitedForPersist = 0;
  let failures = 0;
  let lastDetail = "";

  while (opts.now() < deadline) {
    await sleep(pollMs);
    if (!live()) return await harvest({ rpc, member, session, log });

    let raw: unknown;
    try {
      raw = await rpc.request("session.resume", {
        session_id: resumeId,
        profile: member,
        omit_messages: false,
      });
      failures = 0;
      persisted = true;
    } catch (err) {
      lastDetail = detailOf(err);
      // The lazily-created session's write has not landed yet. Nothing is wrong, so nothing is
      // counted; the grace bounds how long "nothing is wrong" stays believable.
      if (!persisted && waitedForPersist < CREATED_SESSION_PERSIST_GRACE_POLLS) {
        waitedForPersist += 1;
        continue;
      }
      failures += 1;
      log(`group turn poll failed for ${member}: ${lastDetail}`);
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) return { outcome: "failed", detail: lastDetail };
      continue;
    }

    const snapshot = parseChatSnapshot(raw, session.storedId);
    if (snapshot.running || snapshot.inflight) continue;
    // RAW against RAW: `messageCount` is Hermes' own row count, and this is the only thing it is
    // ever compared against. The reply itself is picked in the FILTERED space by `findFreshReply`.
    //
    // Skipped entirely for a transcript that was rewritten under us: a compaction can leave the
    // count level or send it BACKWARDS while the reply is sitting right there, and gating on growth
    // that can never happen is how a turn burns its whole cap for nothing.
    const count = Math.max(snapshot.messages.length, snapshot.messageCount);
    // The growth gate is a CHEAP stand-in for "is there anything new here", and it is only needed
    // when there is no anchor to ask instead. An anchor that still holds names the exact row this
    // turn started from, so `findFreshReply` can only ever return something written after it, and
    // asking the count as well is what made a compaction look like silence: a head trim leaves the
    // row count level (or sends it backwards) with the reply sitting right there, and since ids
    // survive a re-base now (`chat-identity.ts`) the anchor holds through exactly that trim, so the
    // rewrite escape hatch below no longer fires for it either (cozygateway#87).
    const anchored = anchorIndexOf(snapshot.messages, session) !== -1;
    if (!anchored && count <= session.messageCount && !transcriptRewritten(snapshot.messages, session)) continue;
    const reply = findFreshReply(snapshot.messages, session);
    if (reply === undefined) continue;
    const text = reply.text.trim();
    return text.length === 0 ? { outcome: "pass" } : { outcome: "spoke", text };
  }

  const detail = lastDetail.length > 0 ? lastDetail : `no reply within ${Math.round(timeoutMs / 1000)}s`;
  return { outcome: "timeout", detail };
}

/** What a superseded turn does with its answer.
 *
 *  The contract's promise is that a member turn already in flight when a newer user message lands
 *  is not thrown away just for being late: it was a real answer to a real question. But it must not
 *  hold the room up either, so this does NOT wait. One read: if the reply has ALREADY completed it
 *  is returned and the room posts it; if the member is still thinking, the turn is abandoned and
 *  the answer stays in the member's own `Group: <name>` session, where the next round's delta will
 *  carry the conversation forward anyway. */
async function harvest(args: {
  rpc: HermesRpc;
  member: string;
  session: GroupSession;
  log: (message: string) => void;
}): Promise<GroupTurnResult> {
  const { rpc, member, session, log } = args;
  try {
    const raw = await rpc.request("session.resume", {
      session_id: session.storedId,
      profile: member,
      omit_messages: false,
    });
    const snapshot = parseChatSnapshot(raw, session.storedId);
    if (!snapshot.running && !snapshot.inflight) {
      const text = findFreshReply(snapshot.messages, session)?.text.trim() ?? "";
      if (text.length > 0) return { outcome: "spoke", text };
    }
  } catch (err) {
    log(`group turn harvest failed for ${member}: ${detailOf(err)}`);
  }
  return { outcome: "pass" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

import type { HermesRpc } from "./canonical-chat.ts";
import { parseChatSnapshot } from "./chat-messages.ts";
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

/** What a member's turn produced.
 *
 *  `pass` is the healthy outcome and covers both the literal `(pass)` and a reply with no text at
 *  all. `timeout` and `failed` are the honest ones: the member said nothing because its turn did not
 *  complete, which the room reports as a note and never as a message it invented on the member's
 *  behalf. */
export type GroupTurnResult =
  | { outcome: "spoke"; text: string }
  | { outcome: "pass" }
  | { outcome: "timeout"; detail: string }
  | { outcome: "failed"; detail: string };

/** The two ids a member's room session is addressed by. `storedId` is what gets persisted and what
 *  `session.resume` takes; `runtimeId` is the only id `prompt.submit` accepts (dissection 1.2). */
export interface GroupSession {
  storedId: string;
  runtimeId: string;
  /** Messages already in the session when it was resolved, the baseline a turn grows past. Zero for
   *  a session that was just created, or one too lazy to resume. */
  messageCount: number;
  /** True when this call created the session, so the caller knows to persist the stored id. */
  created: boolean;
}

export interface GroupSessionOptions {
  /** The stored id this room remembers for the member, when it has one. */
  storedId?: string;
  /** Room sessions are born hidden by the same rule canonical chats are. */
  hidden: boolean;
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
 *  `session_id` slot. The second is not a curiosity, it is what makes a room survive losing its
 *  stored ids (a wiped cache, a room restored from a backup, a session the desktop created first):
 *  Hermes resolves a title in that slot, and a proxy that refuses to pass one through breaks
 *  rehydration and mints a second room session per member instead. */
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
      const raw = asRecord(await rpc.request("session.resume", {
        session_id: target,
        profile: member,
        omit_messages: true,
      }));
      const runtimeId = asId(raw?.["session_id"]);
      if (runtimeId === undefined) continue;
      const storedId = asId(raw?.["session_key"]) ?? (target === title ? runtimeId : target);
      const snapshot = parseChatSnapshot(raw, storedId);
      return { storedId, runtimeId, messageCount: snapshot.messageCount, created: false };
    } catch {
      // A session that does not exist under this key is the ordinary case for the first turn of a
      // new room. Fall through to the next key, and then to creation.
    }
  }

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
  return { storedId, runtimeId, messageCount: 0, created: true };
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
   *  the poll then stops rather than spending the rest of the 180 s cap on an answer nobody wants. */
  live?: () => boolean;
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

  try {
    await rpc.request("prompt.submit", { session_id: session.runtimeId, text: prompt });
  } catch (err) {
    const detail = detailOf(err);
    log(`group turn submit failed for ${member}: ${detail}`);
    return { outcome: "failed", detail };
  }

  const deadline = opts.now() + timeoutMs;
  // The stored id is the resumable one; a session created moments ago has no row under it until the
  // prompt lands, and the runtime id is the only handle that works in the meantime.
  let resumeId = session.created ? session.runtimeId : session.storedId;
  let failures = 0;
  let lastDetail = "";

  while (opts.now() < deadline) {
    await sleep(pollMs);
    if (!live()) return { outcome: "pass" };

    let raw: unknown;
    try {
      raw = await rpc.request("session.resume", {
        session_id: resumeId,
        profile: member,
        omit_messages: false,
      });
      failures = 0;
    } catch (err) {
      lastDetail = detailOf(err);
      // A stored id that will not resume yet is not a failure while the runtime id still answers.
      if (resumeId !== session.runtimeId) {
        resumeId = session.runtimeId;
        continue;
      }
      failures += 1;
      log(`group turn poll failed for ${member}: ${lastDetail}`);
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) return { outcome: "failed", detail: lastDetail };
      continue;
    }

    const snapshot = parseChatSnapshot(raw, resumeId);
    if (snapshot.running || snapshot.inflight) continue;
    const count = Math.max(snapshot.messages.length, snapshot.messageCount);
    if (count <= session.messageCount) continue;
    // The newest assistant message AT OR PAST THE BASELINE. The desktop walks back over the whole
    // transcript here, which has a race it gets away with because the window is small: the user's own
    // prompt lands first, so between "the count grew" and "the model started" the walk finds the
    // PREVIOUS turn's reply and returns it as this turn's. In a room that reads as a member repeating
    // itself, which is exactly the thing the protocol asks members not to do. Slicing at the baseline
    // costs nothing and makes a stale reply unrepresentable.
    const fresh = snapshot.messages.slice(Math.min(session.messageCount, snapshot.messages.length));
    const reply = [...fresh].reverse().find((message) => message.role === "assistant");
    if (reply === undefined) continue;
    const text = reply.text.trim();
    return text.length === 0 ? { outcome: "pass" } : { outcome: "spoke", text };
  }

  const detail = lastDetail.length > 0 ? lastDetail : `no reply within ${Math.round(timeoutMs / 1000)}s`;
  return { outcome: "timeout", detail };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

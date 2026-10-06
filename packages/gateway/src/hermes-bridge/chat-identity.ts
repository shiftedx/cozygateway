import { createHash } from "node:crypto";

import type { BotChatMessage } from "cozygateway-contract";

/** Message identity that survives a compaction (cozygateway#87).
 *
 *  A hermes transcript is not an append-only log. `/compact` REPLACES it: the head is dropped, a
 *  summary row may take its place, and the tail is carried over verbatim. Two things in this bridge
 *  used to derive a row's id from where it sat in that list, so one compaction renamed rows the
 *  client already held:
 *
 *   1. a row that carries no id of its own got `<sessionId>#<raw index>`, and every surviving row's
 *      raw index moves when the head is trimmed;
 *   2. the delta watermark then failed to find the id it held, re-based to the start, and broadcast
 *      the whole compacted transcript again.
 *
 *  The client cannot repair that. Every guard it has is an IDENTITY guard, so the same words under a
 *  fresh id is a second bubble, not a duplicate to fold away, and no client-side rule can tell a
 *  re-delivery from a user who genuinely said the same thing twice (cozychat#112, PR #115).
 *
 *  So identity is anchored HERE, in two layers:
 *
 *   • the synthesized id is derived from the row's CONTENT rather than its position
 *     (`syntheticChatId`), which is position independent by construction and, because it is a pure
 *     function, mints the same id again after a gateway restart;
 *   • this ledger remembers which id each row was actually delivered under and hands the same one
 *     back for as long as the row is in the transcript, which covers the case content alone cannot:
 *     two rows with identical words, where compaction trims the earlier one. It also covers a
 *     backend that renames its OWN ids across a compaction, since the ledger never consults where
 *     the id came from.
 *
 *  Nothing here is persisted. It does not need to be: the synthesized id is deterministic, so a
 *  restarted gateway lands on the same ids the ledger was handing out, and the one case that drifts
 *  (a repeated line whose earlier copy was compacted away while the gateway was down) costs a single
 *  re-delivered row rather than a transcript. */

/** How many sessions hold a ledger. One per open bot chat plus a margin; the oldest is evicted. */
const MAX_SESSIONS = 64;

/** How many ids one session's ledger holds. A row is ~80 bytes here, so this is a leak stop rather
 *  than a tuning knob, and it is comfortably past what a compacted transcript carries. */
const MAX_IDS_PER_SESSION = 2_000;

/** The identity of a row's CONTENT: role and text, and deliberately nothing else. Not the timestamp,
 *  because a row that gains or loses a stamp between builds (or between a poll and a history read)
 *  is the same row, and not the position, because position is the thing a compaction moves. */
export function chatRowFingerprint(role: string, text: string): string {
  return createHash("sha256").update(`${role}\n${text}`).digest("hex").slice(0, 16);
}

/** The id given to a row the backend did not name. Position independent, and stable for a given
 *  session, role, text and occurrence: the `ordinal` is how many EARLIER unnamed rows in the same
 *  transcript carry the same role and text, so two identical lines are still two identities. */
export function syntheticChatId(sessionId: string, role: string, text: string, ordinal: number): string {
  return `${sessionId}#${chatRowFingerprint(role, text)}-${ordinal}`;
}

/** Ids already handed out for one session, grouped by content fingerprint and kept in the order the
 *  rows appear in the transcript. */
type SessionLedger = Map<string, string[]>;

export class ChatIdentityLedger {
  /** Insertion ordered, so evicting the first key evicts the least recently used session. */
  readonly #sessions = new Map<string, SessionLedger>();
  /** Backend/synthetic ids proven to be a second segment of an already delivered utterance. */
  readonly #aliases = new Map<string, Map<string, string>>();

  /** Answers the rows of one freshly decoded snapshot, with every row that this session has already
   *  delivered wearing the id it was delivered under.
   *
   *  The alignment rule, for a group of rows sharing one fingerprint: when the transcript holds at
   *  least as many copies as the ledger does, the copies line up from the FRONT and the extra ones
   *  are new (a repeated line is appended at the tail). When it holds fewer, they line up from the
   *  BACK, because the only thing that removes a row is a compaction and a compaction removes from
   *  the head. That is the whole of it, and it is deliberately not a diff: a transcript is only ever
   *  appended to or head-rewritten, and a rule that tried to be cleverer would have to guess.
   *
   *  An empty snapshot is left alone rather than treated as a transcript that lost every row: an
   *  `omit_messages` poll and a chat that has not been created yet both look like this, and neither
   *  is news about identity. */
  assign(sessionId: string, messages: BotChatMessage[]): BotChatMessage[] {
    if (messages.length === 0) return messages;
    const known = this.#sessions.get(sessionId);
    const counts = new Map<string, number>();
    for (const message of messages) {
      const key = chatRowFingerprint(message.role, message.text);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const next: SessionLedger = new Map();
    const cursor = new Map<string, number>();
    const aliases = this.#aliases.get(sessionId);
    const assigned = messages.map((message) => {
      const key = chatRowFingerprint(message.role, message.text);
      const occurrence = cursor.get(key) ?? 0;
      cursor.set(key, occurrence + 1);
      const prior = known?.get(key) ?? [];
      // Fewer copies than the ledger holds means the head was trimmed, so line up from the back.
      const offset = Math.max(0, prior.length - (counts.get(key) ?? 0));
      const candidate = prior[offset + occurrence] ?? message.id;
      const id = aliases?.get(candidate) ?? candidate;
      const ids = next.get(key);
      if (ids === undefined) next.set(key, [id]);
      else ids.push(id);
      return id === message.id ? message : { ...message, id };
    });

    this.#remember(sessionId, next);
    const unique = new Set<string>();
    return assigned.filter((message) => {
      if (unique.has(message.id)) return false;
      unique.add(message.id);
      return true;
    });
  }

  /** Records that `duplicateId` is a settle-time segment of the row already delivered as
   *  `deliveredId`. The alias is id-specific, not content-wide, so the same words in a later turn
   *  still receive their own identity. */
  coalesce(sessionId: string, duplicateId: string, deliveredId: string): string {
    if (duplicateId === deliveredId) return deliveredId;
    const aliases = this.#aliases.get(sessionId) ?? new Map<string, string>();
    aliases.set(duplicateId, deliveredId);
    while (aliases.size > MAX_IDS_PER_SESSION) {
      const oldest = aliases.keys().next();
      if (oldest.done === true) break;
      aliases.delete(oldest.value);
    }
    this.#aliases.set(sessionId, aliases);

    const ledger = this.#sessions.get(sessionId);
    if (ledger !== undefined) {
      for (const ids of ledger.values()) {
        for (let index = 0; index < ids.length; index += 1) {
          if (ids[index] === duplicateId) ids[index] = deliveredId;
        }
      }
    }
    return deliveredId;
  }

  /** Forgets one session's ledger. Called when a chat is retired, so a re-pinned session cannot
   *  inherit identities from the one it replaced. */
  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
    this.#aliases.delete(sessionId);
  }

  clear(): void {
    this.#sessions.clear();
    this.#aliases.clear();
  }

  #remember(sessionId: string, ledger: SessionLedger): void {
    let total = 0;
    for (const ids of ledger.values()) total += ids.length;
    // Over the cap the OLDEST fingerprints go first, which is the head of the transcript: exactly
    // the rows a compaction is about to take away anyway.
    for (const key of ledger.keys()) {
      if (total <= MAX_IDS_PER_SESSION) break;
      total -= ledger.get(key)?.length ?? 0;
      ledger.delete(key);
    }
    // Re-inserting moves the session to the end of the iteration order, which is what makes the
    // eviction below least-recently-used rather than arbitrary.
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, ledger);
    while (this.#sessions.size > MAX_SESSIONS) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done === true) break;
      this.#sessions.delete(oldest.value);
      this.#aliases.delete(oldest.value);
    }
  }
}

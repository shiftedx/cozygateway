/** The group-chat deliberation protocol, as pure functions: who speaks, in what order, what each
 *  member is asked, and what counts as a pass. Every rule here is the Hermes desktop plugin's
 *  (dissection sections 9.1 and 9.3 to 9.5), reimplemented so a room hosted by this gateway behaves
 *  exactly like a room hosted by the desktop renderer.
 *
 *  Nothing in this file touches a socket, a clock or a database. The orchestrator that does lives
 *  in `group-rooms.ts`; keeping the rules pure is what makes the caps, the mention scoping and the
 *  prompt text directly testable without a Hermes at all. */

/** Caps, verbatim from the desktop plugin (dissection 9.1). */
export const GROUP_MAX_ROUNDS = 3;
export const GROUP_MAX_MESSAGES = 10;
export const GROUP_HISTORY_LIMIT = 24;
export const GROUP_MIN_MEMBERS = 2;
export const GROUP_MAX_MEMBERS = 6;
/** Log retention: four times the per-turn delta window, trimmed from the head. */
export const GROUP_LOG_LIMIT = GROUP_HISTORY_LIMIT * 4;
/** Longest room name, matching the desktop dialog's own `maxLength`. */
export const GROUP_NAME_MAX = 64;

/** The display name the desktop gives the human in a room log. It is what `formatLine` renders and
 *  what the prompt's `(user)` tag hangs off, so it is convention, not decoration. */
export const GROUP_USER_LABEL = "You";

/** One member as the protocol sees it: the Hermes profile name, the `@handle` peers address it by,
 *  and the display title a transcript renders. */
export interface GroupMember {
  name: string;
  handle: string;
  displayName: string;
}

/** One entry in the room log. `kind: "user"` is the human. */
export interface GroupLogEntry {
  seq: number;
  kind: "user" | "member";
  /** Profile name for a member; `GROUP_USER_LABEL` for the human. */
  name: string;
  displayName: string;
  text: string;
  at: number;
}

/** Every handle form a member answers to, lowercased (dissection 9.4): its name, its name with
 *  whitespace/`_`/`-` runs collapsed away, and, when it carries a title, the lowercased title, the
 *  collapsed title, and the title's FIRST WORD (so `@atlas` reaches "Atlas the Planner"). */
export function memberMentionForms(member: GroupMember): string[] {
  const forms = new Set<string>();
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim().toLowerCase() ?? "";
    if (trimmed.length > 0) forms.add(trimmed);
  };
  add(member.name);
  add(member.name.replace(/[\s_-]+/g, ""));
  add(member.handle);
  add(member.handle.replace(/[\s_-]+/g, ""));
  const title = member.displayName.trim();
  if (title.length > 0 && title.toLowerCase() !== member.name.trim().toLowerCase()) {
    add(title);
    add(title.replace(/[\s_-]+/g, ""));
    add(title.split(/\s+/)[0]);
  }
  return [...forms];
}

/** `@everyone` and `@all` name the whole room rather than a member. */
const EVERYONE_TOKENS = new Set(["everyone", "all"]);

/** The human's own handle. Skipped when resolving members: `@user` is the escalation signal
 *  (dissection 9.9), never a participant to pull in. */
export const USER_MENTION = "user";

/** Mentions found in one line of room text, resolved against the room's membership.
 *  `everyone` is true when the text named the whole room; `members` carries the profile names of
 *  the members that were named individually. */
export function parseMentions(text: string, members: GroupMember[]): { everyone: boolean; members: Set<string> } {
  const named = new Set<string>();
  let everyone = false;
  // The desktop's own token rule. `gi` because a mention may be capitalized anywhere in a sentence.
  const pattern = /@([a-z0-9][a-z0-9._-]*)/gi;
  const forms = members.map((member) => ({ member, forms: memberMentionForms(member) }));
  for (const match of text.matchAll(pattern)) {
    const token = (match[1] ?? "").toLowerCase();
    if (token.length === 0) continue;
    if (EVERYONE_TOKENS.has(token)) {
      everyone = true;
      continue;
    }
    if (token === USER_MENTION) continue;
    // Exact form first, then the form with separators stripped, which is what lets `@ops-runner`,
    // `@ops_runner` and `@opsrunner` all reach the same bot.
    const bare = token.replace(/[._-]+/g, "");
    for (const entry of forms) {
      if (entry.forms.includes(token) || entry.forms.some((form) => form.replace(/[._-]+/g, "") === bare)) {
        named.add(entry.member.name);
        break;
      }
    }
  }
  return { everyone, members: named };
}

/** True when a MEMBER's reply escalates to the human (dissection 9.9).
 *
 *  Word-bounded on the right so `@userland` is not an escalation, and bounded on the LEFT as well,
 *  which upstream is not: `@user` has to START a mention, so `mail me at ops@user.example.com` is an
 *  email address rather than a summons. Upstream got away with the looser rule because a false
 *  positive there only lit a pill in a window the user was already looking at; here it sets durable
 *  room state and raises an out-of-band escalation. */
export function mentionsUser(text: string): boolean {
  return /(?:^|[^\w@.-])@user\b/i.test(text);
}

/** Who answers this round (dissection 9.4). Scan the log back to the last USER entry, take that
 *  slice, and read every mention in it: `@everyone`/`@all`, or nobody named at all, means the whole
 *  room; otherwise only the members that were named.
 *
 *  Recomputed every round on purpose, so a member pulled in by a teammate mid-conversation joins the
 *  NEXT round rather than never. */
export function resolveResponders(log: GroupLogEntry[], members: GroupMember[]): GroupMember[] {
  let start = 0;
  for (let index = log.length - 1; index >= 0; index -= 1) {
    if (log[index]!.kind === "user") {
      start = index;
      break;
    }
  }
  const slice = log.slice(start);
  const named = new Set<string>();
  let everyone = false;
  for (const entry of slice) {
    const parsed = parseMentions(entry.text, members);
    if (parsed.everyone) everyone = true;
    for (const name of parsed.members) named.add(name);
  }
  if (everyone || named.size === 0) return [...members];
  return members.filter((member) => named.has(member.name));
}

/** Left-rotates the speaker list by the round number, so a different member leads each round
 *  (dissection 9.3). A no-op for fewer than two speakers. */
export function rotateSpeakers(members: GroupMember[], round: number): GroupMember[] {
  if (members.length < 2) return [...members];
  const offset = ((round % members.length) + members.length) % members.length;
  return [...members.slice(offset), ...members.slice(0, offset)];
}

/** A pass: empty, or the literal `(pass)` in any of the shapes a model actually emits (dissection
 *  9.5). A timeout, a null reply and a thrown error read as a pass too, but that decision belongs to
 *  the turn runner, not here. */
export function isPassText(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return /^\(?\s*pass\s*\)?\.?$/i.test(trimmed);
}

/** One transcript line as the viewing member sees it (dissection 9.5): the human is tagged
 *  `(user)`, the viewer's own lines are tagged `(you)`, and a peer's lines carry no tag at all. */
export function formatLine(entry: GroupLogEntry, viewer: GroupMember): string {
  if (entry.kind === "user") return `${entry.displayName} (user): ${entry.text}`;
  if (entry.name === viewer.name) return `${entry.displayName} (you): ${entry.text}`;
  return `${entry.displayName}: ${entry.text}`;
}

/** The per-turn prompt (dissection 9.5). The rules travel in the TURN PAYLOAD rather than in the
 *  bot's SOUL, which is what lets any existing bot join a room with no profile migration, and it is
 *  why this text is reproduced verbatim rather than reworded: a room hosted here must read to the
 *  model exactly like a room hosted by the desktop.
 *
 *  The two em dashes below are upstream's bytes, kept because this string is a wire-compatibility
 *  artifact sent to a model, not CozyLabs copy shown to a person.
 *
 *  `delta` is the entries this member has not seen, oldest first; only the last
 *  `GROUP_HISTORY_LIMIT` of them are quoted. */
export function buildTurnPrompt(
  group: string,
  members: GroupMember[],
  viewer: GroupMember,
  delta: GroupLogEntry[],
): string {
  const peers = members.filter((member) => member.name !== viewer.name);
  const peerList =
    peers.length === 0
      ? "no one else yet"
      : peers.map((peer) => `${peer.displayName} (@${peer.handle})`).join(", ");
  const lines = delta
    .slice(-GROUP_HISTORY_LIMIT)
    .map((entry) => `  ${formatLine(entry, viewer)}`)
    .join("\n");
  return [
    `[Group chat: "${group}"] You are @${viewer.handle}, one participant in a group chat with ${peerList} and the user.`,
    "",
    "New messages in the room since your last turn (oldest first):",
    lines,
    "",
    "Rules for this room:",
    "- Reply with ONE short conversational message (1-3 sentences) ONLY if you have something new worth adding: build on what was just said, claim or hand off work, answer a question aimed at you, or report a real result.",
    '- If you have nothing new to add, reply with exactly "(pass)". Passing is good — it lets the conversation settle.',
    "- Mention a teammate as @name to pull them in; mention @user only for a judgment call or a result the user needs. Do not repeat points already made.",
    "- Never reveal content from your private 1:1 chats. Your reply text goes to the room verbatim — no preamble, no meta-commentary.",
  ].join("\n");
}

/** The session title a member's room session carries. Byte-compatible with the desktop
 *  (dissection 9.6): the title doubles as a lookup key, since `session.resume` accepts a TITLE in
 *  the `session_id` slot, which is how a room whose stored session id was lost rehydrates. */
export function groupSessionTitle(group: string): string {
  return `Group: ${group}`;
}

/** The entries a member has not seen: everything past its watermark, oldest first.
 *
 *  ONE deliberate implementation difference from the desktop, with identical semantics. The desktop
 *  keeps a watermark as an INDEX into its in-memory log array, which is why trimming the log has to
 *  shift every watermark down by the number of entries dropped (dissection 9.1); miss that and every
 *  member silently re-reads the whole room. This gateway keeps the watermark as a SEQ instead, so
 *  trimming the head cannot invalidate it and there is nothing to shift. The delta a member is shown
 *  is the same either way. */
export function deltaSince(log: GroupLogEntry[], watermark: number): GroupLogEntry[] {
  return log.filter((entry) => entry.seq > watermark);
}

/** The highest seq in a log, or the caller's floor when the log is empty. What a member's watermark
 *  is set to once it has been shown everything. */
export function highestSeq(log: GroupLogEntry[], floor = 0): number {
  return log.reduce((max, entry) => (entry.seq > max ? entry.seq : max), floor);
}

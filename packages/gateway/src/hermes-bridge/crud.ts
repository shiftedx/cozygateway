/** The on-disk Hermes profile id rule. It protects routine tags, which encode the profile name in
 * a compact string, from ambiguous delimiters. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_PROFILE_NAMES = new Set([
  "hermes",
  "default",
  "test",
  "tmp",
  "root",
  "sudo",
]);

/** An unusable profile identity supplied in a route or group membership. */
export class BotNameInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotNameInvalid";
  }
}

/** The configured Hermes profile named is not there. */
export class BotNotFound extends Error {
  readonly botName: string;

  constructor(botName: string) {
    super(`no bot named "${botName}" exists`);
    this.name = "BotNotFound";
    this.botName = botName;
  }
}

/** The bot has a live native turn, so a delete would kill work in flight. `?force=1` proceeds. */
export class BotTurnActive extends Error {
  readonly botName: string;
  readonly turnId: string;

  constructor(botName: string, turnId: string) {
    super(`bot "${botName}" has a running turn (${turnId}); retry with force=1 to delete it anyway`);
    this.name = "BotTurnActive";
    this.botName = botName;
    this.turnId = turnId;
  }
}

export class BotNameTaken extends Error {
  readonly botName: string;

  constructor(botName: string) {
    super(`a bot named "${botName}" already exists`);
    this.name = "BotNameTaken";
    this.botName = botName;
  }
}

/** Hermes profiles are lowercase on disk, so every route and group uses one canonical identity. */
export function normalizeProfileName(raw: string): string {
  const stripped = raw.trim();
  if (stripped.length === 0) throw new BotNameInvalid("a bot name is required");
  return stripped.toLowerCase();
}

export function validateNewBotName(raw: string): string {
  const name = normalizeProfileName(raw);
  if (!PROFILE_ID_RE.test(name))
    throw new BotNameInvalid(
      `invalid bot name "${name}": it must match [a-z0-9][a-z0-9_-]{0,63} (lowercase letters, digits, - and _)`,
    );
  if (RESERVED_PROFILE_NAMES.has(name))
    throw new BotNameInvalid(`"${name}" is reserved and cannot be used as a bot name`);
  return name;
}

/** The on-disk Hermes profile id rule. It protects routine tags, which encode the profile name in
 * a compact string, from ambiguous delimiters. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

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

/** Hermes profiles are lowercase on disk, so every route and group uses one canonical identity. */
export function normalizeProfileName(raw: string): string {
  const stripped = raw.trim();
  if (stripped.length === 0) throw new BotNameInvalid("a bot name is required");
  return stripped.toLowerCase();
}

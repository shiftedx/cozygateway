/** The thread's backend adapter cannot accept a send right now. REST maps this to
 *  503 backend_unavailable; the message is NOT persisted (the client keeps it queued). */
export class BackendUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailable";
  }
}

/** A Dashboard-backed feature was asked of a bot served by a non-Hermes runtime. The bot exists
 *  and its chat lane works; this particular surface has no backend for it. REST maps this to
 *  409 unsupported_for_runtime, never a 404: the bot is real. */
export class UnsupportedForRuntime extends Error {
  readonly bot: string;
  readonly feature: string;
  readonly runtime: string;
  constructor(bot: string, feature: string, runtime: string) {
    super(`${feature} is not supported for bot "${bot}" (runtime ${runtime})`);
    this.name = "UnsupportedForRuntime";
    this.bot = bot;
    this.feature = feature;
    this.runtime = runtime;
  }
}

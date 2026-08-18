import type { BotSummary, ServerFrame } from "cozygateway-contract";

import type { Storage } from "../storage.ts";
import { HermesUnavailable, type HermesClient, type HermesState } from "./client.ts";
import {
  resolveCanonicalChat,
  listBotSessions,
  type CanonicalChatResult,
  type PinStore,
  type SessionRow,
} from "./canonical-chat.ts";
import { buildRoster, parseProfilesList } from "./roster.ts";

/** The bots bridge: everything between the Hermes JSON-RPC client and the `/bots` REST routes.
 *  It owns the cache, the refresh cadence, the focus state the app declares, and the `/ws`
 *  broadcasts. Nothing above this module knows a Hermes method name.
 *
 *  Cadence follows the desktop's own polling rates, but only while a device says it is looking at
 *  something: roster every 5 s while the roster screen is focused, routines every 20 s while the
 *  routines screen is (routine data itself arrives in a later wave; the cadence hook is here so
 *  the focus contract is complete). With nothing focused the bridge is idle and costs the Hermes
 *  gateway nothing. Where Hermes offers a broadcast instead (`sessions.changed`, `cron.changed`)
 *  the bridge refreshes on the event, debounced, which beats any poll. */

/** Desktop-parity poll cadences, in milliseconds (dissection 1.3). */
export const ROSTER_POLL_MS = 5_000;
export const ROUTINES_POLL_MS = 20_000;

/** A focus declaration goes stale on its own so a device that vanishes without saying goodbye
 *  cannot pin the bridge into polling forever. */
export const FOCUS_TTL_MS = 60_000;

/** Change broadcasts are coalesced: a burst of `sessions.changed` during one turn should cost one
 *  refresh, not one per event. */
const CHANGE_DEBOUNCE_MS = 250;

export type BotFocusScreen = "roster" | "routines";

export interface BotRosterView {
  bots: BotSummary[];
  /** Milliseconds; null when no refresh has ever landed (cold cache). */
  updatedAt: number | null;
  /** True when the cache is being served without a live Hermes link behind it. */
  stale: boolean;
  hermesState: HermesState;
}

/** What the REST layer is allowed to ask of the bridge. Keeping it an interface lets the routes
 *  be tested against a stub with no sockets. */
export interface BotsSurface {
  roster(): BotRosterView;
  /** Fire-and-forget background refresh. Never throws, never awaited by a request handler. */
  refreshSoon(reason: string): void;
  canonicalChat(name: string): Promise<CanonicalChatResult>;
  sessions(name: string, limit: number): Promise<SessionRow[]>;
  setFocus(deviceId: string, screen: BotFocusScreen | null): void;
}

export interface HermesBridgeOptions {
  client: HermesClient;
  storage: Storage;
  broadcast: (frame: ServerFrame) => void;
  now: () => number;
  /** New canonical chats are born hidden (desktop default). */
  hideBotChats?: boolean;
  rosterPollMs?: number;
  routinesPollMs?: number;
  focusTtlMs?: number;
  logSink?: (line: string) => void;
}

export class HermesBridge implements BotsSurface {
  readonly #client: HermesClient;
  readonly #storage: Storage;
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #now: () => number;
  readonly #hideBotChats: boolean;
  readonly #rosterPollMs: number;
  readonly #routinesPollMs: number;
  readonly #focusTtlMs: number;
  readonly #log: (message: string) => void;

  readonly #focus = new Map<string, { screen: BotFocusScreen; at: number }>();
  readonly #chatInflight = new Map<string, Promise<CanonicalChatResult>>();
  readonly #pins: PinStore;

  /** The profile the Hermes gateway is routed to, and whether it is mid-turn. Both feed the
   *  presence rule (dissection 7.1). The bridge only knows the routed profile when it is the one
   *  driving a turn, which in wave 1 is the canonical-chat kickoff. */
  #routedProfile: string | null = null;
  #busyDepth = 0;

  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #debounceTimer: ReturnType<typeof setTimeout> | undefined;
  #refreshing: Promise<void> | undefined;
  /** Set when a refresh was asked for while one was already running; drives the trailing run. */
  #refreshDirty = false;
  #closed = false;
  #lastRosterJson = "";
  #lastActiveJson = "";

  constructor(opts: HermesBridgeOptions) {
    this.#client = opts.client;
    this.#storage = opts.storage;
    this.#broadcast = opts.broadcast;
    this.#now = opts.now;
    this.#hideBotChats = opts.hideBotChats ?? true;
    this.#rosterPollMs = opts.rosterPollMs ?? ROSTER_POLL_MS;
    this.#routinesPollMs = opts.routinesPollMs ?? ROUTINES_POLL_MS;
    this.#focusTtlMs = opts.focusTtlMs ?? FOCUS_TTL_MS;
    const sink = opts.logSink ?? ((line: string) => void process.stderr.write(line));
    this.#log = (message: string) => sink(`[hermes-bridge] ${message}\n`);
    this.#pins = {
      get: (name) => this.#storage.botChatPin(name),
      set: (name, sessionId) => this.#storage.setBotChatPin(name, sessionId, this.#now()),
      clear: (name) => this.#storage.clearBotChatPin(name),
    };
  }

  /** Wires the client's events and starts it. The first roster refresh runs as soon as the link
   *  reaches online, regardless of focus, so a cold cache fills without waiting for a device. */
  start(): void {
    this.#client.onStateChange((state) => {
      if (state === "online") this.refreshSoon("hermes online");
    });
    this.#client.onEvent((event) => {
      // Optional broadcasts. A gateway that never sends them is fully supported: the poll path
      // covers the same ground, just slower.
      if (event.type === "sessions.changed" || event.type === "cron.changed") {
        this.refreshSoon(event.type);
      }
    });
    this.#client.start();
    this.#schedulePoll();
  }

  roster(): BotRosterView {
    const cached = this.#storage.botRoster();
    const hermesState = this.#client.state();
    return {
      bots: cached.bots,
      updatedAt: cached.updatedAt,
      stale: hermesState !== "online",
      hermesState,
    };
  }

  refreshSoon(reason: string): void {
    if (this.#closed) return;
    if (this.#debounceTimer !== undefined) return;
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = undefined;
      void this.refresh(reason);
    }, CHANGE_DEBOUNCE_MS);
    this.#debounceTimer.unref();
  }

  /** Single-flight roster refresh, with a trailing run. A change that lands while a refresh is
   *  already on the wire describes state that refresh cannot have seen, so it sets a dirty flag
   *  and the in-flight run re-runs exactly once when it finishes. Without it a burst of
   *  `sessions.changed` under a slow `profiles.list` leaves the cache stale until the next poll,
   *  and with nothing focused there is no next poll.
   *
   *  Failures are logged and swallowed: the cache keeps serving, which is exactly the desktop's
   *  "showing the last good list" behavior. */
  async refresh(reason: string): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing !== undefined) {
      this.#refreshDirty = true;
      return this.#refreshing;
    }
    const run = (async () => {
      try {
        const result = await this.#client.request("profiles.list", {});
        const { profiles } = parseProfilesList(result);
        const bots = buildRoster(profiles, {
          pins: this.#storage.botChatPins(),
          routedProfile: this.#routedProfile,
          gatewayState: this.#gatewayState(),
          now: this.#now(),
        });
        const updatedAt = this.#now();
        this.#storage.replaceBotRoster(
          bots.map((summary) => ({ name: summary.name, summary })),
          updatedAt,
        );
        this.#publish(bots, updatedAt);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "unknown failure";
        this.#log(`roster refresh failed (${reason}): ${detail}`);
      } finally {
        this.#refreshing = undefined;
        if (this.#refreshDirty && !this.#closed) {
          this.#refreshDirty = false;
          void this.refresh(`${reason} (trailing)`);
        }
      }
    })();
    this.#refreshing = run;
    return run;
  }

  /** Broadcasts only on change: an idle gateway with a steady roster is silent on the wire. */
  #publish(bots: BotSummary[], updatedAt: number): void {
    const rosterJson = JSON.stringify(bots);
    if (rosterJson !== this.#lastRosterJson) {
      this.#lastRosterJson = rosterJson;
      this.#broadcast({ type: "bot_roster", bots, updatedAt });
    }
    const active = bots.filter((bot) => bot.active).map((bot) => bot.name);
    const activeJson = JSON.stringify(active);
    if (activeJson !== this.#lastActiveJson) {
      this.#lastActiveJson = activeJson;
      this.#broadcast({ type: "bot_presence", active, updatedAt });
    }
  }

  async canonicalChat(name: string): Promise<CanonicalChatResult> {
    const inflight = this.#chatInflight.get(name);
    // De-duplicated by bot name: two taps (or two devices) must not mint two canonical chats.
    if (inflight !== undefined) return inflight;

    const serverPin = this.#serverPinOf(name);
    const run = (async () => {
      this.#routedProfile = name;
      this.#busyDepth += 1;
      try {
        return await resolveCanonicalChat(name, {
          rpc: this.#client,
          pins: this.#pins,
          hideBotChats: this.#hideBotChats,
          serverPin,
        });
      } finally {
        this.#busyDepth = Math.max(0, this.#busyDepth - 1);
        // Nothing is routed once the last turn drains, so the busy leg of the presence rule stops
        // being attributed to whichever bot happened to resolve last.
        if (this.#busyDepth === 0) this.#routedProfile = null;
        this.#chatInflight.delete(name);
        this.refreshSoon("canonical chat resolved");
      }
    })();
    this.#chatInflight.set(name, run);
    return run;
  }

  async sessions(name: string, limit: number): Promise<SessionRow[]> {
    return listBotSessions(this.#client, name, limit);
  }

  setFocus(deviceId: string, screen: BotFocusScreen | null): void {
    if (screen === null) this.#focus.delete(deviceId);
    else this.#focus.set(deviceId, { screen, at: this.#now() });
    this.#schedulePoll();
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#pollTimer !== undefined) clearTimeout(this.#pollTimer);
    this.#pollTimer = undefined;
    if (this.#debounceTimer !== undefined) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = undefined;
    await this.#client.close();
  }

  /** The cached `ui_meta` pin for a bot. Three-valued, and it must agree key-for-key with what
   *  `buildRoster` reports, or `GET /bots` and `GET /bots/:name/chat` answer differently for the
   *  same bot: `undefined` only when the server carries no bot blob at all (or the bot is not in
   *  the cache yet), the pin when the blob names one, and `null` otherwise, because a blob without
   *  a `chat` key is an authoritative clear (dissection 3.2). */
  #serverPinOf(name: string): string | null | undefined {
    const cached = this.#storage.botRoster().bots.find((bot) => bot.name === name);
    if (cached === undefined) return undefined;
    const meta = cached.meta;
    if (meta === null) return undefined;
    return typeof meta["chat"] === "string" ? meta["chat"] : null;
  }

  #gatewayState(): "idle" | "connecting" | "open" | "busy" {
    if (this.#busyDepth > 0) return "busy";
    const state = this.#client.state();
    if (state === "online") return "open";
    return state === "connecting" ? "connecting" : "idle";
  }

  /** The poll interval implied by what devices say they are looking at, or undefined for idle. */
  #pollIntervalMs(): number | undefined {
    const cutoff = this.#now() - this.#focusTtlMs;
    let roster = false;
    let routines = false;
    for (const [deviceId, entry] of this.#focus) {
      if (entry.at < cutoff) {
        this.#focus.delete(deviceId);
        continue;
      }
      if (entry.screen === "roster") roster = true;
      if (entry.screen === "routines") routines = true;
    }
    if (roster) return this.#rosterPollMs;
    if (routines) return this.#routinesPollMs;
    return undefined;
  }

  #schedulePoll(): void {
    if (this.#pollTimer !== undefined) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#closed) return;
    const interval = this.#pollIntervalMs();
    if (interval === undefined) return;
    this.#pollTimer = setTimeout(() => {
      this.#pollTimer = undefined;
      void this.refresh("poll").finally(() => this.#schedulePoll());
    }, interval);
    this.#pollTimer.unref();
  }
}

/** True when a failure means "Hermes is not reachable right now" rather than "Hermes said no". */
export function isHermesUnavailable(err: unknown): boolean {
  return err instanceof HermesUnavailable;
}

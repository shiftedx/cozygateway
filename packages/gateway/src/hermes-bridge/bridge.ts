import type { BotChatMessage, BotSummary, ServerFrame } from "cozygateway-contract";

import type { Storage } from "../storage.ts";
import { HermesUnavailable, type HermesClient, type HermesState } from "./client.ts";
import {
  resolveCanonicalChat,
  listBotSessions,
  type CanonicalChatResult,
  type ChatAdoption,
  type PinStore,
  type SessionRow,
} from "./canonical-chat.ts";
import {
  botMetaForWriteback,
  buildRoster,
  parseProfilesList,
  readBotMeta,
  resolveChatPin,
  UI_META_KEY,
} from "./roster.ts";
import { BotChatTurns, CHAT_TURN_TIMEOUT_MS } from "./chat-turns.ts";

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
  chatHistory(name: string): Promise<BotChatHistory>;
  sendChatMessage(
    name: string,
    text: string,
    opts?: { clientId?: string },
  ): Promise<{ sessionId: string; message: BotChatMessage }>;
  setFocus(deviceId: string, screen: BotFocusScreen | null): void;
}

/** What `GET /bots/:name/chat/messages` answers with. `adoption` says how the chat was resolved,
 *  which is the same value `GET /bots/:name/chat` reports. */
export interface BotChatHistory {
  sessionId: string;
  adoption: ChatAdoption;
  messages: BotChatMessage[];
  running: boolean;
  inflight: boolean;
  updatedAt: number;
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
  /** Turn-poll cadence and cap. Defaults are the desktop's own 2 s / 180 s. */
  chatPollMs?: number;
  chatTurnTimeoutMs?: number;
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
  readonly #chat: BotChatTurns;

  /** Chats THIS bridge created whose kickoff has not been observed to land yet, by bot name. Two
   *  things hang off it: the empty-history tolerance (a session with no persisted row cannot be
   *  resumed, and Hermes answers that with an error, which is not a failure the app should see),
   *  and the RUNTIME session id, which `prompt.submit` requires and which nothing else can hand
   *  back while the chat is still lazy. Cleared the moment a resume of that session succeeds. */
  readonly #kickoffs = new Map<string, { sessionId: string; runtimeId: string; at: number }>();

  /** False once this Hermes has shown it cannot store `ui_meta` (an unknown-method rejection, or a
   *  reply carrying no `applied` object at all: dissection 3.1's `unsupported` outcome). Retrying
   *  forever costs one `profiles.configure` per chat open on every old gateway, for a write that
   *  is never going to apply. */
  #uiMetaWriteback = true;

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
    this.#chat = new BotChatTurns({
      rpc: this.#client,
      broadcast: this.#broadcast,
      now: this.#now,
      log: this.#log,
      ...(opts.chatPollMs === undefined ? {} : { pollMs: opts.chatPollMs }),
      ...(opts.chatTurnTimeoutMs === undefined ? {} : { timeoutMs: opts.chatTurnTimeoutMs }),
    });
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
        // Stamped BEFORE the call, and the same value is what the cache is stored under: it is the
        // moment this snapshot's data was asked for, so "was this local pin written after the
        // server could have seen it" has one answer, whether it is asked here or by `#serverPinOf`.
        const fetchedAt = this.#now();
        const result = await this.#client.request("profiles.list", {});
        const { profiles } = parseProfilesList(result);
        const bots = buildRoster(profiles, {
          pins: this.#storage.botChatPinEntries(),
          routedProfile: this.#routedProfile,
          gatewayState: this.#gatewayState(),
          now: fetchedAt,
        });
        this.#storage.replaceBotRoster(
          bots.map((summary) => ({ name: summary.name, summary })),
          fetchedAt,
        );
        this.#publish(bots, fetchedAt);
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
        const result = await resolveCanonicalChat(name, {
          rpc: this.#client,
          pins: this.#pins,
          hideBotChats: this.#hideBotChats,
          serverPin,
          saveServerPin: (sessionId) => this.#saveServerPin(name, sessionId, serverPin),
        });
        // A chat this call created is lazy until its kickoff lands: remember the runtime id and
        // the moment, because for the next few seconds it cannot be resumed at all.
        if (result.adoption === "created" && result.runtimeId !== undefined) {
          this.#kickoffs.set(name, { sessionId: result.sessionId, runtimeId: result.runtimeId, at: this.#now() });
        }
        return result;
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

  /** History of a bot's canonical chat. Resolving the chat first is what makes this route usable
   *  as the app's only entry point: the app never has to know a session id.
   *
   *  A chat that was just created has no resumable row until its kickoff lands (dissection 5.1),
   *  and Hermes answers that with an error. That case reads as an empty history rather than a
   *  failure, since the messages arrive over `bot_chat` frames moments later. Any other failure
   *  propagates so the route can pass the Hermes text through verbatim.
   *
   *  The tolerance keys on the KICKOFF WINDOW, not on `adoption`. Adoption only says `created` on
   *  the call that did the creating; the second open inside that same window (open bot, resolve,
   *  read history: the exact sequence the app performs) correctly answers `pin`, and gating on
   *  `created` made that second read a 502 for the one scenario this whole path exists for. */
  async chatHistory(name: string): Promise<BotChatHistory> {
    const chat = await this.canonicalChat(name);
    try {
      const snapshot = await this.#chat.history(name, chat.sessionId);
      // The session resumed, so it is no longer lazy.
      if (this.#kickoffs.get(name)?.sessionId === chat.sessionId) this.#kickoffs.delete(name);
      return {
        sessionId: chat.sessionId,
        adoption: chat.adoption,
        messages: snapshot.messages,
        running: snapshot.running,
        inflight: snapshot.inflight,
        updatedAt: this.#now(),
      };
    } catch (err) {
      if (!this.#inKickoffWindow(name, chat.sessionId)) throw err;
      return {
        sessionId: chat.sessionId,
        adoption: chat.adoption,
        messages: [],
        running: false,
        inflight: false,
        updatedAt: this.#now(),
      };
    }
  }

  /** Submits into the canonical chat and leaves a turn poll running behind it. The reply is
   *  delivered over `/ws`, never in this response.
   *
   *  The runtime id of a chat still inside its kickoff window is handed down: that session cannot
   *  be resumed yet, and `prompt.submit` accepts nothing else. */
  async sendChatMessage(
    name: string,
    text: string,
    opts: { clientId?: string } = {},
  ): Promise<{ sessionId: string; message: BotChatMessage }> {
    const chat = await this.canonicalChat(name);
    const kickoff = this.#kickoffs.get(name);
    const runtimeId =
      chat.runtimeId ?? (kickoff !== undefined && kickoff.sessionId === chat.sessionId ? kickoff.runtimeId : undefined);
    const message = await this.#chat.send(name, chat.sessionId, text, {
      ...(runtimeId === undefined ? {} : { runtimeId }),
      ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
    });
    return { sessionId: chat.sessionId, message };
  }

  /** True while a chat this bridge created is still lazy: the kickoff has not been seen to land,
   *  so `session.resume` on it legitimately fails. The window is the turn cap, after which a
   *  session that still cannot be resumed is a real failure and is reported as one. */
  #inKickoffWindow(name: string, sessionId: string): boolean {
    const kickoff = this.#kickoffs.get(name);
    if (kickoff === undefined || kickoff.sessionId !== sessionId) return false;
    if (this.#now() - kickoff.at > CHAT_TURN_TIMEOUT_MS) {
      this.#kickoffs.delete(name);
      return false;
    }
    return true;
  }

  /** Test seam: true while a turn poll is live for this bot. */
  chatPolling(name: string): boolean {
    return this.#chat.polling(name);
  }

  /** Test seam: resolves when the bot's live turn poll finishes. */
  async chatSettled(name: string): Promise<void> {
    await this.#chat.settled(name);
  }

  setFocus(deviceId: string, screen: BotFocusScreen | null): void {
    if (screen === null) this.#focus.delete(deviceId);
    else this.#focus.set(deviceId, { screen, at: this.#now() });
    this.#schedulePoll();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#chat.close();
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
    const roster = this.#storage.botRoster();
    const cached = roster.bots.find((bot) => bot.name === name);
    if (cached === undefined) return undefined;
    // Exactly the rule `buildRoster` applied to this same snapshot, so `GET /bots` and this route
    // cannot answer differently for the same bot.
    return resolveChatPin(cached.meta, this.#storage.botChatPinEntry(name), roster.updatedAt);
  }

  /** Writes the canonical-chat pin into the bot's `ui_meta`, the desktop's `saveBotMeta`
   *  (dissection 3.1). Nothing here is ever allowed to fail the caller: a gateway that cannot store
   *  `ui_meta` still gets a working chat, the pin just stays gateway-local.
   *
   *  `profiles.configure` REPLACES the whole blob, which makes this a read-modify-write, and the
   *  read must be FRESH. Building it from the cached roster (up to one poll interval old) silently
   *  reverted any desktop `saveBotMeta` that landed since the last refresh, and, worse, pushed a
   *  re-derived pin back into a blob the desktop had authoritatively cleared: the dissection-3.2
   *  resurrection, re-entering through the write path. So: re-read `profiles.list`, skip the write
   *  when the server already carries this pin, and honor a clear that is newer than our own pin.
   *
   *  What goes on the wire is filtered too (`botMetaForWriteback`): `image`/`pet`/`custom` are
   *  stripped and a legacy pre-namespace blob contributes only the fields the plugin owns, because
   *  `ui_meta` is capped at 64 KB and rides every `profiles.list`. */
  async #saveServerPin(
    name: string,
    sessionId: string,
    previousServerPin: string | null | undefined,
  ): Promise<void> {
    if (!this.#uiMetaWriteback) return;
    try {
      const raw = await this.#client.request("profiles.list", {});
      const row = Array.isArray((raw as Record<string, unknown> | null)?.["profiles"])
        ? ((raw as Record<string, unknown>)["profiles"] as unknown[]).find(
            (entry) =>
              typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["name"] === name,
          )
        : undefined;
      const uiMeta = typeof row === "object" && row !== null ? (row as Record<string, unknown>)["ui_meta"] : undefined;
      const fresh = readBotMeta(uiMeta).meta;

      if (fresh !== null && fresh["chat"] === sessionId) return; // The server already agrees.
      const clearedSinceResolve =
        typeof previousServerPin === "string" && fresh !== null && typeof fresh["chat"] !== "string";
      if (clearedSinceResolve) {
        // The pin was there when this resolve started and is gone now: the desktop cleared it, and
        // that clear is authoritative (dissection 3.2). Writing here would resurrect it.
        this.#log(`ui_meta pin writeback skipped for ${name}: the server cleared the pin`);
        return;
      }

      const meta = botMetaForWriteback(uiMeta, { chat: sessionId });
      if (meta === null) {
        this.#log(`ui_meta pin writeback skipped for ${name}: the blob exceeds the 64KB cap`);
        return;
      }

      const result = await this.#client.request("profiles.configure", {
        name,
        ui_meta: { [UI_META_KEY]: meta },
      });
      const applied =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>)["applied"]
          : undefined;
      if (typeof applied !== "object" || applied === null) {
        // No `applied` map at all is dissection 3.1's `unsupported`: an older gateway. Stop asking.
        this.#uiMetaWriteback = false;
        this.#log(`ui_meta pin writeback unsupported by this hermes, keeping pins gateway-local`);
        return;
      }
      if ((applied as Record<string, unknown>)["ui_meta"] !== true) {
        this.#log(`ui_meta pin writeback not applied for ${name}, keeping it gateway-local`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown";
      if (/unknown method/i.test(detail)) this.#uiMetaWriteback = false;
      this.#log(`ui_meta pin writeback failed for ${name}: ${detail}`);
    }
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

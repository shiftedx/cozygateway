import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { ServerFrame } from "cozygateway-contract";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import { UnsupportedForRuntime } from "../errors.ts";
import { HermesRpcError, type HermesClient, type HermesEvent, type HermesServerRequest } from "./client.ts";
import { BotNotFound, normalizeProfileName } from "./crud.ts";
import { UI_META_KEY } from "./roster.ts";

/** Capability 85, bot screen: the gateway half of Hermes Bot Screen (a bot's headless Linux desktop).
 *
 *  ROOT SHAPE. Hermes already owns every screen fact: `display.*` JSON-RPC on `/api/ws` and a raw-RFB
 *  WebSocket at `/api/display/ws` that authenticates on a single-use `display_ticket`. The phone never
 *  talks to Hermes, so this module is a COURIER, not an author:
 *   - RPC results pass through verbatim (snake_case), so the app decodes one shape on both kinds;
 *   - the RFB bytes are spliced, never parsed: Hermes's own `rfb_filter` is the input gate, so a
 *     second parser here would only be a second place for the lease rule to drift;
 *   - the phone gets a gateway-minted ticket bound to its device, and the Hermes ticket is minted
 *     fresh at splice time, because Hermes's expires in 30 s and a phone on cellular can be slower.
 *
 *  Hermes viewer ids are minted per Hermes CONNECTION. This gateway holds one persistent `/api/ws`
 *  per endpoint, so an id it minted stays honoured across a phone's reconnects: the phone presents
 *  its stored id and gets the same one back, which is what keeps a takeover bound to that phone. */

/** Hermes's `_DISPLAY_ERR`. A 5300 with `data.code == "viewer_mismatch"` means a human holds control. */
export const HERMES_DISPLAY_ERROR = 5300;
export const SCREEN_TICKET_TTL_MS = 30_000;
/** Close codes this module sends itself. 4401 and 4001 mirror Hermes's own bridge so a client
 *  cannot tell (and need not care) which hop refused it. */
export const SCREEN_CLOSE_BAD_TICKET = 4401;
export const SCREEN_CLOSE_DESKTOP_GONE = 4001;
export const SCREEN_PING_INTERVAL_MS = 30_000;
const SCREEN_WS_PATH_RE = /^\/bots\/([^/]+)\/screen\/ws$/;
/** Pause a source once the sink has this much queued; resume when it drains below the low mark. */
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const START_TIMEOUT_MS = 90_000;

export class ScreenRequestNotFound extends Error {}

/** One Hermes endpoint this gateway reaches. `namespace` is the federated endpoint id, absent on the
 *  plain single-endpoint gateway where a bot's public name IS its profile name. `apiWsUrl` is the
 *  `/api/ws` URL the client dials; the display socket sits beside it on the same origin. */
export interface BotScreenEndpoint {
  client: HermesClient;
  apiWsUrl: string;
  namespace?: string;
}

export interface BotScreenConfig {
  geometry?: string;
  autoStart?: boolean;
  minFreeMemoryMb?: number;
  idleStopMinutes?: number;
  browserHeaded?: boolean;
}

type Payload = Record<string, unknown>;

interface Target {
  endpoint: BotScreenEndpoint;
  profile: string;
}

interface Ticket {
  deviceId: string;
  bot: string;
  viewerId: string;
  expiresAt: number;
}

export interface BotScreenSurfaceOptions {
  endpoints: readonly BotScreenEndpoint[];
  broadcast: (frame: ServerFrame) => void;
  /** Sends to one device's sockets; false when it has none open (the frame then broadcasts). */
  sendToDevice?: (deviceId: string, frame: ServerFrame) => boolean;
  /** Resolves a device token (the `Authorization: Bearer` on the screen WebSocket upgrade) to its
   *  device id. A ticket is redeemed only by the device it was minted for; without this nothing
   *  can redeem one. */
  deviceForToken?: (token: string) => string | undefined;
  /** How often the splice pings the phone; a phone that misses one ping is cut. */
  pingIntervalMs?: number;
  now?: () => number;
  logSink?: (line: string) => void;
}

function record(value: unknown): Payload {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Payload) : {};
}

/** `ws://h:p/api/ws` -> `ws://h:p/api/display/ws`. */
export function displaySocketUrl(apiWsUrl: string): string {
  const url = new URL(apiWsUrl);
  url.pathname = "/api/display/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class BotScreenSurface {
  readonly #endpoints: readonly BotScreenEndpoint[];
  readonly #broadcast: (frame: ServerFrame) => void;
  readonly #sendToDevice: ((deviceId: string, frame: ServerFrame) => boolean) | undefined;
  readonly #deviceForToken: ((token: string) => string | undefined) | undefined;
  readonly #pingIntervalMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  /** profile_key (the profile's HERMES_HOME) -> public bot name, per endpoint client. Learned from
   *  every result that carries one: Hermes events name a screen by home path, never by profile. */
  readonly #keys = new Map<HermesClient, Map<string, string>>();
  readonly #tickets = new Map<string, Ticket>();
  /** Open `display.install.sudo` requests, by Hermes request id. */
  readonly #sudo = new Map<string, { client: HermesClient; bot: string; device: string }>();
  /** Who pressed Install, per bot: the sudo card goes to that phone. */
  readonly #installer = new Map<string, string>();
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  constructor(opts: BotScreenSurfaceOptions) {
    this.#endpoints = opts.endpoints;
    this.#broadcast = opts.broadcast;
    this.#sendToDevice = opts.sendToDevice;
    this.#deviceForToken = opts.deviceForToken;
    this.#pingIntervalMs = opts.pingIntervalMs ?? SCREEN_PING_INTERVAL_MS;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.logSink ?? ((line) => void process.stderr.write(`[bot-screen] ${line}\n`));
    this.#wss.on("error", () => {});
    const seen = new Set<HermesClient>();
    for (const endpoint of this.#endpoints) {
      if (seen.has(endpoint.client)) continue;
      seen.add(endpoint.client);
      this.#keys.set(endpoint.client, new Map());
      endpoint.client.onEvent((event) => this.#onEvent(endpoint.client, event));
      endpoint.client.onServerRequest?.((request) => this.#onServerRequest(endpoint.client, request));
    }
  }

  // MARK: Addressing

  #target(name: string): Target {
    const plain = this.#endpoints.find((endpoint) => endpoint.namespace === undefined);
    if (plain !== undefined) return { endpoint: plain, profile: name };
    const colon = name.indexOf(":");
    if (colon > 0) {
      const namespace = name.slice(0, colon);
      const endpoint = this.#endpoints.find((candidate) => candidate.namespace === namespace);
      if (endpoint !== undefined) return { endpoint, profile: name.slice(colon + 1) };
    }
    // A federated gateway whose name carries no endpoint prefix this gateway knows.
    if (this.#endpoints.length === 0) throw new UnsupportedForRuntime(name, "bot_screen", "none");
    throw new BotNotFound(name);
  }

  #publicName(endpoint: BotScreenEndpoint, profile: string): string {
    return endpoint.namespace === undefined ? profile : `${endpoint.namespace}:${profile}`;
  }

  async #call(name: string, method: string, params: Payload = {}, timeoutMs?: number): Promise<Payload> {
    const target = this.#target(name);
    const result = record(
      await target.endpoint.client.request(
        method,
        { profile: target.profile, ...params },
        timeoutMs === undefined ? {} : { timeoutMs },
      ),
    );
    this.#learn(target.endpoint.client, result["profile_key"], this.#publicName(target.endpoint, target.profile));
    return result;
  }

  #learn(client: HermesClient, key: unknown, bot: string): void {
    if (typeof key === "string" && key.length > 0) this.#keys.get(client)?.set(key, bot);
  }

  #botFor(client: HermesClient, key: unknown): string | undefined {
    return typeof key === "string" ? this.#keys.get(client)?.get(key) : undefined;
  }

  // MARK: RPC routes

  status(name: string): Promise<Payload> {
    return this.#call(name, "display.status");
  }

  thumbnail(name: string): Promise<Payload> {
    return this.#call(name, "display.thumbnail");
  }

  start(name: string): Promise<Payload> {
    return this.#call(name, "display.start", {}, START_TIMEOUT_MS);
  }

  stop(name: string, force: boolean): Promise<Payload> {
    return this.#call(name, "display.stop", force ? { force: true } : {}, START_TIMEOUT_MS);
  }

  /** The installer is recorded BEFORE the call (Hermes may ask for sudo before its reply to
   *  `display.install` is written) and forgotten if the call fails, so a refused or busy install
   *  never leaves a device named for a card it did not ask for. */
  async install(name: string, deviceId: string): Promise<Payload> {
    const previous = this.#installer.get(name);
    this.#installer.set(name, deviceId);
    try {
      return await this.#call(name, "display.install");
    } catch (err) {
      if (previous === undefined) this.#installer.delete(name);
      else this.#installer.set(name, previous);
      throw err;
    }
  }

  /** Answers one open sudo request, from the device it was sent to only. The password is written
   *  to the socket and nowhere else. */
  answerSudo(name: string, requestId: string, password: string, deviceId: string): void {
    const open = this.#sudo.get(requestId);
    if (open === undefined || open.bot !== name || open.device !== deviceId)
      throw new ScreenRequestNotFound(`no open sudo request ${requestId} for ${name}`);
    this.#sudo.delete(requestId);
    if (open.client.respond?.(requestId, { value: password }) !== true) {
      throw new ScreenRequestNotFound(`the Hermes link that asked for sudo request ${requestId} is gone`);
    }
  }

  acquire(name: string, viewerId: string, reason: string): Promise<Payload> {
    return this.#call(name, "display.lease.acquire", { viewer_id: viewerId, reason });
  }

  release(name: string, viewerId: string | undefined, force: boolean): Promise<Payload> {
    return this.#call(name, "display.lease.release", {
      ...(viewerId === undefined ? {} : { viewer_id: viewerId }),
      ...(force ? { force: true } : {}),
    });
  }

  /** Mints the gateway's own ticket. Hermes's observe runs here too, to mint (or confirm) the Hermes
   *  viewer id the phone will present to acquire/release; its ticket is discarded, because the
   *  splice asks for a fresh one when the phone actually dials. */
  async observe(name: string, deviceId: string, viewerId: string | undefined): Promise<Payload> {
    const result = await this.#call(name, "display.observe", viewerId === undefined ? {} : { viewer_id: viewerId });
    const minted = typeof result["viewer_id"] === "string" ? result["viewer_id"] : "";
    const now = this.#now();
    for (const [key, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    this.#tickets.set(ticket, { deviceId, bot: name, viewerId: minted, expiresAt: now + SCREEN_TICKET_TTL_MS });
    return { ...result, ticket, path: `/bots/${encodeURIComponent(name)}/screen/ws`, viewer_id: minted };
  }

  /** Single use: a ticket is gone the moment it is presented, valid or not for this bot. */
  consumeTicket(ticket: string, bot: string, device: string | undefined): Ticket | undefined {
    const found = this.#tickets.get(ticket);
    this.#tickets.delete(ticket);
    if (found === undefined || found.bot !== bot || found.expiresAt <= this.#now()) return undefined;
    // Bound to the device that minted it: a leaked ticket is worth nothing to anyone else.
    if (device === undefined || found.deviceId !== device) return undefined;
    return found;
  }

  // MARK: Config

  async config(name: string): Promise<BotScreenConfig> {
    const target = this.#target(name);
    const config = record(
      await target.endpoint.client.dashboardJson(`/api/config?profile=${encodeURIComponent(target.profile)}`),
    );
    const desktop = record(config["bot_desktop"]);
    const browser = record(config["browser"]);
    const out: BotScreenConfig = {};
    if (typeof desktop["geometry"] === "string") out.geometry = desktop["geometry"];
    if (typeof desktop["auto_start"] === "boolean") out.autoStart = desktop["auto_start"];
    if (typeof desktop["min_free_memory_mb"] === "number") out.minFreeMemoryMb = desktop["min_free_memory_mb"];
    if (typeof desktop["idle_stop_minutes"] === "number") out.idleStopMinutes = desktop["idle_stop_minutes"];
    if (typeof browser["headed"] === "boolean") out.browserHeaded = browser["headed"];
    return out;
  }

  /** Deep-merged server side (Hermes `PUT /api/config` merges), so only the touched leaves are sent
   *  and no other `bot_desktop` or `browser` key can be clobbered. */
  async patchConfig(name: string, patch: BotScreenConfig): Promise<BotScreenConfig> {
    const target = this.#target(name);
    const desktop: Payload = {};
    if (patch.geometry !== undefined) desktop["geometry"] = patch.geometry;
    if (patch.autoStart !== undefined) desktop["auto_start"] = patch.autoStart;
    if (patch.minFreeMemoryMb !== undefined) desktop["min_free_memory_mb"] = patch.minFreeMemoryMb;
    if (patch.idleStopMinutes !== undefined) desktop["idle_stop_minutes"] = patch.idleStopMinutes;
    const config: Payload = {};
    if (Object.keys(desktop).length > 0) config["bot_desktop"] = desktop;
    if (patch.browserHeaded !== undefined) config["browser"] = { headed: patch.browserHeaded };
    if (Object.keys(config).length > 0) {
      await target.endpoint.client.dashboardJson(`/api/config?profile=${encodeURIComponent(target.profile)}`, {
        method: "PUT",
        body: { config },
      });
    }
    return this.config(name);
  }

  // MARK: Auto-open (ui_meta['hermes-bots'].screenAutoOpen)
  //
  // Minimal on purpose: slice S1's row-80 `GET/PATCH /bots/:name/presentation` is the general
  // ui_meta writer and supersedes these two routes when the branches meet. Until then this is a
  // one-key read-modify-write with Hermes's per-key compare-and-swap, so a concurrent writer's
  // other keys (pinned, hidden, look, groups...) are never overwritten.

  async #uiMeta(target: Target): Promise<{ meta: Payload; revision: number }> {
    const listed = record(await target.endpoint.client.request("profiles.list", { include_sessions: false }));
    const rows = Array.isArray(listed["profiles"]) ? listed["profiles"] : [];
    const row = rows.map(record).find((candidate) => candidate["name"] === target.profile);
    if (row === undefined) throw new BotNotFound(this.#publicName(target.endpoint, target.profile));
    const revisions = record(row["ui_meta_revisions"]);
    const revision = typeof revisions[UI_META_KEY] === "number" ? (revisions[UI_META_KEY] as number) : 0;
    return { meta: record(record(row["ui_meta"])[UI_META_KEY]), revision };
  }

  async autoOpen(name: string): Promise<{ enabled: boolean }> {
    const { meta } = await this.#uiMeta(this.#target(name));
    return { enabled: meta["screenAutoOpen"] === true };
  }

  async setAutoOpen(name: string, enabled: boolean): Promise<{ enabled: boolean }> {
    const target = this.#target(name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { meta, revision } = await this.#uiMeta(target);
      const result = record(
        await target.endpoint.client.request("profiles.configure", {
          name: target.profile,
          ui_meta: { [UI_META_KEY]: { ...meta, screenAutoOpen: enabled } },
          ui_meta_expected_revisions: { [UI_META_KEY]: revision },
        }),
      );
      const applied = record(result["applied"] ?? result);
      const conflicts = applied["ui_meta_conflicts"] ?? result["ui_meta_conflicts"];
      const clean = conflicts === undefined || (Array.isArray(conflicts) && conflicts.length === 0);
      // Only a write Hermes says it applied is a success; a conflict retries once, anything else
      // (a refused or skipped section) is an error rather than a toggle that silently did nothing.
      if (clean && applied["ui_meta"] === true) return { enabled };
      if (clean) throw new HermesRpcError("hermes did not apply the screenAutoOpen write");
    }
    throw new HermesRpcError("ui_meta changed twice while writing screenAutoOpen; try again");
  }

  // MARK: Hermes -> phone

  #onEvent(client: HermesClient, event: HermesEvent): void {
    const payload = record(event.payload);
    switch (event.type) {
      case "display.status": {
        const bot = this.#botFor(client, payload["profile_key"]);
        if (bot !== undefined) this.#broadcast({ type: "bot_screen_status", bot, status: payload });
        return;
      }
      case "display.lease": {
        const bot = this.#botFor(client, payload["profile_key"]);
        if (bot !== undefined) this.#broadcast({ type: "bot_screen_lease", bot, lease: record(payload["lease"]) });
        return;
      }
      case "display.install.log": {
        const bot = this.#botFor(client, payload["profile_key"]);
        if (bot !== undefined && typeof payload["line"] === "string")
          this.#broadcast({ type: "bot_screen_install_log", bot, line: payload["line"] });
        return;
      }
      case "display.install.done": {
        const bot = this.#botFor(client, payload["profile_key"]);
        if (bot === undefined) return;
        this.#installer.delete(bot);
        const code = typeof payload["code"] === "number" ? Math.trunc(payload["code"]) : 1;
        const status = payload["status"];
        this.#broadcast({
          type: "bot_screen_install_done",
          bot,
          code,
          ...(typeof status === "object" && status !== null ? { status: record(status) } : {}),
        });
        return;
      }
      case "request.cancel": {
        const id = typeof payload["id"] === "string" ? payload["id"] : undefined;
        const open = id === undefined ? undefined : this.#sudo.get(id);
        if (id === undefined || open === undefined || open.client !== client) return;
        this.#sudo.delete(id);
        this.#broadcast({ type: "bot_screen_request_cancel", bot: open.bot, requestId: id });
        return;
      }
      default:
        return;
    }
  }

  #onServerRequest(client: HermesClient, request: HermesServerRequest): void {
    if (request.method !== "display.install.sudo") return;
    const bot = this.#botFor(client, request.params["profile_key"]);
    if (bot === undefined) {
      // Nobody here can answer it: say so now instead of leaving the installer waiting 300 s.
      client.respond?.(request.id, { value: "" });
      return;
    }
    // The masked card goes to the phone that pressed Install and to nobody else. With no such
    // phone reachable the request is skipped at once (Hermes reports the install cancelled)
    // rather than broadcast to every device or left waiting its 300 s.
    const device = this.#installer.get(bot);
    const frame: ServerFrame = { type: "bot_screen_install_sudo", bot, requestId: request.id };
    if (device === undefined) {
      client.respond?.(request.id, { value: "" });
      return;
    }
    this.#sudo.set(request.id, { client, bot, device });
    if (this.#sendToDevice?.(device, frame) !== true) {
      this.#sudo.delete(request.id);
      client.respond?.(request.id, { value: "" });
    }
  }

  // MARK: The RFB splice

  /** Whether `pathname` is this module's WebSocket route. */
  static matches(pathname: string): boolean {
    return SCREEN_WS_PATH_RE.test(pathname);
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const match = SCREEN_WS_PATH_RE.exec(url.pathname);
    let bot: string | undefined;
    try {
      bot = match === null ? undefined : normalizeProfileName(decodeURIComponent(match[1]!));
    } catch {
      bot = undefined;
    }
    const ticketText = url.searchParams.get("ticket") ?? "";
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const device = token === "" ? undefined : this.#deviceForToken?.(token);
    this.#wss.handleUpgrade(req, socket, head, (phone) => {
      // Accept first, refuse after: a close frame carries a code, an HTTP 403 does not, and the
      // viewer has to tell "re-observe" (4401) from "the screen is gone" (4001).
      const ticket = bot === undefined ? undefined : this.consumeTicket(ticketText, bot, device);
      if (bot === undefined || ticket === undefined) {
        phone.close(SCREEN_CLOSE_BAD_TICKET, "screen ticket missing, expired or used");
        return;
      }
      void this.#splice(phone, ticket);
    });
  }

  async #splice(phone: WebSocket, ticket: Ticket): Promise<void> {
    // The phone may speak first (it will not under RFB, but a byte must never be lost): hold its
    // frames until the Hermes leg is open.
    const early: Array<{ data: RawData; binary: boolean }> = [];
    let phoneClosed: { code: number; reason: string } | undefined;
    const holdEarly = (data: RawData, binary: boolean) => early.push({ data, binary });
    phone.on("message", holdEarly);
    phone.once("close", (code, reason) => {
      phoneClosed = { code, reason: reason.toString() };
    });
    phone.on("error", () => {});
    // An idle viewer is still a viewer, but a vanished one must not hold both legs and the Xvnc
    // connection open: one missed ping cuts it (which terminates the Hermes leg below).
    let alive = true;
    phone.on("pong", () => { alive = true; });
    const pinger = setInterval(() => {
      if (!alive) { phone.terminate(); return; }
      alive = false;
      if (phone.readyState === WebSocket.OPEN) phone.ping();
    }, this.#pingIntervalMs);
    pinger.unref();
    phone.once("close", () => clearInterval(pinger));

    let hermesUrl: string;
    try {
      const target = this.#target(ticket.bot);
      const fresh = await this.#call(ticket.bot, "display.observe", ticket.viewerId ? { viewer_id: ticket.viewerId } : {});
      const hermesTicket = typeof fresh["ticket"] === "string" ? fresh["ticket"] : "";
      if (!hermesTicket) throw new Error("hermes display.observe returned no ticket");
      hermesUrl = `${displaySocketUrl(target.endpoint.apiWsUrl)}?display_ticket=${encodeURIComponent(hermesTicket)}`;
    } catch (err) {
      this.#log(`observe for ${ticket.bot} failed: ${(err as Error).message}`);
      if (phone.readyState === WebSocket.OPEN) phone.close(SCREEN_CLOSE_DESKTOP_GONE, "Bot Desktop is not running");
      return;
    }
    if (phoneClosed !== undefined) return;

    const hermes = new WebSocket(hermesUrl, { perMessageDeflate: false });
    hermes.on("error", (err) => this.#log(`display socket for ${ticket.bot}: ${err.message}`));
    hermes.once("open", () => {
      phone.off("message", holdEarly);
      for (const { data, binary } of early.splice(0)) hermes.send(data, { binary });
      pipe(hermes, phone);
      pipe(phone, hermes);
    });
    hermes.once("close", (code, reason) => {
      if (phone.readyState !== WebSocket.OPEN && phone.readyState !== WebSocket.CONNECTING) return;
      // Every code a close frame may carry passes through unchanged; 1004-1006 and 1015 are
      // reserved and never sent, so a drop on the Hermes side is reported as a lost stream.
      if (sendableCloseCode(code)) phone.close(code, reason.toString());
      else phone.close(1011, "screen stream lost");
    });
    phone.once("close", (code) => {
      if (hermes.readyState === WebSocket.CLOSED || hermes.readyState === WebSocket.CLOSING) return;
      // Hermes hands control back only on a CLEAN viewer close (1000/1001). A dropped phone keeps
      // the human's exclusion (they may be mid-login), so the Hermes leg is cut, not closed.
      if (code === 1000 || code === 1001) {
        if (hermes.readyState === WebSocket.OPEN) hermes.close(code);
        else hermes.terminate();
      } else {
        hermes.terminate();
      }
    });
  }

  close(): void {
    for (const client of this.#wss.clients) client.terminate();
    this.#wss.close();
  }
}

/** RFC 6455 / IANA codes a close frame may carry: 1000-1003, 1007-1014 and 3000-4999. */
export function sendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/** Forward every frame from `from` to `to`, pausing `from` while `to` has too much queued. */
function pipe(from: WebSocket, to: WebSocket): void {
  from.on("message", (data, binary) => {
    if (to.readyState !== WebSocket.OPEN) return;
    to.send(data, { binary }, () => {
      if (from.isPaused && to.bufferedAmount < LOW_WATER_BYTES) from.resume();
    });
    if (to.bufferedAmount > HIGH_WATER_BYTES) from.pause();
  });
}

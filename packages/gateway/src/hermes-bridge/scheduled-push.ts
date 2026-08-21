import type { HermesEvent } from "./client.ts";
import { parseChatSnapshot } from "./chat-messages.ts";
import { listBotSessions, sessionKind, type HermesRpc, type SessionRow } from "./canonical-chat.ts";
import { parseProfilesList } from "./roster.ts";

const MESSAGE_COMPLETE = "message.complete";
const MAX_CANDIDATES = 12;
const MAX_DELIVERED = 512;
const RESOLVE_DELAYS_MS = [0, 100, 250] as const;

export interface ScheduledAssistantPush {
  bot: string;
  chatSessionId: string;
  messageId: string;
  text: string;
}

export interface ScheduledPushOptions {
  rpc: HermesRpc;
  hidden: ReadonlySet<string>;
  binding: (runtimeId: string) => unknown;
  deliver: (event: ScheduledAssistantPush) => void;
  log: (message: string) => void;
}

function completionText(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const text = (payload as Record<string, unknown>)["text"];
  return typeof text === "string" && text.trim().length > 0 ? text.trim() : undefined;
}

function newestFirst(rows: readonly SessionRow[]): SessionRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const byActivity = right.row.lastActiveAt - left.row.lastActiveAt;
      return byActivity === 0 ? left.index - right.index : byActivity;
    })
    .map(({ row }) => row);
}

/**
 * Resolves assistant completions that did not originate in CozyChat.
 *
 * Hermes event frames carry only an ephemeral runtime session id. A `session.resume` rotates that
 * id, so it cannot be used to discover which durable session produced a scheduler-owned turn.
 * Instead, this observer considers only durable cron/routine rows, prefers rows whose list preview
 * already equals the completed text, and confirms the actual settled assistant row from the
 * transcript. The scan is bounded; conversational, group, and a2a sessions never enter it.
 */
export class ScheduledPushObserver {
  readonly #rpc: HermesRpc;
  readonly #hidden: ReadonlySet<string>;
  readonly #binding: (runtimeId: string) => unknown;
  readonly #deliver: (event: ScheduledAssistantPush) => void;
  readonly #log: (message: string) => void;
  readonly #inflight = new Set<string>();
  readonly #delivered = new Set<string>();
  #closed = false;

  constructor(opts: ScheduledPushOptions) {
    this.#rpc = opts.rpc;
    this.#hidden = opts.hidden;
    this.#binding = opts.binding;
    this.#deliver = opts.deliver;
    this.#log = opts.log;
  }

  handleEvent(event: HermesEvent): void {
    if (this.#closed || event.type !== MESSAGE_COMPLETE || event.sessionId === undefined) return;
    // Gateway-owned conversational and group turns already have authoritative settlement paths.
    if (this.#binding(event.sessionId) !== undefined) return;
    const text = completionText(event.payload);
    if (text === undefined) return;
    const key = `${event.sessionId}\0${text}`;
    if (this.#inflight.has(key)) return;
    this.#inflight.add(key);
    void this.#resolve(text).finally(() => this.#inflight.delete(key));
  }

  close(): void {
    this.#closed = true;
    this.#inflight.clear();
    this.#delivered.clear();
  }

  async #resolve(text: string): Promise<void> {
    for (const delayMs of RESOLVE_DELAYS_MS) {
      if (delayMs > 0) await this.#sleep(delayMs);
      if (this.#closed) return;
      try {
        if (await this.#resolveOnce(text)) return;
      } catch (err) {
        this.#log(`scheduled chat push resolution failed: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }

  async #resolveOnce(text: string): Promise<boolean> {
    const { profiles } = parseProfilesList(await this.#rpc.request("profiles.list", {}));
    const rows = (
      await Promise.all(
        profiles
          .filter((profile) => !this.#hidden.has(profile.name))
          .map(async (profile) => {
            try {
              return { bot: profile.name, rows: await listBotSessions(this.#rpc, profile.name, 200) };
            } catch (err) {
              this.#log(
                `scheduled chat sessions unavailable for ${profile.name}: ${
                  err instanceof Error ? err.message : "unknown"
                }`,
              );
              return { bot: profile.name, rows: [] };
            }
          }),
      )
    )
      .flatMap(({ bot, rows }) =>
        newestFirst(rows)
          .filter((row) => {
            const kind = sessionKind(row);
            return kind === "cron" || kind === "routine";
          })
          .map((row) => ({ bot, row })),
      )
      .sort((left, right) => right.row.lastActiveAt - left.row.lastActiveAt);
    const candidates = [
      ...rows.filter(({ row }) => row.preview?.trim() === text),
      ...rows.filter(({ row }) => row.preview?.trim() !== text),
    ].slice(0, MAX_CANDIDATES);

    for (const { bot, row } of candidates) {
      let raw: unknown;
      try {
        raw = await this.#rpc.request("session.resume", {
          session_id: row.id,
          profile: bot,
          omit_messages: false,
        });
      } catch {
        continue;
      }
      const message = parseChatSnapshot(raw, row.id).messages
        .toReversed()
        .find((candidate) => candidate.role === "assistant" && candidate.text.trim() === text);
      if (message === undefined) continue;
      const deliveredKey = `${bot}\0${row.id}\0${message.id}`;
      if (this.#delivered.has(deliveredKey) || this.#closed) return true;
      this.#delivered.add(deliveredKey);
      while (this.#delivered.size > MAX_DELIVERED) {
        const oldest = this.#delivered.values().next();
        if (oldest.done) break;
        this.#delivered.delete(oldest.value);
      }
      this.#deliver({ bot, chatSessionId: row.id, messageId: message.id, text: message.text });
      return true;
    }
    return false;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

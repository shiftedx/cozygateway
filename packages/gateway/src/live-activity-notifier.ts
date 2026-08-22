import type { ServerFrame } from "cozygateway-contract";

import type { LiveActivityRegistrationRow, Storage } from "./storage.ts";

export const LIVE_ACTIVITY_TOOL_COALESCE_MS = 15_000;
const LIVE_ACTIVITY_TIMEOUT_MS = 10_000;

type Phase = "thinking" | "usingTools" | "writing" | "completed" | "failed";

interface Projection {
  phase: Phase;
  toolCallCount: number;
  shortStatus: string;
  elapsedSeconds?: number;
}

export interface LiveActivityNotifierDeps {
  storage: Storage;
  relayBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  toolCoalesceMs?: number;
  log?: (message: string) => void;
}

/** Projects the already-redacted bot lifecycle into coarse ActivityKit state. No prompt, draft,
 * tool name, arguments, result, or response content crosses this boundary. */
export class LiveActivityNotifier {
  readonly #storage: Storage;
  readonly #relayBaseUrl: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #toolCoalesceMs: number;
  readonly #log: (message: string) => void;
  readonly #lastProjection = new Map<string, Projection>();
  readonly #lastToolUpdate = new Map<string, number>();

  constructor(deps: LiveActivityNotifierDeps) {
    this.#storage = deps.storage;
    this.#relayBaseUrl = deps.relayBaseUrl;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? Date.now;
    this.#toolCoalesceMs = deps.toolCoalesceMs ?? LIVE_ACTIVITY_TOOL_COALESCE_MS;
    this.#log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "bot_chat_state":
        if (frame.phase === "polling") {
          this.#publish(frame.bot, { phase: "thinking", toolCallCount: 0, shortStatus: "Thinking" });
        } else if (frame.phase === "timeout" || frame.phase === "failed") {
          this.#end(frame.bot, false);
        } else if (frame.phase === "complete") {
          this.#end(frame.bot, true);
        }
        return;
      case "bot_tool_activity":
        if (frame.room !== undefined) return;
        this.#publishTools(frame.bot, frame.steps.length);
        return;
      case "bot_chat_delta":
        if (frame.room !== undefined || frame.text.length === 0) return;
        this.#publish(frame.bot, {
          phase: "writing",
          toolCallCount: this.#toolCount(frame.bot),
          shortStatus: "Writing response",
        });
        return;
      default:
        return;
    }
  }

  #publishTools(bot: string, count: number): void {
    const now = this.#now();
    for (const row of this.#storage.liveActivityRegistrations(bot)) {
      const key = this.#key(row);
      const previous = this.#lastProjection.get(key);
      const firstTools = previous?.phase !== "usingTools";
      if (!firstTools && now - (this.#lastToolUpdate.get(key) ?? 0) < this.#toolCoalesceMs) continue;
      this.#lastToolUpdate.set(key, now);
      this.#send(row, {
        phase: "usingTools",
        toolCallCount: count,
        shortStatus: count === 1 ? "Using 1 tool" : `Using ${count} tools`,
      }, false);
    }
  }

  #publish(bot: string, projection: Projection): void {
    for (const row of this.#storage.liveActivityRegistrations(bot)) {
      const previous = this.#lastProjection.get(this.#key(row));
      const merged = projection.toolCallCount === 0 && previous !== undefined
        ? { ...projection, toolCallCount: previous.toolCallCount }
        : projection;
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(merged)) continue;
      this.#send(row, merged, false);
    }
  }

  #end(bot: string, succeeded: boolean): void {
    for (const row of this.#storage.liveActivityRegistrations(bot)) {
      this.#send(row, {
        phase: succeeded ? "completed" : "failed",
        toolCallCount: this.#lastProjection.get(this.#key(row))?.toolCallCount ?? 0,
        shortStatus: succeeded ? "Finished" : "Could not finish",
        elapsedSeconds: Math.min(604_800, Math.max(0, Math.floor((this.#now() - row.createdAt) / 1000))),
      }, true);
    }
  }

  #toolCount(bot: string): number {
    const row = this.#storage.liveActivityRegistrations(bot)[0];
    return row === undefined ? 0 : (this.#lastProjection.get(this.#key(row))?.toolCallCount ?? 0);
  }

  #send(row: LiveActivityRegistrationRow, projection: Projection, terminal: boolean): void {
    if (this.#relayBaseUrl === undefined) return;
    const key = this.#key(row);
    this.#lastProjection.set(key, projection);
    const wallSeconds = Math.floor(this.#now() / 1000);
    const timestamp = Math.max(wallSeconds, row.lastTimestamp + 1);
    const eventSequence = this.#storage.advanceLiveActivity(row.deviceId, row.activityId, timestamp);
    const liveActivity = {
      timestamp,
      event: terminal ? "end" as const : "update" as const,
      contentState: { ...projection, eventSequence },
      ...(terminal ? { dismissalDate: timestamp + (projection.phase === "completed" ? 15 * 60 : 0) } : {
        staleDate: timestamp + 120,
      }),
      // No alert: the existing encrypted settled-reply notification remains the sole user alert.
      priority: 5 as const,
    };
    void this.#fetch(`${this.#relayBaseUrl.replace(/\/+$/, "")}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: row.pushId, liveActivity }),
      signal: AbortSignal.timeout(LIVE_ACTIVITY_TIMEOUT_MS),
    }).then(async (response) => {
      if (response.status === 404 || terminal) {
        this.#storage.deleteLiveActivityRegistration(row.deviceId, row.activityId);
        this.#lastProjection.delete(key);
        this.#lastToolUpdate.delete(key);
      }
      if (!response.ok && response.status !== 404) throw new Error(`relay returned HTTP ${response.status}`);
      if (terminal) {
        await this.#fetch(
          `${this.#relayBaseUrl!.replace(/\/+$/, "")}/register/${encodeURIComponent(row.pushId)}`,
          { method: "DELETE", signal: AbortSignal.timeout(LIVE_ACTIVITY_TIMEOUT_MS) },
        ).catch(() => undefined);
      }
    }).catch((error: unknown) => {
      this.#log(`live activity ${row.activityId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  #key(row: LiveActivityRegistrationRow): string {
    return `${row.deviceId}\0${row.activityId}`;
  }
}

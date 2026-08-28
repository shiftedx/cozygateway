import type { ServerFrame } from "cozygateway-contract";

import type { LiveActivityRegistrationRow, Storage } from "./storage.ts";
import type { ChatMessagePushEvent } from "./push-notifier.ts";
import { emitTrace, traceId, type TraceLog } from "./trace.ts";

export const LIVE_ACTIVITY_TOOL_COALESCE_MS = 15_000;
const LIVE_ACTIVITY_TIMEOUT_MS = 10_000;
const COMPLETION_COVERAGE_MS = 60_000;

type Phase =
  | "thinking"
  | "usingTools"
  | "writing"
  | "waitingOnApproval"
  | "completed"
  | "failed";

interface Projection {
  phase: Phase;
  toolCallCount: number;
  shortStatus: string;
  elapsedSeconds?: number;
  /** The pending approval this card is blocked on, so the Live Activity can offer Approve and Deny
   * against `POST /bots/:name/approvals/:toolCallId/{approve,deny}`. An opaque id, never a tool
   * name or its arguments. */
  approvalID?: string;
}

export interface LiveActivityNotifierDeps {
  storage: Storage;
  relayBaseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  toolCoalesceMs?: number;
  log?: (message: string) => void;
  trace?: TraceLog;
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
  readonly #trace: TraceLog | undefined;
  readonly #lastProjection = new Map<string, Projection>();
  readonly #lastToolUpdate = new Map<string, number>();
  readonly #claimedActivities = new Set<string>();
  readonly #terminalCoverage = new Map<string, ReadonlySet<string>>();
  readonly #settledCompletions = new Set<string>();
  /** Per activity, the projection to restore once the run stops being blocked. */
  readonly #preApproval = new Map<string, Projection>();
  /** Per bot conversation, the approvals still awaiting a decision, oldest first. A turn can
   * raise several at once, so resolving one must not clear the card while the others still block
   * the run. */
  readonly #pendingApprovals = new Map<string, string[]>();

  constructor(deps: LiveActivityNotifierDeps) {
    this.#storage = deps.storage;
    this.#relayBaseUrl = deps.relayBaseUrl;
    this.#fetch = deps.fetchImpl ?? fetch;
    this.#now = deps.now ?? Date.now;
    this.#toolCoalesceMs = deps.toolCoalesceMs ?? LIVE_ACTIVITY_TOOL_COALESCE_MS;
    this.#log = deps.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.#trace = deps.trace;
  }

  handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "bot_chat_state":
        if (frame.phase === "polling") {
          this.#settledCompletions.delete(this.#completionKey(frame.bot, frame.sessionId));
          this.#publish(frame.bot, frame.sessionId, {
            phase: "thinking", toolCallCount: 0, shortStatus: "Thinking",
          });
        } else if (frame.phase === "timeout" || frame.phase === "failed") {
          this.#end(frame.bot, frame.sessionId, false);
        } else if (frame.phase === "complete") {
          this.#end(frame.bot, frame.sessionId, true);
        }
        return;
      case "bot_tool_activity":
        if (frame.room !== undefined) return;
        this.#publishTools(frame.bot, frame.sessionId, frame.steps.length);
        return;
      case "bot_approval_pending": {
        if (frame.room !== undefined) return;
        const conversationKey = this.#completionKey(frame.bot, frame.sessionId);
        const pending = this.#pendingApprovals.get(conversationKey) ?? [];
        if (!pending.includes(frame.toolCallId)) pending.push(frame.toolCallId);
        this.#pendingApprovals.set(conversationKey, pending);
        this.#publishApproval(frame.bot, frame.sessionId, pending[0] ?? frame.toolCallId);
        return;
      }
      case "bot_approval_resolved": {
        if (frame.room !== undefined) return;
        const conversationKey = this.#completionKey(frame.bot, frame.sessionId);
        const rest = (this.#pendingApprovals.get(conversationKey) ?? [])
          .filter((id) => id !== frame.toolCallId);
        const next = rest[0];
        if (next === undefined) {
          this.#pendingApprovals.delete(conversationKey);
          this.#resumeFromApproval(frame.bot, frame.sessionId);
        } else {
          this.#pendingApprovals.set(conversationKey, rest);
          this.#publishApproval(frame.bot, frame.sessionId, next);
        }
        return;
      }
      case "bot_chat_delta":
        if (frame.room !== undefined || frame.text.length === 0) return;
        this.#publish(frame.bot, frame.sessionId, {
          phase: "writing",
          toolCallCount: this.#toolCount(frame.bot, frame.sessionId),
          shortStatus: "Writing response",
        });
        return;
      default:
        return;
    }
  }

  /** Returns devices whose reply-ready alert is owned by ActivityKit for this settled message.
   *
   * The bridge can report the settled assistant message either immediately before or immediately
   * after its terminal state frame. Active rows cover the first ordering; terminal coverage covers
   * the second. Consuming the latter makes this a one-reply decision rather than a blanket mute for
   * later scheduled messages in the same bot chat. */
  coveredDeviceIdsForChat(event: Pick<ChatMessagePushEvent, "bot" | "chatSessionId">): ReadonlySet<string> {
    const completionKey = this.#completionKey(event.bot, event.chatSessionId);
    const terminal = this.#terminalCoverage.get(completionKey);
    if (terminal !== undefined) {
      this.#terminalCoverage.delete(completionKey);
      return terminal;
    }
    if (this.#settledCompletions.has(completionKey)) return new Set();

    const rows = this.#conversationRows(event.bot, event.chatSessionId);
    for (const row of rows) this.#claimedActivities.add(this.#key(row));
    return new Set(rows.map((row) => row.deviceId));
  }

  #publishTools(bot: string, sessionId: string, count: number): void {
    const now = this.#now();
    for (const row of this.#conversationRows(bot, sessionId)) {
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

  /** A run blocked on an approval is stopped, not working, and the card said "Thinking" before
   * this. Carrying the approval id is what lets the Live Activity answer it in place. */
  #publishApproval(bot: string, sessionId: string, approvalID: string): void {
    for (const row of this.#conversationRows(bot, sessionId)) {
      const key = this.#key(row);
      const previous = this.#lastProjection.get(key);
      if (previous !== undefined && previous.phase !== "waitingOnApproval") {
        this.#preApproval.set(key, previous);
      }
    }
    // `toolCallCount: 0` so #publish carries the count the run already reported forward.
    this.#publish(bot, sessionId, {
      phase: "waitingOnApproval",
      toolCallCount: 0,
      shortStatus: "Waiting on your approval",
      approvalID,
    });
  }

  /** Every resolution path lands here through `bot_approval_resolved`, expiry included, so the card
   * leaves the blocked state even when nobody answered on this device. */
  #resumeFromApproval(bot: string, sessionId: string): void {
    for (const row of this.#conversationRows(bot, sessionId)) {
      const key = this.#key(row);
      if (this.#lastProjection.get(key)?.phase !== "waitingOnApproval") continue;
      const resumed = this.#preApproval.get(key);
      this.#preApproval.delete(key);
      this.#send(row, resumed ?? { phase: "thinking", toolCallCount: 0, shortStatus: "Thinking" }, false);
    }
  }

  #publish(bot: string, sessionId: string, projection: Projection): void {
    for (const row of this.#conversationRows(bot, sessionId)) {
      const previous = this.#lastProjection.get(this.#key(row));
      const merged = projection.toolCallCount === 0 && previous !== undefined
        ? { ...projection, toolCallCount: previous.toolCallCount }
        : projection;
      if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(merged)) continue;
      this.#send(row, merged, false);
    }
  }

  #end(bot: string, sessionId: string, succeeded: boolean): void {
    this.#settledCompletions.add(this.#completionKey(bot, sessionId));
    this.#pendingApprovals.delete(this.#completionKey(bot, sessionId));
    const rows = this.#conversationRows(bot, sessionId);
    const uncoveredDevices = new Set<string>();
    for (const row of rows) {
      const key = this.#key(row);
      this.#preApproval.delete(key);
      if (!this.#claimedActivities.delete(key)) uncoveredDevices.add(row.deviceId);
      this.#send(row, {
        phase: succeeded ? "completed" : "failed",
        toolCallCount: this.#lastProjection.get(key)?.toolCallCount ?? 0,
        shortStatus: succeeded ? "Finished" : "Could not finish",
        elapsedSeconds: Math.min(604_800, Math.max(0, Math.floor((this.#now() - row.createdAt) / 1000))),
      }, true);
    }
    if (uncoveredDevices.size > 0) {
      const completionKey = this.#completionKey(bot, sessionId);
      this.#terminalCoverage.set(completionKey, uncoveredDevices);
      const timer = setTimeout(() => {
        if (this.#terminalCoverage.get(completionKey) === uncoveredDevices) {
          this.#terminalCoverage.delete(completionKey);
        }
      }, COMPLETION_COVERAGE_MS);
      timer.unref();
    }
  }

  #toolCount(bot: string, sessionId: string): number {
    const row = this.#conversationRows(bot, sessionId)[0];
    return row === undefined ? 0 : (this.#lastProjection.get(this.#key(row))?.toolCallCount ?? 0);
  }

  #conversationRows(bot: string, sessionId: string): LiveActivityRegistrationRow[] {
    return this.#storage.liveActivityRegistrations(bot)
      .filter((row) => row.conversationId === sessionId);
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
      // The activity belongs to the conversation, not this individual response. Completion is an
      // alerting update so the next response can reuse the same Lock Screen / Dynamic Island card.
      event: "update" as const,
      contentState: { ...projection, eventSequence },
      // A blocked run waits on a person, so the 2 minute working-card window would grey the card
      // out with the buttons still on screen. Approvals expire well inside this window.
      staleDate: timestamp
        + (terminal ? 8 * 60 * 60 : projection.phase === "waitingOnApproval" ? 30 * 60 : 120),
      ...(terminal ? {
        alert: {
          title: "CozyChat",
          body: projection.phase === "completed" ? "Your bot’s reply is ready" : "Your bot could not finish",
          sound: "default" as const,
        },
      } : {}),
      priority: terminal ? 10 as const : 5 as const,
    };
    void this.#fetch(`${this.#relayBaseUrl.replace(/\/+$/, "")}/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pushId: row.pushId, liveActivity }),
      signal: AbortSignal.timeout(LIVE_ACTIVITY_TIMEOUT_MS),
    }).then(async (response) => {
      emitTrace(this.#trace, "relay_result", {
        channel: "live_activity",
        device: traceId(row.deviceId),
        result: response.ok ? "ok" : response.status === 404 ? "not_found" : "http_error",
      });
      if (response.status === 404) {
        const deleted = this.#storage.deleteLiveActivityRegistration(
          row.deviceId,
          row.activityId,
          { expectedPushId: row.pushId, queuedAt: this.#now() },
        );
        if (deleted !== undefined) {
          this.#lastProjection.delete(key);
          this.#lastToolUpdate.delete(key);
          this.#preApproval.delete(key);
        }
      }
      if (!response.ok && response.status !== 404) throw new Error(`relay returned HTTP ${response.status}`);
    }).catch((error: unknown) => {
      emitTrace(this.#trace, "relay_result", {
        channel: "live_activity",
        device: traceId(row.deviceId),
        result: "network_error",
      });
      this.#log(`live activity ${row.activityId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  #key(row: LiveActivityRegistrationRow): string {
    return `${row.deviceId}\0${row.activityId}`;
  }

  #completionKey(bot: string, sessionId: string): string {
    return `${bot}\0${sessionId}`;
  }
}

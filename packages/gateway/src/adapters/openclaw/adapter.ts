import type { PresenceState, RichBlock } from "cozygateway-contract";

import { normalizeMarkdownToBlocks } from "../../markdown-blocks.ts";
import type { BackendAdapter, BackendSession, TurnHandlers } from "../types.ts";
import { blocksToText } from "../attach/blocks-to-text.ts";
import type { OpenClawClient } from "./client.ts";

/** Generous by default, matching the attach adapter's own default: agentic turns with tool use
 *  can legitimately run for minutes. */
export const DEFAULT_TURN_TIMEOUT_SECONDS = 600;

/** How often (in ms) an in-flight turn's accumulated delta snapshot is re-normalized and pushed
 *  out as a draft. A trailing timer, not a leading one: a burst of deltas inside one window
 *  collapses into a single draft at the end of the window, and the pending draft is always
 *  flushed before the turn's final commit (see `send`'s `onDone` handler) so the last snapshot
 *  is never silently dropped. */
const DEFAULT_DRAFT_FLUSH_MS = 120;

export interface OpenClawAdapterDeps {
  agentId: string;
  /** Injected so tests drive a fake implementing the `OpenClawClient` interface, with no socket. */
  client: OpenClawClient;
  turnTimeoutMs: number;
  /** default `DEFAULT_DRAFT_FLUSH_MS` (120) */
  draftFlushMs?: number;
}

/** ASSUMPTION (Task 8 to verify, matching the same stance as client.ts's sessionKeyOf): the
 *  verified wire facts confirm `sessions.create` returns a `sessionKey` but not its exact response
 *  envelope shape beyond that (see `OkResponseSchema` in protocol.ts, which deliberately leaves the
 *  payload an open record for exactly this reason), so this reads `sessionKey` off the resolved
 *  payload as an open/unknown field rather than asserting a wider shape on a guess. */
function sessionKeyFromCreateResponse(payload: unknown): string {
  const record = payload as Record<string, unknown> | null | undefined;
  const sessionKey = record?.["sessionKey"];
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new Error("openclaw sessions.create response did not include a sessionKey");
  }
  return sessionKey;
}

/** One OpenClaw agent's BackendAdapter. Sessions are per thread (lazily created once, then
 *  cached); a turn's lifecycle is entirely scoped to its own session subscription, so distinct
 *  threads' turns can run concurrently with no shared, correlatable turn id (unlike the attach
 *  adapter, which mints its own turnId because one attach connection multiplexes many threads
 *  over a single wire). */
export function createOpenClawAdapter(deps: OpenClawAdapterDeps): BackendAdapter {
  const draftFlushMs = deps.draftFlushMs ?? DEFAULT_DRAFT_FLUSH_MS;
  const sessionKeys = new Map<string, string>();
  const sessionCreates = new Map<string, Promise<string>>();

  async function ensureSession(threadId: string): Promise<string> {
    const cached = sessionKeys.get(threadId);
    if (cached !== undefined) return cached;

    let creating = sessionCreates.get(threadId);
    if (creating === undefined) {
      creating = deps.client.request("sessions.create", {}).then((payload) => {
        const sessionKey = sessionKeyFromCreateResponse(payload);
        sessionKeys.set(threadId, sessionKey);
        return sessionKey;
      });
      sessionCreates.set(threadId, creating);
      // Regardless of outcome, this thread's in-flight create is done; a later call either hits
      // the cache (success) or starts a fresh attempt (failure), never awaits a stale promise.
      creating.then(
        () => sessionCreates.delete(threadId),
        () => sessionCreates.delete(threadId),
      );
    }
    return creating;
  }

  return {
    backend: "openclaw",

    presence(): PresenceState {
      return deps.client.state() === "online" ? "online" : "absent";
    },

    async startSession(threadId: string): Promise<BackendSession> {
      const sessionKey = await ensureSession(threadId);

      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          if (deps.client.state() !== "online") {
            return Promise.reject(new Error(`agent "${deps.agentId}" is not attached`));
          }

          return new Promise<void>((resolve, reject) => {
            let settled = false;
            let snapshot = "";
            let lastFlushedSnapshot: string | undefined;
            let flushTimer: ReturnType<typeof setTimeout> | undefined;

            const clearFlushTimer = (): void => {
              if (flushTimer !== undefined) clearTimeout(flushTimer);
              flushTimer = undefined;
            };

            const flushDraft = (): void => {
              clearFlushTimer();
              if (snapshot === lastFlushedSnapshot) return;
              lastFlushedSnapshot = snapshot;
              handlers.onDraft({ blocks: normalizeMarkdownToBlocks(snapshot), toolCalls: [] });
            };

            const scheduleFlush = (): void => {
              if (flushTimer !== undefined) return;
              flushTimer = setTimeout(flushDraft, draftFlushMs);
              flushTimer.unref();
            };

            const timer = setTimeout(() => {
              failTurn(`turn timed out after ${deps.turnTimeoutMs / 1000}s`);
            }, deps.turnTimeoutMs);
            timer.unref();

            const settle = (): void => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              clearFlushTimer();
              unsubscribe();
            };

            function failTurn(message: string): void {
              if (settled) return;
              settle();
              reject(new Error(message));
            }

            const unsubscribe = deps.client.subscribeSession(sessionKey, {
              onDelta: (nextSnapshot) => {
                if (settled) return;
                snapshot = nextSnapshot;
                scheduleFlush();
              },
              onDone: () => {
                if (settled) return;
                // The trailing throttle timer, if one is still pending, has a snapshot newer than
                // the last flushed draft: flush it now so the drafts stream never silently drops
                // the turn's final content before commit takes over.
                if (flushTimer !== undefined) flushDraft();

                const finalBlocks = normalizeMarkdownToBlocks(snapshot);
                if (finalBlocks.length === 0) {
                  failTurn("the agent finished the turn without any reply content");
                  return;
                }
                settle();
                handlers.onCommit({ blocks: finalBlocks });
                handlers.onDone();
                resolve();
              },
              onError: () => {
                failTurn("the openclaw connection dropped mid-turn");
              },
            });

            deps.client
              .request("chat.send", { sessionKey, text: blocksToText(blocks) })
              .catch(() => {
                failTurn("the openclaw connection dropped mid-turn");
              });
          });
        },

        async close(): Promise<void> {},
      };
    },
  };
}

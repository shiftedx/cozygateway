import type { RichBlock } from "cozygateway-contract";

import type { BackendAdapter, BackendSession, TurnHandlers } from "./types.ts";

function firstText(blocks: RichBlock[]): string {
  const first = blocks[0];
  return first !== undefined && first.type === "paragraph" ? first.text : "(rich content)";
}

/** Reference echo backend. contract/v1.md section 7 freezes these semantics; the conformance
 *  suite asserts them frame by frame. Change nothing here without a contract version bump. It
 *  declares "queue" mid-turn delivery: a send while a turn is in flight serializes behind it. */
export function createMockAdapter(options?: { failOn?: string }): BackendAdapter {
  const failToken = options?.failOn ?? "[[fail]]";

  const session: BackendSession = {
    async send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
      const text = firstText(blocks);
      await Promise.resolve();
      handlers.onDraft({ blocks: [{ type: "paragraph", text: "Echo: " }], toolCalls: [] });
      if (text.includes(failToken)) {
        await Promise.resolve();
        throw new Error("scripted failure");
      }
      await Promise.resolve();
      const final: RichBlock[] = [{ type: "paragraph", text: `Echo: ${text}` }];
      handlers.onDraft({ blocks: final, toolCalls: [] });
      await Promise.resolve();
      handlers.onCommit({ blocks: final });
      await Promise.resolve();
      handlers.onDone();
    },
    async close(): Promise<void> {},
  };

  return {
    backend: "mock",
    midTurnDelivery: "queue",
    async startSession(): Promise<BackendSession> {
      return session;
    },
    presence: () => "online",
  };
}

/** LLM-free steer-capable backend used to exercise the TurnRunner steer/interrupt policy and the
 *  full HTTP/WS stack end to end. A send emits one draft ("Working: <text>") and stays in flight;
 *  it never completes on its own. A steer folds the steer text ("Working: <text> + <steer>") and
 *  then commits + done + resolves. An interrupt rejects the pending send. One in-flight turn at a
 *  time per session (the runner serializes turns per thread and caches one session per thread). */
export function createSteerMockAdapter(): BackendAdapter {
  return {
    backend: "mock-steer",
    midTurnDelivery: "steer",
    presence: () => "online",
    async startSession(): Promise<BackendSession> {
      let inflight:
        | {
            handlers: TurnHandlers;
            text: string;
            resolve: () => void;
            reject: (err: Error) => void;
            settled: boolean;
          }
        | undefined;

      return {
        send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
          const text = `Working: ${firstText(blocks)}`;
          return new Promise<void>((resolve, reject) => {
            inflight = { handlers, text, resolve, reject, settled: false };
            handlers.onDraft({ blocks: [{ type: "paragraph", text }], toolCalls: [] });
            // Deliberately does not resolve: the turn stays in flight until steer/interrupt.
          });
        },
        async steer(steerBlocks: RichBlock[]): Promise<void> {
          const cur = inflight;
          if (cur === undefined || cur.settled) return; // race: the turn already ended
          cur.text = `${cur.text} + ${firstText(steerBlocks)}`;
          const final: RichBlock[] = [{ type: "paragraph", text: cur.text }];
          cur.handlers.onDraft({ blocks: final, toolCalls: [] });
          cur.settled = true;
          cur.handlers.onCommit({ blocks: final });
          cur.handlers.onDone();
          cur.resolve();
          inflight = undefined;
        },
        async interrupt(): Promise<void> {
          const cur = inflight;
          if (cur === undefined || cur.settled) return;
          cur.settled = true;
          cur.reject(new Error("interrupted by user"));
          inflight = undefined;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

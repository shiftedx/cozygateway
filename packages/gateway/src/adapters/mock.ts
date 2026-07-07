import type { RichBlock } from "cozygateway-contract";

import type { BackendAdapter, BackendSession, TurnHandlers } from "./types.ts";

/** Reference echo backend. contract/v1.md section 7 freezes these semantics; the conformance
 *  suite asserts them frame by frame. Change nothing here without a contract version bump. */
export function createMockAdapter(options?: { failOn?: string }): BackendAdapter {
  const failToken = options?.failOn ?? "[[fail]]";

  const session: BackendSession = {
    async send(blocks: RichBlock[], handlers: TurnHandlers): Promise<void> {
      const first = blocks[0];
      const text = first !== undefined && first.type === "paragraph" ? first.text : "(rich content)";
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
    async startSession(): Promise<BackendSession> {
      return session;
    },
    presence: () => "online",
  };
}

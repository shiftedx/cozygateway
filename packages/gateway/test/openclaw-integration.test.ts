import { afterEach, describe, expect, it } from "vitest";
import type { RichBlock } from "cozygateway-contract";

import { createOpenClawClient, type OpenClawClient } from "../src/adapters/openclaw/client.ts";
import { createOpenClawAdapter } from "../src/adapters/openclaw/adapter.ts";
import { generateDeviceIdentity } from "../src/adapters/openclaw/device-auth.ts";
import { normalizeMarkdownToBlocks } from "../src/markdown-blocks.ts";
import type { TurnHandlers } from "../src/adapters/types.ts";
import { startFakeOpenClawServer, type FakeOpenClawServer } from "./support/fake-openclaw-server.ts";

/** The last untested seam in the OpenClaw adapter branch: a real `OpenClawClient` PLUS a real
 *  `createOpenClawAdapter`, driven through a full turn, against only a FAKED server. Every other
 *  suite either drives the real client alone (openclaw-client.test.ts) or drives the real adapter
 *  against a hand-rolled fake client (openclaw-adapter.test.ts); neither exercises the two ASSUMPTION
 *  sites together where `sessions.create`'s returned `sessionKey` and the delta event's own
 *  session-identifying field are assumed to be the SAME field/value. This file exercises exactly
 *  that: sessions.create -> subscribe on the returned key -> a server delta tagged with that SAME
 *  key -> accumulate -> throttled draft -> commit -> done. */

async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function deltaFrame(input: { sessionKey: string; deltaText: string; done?: boolean }): Record<string, unknown> {
  // The Task-8-pinned `chat` event: `state` streams `delta` then a terminal `final` (reply-end).
  return {
    type: "event",
    event: "chat",
    payload: {
      sessionKey: input.sessionKey,
      state: input.done ? "final" : "delta",
      deltaText: input.deltaText,
    },
  };
}

interface Observed {
  drafts: Array<{ blocks: RichBlock[]; toolCalls: unknown[] }>;
  commits: RichBlock[][];
  done: number;
}

function observer(): { handlers: TurnHandlers; observed: Observed } {
  const observed: Observed = { drafts: [], commits: [], done: 0 };
  return {
    observed,
    handlers: {
      onDraft: (update) => observed.drafts.push(update),
      onCommit: (final) => observed.commits.push(final.blocks),
      onDone: () => {
        observed.done += 1;
      },
    },
  };
}

const servers: FakeOpenClawServer[] = [];
const clients: OpenClawClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) await s.close();
});

describe("real OpenClawClient + real createOpenClawAdapter against a faked server", () => {
  it("carries a full turn: sessions.create -> subscribe on the returned key -> matching delta -> throttled draft -> commit -> done", async () => {
    const server = await startFakeOpenClawServer();
    servers.push(server);

    const client = createOpenClawClient({
      url: server.url,
      token: "SECRET-INTEGRATION-TOKEN",
      identity: generateDeviceIdentity(),
      reconnect: { minMs: 15, maxMs: 80 },
    });
    clients.push(client);
    client.start();
    await until(() => client.state() === "online");

    const adapter = createOpenClawAdapter({
      agentId: "integration-agent",
      client,
      turnTimeoutMs: 5_000,
      draftFlushMs: 20,
    });

    const session = await adapter.startSession("thread-1");
    // The fake server's sessions.create handler mints a real sessionKey and hands it back through
    // the real request()/hello-ok wire round-trip; ensureSession() in adapter.ts read this exact
    // value off the response payload (sessionKeyFromCreateResponse), so it must match what the
    // server itself recorded.
    expect(server.sessionKeys()).toHaveLength(1);
    const sessionKey = server.sessionKeys()[0]!;

    const { handlers, observed } = observer();
    const turn = session.send([{ type: "paragraph", text: "hi there" }], handlers);

    const chunks = [
      "# Streamed Reply\n\n",
      "This turn is carried by a real `OpenClawClient` and a real ",
      "`createOpenClawAdapter`, with only the SERVER faked.\n\n- point one\n- point two",
    ];
    for (const [i, deltaText] of chunks.entries()) {
      // Tag every delta with the SAME sessionKey the server itself returned from sessions.create,
      // exercising the assumed-same-field/value across the two ASSUMPTION sites (client.ts's
      // sessionKeyOf and adapter.ts's sessionKeyFromCreateResponse).
      server.sendEvent(deltaFrame({ sessionKey, deltaText, done: i === chunks.length - 1 }));
      // The adapter's draft flush is a TRAILING timer (draftFlushMs, 20 here), not a leading one:
      // a burst of deltas with no real gap between them can all land inside one flush window with
      // nothing forcing a flush until `onDone`. Space non-terminal deltas out past draftFlushMs so
      // the trailing timer actually fires between them, independent of `onDone`'s own
      // flush-pending-draft-before-commit safeguard (see adapter.ts) -- this keeps the drafts
      // assertion below deterministic rather than dependent on incidental event-delivery timing.
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }

    await turn;

    const fullText = chunks.join("");
    expect(observed.commits).toHaveLength(1);
    expect(observed.commits[0]).toEqual(normalizeMarkdownToBlocks(fullText));
    expect(observed.done).toBe(1);
    // The throttle actually engaged at least once before the final commit: this is a streamed
    // turn, not a single synchronous flush.
    expect(observed.drafts.length).toBeGreaterThan(0);
    // And the last draft observed before commit reflects the full accumulated snapshot, matching
    // the eventual commit content: `onDone` always flushes a still-pending trailing timer with the
    // CURRENT snapshot before it commits (see adapter.ts), so this holds regardless of the exact
    // number of intermediate flushes.
    expect(observed.drafts.at(-1)?.blocks).toEqual(normalizeMarkdownToBlocks(fullText));
  });

  it("surfaces tool chips end-to-end: wire agent frames -> client fold -> adapter drafts", async () => {
    const server = await startFakeOpenClawServer();
    servers.push(server);

    const client = createOpenClawClient({
      url: server.url,
      token: "SECRET-INTEGRATION-TOKEN",
      identity: generateDeviceIdentity(),
      reconnect: { minMs: 15, maxMs: 80 },
    });
    clients.push(client);
    client.start();
    await until(() => client.state() === "online");

    const adapter = createOpenClawAdapter({
      agentId: "integration-agent",
      client,
      turnTimeoutMs: 5_000,
      draftFlushMs: 20,
    });
    const session = await adapter.startSession("thread-1");
    const sessionKey = server.sessionKeys()[0]!;

    const { handlers, observed } = observer();
    const turn = session.send([{ type: "paragraph", text: "use a tool" }], handlers);

    function toolItemFrame(phase: "start" | "end"): Record<string, unknown> {
      return {
        type: "event",
        event: "agent",
        payload: {
          sessionKey,
          stream: "item",
          data: {
            itemId: "tool:1",
            kind: "tool",
            phase,
            toolCallId: "1",
            name: "read",
            status: phase === "start" ? "running" : "completed",
          },
        },
      };
    }

    server.sendEvent(toolItemFrame("start"));
    // Space past draftFlushMs (20) so the running-status draft actually flushes before the end
    // frame overwrites the chip (same trailing-timer reasoning as the full-turn test above).
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.sendEvent(toolItemFrame("end"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    server.sendEvent(deltaFrame({ sessionKey, deltaText: "The answer.", done: true }));
    await turn;

    const chipDrafts = observed.drafts.filter((d) => d.toolCalls.length > 0);
    expect(chipDrafts.length).toBeGreaterThanOrEqual(2);
    expect(chipDrafts[0]!.toolCalls).toEqual([{ id: "1", name: "read", status: "running" }]);
    expect(chipDrafts.at(-1)!.toolCalls).toEqual([{ id: "1", name: "read", status: "ok" }]);
    expect(observed.commits).toHaveLength(1);
    expect(observed.done).toBe(1);
  });
});

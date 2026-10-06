import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";

import { AttachV1Ingress } from "../src/adapters/attach/ingress-v1.ts";
import { openStorage, type Storage } from "../src/storage.ts";

/** The attach ingress deliberately retains its Storage handle across teardown: a peer socket can
 * close, and its heartbeat tick can fire, after the durable store is gone. Every one of those
 * seams reaches Tasks, and any of them throwing `ERR_INVALID_STATE` out of a socket callback or an
 * interval callback is an uncaught exception that takes the process down on the way out. */
const stores: Storage[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) try { store.close(); } catch { /* already closed by the test */ }
  for (const server of servers.splice(0)) server.close();
  vi.useRealTimers();
});

it("refuses every ingress-to-Tasks seam once the durable store is closed", () => {
  const storage = openStorage(":memory:");
  stores.push(storage);
  const sessionId = storage.nativeBotChat("sage", 100).sessionId;
  storage.enqueueAttachCommand("sage", "turn", { kind: "turn", threadId: sessionId, turnId: "run-1", messageId: "user", text: "work" }, 100);
  expect(storage.tasks.list({ bot: "sage" })).toHaveLength(1);
  storage.close();

  // These are exactly the five entry points `AttachV1Ingress` calls after teardown: the socket
  // close handler, the hello handler, the catalog declaration, the heartbeat tick, and the
  // command flush the tick performs.
  expect(() => storage.tasks.presence("sage", false, 200)).not.toThrow();
  expect(() => storage.tasks.hello("sage", 200)).not.toThrow();
  expect(() => storage.tasks.declareSlashCommands("sage", ["/status"])).not.toThrow();
  expect(() => storage.tasks.reconcile(200)).not.toThrow();
  expect(() => storage.tasks.dispatch(() => { throw new Error("no command may be dispatched from a closed store"); })).not.toThrow();
});

it("survives the heartbeat tick that fires after storage teardown", async () => {
  vi.useFakeTimers();
  const storage = openStorage(":memory:");
  stores.push(storage);
  const server = createServer();
  servers.push(server);
  const ingress = new AttachV1Ingress({
    tokens: new Map([["peer-secret", "sage"]]), storage, now: () => 100,
    events: { onEvent: () => true, onPresence: () => {} }, log: () => {}, heartbeatIntervalMs: 10,
  });
  server.on("upgrade", (request, socket, head) => ingress.handleUpgrade(request, socket, head));
  storage.close();
  // The interval is still armed. Advancing it runs the real tick body synchronously, so a throw
  // from `reconcile` or the command flush lands here rather than as an uncaught exception.
  expect(() => vi.advanceTimersByTime(50)).not.toThrow();
  ingress.close();
});

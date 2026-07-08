import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createUpgradeDispatcher, type UpgradeHandler } from "../src/upgrade-dispatcher.ts";

/** A minimal Duplex stand-in for the raw socket ws/http hand the 'upgrade' listener; records
 *  what would have been written to the wire and whether it was torn down. */
function fakeSocket(): Duplex & { writes: string[]; destroyed: boolean } {
  const socket = new Duplex({
    write(chunk, _enc, cb) {
      (socket as unknown as { writes: string[] }).writes.push(String(chunk));
      cb();
    },
    read() {},
  }) as Duplex & { writes: string[]; destroyed: boolean };
  socket.writes = [];
  return socket;
}

function req(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe("createUpgradeDispatcher", () => {
  it("calls the handler registered for the request's pathname", () => {
    const wsHandler: UpgradeHandler = vi.fn();
    const attachHandler: UpgradeHandler = vi.fn();
    const dispatch = createUpgradeDispatcher(
      new Map([
        ["/ws", wsHandler],
        ["/attach", attachHandler],
      ]),
    );
    const socket = fakeSocket();
    const head = Buffer.from("");

    dispatch(req("/ws?x=1"), socket, head);

    expect(wsHandler).toHaveBeenCalledWith(expect.anything(), socket, head);
    expect(attachHandler).not.toHaveBeenCalled();
    expect(socket.writes).toHaveLength(0);
    expect(socket.destroyed).toBe(false);
  });

  it("routes each registered path to its own handler and never cross-calls the other", () => {
    const wsHandler: UpgradeHandler = vi.fn();
    const attachHandler: UpgradeHandler = vi.fn();
    const dispatch = createUpgradeDispatcher(
      new Map([
        ["/ws", wsHandler],
        ["/attach", attachHandler],
      ]),
    );

    dispatch(req("/attach"), fakeSocket(), Buffer.from(""));

    expect(attachHandler).toHaveBeenCalledTimes(1);
    expect(wsHandler).not.toHaveBeenCalled();
  });

  it("writes a plain HTTP error response and destroys the socket for an unknown path", () => {
    const wsHandler: UpgradeHandler = vi.fn();
    const dispatch = createUpgradeDispatcher(new Map([["/ws", wsHandler]]));
    const socket = fakeSocket();

    dispatch(req("/does-not-exist"), socket, Buffer.from(""));

    expect(wsHandler).not.toHaveBeenCalled();
    expect(socket.writes.join("")).toMatch(/^HTTP\/1\.1 404/);
    expect(socket.destroyed).toBe(true);
  });
});

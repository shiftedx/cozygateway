import { Duplex } from "node:stream";
import type { IncomingMessage } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  createUpgradeDispatcher,
  type UpgradeHandler,
  type UpgradeResolver,
} from "../src/upgrade-dispatcher.ts";

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
        ["/attach/v1", attachHandler],
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
        ["/attach/v1", attachHandler],
      ]),
    );

    dispatch(req("/attach/v1"), fakeSocket(), Buffer.from(""));

    expect(attachHandler).toHaveBeenCalledTimes(1);
    expect(wsHandler).not.toHaveBeenCalled();
  });

  it("keeps exact routes authoritative and does not ask the dynamic resolver to shadow them", () => {
    const wsHandler: UpgradeHandler = vi.fn();
    const attachHandler: UpgradeHandler = vi.fn();
    const shadowHandler: UpgradeHandler = vi.fn();
    const resolveDynamic: UpgradeResolver = vi.fn(() => shadowHandler);
    const dispatch = createUpgradeDispatcher(
      new Map([
        ["/ws", wsHandler],
        ["/attach/v1", attachHandler],
      ]),
      resolveDynamic,
    );

    dispatch(req("/ws?probe=shadow"), fakeSocket(), Buffer.from("ws"));
    dispatch(req("/attach/v1?probe=shadow"), fakeSocket(), Buffer.from("attach"));

    expect(wsHandler).toHaveBeenCalledTimes(1);
    expect(attachHandler).toHaveBeenCalledTimes(1);
    expect(resolveDynamic).not.toHaveBeenCalled();
    expect(shadowHandler).not.toHaveBeenCalled();
  });

  it("passes only the pathname to the dynamic resolver and dispatches its match once", () => {
    const probeHandler: UpgradeHandler = vi.fn();
    const resolveDynamic: UpgradeResolver = vi.fn((pathname) =>
      pathname === "/onboarding/probe/abc" ? probeHandler : undefined,
    );
    const dispatch = createUpgradeDispatcher(new Map(), resolveDynamic);
    const socket = fakeSocket();
    const head = Buffer.from("probe");
    const request = req("/onboarding/probe/abc?token=secret#ignored-as-query-data");

    dispatch(request, socket, head);

    expect(resolveDynamic).toHaveBeenCalledOnce();
    expect(resolveDynamic).toHaveBeenCalledWith("/onboarding/probe/abc");
    expect(probeHandler).toHaveBeenCalledOnce();
    expect(probeHandler).toHaveBeenCalledWith(request, socket, head);
    expect(socket.writes).toHaveLength(0);
    expect(socket.destroyed).toBe(false);
  });

  it.each([undefined, "not-a-path", "/missing?token=secret"])(
    "keeps a clean 404 for malformed or unmatched URL %s",
    (url) => {
      const resolveDynamic: UpgradeResolver = vi.fn(() => undefined);
      const dispatch = createUpgradeDispatcher(new Map(), resolveDynamic);
      const socket = fakeSocket();
      const request = { url } as IncomingMessage;

      dispatch(request, socket, Buffer.from(""));

      expect(socket.writes).toEqual([
        "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      ]);
      expect(socket.destroyed).toBe(true);
    },
  );

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

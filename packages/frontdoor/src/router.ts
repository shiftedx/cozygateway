import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { encodeFrame, type Frame } from "./frames.ts";
import type { AgentLink, AgentRegistry } from "./registry.ts";

/** One in-flight proxied request. The server feeds agent frames back via onFrame. */
export interface OpenStream {
  sid: number;
  onFrame(frame: Frame): void;
}

export function rawHeaders(req: IncomingMessage): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!.toLowerCase();
    (out[k] ??= []).push(req.rawHeaders[i + 1]!);
  }
  return out;
}

/** Pipe a plain (non-upgrade) request over the agent link; wires the response when head arrives. */
export function proxyRequest(
  registry: AgentRegistry,
  link: AgentLink,
  req: IncomingMessage,
  res: ServerResponse,
  streams: Map<number, OpenStream>,
): void {
  const sid = registry.nextStreamId();
  let hasHead = false;
  let ended = false;
  const abortStream = (reason: string) => {
    if (!streams.delete(sid)) return;
    res.destroy();
    link.send({ t: "abort", sid, reason });
  };
  streams.set(sid, {
    sid,
    onFrame(frame) {
      if (frame.t === "head") {
        if (hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(frame.headers)) headers[k] = v.length === 1 ? v[0]! : v;
        try {
          res.writeHead(frame.status, headers);
          hasHead = true;
        } catch {
          abortStream("invalid response frame");
        }
      } else if (frame.t === "data") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        try {
          res.write(Buffer.from(frame.b64, "base64"));
        } catch {
          abortStream("invalid response frame");
        }
      } else if (frame.t === "end") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        ended = true;
        try {
          res.end();
          streams.delete(sid);
        } catch {
          ended = false;
          abortStream("invalid response frame");
        }
      } else if (frame.t === "abort") {
        ended = true;
        res.destroy();
        streams.delete(sid);
      }
    },
  });
  link.send({ t: "open", sid, method: req.method ?? "GET", path: req.url ?? "/", headers: rawHeaders(req), upgrade: false });
  req.on("data", (chunk: Buffer) => link.send({ t: "data", sid, b64: chunk.toString("base64") }));
  req.on("end", () => link.send({ t: "end", sid }));
  res.on("close", () => {
    if (streams.delete(sid)) link.send({ t: "abort", sid, reason: "client closed" });
  });
}

/** Pipe an HTTP upgrade over the agent link, preserving the upgraded byte stream. */
export function proxyUpgrade(
  registry: AgentRegistry,
  link: AgentLink,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  streams: Map<number, OpenStream>,
): void {
  const sid = registry.nextStreamId();
  let hasHead = false;
  let ended = false;
  const abortStream = (reason: string) => {
    if (!streams.delete(sid)) return;
    ended = true;
    socket.destroy();
    link.send({ t: "abort", sid, reason });
  };
  streams.set(sid, {
    sid,
    onFrame(frame) {
      if (frame.t === "head") {
        if (hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        const reason = frame.status === 101 ? "Switching Protocols" : "";
        const lines = [`HTTP/1.1 ${frame.status} ${reason}`];
        for (const [k, vs] of Object.entries(frame.headers)) {
          for (const v of vs) lines.push(`${k}: ${v}`);
        }
        const rawResponse = lines.join("\r\n") + "\r\n\r\n";
        if (frame.status !== 101) {
          ended = true;
          streams.delete(sid);
          try {
            socket.end(rawResponse);
          } catch {
            socket.destroy();
          }
          return;
        }
        try {
          socket.write(rawResponse);
          hasHead = true;
        } catch {
          abortStream("invalid response frame");
          return;
        }
      } else if (frame.t === "data") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        try {
          socket.write(Buffer.from(frame.b64, "base64"));
        } catch {
          abortStream("invalid response frame");
        }
      } else if (frame.t === "end") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        ended = true;
        streams.delete(sid);
        socket.end();
      } else if (frame.t === "abort") {
        ended = true;
        streams.delete(sid);
        socket.destroy();
      }
    },
  });
  socket.on("data", (chunk: Buffer) => {
    if (streams.has(sid)) link.send({ t: "data", sid, b64: chunk.toString("base64") });
  });
  socket.on("close", () => {
    if (streams.delete(sid)) {
      ended = true;
      link.send({ t: "abort", sid, reason: "client closed" });
    }
  });
  socket.on("error", () => { /* close handler covers it */ });
  link.send({ t: "open", sid, method: req.method ?? "GET", path: req.url ?? "/", headers: rawHeaders(req), upgrade: true });
  if (head.length > 0 && streams.has(sid)) link.send({ t: "data", sid, b64: head.toString("base64") });
}

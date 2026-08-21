import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { MAX_BUFFERED_BYTES, MAX_DECODED_DATA_BYTES, STREAM_IDLE_TIMEOUT_MS, type Frame } from "./frames.ts";
import type { AgentLink, AgentRegistry } from "./registry.ts";

/** One in-flight proxied request. The server feeds agent frames back via onFrame. */
export interface OpenStream {
  sid: number;
  onFrame(frame: Frame): void;
}

export interface ProxyStreamOptions {
  onClosed?: () => void;
  idleTimeoutMs?: number;
}

const unsafeHeaderNames = new Set(["__proto__", "constructor", "prototype"]);

function isSafeHeaderName(name: string): boolean {
  return !unsafeHeaderNames.has(name.toLowerCase());
}

export function rawHeaders(req: IncomingMessage): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!.toLowerCase();
    (out[k] ??= []).push(req.rawHeaders[i + 1]!);
  }
  return out;
}

function shouldAbortForBackpressure(link: AgentLink): boolean {
  return (link.bufferedAmount?.() ?? 0) > MAX_BUFFERED_BYTES;
}

/** Pipe a plain (non-upgrade) request over the agent link; wires the response when head arrives. */
export function proxyRequest(
  registry: AgentRegistry,
  link: AgentLink,
  req: IncomingMessage,
  res: ServerResponse,
  streams: Map<number, OpenStream>,
  options: ProxyStreamOptions = {},
): void {
  const sid = registry.nextStreamId();
  let hasHead = false;
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const removeStream = (): boolean => {
    if (!streams.delete(sid)) return false;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.onClosed?.();
    return true;
  };
  const sendAbort = (reason: string): void => {
    if (shouldAbortForBackpressure(link)) return;
    try { link.send({ t: "abort", sid, reason }); } catch { /* the link is already unavailable */ }
  };
  const abortStream = (reason: string): void => {
    if (!removeStream()) return;
    ended = true;
    res.destroy();
    sendAbort(reason);
  };
  const touch = (): void => {
    if (!streams.has(sid)) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortStream("stream idle timeout"), options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
  };
  const sendFrame = (frame: Frame): boolean => {
    if (!streams.has(sid)) return false;
    if (shouldAbortForBackpressure(link)) {
      abortStream("agent backpressure");
      return false;
    }
    try {
      link.send(frame);
      if (shouldAbortForBackpressure(link)) {
        abortStream("agent backpressure");
        return false;
      }
      touch();
      return true;
    } catch {
      abortStream("agent unavailable");
      return false;
    }
  };
  streams.set(sid, {
    sid,
    onFrame(frame) {
      if (frame.t === "head") {
        if (hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        const headers: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
        for (const [k, v] of Object.entries(frame.headers)) {
          if (isSafeHeaderName(k)) headers[k] = v.length === 1 ? v[0]! : v;
        }
        try {
          res.writeHead(frame.status, headers);
          hasHead = true;
          touch();
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
          touch();
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
          removeStream();
        } catch {
          ended = false;
          abortStream("invalid response frame");
        }
      } else if (frame.t === "abort") {
        ended = true;
        res.destroy();
        removeStream();
      } else {
        abortStream("invalid response frame");
      }
    },
  });
  touch();
  if (!sendFrame({ t: "open", sid, method: req.method ?? "GET", path: req.url ?? "/", headers: rawHeaders(req), upgrade: false })) return;
  req.on("data", (chunk: Buffer) => {
    if (!streams.has(sid)) return;
    for (let offset = 0; offset < chunk.length; offset += MAX_DECODED_DATA_BYTES) {
      if (!sendFrame({
        t: "data", sid,
        b64: chunk.subarray(offset, offset + MAX_DECODED_DATA_BYTES).toString("base64"),
      })) {
        req.destroy();
        return;
      }
    }
  });
  req.on("end", () => { sendFrame({ t: "end", sid }); });
  req.on("error", () => abortStream("client request error"));
  res.on("close", () => {
    if (removeStream()) sendAbort("client closed");
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
  options: ProxyStreamOptions = {},
): void {
  const sid = registry.nextStreamId();
  let hasHead = false;
  let ended = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const removeStream = (): boolean => {
    if (!streams.delete(sid)) return false;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    options.onClosed?.();
    return true;
  };
  const sendAbort = (reason: string): void => {
    if (shouldAbortForBackpressure(link)) return;
    try { link.send({ t: "abort", sid, reason }); } catch { /* the link is already unavailable */ }
  };
  const abortStream = (reason: string): void => {
    if (!removeStream()) return;
    ended = true;
    socket.destroy();
    sendAbort(reason);
  };
  const touch = (): void => {
    if (!streams.has(sid)) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abortStream("stream idle timeout"), options.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
  };
  const sendFrame = (frame: Frame): boolean => {
    if (!streams.has(sid)) return false;
    if (shouldAbortForBackpressure(link)) {
      abortStream("agent backpressure");
      return false;
    }
    try {
      link.send(frame);
      if (shouldAbortForBackpressure(link)) {
        abortStream("agent backpressure");
        return false;
      }
      touch();
      return true;
    } catch {
      abortStream("agent unavailable");
      return false;
    }
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
          if (!isSafeHeaderName(k)) continue;
          for (const v of vs) lines.push(`${k}: ${v}`);
        }
        const rawResponse = lines.join("\r\n") + "\r\n\r\n";
        try {
          socket.write(rawResponse);
          hasHead = true;
          touch();
        } catch {
          abortStream("invalid response frame");
        }
      } else if (frame.t === "data") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        try {
          socket.write(Buffer.from(frame.b64, "base64"));
          touch();
        } catch {
          abortStream("invalid response frame");
        }
      } else if (frame.t === "end") {
        if (!hasHead || ended) {
          abortStream("invalid response frame order");
          return;
        }
        ended = true;
        removeStream();
        socket.end();
      } else if (frame.t === "abort") {
        ended = true;
        removeStream();
        socket.destroy();
      } else {
        abortStream("invalid response frame");
      }
    },
  });
  touch();
  if (!sendFrame({ t: "open", sid, method: req.method ?? "GET", path: req.url ?? "/", headers: rawHeaders(req), upgrade: true })) return;
  socket.on("data", (chunk: Buffer) => {
    if (!streams.has(sid)) return;
    for (let offset = 0; offset < chunk.length; offset += MAX_DECODED_DATA_BYTES) {
      if (!sendFrame({
        t: "data", sid,
        b64: chunk.subarray(offset, offset + MAX_DECODED_DATA_BYTES).toString("base64"),
      })) {
        socket.destroy();
        return;
      }
    }
  });
  socket.on("close", () => {
    if (removeStream()) {
      ended = true;
      sendAbort("client closed");
    }
  });
  socket.on("error", () => { /* close handler covers it */ });
  if (head.length > 0 && streams.has(sid)) {
    for (let offset = 0; offset < head.length; offset += MAX_DECODED_DATA_BYTES) {
      if (!sendFrame({
        t: "data", sid,
        b64: head.subarray(offset, offset + MAX_DECODED_DATA_BYTES).toString("base64"),
      })) break;
    }
  }
}

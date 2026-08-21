import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";

import WebSocket from "ws";

import {
  MAX_BUFFERED_BYTES,
  MAX_DECODED_DATA_BYTES,
  MAX_MESSAGE_BYTES,
  STREAM_IDLE_TIMEOUT_MS,
  decodeFrame,
  encodeFrame,
  type Frame,
} from "./frames.ts";

export interface AgentConfig {
  frontdoorUrl: string;
  credential: string;
  targetHost: string;
  targetPort: number;
  backoffMs?: { initial: number; max: number };
  streamIdleTimeoutMs?: number;
}

export interface RunningAgent { connectedOnce: Promise<void>; close(): void; }

type Stream = { write(chunk: Buffer): void; end(): void; destroy(): void; };

export function startAgent(config: AgentConfig): RunningAgent {
  const backoff = config.backoffMs ?? { initial: 1000, max: 30000 };
  let closed = false;
  let ws: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let delay = backoff.initial;
  let resolveConnected!: () => void;
  const connectedOnce = new Promise<void>((r) => (resolveConnected = r));

  const wsUrl = config.frontdoorUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";

  function connect(): void {
    if (closed) return;
    const streams = new Map<number, Stream>();
    const sock = new WebSocket(wsUrl, {
      headers: { authorization: `Bearer ${config.credential}` },
      maxPayload: MAX_MESSAGE_BYTES,
    });
    ws = sock;
    let connectedAt: number | undefined;
    const send = (f: Frame): boolean => {
      if (sock.readyState !== WebSocket.OPEN) return false;
      const payload = encodeFrame(f);
      if (sock.bufferedAmount > MAX_BUFFERED_BYTES || Buffer.byteLength(payload, "utf8") > MAX_MESSAGE_BYTES) {
        streams.get(f.sid)?.destroy();
        return false;
      }
      try {
        sock.send(payload);
        if (sock.bufferedAmount > MAX_BUFFERED_BYTES) {
          streams.get(f.sid)?.destroy();
          return false;
        }
        return true;
      } catch {
        streams.get(f.sid)?.destroy();
        return false;
      }
    };

    sock.on("open", () => {
      connectedAt = Date.now();
      resolveConnected();
    });
    sock.on("message", (raw) => {
      const f = decodeFrame(String(raw));
      if (f === undefined) return;
      if (f.t === "open" && !f.upgrade) {
        startHttpStream(f, streams, send, config);
      } else if (f.t === "open" && f.upgrade) {
        startUpgradeStream(f, streams, send, config);
      } else if (f.t === "data") {
        streams.get(f.sid)?.write(Buffer.from(f.b64, "base64"));
      } else if (f.t === "end") {
        streams.get(f.sid)?.end();
      } else if (f.t === "abort") {
        const stream = streams.get(f.sid);
        if (stream === undefined) return;
        streams.delete(f.sid);
        stream.destroy();
      }
    });
    sock.on("close", () => {
      for (const stream of streams.values()) stream.destroy();
      streams.clear();
      if (closed) return;
      if (connectedAt !== undefined && Date.now() - connectedAt > 30_000) delay = backoff.initial;
      const jittered = delay + Math.floor(Math.random() * delay * 0.2);
      delay = Math.min(delay * 2, backoff.max);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, jittered);
    });
    sock.on("error", () => { /* close handler schedules the retry */ });
  }

  connect();
  return {
    connectedOnce,
    close() {
      closed = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      retryTimer = undefined;
      ws?.close();
    },
  };
}

function startHttpStream(
  frame: Extract<Frame, { t: "open" }>,
  streams: Map<number, Stream>,
  send: (frame: Frame) => boolean,
  config: AgentConfig,
): void {
  let responseHeadSent = false;
  let inboundEnded = false;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let req: ReturnType<typeof httpRequest> | undefined;
  const touch = (): void => {
    if (finished) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort("stream idle timeout"), config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
  };
  const finish = (terminal: "end" | "abort" | undefined, reason?: string, forceDestroy = false): void => {
    if (finished) return;
    finished = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    streams.delete(frame.sid);
    if (req !== undefined && !req.destroyed && (forceDestroy || !inboundEnded || !req.writableFinished)) req.destroy();
    if (terminal === "end") send({ t: "end", sid: frame.sid });
    if (terminal === "abort") send({ t: "abort", sid: frame.sid, reason });
  };
  const abort = (reason: string): void => finish("abort", reason);
  const sendData = (chunk: Buffer): boolean => {
    for (let offset = 0; offset < chunk.length; offset += MAX_DECODED_DATA_BYTES) {
      const piece = chunk.subarray(offset, offset + MAX_DECODED_DATA_BYTES);
      if (!send({ t: "data", sid: frame.sid, b64: piece.toString("base64") })) return false;
      touch();
    }
    return true;
  };

  const headers = withTargetHost(frame.headers, config.targetHost, config.targetPort);
  try {
    req = httpRequest(
      {
        host: config.targetHost,
        port: config.targetPort,
        method: frame.method,
        path: frame.path,
        headers: flatten(headers),
      },
      (res) => {
        if (finished) return;
        responseHeadSent = true;
        touch();
        if (!send({ t: "head", sid: frame.sid, status: res.statusCode ?? 502, headers: groupHeaders(res.rawHeaders) })) {
          res.destroy();
          return;
        }
        res.on("data", (chunk: Buffer) => {
          if (!finished && responseHeadSent && !sendData(chunk)) res.destroy();
        });
        res.on("end", () => finish("end"));
        res.on("aborted", () => abort("target response aborted"));
        res.on("error", () => abort("target unreachable"));
      },
    );
  } catch {
    abort("target unreachable");
    return;
  }

  const stream: Stream = {
    write: (chunk) => {
      if (!finished && !inboundEnded) {
        try {
          req!.write(chunk);
          touch();
        } catch { abort("target unreachable"); }
      }
    },
    end: () => {
      if (!finished && !inboundEnded) {
        inboundEnded = true;
        try { req!.end(); touch(); } catch { abort("target unreachable"); }
      }
    },
    destroy: () => finish(undefined, undefined, true),
  };
  streams.set(frame.sid, stream);
  touch();
  req.on("error", () => abort("target unreachable"));
}

function startUpgradeStream(
  frame: Extract<Frame, { t: "open" }>,
  streams: Map<number, Stream>,
  send: (frame: Frame) => boolean,
  config: AgentConfig,
): void {
  let responseHeadSent = false;
  let finished = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const tcp: Socket = netConnect(config.targetPort, config.targetHost);
  const touch = (): void => {
    if (finished) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort("stream idle timeout"), config.streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
  };
  const abort = (reason: string): void => {
    if (finished) return;
    finished = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    streams.delete(frame.sid);
    send({ t: "abort", sid: frame.sid, reason });
    tcp.destroy();
  };
  const sendData = (chunk: Buffer): boolean => {
    for (let offset = 0; offset < chunk.length; offset += MAX_DECODED_DATA_BYTES) {
      const piece = chunk.subarray(offset, offset + MAX_DECODED_DATA_BYTES);
      if (!send({ t: "data", sid: frame.sid, b64: piece.toString("base64") })) return false;
      touch();
    }
    return true;
  };
  const stream: Stream = {
    write: (chunk) => {
      if (!finished) {
        try {
          tcp.write(chunk);
          touch();
        } catch { abort("target unreachable"); }
      }
    },
    end: () => {
      if (!finished) {
        try { tcp.end(); touch(); } catch { abort("target unreachable"); }
      }
    },
    destroy: () => {
      if (finished) return;
      finished = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      streams.delete(frame.sid);
      tcp.destroy();
    },
  };
  streams.set(frame.sid, stream);
  touch();

  tcp.on("connect", () => {
    if (finished) return;
    const headers = withTargetHost(frame.headers, config.targetHost, config.targetPort);
    const lines = [`${frame.method} ${frame.path} HTTP/1.1`];
    for (const [key, values] of Object.entries(headers)) {
      if (!isSafeHeaderName(key)) continue;
      for (const value of values) lines.push(`${key}: ${value}`);
    }
    try {
      tcp.write(lines.join("\r\n") + "\r\n\r\n");
      touch();
    } catch { abort("target unreachable"); }
  });

  let buffered = Buffer.alloc(0);
  tcp.on("data", (chunk: Buffer) => {
    if (finished) return;
    touch();
    if (responseHeadSent) {
      if (!sendData(chunk)) abort("frontdoor backpressure");
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_MESSAGE_BYTES) {
      abort("target response head too large");
      return;
    }
    const sep = buffered.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const headText = buffered.subarray(0, sep).toString();
    const rest = buffered.subarray(sep + 4);
    const [statusLine = "", ...headerLines] = headText.split("\r\n");
    const status = Number(statusLine.split(" ")[1] ?? 502);
    const responseHeaders: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    for (const line of headerLines) {
      const i = line.indexOf(":");
      if (i === -1) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      if (!isSafeHeaderName(key)) continue;
      (responseHeaders[key] ??= []).push(line.slice(i + 1).trim());
    }
    responseHeadSent = true;
    if (!send({ t: "head", sid: frame.sid, status: Number.isFinite(status) ? status : 502, headers: responseHeaders })) {
      abort("frontdoor backpressure");
      return;
    }
    if (rest.length > 0 && !sendData(rest)) abort("frontdoor backpressure");
  });
  tcp.on("close", () => {
    if (finished) return;
    if (!responseHeadSent) {
      abort("target unreachable");
      return;
    }
    finished = true;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    streams.delete(frame.sid);
    send({ t: "end", sid: frame.sid });
  });
  tcp.on("error", () => abort("target unreachable"));
}

const unsafeHeaderNames = new Set(["__proto__", "constructor", "prototype"]);
const isSafeHeaderName = (name: string): boolean => !unsafeHeaderNames.has(name.toLowerCase());

function withTargetHost(
  input: Record<string, string[]>,
  targetHost: string,
  targetPort?: number,
): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (const [key, values] of Object.entries(input)) {
    if (isSafeHeaderName(key) && key.toLowerCase() !== "host") out[key] = values;
  }
  out.host = [`${targetHost}:${targetPort ?? 80}`];
  return out;
}

function flatten(h: Record<string, string[]>): Record<string, string | string[]> {
  const out = Object.create(null) as Record<string, string | string[]>;
  for (const [k, v] of Object.entries(h)) {
    if (isSafeHeaderName(k)) out[k] = v.length === 1 ? v[0]! : v;
  }
  return out;
}

function groupHeaders(raw: string[]): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (let i = 0; i < raw.length; i += 2) {
    const key = raw[i]!.toLowerCase();
    if (isSafeHeaderName(key)) (out[key] ??= []).push(raw[i + 1]!);
  }
  return out;
}

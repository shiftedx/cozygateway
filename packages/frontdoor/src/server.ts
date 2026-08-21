import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";

import { decodeFrame, encodeFrame, MAX_MESSAGE_BYTES, type Frame } from "./frames.ts";
import { createProvisionApp } from "./provision.ts";
import { AgentRegistry, type AgentLink } from "./registry.ts";
import { proxyRequest, proxyUpgrade, type OpenStream } from "./router.ts";
import { errorBody } from "./schemas.ts";
import { openFrontdoorStorage, type FrontdoorStorage } from "./storage.ts";

export interface FrontdoorConfig {
  port: number; host: string; dbPath: string;
  pool: string[]; maxHouseholds: number; provisionsPerHourPerIp: number;
  apiHostnames: string[];
  maxActiveStreams?: number;
  maxActiveStreamsPerHousehold?: number;
  streamIdleTimeoutMs?: number;
}

export interface RunningFrontdoor {
  url: string; port: number; storage: FrontdoorStorage; registry: AgentRegistry;
  close(): Promise<void>;
}

export const MAX_ACTIVE_STREAMS = 512;
export const MAX_ACTIVE_STREAMS_PER_HOUSEHOLD = 64;

const canonicalHostname = (hostname: string): string => hostname.split(":")[0]!.toLowerCase();
const hostOf = (req: IncomingMessage): string => canonicalHostname(req.headers.host ?? "");

export async function startFrontdoor(config: FrontdoorConfig): Promise<RunningFrontdoor> {
  const storage = openFrontdoorStorage(config.dbPath);
  const pool = config.pool.map(canonicalHostname);
  const apiHostnames = config.apiHostnames.map(canonicalHostname);
  storage.syncPool(pool);
  const registry = new AgentRegistry();
  const poolSet = new Set(pool);
  const apiHostnamesSet = new Set(apiHostnames);
  const provisionApp = createProvisionApp({
    storage, now: () => Date.now(),
    maxHouseholds: config.maxHouseholds, provisionsPerHourPerIp: config.provisionsPerHourPerIp,
    disconnectHousehold: (householdId) => registry.get(householdId)?.close(),
  });
  const provisionListener = getRequestListener(provisionApp.fetch);
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  // per-agent stream tables so a dying agent aborts exactly its own streams
  const agentStreams = new Map<AgentLink, Map<number, OpenStream>>();
  const agentSockets = new Set<WebSocket>();
  let activeStreams = 0;
  const activeStreamsByHousehold = new Map<string, number>();
  const maxActiveStreams = config.maxActiveStreams ?? MAX_ACTIVE_STREAMS;
  const maxActiveStreamsPerHousehold = config.maxActiveStreamsPerHousehold ?? MAX_ACTIVE_STREAMS_PER_HOUSEHOLD;

  const reserveStream = (householdId: string): boolean => {
    const householdStreams = activeStreamsByHousehold.get(householdId) ?? 0;
    if (activeStreams >= maxActiveStreams || householdStreams >= maxActiveStreamsPerHousehold) return false;
    activeStreams += 1;
    activeStreamsByHousehold.set(householdId, householdStreams + 1);
    return true;
  };
  const releaseStream = (householdId: string): void => {
    activeStreams = Math.max(0, activeStreams - 1);
    const next = (activeStreamsByHousehold.get(householdId) ?? 1) - 1;
    if (next <= 0) activeStreamsByHousehold.delete(householdId);
    else activeStreamsByHousehold.set(householdId, next);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer((req, res) => {
    const host = hostOf(req);
    if (poolSet.has(host)) {
      const hh = storage.householdIdForHostname(host);
      if (hh === undefined) return json(res, 404, errorBody("unknown_hostname", "This relay hostname is not assigned."));
      const link = registry.get(hh);
      if (link === undefined) return json(res, 502, errorBody("agent_offline", "The household box is not connected."));
      const streams = agentStreams.get(link);
      if (streams === undefined) return json(res, 502, errorBody("agent_offline", "The household box is not connected."));
      if (!reserveStream(hh)) return json(res, 503, errorBody("stream_cap", "Too many active streams right now."));
      return proxyRequest(registry, link, req, res, streams, {
        idleTimeoutMs: config.streamIdleTimeoutMs,
        onClosed: () => releaseStream(hh),
      });
    }
    if (config.apiHostnames.length === 0 || config.apiHostnames.includes(host)) return provisionListener(req, res);
    return json(res, 404, errorBody("unknown_hostname", "Unrecognized hostname."));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const rejectUpgrade = (status: number, reason: string) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
    };
    const host = hostOf(req);
    if (req.url === "/agent") {
      if (apiHostnamesSet.size > 0 && !apiHostnamesSet.has(host)) {
        rejectUpgrade(404, "Not Found");
        return;
      }
      const auth = req.headers.authorization ?? "";
      const credential = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const householdId = storage.householdIdForCredential(credential);
      if (householdId === undefined) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const streams = new Map<number, OpenStream>();
        const link: AgentLink = {
          send(frame: Frame) {
            const payload = encodeFrame(frame);
            if (Buffer.byteLength(payload, "utf8") > MAX_MESSAGE_BYTES) throw new Error("frame too large");
            ws.send(payload);
          },
          close() { ws.close(); },
          bufferedAmount() { return ws.bufferedAmount; },
        };
        agentStreams.set(link, streams);
        agentSockets.add(ws);
        registry.attach(householdId, link);
        console.log(`frontdoor: agent attached for ${householdId}`);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          registry.detach(householdId, link);
          for (const s of [...streams.values()]) s.onFrame({ t: "abort", sid: s.sid, reason: "agent disconnected" });
          agentStreams.delete(link);
          agentSockets.delete(ws);
        };
        ws.on("message", (raw) => {
          const frame = decodeFrame(String(raw));
          if (frame === undefined) return;
          streams.get(frame.sid)?.onFrame(frame);
        });
        ws.on("error", cleanup);
        ws.on("close", cleanup);
      });
      return;
    }
    if (poolSet.has(host)) {
      const householdId = storage.householdIdForHostname(host);
      if (householdId === undefined) {
        rejectUpgrade(404, "Not Found");
        return;
      }
      const link = registry.get(householdId);
      if (link === undefined) {
        rejectUpgrade(502, "Bad Gateway");
        return;
      }
      const streams = agentStreams.get(link);
      if (streams === undefined) {
        rejectUpgrade(502, "Bad Gateway");
        return;
      }
      if (!reserveStream(householdId)) {
        rejectUpgrade(503, "Service Unavailable");
        return;
      }
      proxyUpgrade(registry, link, req, socket, head, streams, {
        idleTimeoutMs: config.streamIdleTimeoutMs,
        onClosed: () => releaseStream(householdId),
      });
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${port}`, port, storage, registry,
    async close() {
      if (closePromise !== undefined) return closePromise;
      closePromise = (async () => {
        for (const ws of agentSockets) ws.terminate();
        await Promise.all([
          new Promise<void>((resolve) => wss.close(() => resolve())),
          new Promise<void>((resolve) => server.close(() => resolve())),
        ]);
        storage.close();
      })();
      return closePromise;
    },
  };
}

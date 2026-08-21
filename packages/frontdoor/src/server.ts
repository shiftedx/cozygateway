import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";

import { decodeFrame, encodeFrame, type Frame } from "./frames.ts";
import { createProvisionApp } from "./provision.ts";
import { AgentRegistry, type AgentLink } from "./registry.ts";
import { proxyRequest, type OpenStream } from "./router.ts";
import { errorBody } from "./schemas.ts";
import { openFrontdoorStorage, type FrontdoorStorage } from "./storage.ts";

export interface FrontdoorConfig {
  port: number; host: string; dbPath: string;
  pool: string[]; maxHouseholds: number; provisionsPerHourPerIp: number;
  apiHostnames: string[];
}

export interface RunningFrontdoor {
  url: string; port: number; storage: FrontdoorStorage; registry: AgentRegistry;
  close(): Promise<void>;
}

const hostOf = (req: IncomingMessage): string => (req.headers.host ?? "").split(":")[0]!;

export async function startFrontdoor(config: FrontdoorConfig): Promise<RunningFrontdoor> {
  const storage = openFrontdoorStorage(config.dbPath);
  storage.syncPool(config.pool);
  const registry = new AgentRegistry();
  const poolSet = new Set(config.pool);
  const provisionApp = createProvisionApp({
    storage, now: () => Date.now(),
    maxHouseholds: config.maxHouseholds, provisionsPerHourPerIp: config.provisionsPerHourPerIp,
  });
  const provisionListener = getRequestListener(provisionApp.fetch);
  const wss = new WebSocketServer({ noServer: true });
  // per-agent stream tables so a dying agent aborts exactly its own streams
  const agentStreams = new Map<AgentLink, Map<number, OpenStream>>();
  const agentSockets = new Set<WebSocket>();

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
      return proxyRequest(registry, link, req, res, streams);
    }
    if (config.apiHostnames.length === 0 || config.apiHostnames.includes(host)) return provisionListener(req, res);
    return json(res, 404, errorBody("unknown_hostname", "Unrecognized hostname."));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const host = hostOf(req);
    if (!poolSet.has(host) && req.url === "/agent") {
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
          send(frame: Frame) { ws.send(encodeFrame(frame)); },
          close() { ws.close(); },
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
          for (const s of streams.values()) s.onFrame({ t: "abort", sid: s.sid, reason: "agent disconnected" });
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
    // Upgrade requests bound for a pool hostname are the ts2021 path: Task 5.
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

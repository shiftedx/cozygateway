import { afterEach, describe, expect, it } from "vitest";
import { BotVoiceSchema, check } from "cozygateway-contract";
import type { WebSocket } from "ws";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import { SPEAK_QUEUE_HIGH_WATER_BYTES, decodeDataUrl, speakThroughHermes, voiceFromConfig } from "../src/hermes-bridge/voice.ts";
import { HermesRpcError, HermesTimeout, type HermesClient } from "../src/hermes-bridge/client.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startFakeHermesServer, type FakeHermesBehavior, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 86 (voice): `GET /bots/:name/voice` and `POST /bots/:name/speak`, over the bot's OWN
 *  profile. The speak-stream frames are the ones Hermes 068db016fb sends (`hermes_cli/web_routers/
 *  audio.py`): `start` with the rate, binary int16 PCM, `end`; or `fallback` for a provider with no
 *  chunked API (edge, which the Mac's `cleo` uses), answered by `POST /api/audio/speak`'s data URL. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Four bytes of a real `/api/audio/speak` answer for "hello" through cleo's edge voice. */
const MP3_HEAD = Buffer.from([0xff, 0xf3, 0x64, 0xc4]);

async function setup(behavior: FakeHermesBehavior) {
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({ profiles: [{ name: "default" }, { name: "cleo" }] }),
    },
    ...behavior,
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const bridge = new HermesBridge({ client, storage, broadcast: () => {}, now: () => 1_800_000_000_000, logSink: () => {} });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 86 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };
  bridge.start();
  await until(() => client.state() === "online");
  lastClient = client;
  return (path: string, init?: RequestInit) =>
    app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } });
}
let lastClient: HermesClient | undefined;

const speak = (text: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),
});

describe("voice: pure rules", () => {
  it("reads the provider and its voice, defaulting to Hermes's edge", () => {
    expect(voiceFromConfig("cleo", { tts: { provider: "edge", edge: { voice: "en-US-AriaNeural" } } }))
      .toEqual({ name: "cleo", configured: true, provider: "edge", voice: "en-US-AriaNeural" });
    expect(voiceFromConfig("cleo", { tts: { provider: "ElevenLabs", elevenlabs: { voice_id: "pNIn" } } }))
      .toEqual({ name: "cleo", configured: true, provider: "elevenlabs", voice: "pNIn" });
    expect(voiceFromConfig("cleo", { tts: {} })).toEqual({ name: "cleo", configured: true, provider: "edge" });
  });

  it("is not configured without a tts block or with the provider switched off", () => {
    expect(voiceFromConfig("cleo", { model: {} })).toEqual({ name: "cleo", configured: false });
    expect(voiceFromConfig("cleo", { tts: { provider: "none" } })).toEqual({ name: "cleo", configured: false });
    expect(voiceFromConfig("cleo", null)).toEqual({ name: "cleo", configured: false });
  });

  it("decodes only audio data URLs", () => {
    expect(decodeDataUrl(`data:audio/mpeg;base64,${MP3_HEAD.toString("base64")}`))
      .toEqual({ mimeType: "audio/mpeg", bytes: new Uint8Array(MP3_HEAD) });
    expect(decodeDataUrl("data:text/html;base64,PGI+")).toBeUndefined();
    expect(decodeDataUrl("https://example.com/a.mp3")).toBeUndefined();
  });
});

describe("GET /bots/:name/voice", () => {
  it("answers the bot's own profile voice", async () => {
    const profiles: string[] = [];
    const authed = await setup({
      dashboard: ({ path, query }) => {
        expect(path).toBe("/api/config");
        profiles.push(query.get("profile") ?? "");
        return { body: { tts: { provider: "openai", openai: { voice: "alloy" } } } };
      },
    });
    const res = await authed("/bots/cleo/voice");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(check(BotVoiceSchema, body)).toBe(true);
    expect(body).toEqual({ name: "cleo", configured: true, provider: "openai", voice: "alloy" });
    expect(profiles).toEqual(["cleo"]);
  });

  it("is 404 for a name that names no profile", async () => {
    const authed = await setup({ dashboard: () => ({ body: {} }) });
    expect((await authed("/bots/nobody/voice")).status).toBe(404);
  });
});

describe("POST /bots/:name/speak", () => {
  it("streams Hermes's PCM through with its rate, under the bot's profile", async () => {
    const seen: Array<{ query: string; frames: unknown[] }> = [];
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket, query) => {
          const entry = { query: query.toString(), frames: [] as unknown[] };
          seen.push(entry);
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as Record<string, unknown>;
            entry.frames.push(frame);
            if (frame["done"] !== true) return;
            ws.send(JSON.stringify({ type: "start", sample_rate: 22_050, channels: 1 }));
            ws.send(Buffer.from([1, 0, 2, 0]));
            ws.send(Buffer.from([3, 0]));
            ws.send(JSON.stringify({ type: "end" }));
          });
        },
      },
    });
    const res = await authed("/bots/cleo/speak", speak("Hello there."));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/pcm;rate=22050;channels=1");
    expect(res.headers.get("x-audio-sample-rate")).toBe("22050");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 0, 2, 0, 3, 0]);
    const query = new URLSearchParams(seen[0]!.query);
    expect(query.get("profile")).toBe("cleo");
    expect(query.get("token")).toBe("T");
    expect(seen[0]!.frames).toEqual([{ text: "Hello there.", done: true }]);
  });

  it("answers the whole file when the voice has no chunked API", async () => {
    const speaks: Array<{ profile: string | null; body: unknown }> = [];
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket) => {
          ws.send(JSON.stringify({ type: "fallback" }));
          ws.close();
        },
      },
      dashboard: ({ method, path, query, body }) => {
        expect(`${method} ${path}`).toBe("POST /api/audio/speak");
        speaks.push({ profile: query.get("profile"), body });
        return {
          body: {
            ok: true,
            data_url: `data:audio/mpeg;base64,${MP3_HEAD.toString("base64")}`,
            mime_type: "audio/mpeg",
            provider: "edge",
          },
        };
      },
    });
    const res = await authed("/bots/cleo/speak", speak("hello"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(MP3_HEAD);
    expect(speaks).toEqual([{ profile: "cleo", body: { text: "hello" } }]);
  });

  it("passes Hermes's refusal on as a 502 with its sentence", async () => {
    const authed = await setup({
      sidecars: { "/api/audio/speak-stream": (ws: WebSocket) => ws.send(JSON.stringify({ type: "fallback" })) },
      dashboard: () => ({ status: 400, body: { detail: "edge-tts is not installed" } }),
    });
    const res = await authed("/bots/cleo/speak", speak("hello"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ hermesError: "edge-tts is not installed" });
  });

  it("refuses blank text before reaching Hermes", async () => {
    let dialed = 0;
    const authed = await setup({ sidecars: { "/api/audio/speak-stream": () => void (dialed += 1) } });
    expect((await authed("/bots/cleo/speak", speak("   "))).status).toBe(400);
    expect((await authed("/bots/cleo/speak", speak(""))).status).toBe(400);
    expect((await authed("/bots/cleo/speak", { method: "POST", body: "nope" })).status).toBe(400);
    expect(dialed).toBe(0);
  });

  it("tells Hermes to stop when the phone hangs up mid-speech", async () => {
    const frames: unknown[] = [];
    let closed = false;
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket) => {
          ws.on("close", () => void (closed = true));
          ws.on("message", (data) => {
            const frame = JSON.parse(data.toString()) as Record<string, unknown>;
            frames.push(frame);
            if (frame["done"] === true) {
              ws.send(JSON.stringify({ type: "start", sample_rate: 24_000, channels: 1 }));
              ws.send(Buffer.alloc(8));
            }
          });
        },
      },
    });
    const res = await authed("/bots/cleo/speak", speak("A long reply."));
    const reader = res.body!.getReader();
    expect((await reader.read()).value?.byteLength).toBe(8);
    await reader.cancel();
    await until(() => closed);
    expect(frames).toContainEqual({ stop: true });
  });
});

describe("POST /bots/:name/speak: review fixes", () => {
  it("stops Hermes when the phone hangs up before the first frame", async () => {
    const frames: unknown[] = [];
    let closed = false;
    let connected = false;
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket) => {
          connected = true;
          ws.on("close", () => void (closed = true));
          // Resolving the voice: nothing is sent yet.
          ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
        },
      },
    });
    const hangUp = new AbortController();
    const pending = authed("/bots/cleo/speak", { ...speak("Hello."), signal: hangUp.signal });
    await until(() => connected && frames.length > 0);
    hangUp.abort();
    const res = await Promise.resolve(pending).catch(() => undefined);
    await until(() => closed);
    expect(frames).toContainEqual({ stop: true });
    if (res !== undefined) expect(res.status).not.toBe(200);
  });

  it("answers 502 when Hermes ends without any audio", async () => {
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket) => {
          ws.on("message", () => {
            ws.send(JSON.stringify({ type: "start", sample_rate: 24_000, channels: 1 }));
            ws.send(JSON.stringify({ type: "end" }));
          });
        },
      },
    });
    const res = await authed("/bots/cleo/speak", speak("hello"));
    expect(res.status).toBe(502);
  });

  it("streams past the back-pressure mark without losing a byte", async () => {
    const total = SPEAK_QUEUE_HIGH_WATER_BYTES * 3;
    const authed = await setup({
      sidecars: {
        "/api/audio/speak-stream": (ws: WebSocket) => {
          ws.on("message", () => {
            ws.send(JSON.stringify({ type: "start", sample_rate: 24_000, channels: 1 }));
            for (let sent = 0; sent < total; sent += 64 * 1024) ws.send(Buffer.alloc(64 * 1024, 7));
            ws.send(JSON.stringify({ type: "end" }));
          });
        },
      },
    });
    const res = await authed("/bots/cleo/speak", speak("A long reply."));
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(total);
  });

  it("gives the whole-file synthesis its own budget and maps running out to a timeout", async () => {
    await setup({
      sidecars: { "/api/audio/speak-stream": (ws: WebSocket) => ws.send(JSON.stringify({ type: "fallback" })) },
      dashboard: () => new Promise((resolve) => setTimeout(() => resolve({ body: {} }), 400)),
    });
    await expect(speakThroughHermes(lastClient!, "cleo", "hello", { wholeTimeoutMs: 50 }))
      .rejects.toBeInstanceOf(HermesTimeout);
  });

  it("treats an HTTP 403 before the upgrade as a refused credential", async () => {
    const server = createServer((_req, res) => res.end());
    server.on("upgrade", (_req, socket) => {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = { sidecarSocketUrl: async () => `ws://127.0.0.1:${port}/api/audio/speak-stream` } as unknown as HermesClient;
      const failure = await speakThroughHermes(client, "cleo", "hello").catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(HermesRpcError);
      expect((failure as HermesRpcError).code).toBe(403);
    } finally {
      server.close();
    }
  });
});

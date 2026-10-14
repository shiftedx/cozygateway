import { WebSocket, type RawData } from "ws";
import type { BotVoice } from "cozygateway-contract";

import { HermesRpcError, HermesTimeout, HermesUnavailable, type HermesClient } from "./client.ts";

/** Capability 86 (voice): a bot speaks with its OWN profile's `tts.*` on its own Hermes, exactly as
 *  upstream Bot Mode does (docs `bot-mode.md#voices`). The gateway adds no speech engine. It asks
 *  Hermes to synthesize under the bot's profile and hands the audio to the phone:
 *
 *  - `/api/audio/speak-stream?profile=` (a sibling WebSocket of `/api/ws`) streams raw int16 PCM
 *    for providers with a chunked API. The gateway sends `{text, done: true}` and passes the PCM
 *    through as it arrives, so the phone starts speaking before synthesis ends.
 *  - A provider without one answers `{"type":"fallback"}`, the documented cue to use
 *    `POST /api/audio/speak?profile=`, which returns the whole file as a `data:` URL.
 *
 *  `voice.tts {profile}` is NOT used: it plays through the Hermes host's own speakers, which is the
 *  desktop's case, not a phone's. */

export const SPEAK_STREAM_PATH = "/api/audio/speak-stream";
/** How long Hermes may take to resolve the provider and send its first frame (start or fallback). */
export const SPEAK_FIRST_FRAME_TIMEOUT_MS = 30_000;

export type BotSpeech =
  | {
    kind: "pcm";
    sampleRate: number;
    channels: number;
    /** Raw little-endian int16 PCM, in order, until Hermes says `end` or the socket closes. */
    chunks: AsyncIterable<Uint8Array>;
    /** Barge-in: tells Hermes to stop synthesizing and closes the socket. Idempotent. */
    stop(): void;
  }
  | { kind: "encoded"; mimeType: string; bytes: Uint8Array };

const DISABLED_PROVIDERS = new Set(["none", "off", "false", "disabled"]);
/** Hermes's own default when `tts.provider` is unset (`tools/tts_tool.py` DEFAULT_PROVIDER). */
const HERMES_DEFAULT_TTS_PROVIDER = "edge";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

/** The voice a profile's config names, by Hermes's own resolution rule: no `tts` block at all (or a
 *  provider switched off) is "not configured"; a block without a provider is Hermes's default. The
 *  voice is the provider section's `voice` or `voice_id` (ElevenLabs), when it names one. */
export function voiceFromConfig(name: string, config: unknown): BotVoice {
  const tts = record(record(config)?.["tts"]);
  if (tts === undefined) return { name, configured: false };
  const provider = (text(tts["provider"], 64) ?? HERMES_DEFAULT_TTS_PROVIDER).toLowerCase();
  if (DISABLED_PROVIDERS.has(provider)) return { name, configured: false };
  const section = record(tts[provider]);
  const voice = text(section?.["voice"], 200) ?? text(section?.["voice_id"], 200);
  return { name, configured: true, provider, ...(voice === undefined ? {} : { voice }) };
}

export async function readBotVoice(client: HermesClient, profile: string): Promise<BotVoice> {
  const config = await client.dashboardJson(`/api/config?profile=${encodeURIComponent(profile)}`);
  return voiceFromConfig(profile, config);
}

/** `data:<mime>;base64,<payload>` -> bytes. Anything else is a Hermes answer this gateway cannot pass on. */
export function decodeDataUrl(value: unknown): { mimeType: string; bytes: Uint8Array } | undefined {
  if (typeof value !== "string" || !value.startsWith("data:")) return undefined;
  const comma = value.indexOf(",");
  if (comma < 0) return undefined;
  const header = value.slice(5, comma);
  if (!header.endsWith(";base64")) return undefined;
  const mimeType = header.slice(0, -";base64".length).trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(mimeType)) return undefined;
  const bytes = Buffer.from(value.slice(comma + 1), "base64");
  return bytes.length === 0 ? undefined : { mimeType, bytes: new Uint8Array(bytes) };
}

/** Synthesis of a long reply can take a while; the ordinary 10 s dashboard budget cannot. */
export const SPEAK_WHOLE_TIMEOUT_MS = 120_000;

async function speakWhole(client: HermesClient, profile: string, spoken: string,
                          signal: AbortSignal | undefined, timeoutMs: number): Promise<BotSpeech> {
  const path = `/api/audio/speak?profile=${encodeURIComponent(profile)}`;
  let response: Response;
  try {
    response = await client.dashboardResponse(path, {
      method: "POST", body: { text: spoken }, timeoutMs, ...(signal === undefined ? {} : { signal }),
    });
  } catch (err) {
    if (signal?.aborted === true) throw err;
    if ((err as Error).name === "TimeoutError") throw new HermesTimeout("POST /api/audio/speak", timeoutMs);
    throw new HermesUnavailable(`hermes speech request failed: ${(err as Error).message}`);
  }
  const body = record(await response.json().catch(() => undefined));
  if (!response.ok) {
    const detail = typeof body?.["detail"] === "string"
      ? body["detail"] : `hermes speech request failed (HTTP ${response.status})`;
    throw new HermesRpcError(detail, response.status, body);
  }
  const decoded = decodeDataUrl(body?.["data_url"]);
  if (decoded === undefined) throw new HermesRpcError("hermes answered speech without audio", undefined, undefined);
  return { kind: "encoded", ...decoded };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Hermes may run ahead of a slow phone. Above this many queued bytes the socket is paused (TCP
 *  back-pressure reaches Hermes) and resumed as the phone drains it. About 10 s of 24 kHz mono. */
export const SPEAK_QUEUE_HIGH_WATER_BYTES = 512 * 1024;

/** Synthesizes `spoken` with profile `profile`'s own voice. Resolves once the first audio exists (the
 *  first PCM frame, or the whole file), so a synthesis that produces nothing is an error, not an
 *  empty 200. PCM keeps arriving through `chunks` after that. An abort of `signal` at any point,
 *  including before the first frame, tells Hermes to stop and closes the socket. */
export async function speakThroughHermes(
  client: HermesClient,
  profile: string,
  spoken: string,
  opts: { firstFrameTimeoutMs?: number; wholeTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BotSpeech> {
  const { signal } = opts;
  const wholeTimeoutMs = opts.wholeTimeoutMs ?? SPEAK_WHOLE_TIMEOUT_MS;
  signal?.throwIfAborted();
  // A client without the sibling-socket seam can still speak, just not incrementally.
  if (client.sidecarSocketUrl === undefined) return speakWhole(client, profile, spoken, signal, wholeTimeoutMs);
  const url = await client.sidecarSocketUrl(SPEAK_STREAM_PATH, { profile });
  signal?.throwIfAborted();
  const socket = new WebSocket(url, { perMessageDeflate: false });

  const queue: Uint8Array[] = [];
  let queued = 0;
  let paused = false;
  let finished = false;
  let wake: (() => void) | undefined;
  const settle = () => {
    finished = true;
    wake?.();
  };
  const stop = () => {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ stop: true }));
      } catch { /* closing anyway */ }
    }
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
    settle();
  };
  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });

  let format: { sampleRate: number; channels: number } | undefined;
  const first = await new Promise<"fallback" | { sampleRate: number; channels: number }>((resolve, reject) => {
    let answered = false;
    const answer = (fn: () => void) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => answer(() => {
      socket.terminate();
      reject(new HermesUnavailable("hermes did not start speaking in time"));
    }), opts.firstFrameTimeoutMs ?? SPEAK_FIRST_FRAME_TIMEOUT_MS);
    signal?.addEventListener("abort", () => answer(() => reject(signal.reason ?? new Error("aborted"))), { once: true });
    socket.on("open", () => socket.send(JSON.stringify({ text: spoken, done: true })));
    // Refused before the upgrade (a gated dashboard answers the HTTP request itself).
    socket.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      socket.terminate();
      answer(() => reject(status === 401 || status === 403
        ? new HermesRpcError(`hermes refused the speech socket (HTTP ${status})`, status)
        : new HermesUnavailable(`hermes answered the speech socket with HTTP ${status}`)));
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = toBytes(data);
        queue.push(bytes);
        queued += bytes.byteLength;
        if (queued > SPEAK_QUEUE_HIGH_WATER_BYTES && !paused) {
          paused = true;
          socket.pause();
        }
        wake?.();
        if (format !== undefined) answer(() => resolve(format!));
        return;
      }
      let frame: Record<string, unknown> | undefined;
      try {
        frame = record(JSON.parse(data.toString()));
      } catch {
        frame = undefined;
      }
      const type = frame?.["type"];
      if (type === "fallback" && format === undefined) {
        socket.close();
        answer(() => resolve("fallback"));
      } else if (type === "start" && format === undefined) {
        const sampleRate = Number(frame?.["sample_rate"]);
        const channels = Number(frame?.["channels"] ?? 1);
        format = {
          sampleRate: Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : 24_000,
          channels: Number.isInteger(channels) && channels > 0 ? channels : 1,
        };
        if (queue.length > 0) answer(() => resolve(format!));
      } else if (type === "end") {
        socket.close();
        settle();
        // `end` before any audio: Hermes's synthesis failed (it logs and ends the session).
        answer(() => reject(new HermesRpcError("hermes synthesized no audio for this text", undefined, undefined)));
      }
    });
    socket.on("error", (err) => {
      settle();
      answer(() => reject(new HermesUnavailable(`hermes speech socket failed: ${err.message}`)));
    });
    socket.on("close", (code) => {
      settle();
      // 4401/4403 are Hermes refusing the credential; anything else before audio is a drop.
      answer(() => reject(code === 4401 || code === 4403
        ? new HermesRpcError(`hermes refused the speech socket (close code ${code})`, code)
        : new HermesUnavailable(`hermes closed the speech socket before speaking (close code ${code})`)));
    });
  }).catch((err: unknown) => {
    signal?.removeEventListener("abort", onAbort);
    stop();
    throw err;
  });

  if (first === "fallback") {
    signal?.removeEventListener("abort", onAbort);
    return speakWhole(client, profile, spoken, signal, wholeTimeoutMs);
  }

  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
          queued -= next.byteLength;
          if (paused && queued <= SPEAK_QUEUE_HIGH_WATER_BYTES / 2) {
            paused = false;
            socket.resume();
          }
          yield next;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      stop();
    }
  }

  return { kind: "pcm", ...first, chunks: chunks(), stop };
}

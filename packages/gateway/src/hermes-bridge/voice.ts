import { WebSocket, type RawData } from "ws";
import type { BotVoice } from "cozygateway-contract";

import { HermesRpcError, HermesUnavailable, type HermesClient } from "./client.ts";

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

async function speakWhole(client: HermesClient, profile: string, spoken: string): Promise<BotSpeech> {
  const body = await client.dashboardJson<Record<string, unknown>>(
    `/api/audio/speak?profile=${encodeURIComponent(profile)}`,
    { method: "POST", body: { text: spoken } },
  );
  const decoded = decodeDataUrl(body?.["data_url"]);
  if (decoded === undefined) throw new HermesRpcError("hermes answered speech without audio", undefined, undefined);
  return { kind: "encoded", ...decoded };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Synthesizes `spoken` with profile `profile`'s own voice. Resolves once Hermes has said which of the
 *  two shapes it will answer with; PCM keeps arriving through `chunks` after that. */
export async function speakThroughHermes(
  client: HermesClient,
  profile: string,
  spoken: string,
  opts: { firstFrameTimeoutMs?: number } = {},
): Promise<BotSpeech> {
  // A client without the sibling-socket seam can still speak, just not incrementally.
  if (client.sidecarSocketUrl === undefined) return speakWhole(client, profile, spoken);
  const url = await client.sidecarSocketUrl(SPEAK_STREAM_PATH, { profile });
  const socket = new WebSocket(url, { perMessageDeflate: false });

  const queue: Uint8Array[] = [];
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
    socket.close();
    settle();
  };

  const first = await new Promise<"fallback" | { sampleRate: number; channels: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new HermesUnavailable("hermes did not start speaking in time"));
    }, opts.firstFrameTimeoutMs ?? SPEAK_FIRST_FRAME_TIMEOUT_MS);
    let started = false;
    socket.on("open", () => socket.send(JSON.stringify({ text: spoken, done: true })));
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        queue.push(toBytes(data));
        wake?.();
        return;
      }
      let frame: Record<string, unknown> | undefined;
      try {
        frame = record(JSON.parse(data.toString()));
      } catch {
        frame = undefined;
      }
      const type = frame?.["type"];
      if (type === "fallback" && !started) {
        clearTimeout(timer);
        socket.close();
        resolve("fallback");
      } else if (type === "start" && !started) {
        started = true;
        clearTimeout(timer);
        const sampleRate = Number(frame?.["sample_rate"]);
        const channels = Number(frame?.["channels"] ?? 1);
        resolve({
          sampleRate: Number.isInteger(sampleRate) && sampleRate > 0 ? sampleRate : 24_000,
          channels: Number.isInteger(channels) && channels > 0 ? channels : 1,
        });
      } else if (type === "end") {
        socket.close();
        settle();
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      settle();
      reject(new HermesUnavailable(`hermes speech socket failed: ${err.message}`));
    });
    socket.on("close", (code) => {
      clearTimeout(timer);
      settle();
      if (!started) {
        // 4401/4403 are Hermes refusing the credential; anything else before a first frame is a drop.
        reject(code === 4401 || code === 4403
          ? new HermesRpcError(`hermes refused the speech socket (close code ${code})`, code)
          : new HermesUnavailable(`hermes closed the speech socket before speaking (close code ${code})`));
      }
    });
  });

  if (first === "fallback") return speakWhole(client, profile, spoken);

  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for (;;) {
        const next = queue.shift();
        if (next !== undefined) {
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
      stop();
    }
  }

  return { kind: "pcm", ...first, chunks: chunks(), stop };
}

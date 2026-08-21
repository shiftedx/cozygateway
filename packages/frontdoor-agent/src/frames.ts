export type Frame =
  | { t: "open"; sid: number; method: string; path: string; headers: Record<string, string[]>; upgrade: boolean }
  | { t: "head"; sid: number; status: number; headers: Record<string, string[]> }
  | { t: "data"; sid: number; b64: string }
  | { t: "end"; sid: number }
  | { t: "abort"; sid: number; reason?: string };

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const MAX_DECODED_DATA_BYTES = 4 * 1024 * 1024;
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
export const STREAM_IDLE_TIMEOUT_MS = 60 * 1000;

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f);
}

function isHeaders(v: unknown): v is Record<string, string[]> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.entries(v).every(([, a]) => Array.isArray(a) && a.every((s) => typeof s === "string"));
}

function isCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const paddingAt = value.indexOf("=");
  const contentEnd = paddingAt === -1 ? value.length : paddingAt;
  for (let i = 0; i < contentEnd; i += 1) {
    const code = value.charCodeAt(i);
    const base64Character = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f;
    if (!base64Character) return false;
  }
  if (paddingAt !== -1) {
    const paddingLength = value.length - paddingAt;
    if (paddingLength > 2) return false;
    for (let i = paddingAt; i < value.length; i += 1) if (value[i] !== "=") return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

export function decodeFrame(raw: string): Frame | undefined {
  if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) return undefined;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return undefined; }
  if (typeof v !== "object" || v === null) return undefined;
  const f = v as Record<string, unknown>;
  if (typeof f.sid !== "number") return undefined;
  switch (f.t) {
    case "open":
      if (typeof f.method === "string" && typeof f.path === "string" && isHeaders(f.headers) && typeof f.upgrade === "boolean")
        return f as Frame;
      return undefined;
    case "head":
      if (typeof f.status === "number" && isHeaders(f.headers)) return f as Frame;
      return undefined;
    case "data":
      if (typeof f.b64 === "string" && isCanonicalBase64(f.b64) &&
        Buffer.byteLength(f.b64, "base64") <= MAX_DECODED_DATA_BYTES) return f as Frame;
      return undefined;
    case "end":
      return { t: "end", sid: f.sid };
    case "abort":
      if (f.reason !== undefined && typeof f.reason !== "string") return undefined;
      return { t: "abort", sid: f.sid, ...(typeof f.reason === "string" ? { reason: f.reason } : {}) };
    default:
      return undefined;
  }
}

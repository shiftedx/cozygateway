export type Frame =
  | { t: "open"; sid: number; method: string; path: string; headers: Record<string, string[]>; upgrade: boolean }
  | { t: "head"; sid: number; status: number; headers: Record<string, string[]> }
  | { t: "data"; sid: number; b64: string }
  | { t: "end"; sid: number }
  | { t: "abort"; sid: number; reason?: string };

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f);
}

function isHeaders(v: unknown): v is Record<string, string[]> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.values(v).every((a) => Array.isArray(a) && a.every((s) => typeof s === "string"));
}

export function decodeFrame(raw: string): Frame | undefined {
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
      if (typeof f.b64 === "string") return f as Frame;
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

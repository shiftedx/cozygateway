import { createHash } from "node:crypto";

/** Injected JSONL diagnostic sink. Callers pass only already-redacted scalar fields. */
export type TraceLog = (line: string) => void;

export function traceId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function emitTrace(log: TraceLog | undefined, event: string, fields: Record<string, boolean | number | string | null> = {}): void {
  log?.(JSON.stringify({ event, ...fields }));
}

import { createHash } from "node:crypto";

/** Capability 15 limits one settled assistant row to three media attempts. A fourth directive stays
 *  visible as text, even when one of the first three fails. */
export const ASSISTANT_MEDIA_MAX_PER_MESSAGE = 3;
export const ASSISTANT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

export const ASSISTANT_MEDIA_TYPES = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export interface AssistantMediaDirective {
  path: string;
  /** Stable without retaining the Hermes-host path in SQLite. The line number distinguishes two
   *  identical directives when only one of them was attempted. */
  key: string;
  line: number;
}

function directivePath(line: string): string | undefined {
  let text = line.trim();
  const outer = text[0];
  if (outer === "`" || outer === '"' || outer === "'") {
    if (text.at(-1) !== outer || text.length < 2) return undefined;
    text = text.slice(1, -1).trim();
  }
  const match = /^MEDIA:\s*(.+)$/i.exec(text);
  if (match === null) return undefined;
  let path = match[1]!.trim();
  const inner = path[0];
  if (inner === "`" || inner === '"' || inner === "'") {
    if (path.at(-1) !== inner || path.length < 2) return undefined;
    path = path.slice(1, -1).trim();
  }
  return path.length === 0 ? undefined : path;
}

function directiveKey(line: string, index: number): string {
  return createHash("sha256").update(`${index}\0${line}`).digest("hex");
}

/** Finds whole-line MEDIA directives outside fenced code. Both backtick and tilde fences are
 *  recognized; a fence may carry an info string, and only a matching fence closes it. */
export function assistantMediaDirectives(text: string): AssistantMediaDirective[] {
  const found: AssistantMediaDirective[] = [];
  let fence: { marker: "`" | "~"; width: number } | undefined;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const run = fenceMatch[1]!;
      const marker = run[0] as "`" | "~";
      if (fence === undefined) fence = { marker, width: run.length };
      else if (marker === fence.marker && run.length >= fence.width) fence = undefined;
      continue;
    }
    if (fence !== undefined) continue;
    const path = directivePath(line);
    if (path !== undefined) found.push({ path, key: directiveKey(line, index), line: index });
  }
  return found;
}

/** Removes only directives whose fetch and ingest succeeded. Empty edge lines are trimmed as a
 *  consequence, while spacing between ordinary prose lines is preserved. */
export function stripAssistantMediaDirectives(text: string, successfulKeys: ReadonlySet<string>): string {
  if (successfulKeys.size === 0) return text;
  return text
    .split("\n")
    .filter((line, index) => !successfulKeys.has(directiveKey(line, index)))
    .join("\n")
    .trim();
}

export interface DecodedAssistantMedia {
  bytes: Uint8Array;
  mime: string;
  ext: string;
}

/** Decodes the dashboard's JSON data URL without trusting its MIME claim or allowing base64
 *  expansion to cross the eight-megabyte cap. `sniff` is injected from photos.ts so there remains
 *  one magic-byte table in the runtime. */
export function decodeAssistantMediaDataUrl(
  dataUrl: string,
  sniff: (bytes: Uint8Array) => string | undefined,
): DecodedAssistantMedia {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl.trim());
  if (match === null) throw new Error("hermes returned an invalid media data URL");
  const declared = match[1]!.toLowerCase();
  if (!ASSISTANT_MEDIA_TYPES.has(declared)) throw new Error("hermes returned a disallowed media type");
  const encoded = match[2]!;
  if (encoded.length > Math.ceil(ASSISTANT_MEDIA_MAX_BYTES / 3) * 4) {
    throw new Error("hermes returned media over the size cap");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  if (bytes.byteLength === 0 || bytes.byteLength > ASSISTANT_MEDIA_MAX_BYTES) {
    throw new Error("hermes returned empty or oversized media");
  }
  const actual = sniff(bytes);
  if (actual === undefined || actual !== declared || !ASSISTANT_MEDIA_TYPES.has(actual)) {
    throw new Error("hermes media bytes did not match an allowed raster type");
  }
  return { bytes, mime: actual, ext: ASSISTANT_MEDIA_TYPES.get(actual)! };
}

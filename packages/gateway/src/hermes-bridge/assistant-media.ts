import { createHash } from "node:crypto";
import { FILE_MAX_BYTES, FILE_TYPES, acceptFileBytes } from "./documents.ts";

/** Capability 15 limits one settled assistant row to three media attempts. A fourth directive stays
 *  visible as text, even when one of the first three fails. */
export const ASSISTANT_MEDIA_MAX_PER_MESSAGE = 3;
export const ASSISTANT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const ASSISTANT_AUDIO_MAX_BYTES = 40 * 1024 * 1024;
export const ASSISTANT_VIDEO_MAX_BYTES = 40 * 1024 * 1024;
export const ASSISTANT_FILE_MAX_BYTES = FILE_MAX_BYTES;
/** Compatibility export for image-specific callers and tests. */
export const ASSISTANT_MEDIA_MAX_BYTES = ASSISTANT_IMAGE_MAX_BYTES;

export type AssistantMediaKind = "image" | "video" | "audio" | "file";

const fileMediaTypes: [string, { ext: string; kind: AssistantMediaKind; maxBytes: number }][] =
  [...FILE_TYPES].map(([mime, ext]) => [mime, { ext, kind: "file", maxBytes: FILE_MAX_BYTES }]);

export const ASSISTANT_MEDIA_TYPES = new Map<string, { ext: string; kind: AssistantMediaKind; maxBytes: number }>([
  ["image/png", { ext: "png", kind: "image", maxBytes: ASSISTANT_IMAGE_MAX_BYTES }],
  ["image/jpeg", { ext: "jpg", kind: "image", maxBytes: ASSISTANT_IMAGE_MAX_BYTES }],
  ["image/gif", { ext: "gif", kind: "image", maxBytes: ASSISTANT_IMAGE_MAX_BYTES }],
  ["image/webp", { ext: "webp", kind: "image", maxBytes: ASSISTANT_IMAGE_MAX_BYTES }],
  ["video/mp4", { ext: "mp4", kind: "video", maxBytes: ASSISTANT_VIDEO_MAX_BYTES }],
  ["video/quicktime", { ext: "mov", kind: "video", maxBytes: ASSISTANT_VIDEO_MAX_BYTES }],
  ["audio/mp4", { ext: "m4a", kind: "audio", maxBytes: ASSISTANT_AUDIO_MAX_BYTES }],
  ["audio/mpeg", { ext: "mp3", kind: "audio", maxBytes: ASSISTANT_AUDIO_MAX_BYTES }],
  ["audio/wav", { ext: "wav", kind: "audio", maxBytes: ASSISTANT_AUDIO_MAX_BYTES }],
  ["audio/x-wav", { ext: "wav", kind: "audio", maxBytes: ASSISTANT_AUDIO_MAX_BYTES }],
  ...fileMediaTypes,
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
  kind: AssistantMediaKind;
}

function at(bytes: Uint8Array, offset: number, ...expected: number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function isIsoBaseMedia(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && at(bytes, 4, 0x66, 0x74, 0x79, 0x70); // ftyp
}

function isQuickTime(bytes: Uint8Array): boolean {
  return isIsoBaseMedia(bytes) && at(bytes, 8, 0x71, 0x74, 0x20, 0x20); // QuickTime `qt  ` brand.
}

function bytesMatchMediaType(
  declared: string,
  bytes: Uint8Array,
  sniffImage: (bytes: Uint8Array) => string | undefined,
): boolean {
  if (declared.startsWith("image/")) return sniffImage(bytes) === declared;
  if (declared === "video/quicktime") return isQuickTime(bytes);
  if (declared === "video/mp4" || declared === "audio/mp4") return isIsoBaseMedia(bytes) && !isQuickTime(bytes);
  if (declared === "audio/mpeg") {
    return at(bytes, 0, 0x49, 0x44, 0x33) || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0);
  }
  if (declared === "audio/wav" || declared === "audio/x-wav") {
    return at(bytes, 0, 0x52, 0x49, 0x46, 0x46) && at(bytes, 8, 0x57, 0x41, 0x56, 0x45);
  }
  if (FILE_TYPES.has(declared)) {
    try { acceptFileBytes(declared, bytes); return true; } catch { return false; }
  }
  return false;
}

/** Shared byte-side acceptance for dashboard media and attach-v1's HTTP side channel. The latter
 * carries no data URL, but must preserve the exact same type allow-list, caps and magic checks. */
export function acceptAssistantMediaBytes(
  declared: string,
  bytes: Uint8Array,
  sniff: (bytes: Uint8Array) => string | undefined,
): DecodedAssistantMedia {
  const normalized = declared.toLowerCase();
  const accepted = ASSISTANT_MEDIA_TYPES.get(normalized);
  if (accepted === undefined) throw new Error("hermes returned a disallowed media type");
  if (bytes.byteLength === 0 || bytes.byteLength > accepted.maxBytes) {
    throw new Error("hermes returned empty or oversized media");
  }
  if (!bytesMatchMediaType(normalized, bytes, sniff)) {
    throw new Error("hermes media bytes did not match the declared allowed type");
  }
  return { bytes, mime: normalized, ext: accepted.ext, kind: accepted.kind };
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
  const accepted = ASSISTANT_MEDIA_TYPES.get(declared);
  if (accepted === undefined) throw new Error("hermes returned a disallowed media type");
  const encoded = match[2]!;
  // This check happens before Buffer allocates or decodes the payload. The dashboard response has
  // no separate byte length, so the base64 length is its declared-size equivalent.
  if (encoded.length > Math.ceil(accepted.maxBytes / 3) * 4) {
    throw new Error("hermes returned media over the size cap");
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  return acceptAssistantMediaBytes(declared, bytes, sniff);
}

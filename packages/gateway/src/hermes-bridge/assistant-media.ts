import { FILE_MAX_BYTES, FILE_TYPES, acceptFileBytes } from "./documents.ts";
import { PhotoRefused } from "./photos.ts";

export const ASSISTANT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const ASSISTANT_AUDIO_MAX_BYTES = 40 * 1024 * 1024;
export const ASSISTANT_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

export type AssistantMediaKind = "image" | "video" | "audio" | "file";

const fileMediaTypes: [string, { ext: string; kind: AssistantMediaKind; maxBytes: number }][] =
  [...FILE_TYPES].map(([mime, ext]) => [mime, { ext, kind: "file", maxBytes: FILE_MAX_BYTES }]);

/** The canonical upload allowlist. It is documented MIME by MIME in contract/ext-bots-v1.md, which
 *  the attach plugin's compatibility policy mirrors; the two must not drift. */
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
  if (accepted === undefined) throw new PhotoRefused("content_type", "hermes returned a disallowed media type");
  if (bytes.byteLength === 0) throw new PhotoRefused("empty", "hermes returned empty media");
  if (bytes.byteLength > accepted.maxBytes) throw new PhotoRefused("too_large", "hermes returned oversized media");
  if (!bytesMatchMediaType(normalized, bytes, sniff)) {
    throw new PhotoRefused("content_type", "hermes media bytes did not match the declared allowed type");
  }
  return { bytes, mime: normalized, ext: accepted.ext, kind: accepted.kind };
}

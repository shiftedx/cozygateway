import { FILE_MAX_BYTES, FILE_TYPES, acceptFileBytes, withCanonicalExtension } from "./documents.ts";
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

function ftypMajorBrand(bytes: Uint8Array): string | undefined {
  if (!isIsoBaseMedia(bytes)) return undefined;
  return String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
}

/** Audio-appropriate ISO BMFF major brands, four bytes each (the trailing space in `M4A ` and
 * `M4B ` is part of the brand). An `audio/mp4` declaration is refused for any other brand,
 * including a still-image container that is also ISO BMFF (`heic`, `avif`) and QuickTime's `qt  `.
 * The same list as CozyAgents' embedded gateway. */
const AUDIO_MP4_BRANDS = new Set(["M4A ", "M4B ", "mp42", "isom", "iso2"]);

function isAudioMp4(bytes: Uint8Array): boolean {
  const brand = ftypMajorBrand(bytes);
  return brand !== undefined && AUDIO_MP4_BRANDS.has(brand);
}

function bytesMatchMediaType(
  declared: string,
  bytes: Uint8Array,
  sniffImage: (bytes: Uint8Array) => string | undefined,
): boolean {
  if (declared.startsWith("image/")) return sniffImage(bytes) === declared;
  if (declared === "video/quicktime") return isQuickTime(bytes);
  if (declared === "video/mp4") return isIsoBaseMedia(bytes) && !isQuickTime(bytes);
  if (declared === "audio/mp4") return isAudioMp4(bytes);
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

/** Declarations a phone uses for an AAC voice note that name the same container as `audio/mp4`. */
const CHAT_AUDIO_ALIASES = new Map([["audio/m4a", "audio/mp4"], ["audio/x-m4a", "audio/mp4"]]);

/** `com.cozylabs.chat-audio` 1: what `POST /bots/:name/chat/attachments` admits. Documents keep
 * capability 24's rules. A voice note is one of the audio rows above, checked with the same magic,
 * but held to the route's 20 MiB cap. A `.m4a` name stands in for a declaration the route does
 * not admit (a missing type, `application/octet-stream`, and so on); the bytes still decide. The
 * returned `name` carries the accepted type's extension. */
export function acceptChatAttachmentBytes(
  declared: string,
  filename: string,
  bytes: Uint8Array,
): { mime: string; ext: string; name: string } {
  const lowered = declared.split(";")[0]!.trim().toLowerCase();
  let mime = CHAT_AUDIO_ALIASES.get(lowered) ?? lowered;
  const admitted = FILE_TYPES.has(mime) || ASSISTANT_MEDIA_TYPES.get(mime)?.kind === "audio";
  if (!admitted && /\.m4a$/i.test(filename)) mime = "audio/mp4";
  const type = ASSISTANT_MEDIA_TYPES.get(mime);
  if (type?.kind !== "audio") {
    const document = acceptFileBytes(mime, bytes);
    return { ...document, name: withCanonicalExtension(filename, document.ext) };
  }
  if (bytes.byteLength === 0) throw new Error("file carried no bytes");
  if (bytes.byteLength > FILE_MAX_BYTES) throw new Error("file is over the size cap");
  if (!bytesMatchMediaType(mime, bytes, () => undefined))
    throw new Error("file bytes did not match the declared allowed type");
  return { mime, ext: type.ext, name: withCanonicalExtension(filename, type.ext) };
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

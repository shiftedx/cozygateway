/** Inbound photos: everything that decides whether a device's upload is allowed to become bytes on
 *  this gateway and then pixels in a bot's context (contract/ext-bots-v1.md, capability 9).
 *
 *  The capability-7 media proxy is the same discipline pointed the other way. There the untrusted
 *  thing was a URL out of a bot's reply and the danger was what the gateway would DIAL; here the
 *  untrusted thing is a multipart body from a paired device and the danger is what the gateway will
 *  STORE and forward into an LLM context. So the rules rhyme deliberately: an allow-list rather than
 *  an `image/*` prefix test, a cap enforced against the declared length AND against the bytes that
 *  actually arrive, and a bounded number in flight at once.
 *
 *  The one rule with no counterpart on the outbound side is the magic-byte sniff. Outbound, the
 *  content type is a claim made by a third-party host about its own file. Inbound, it is a claim made
 *  by the client about a file the user picked, and the leading bytes are the only fact available. So
 *  the declared type never decides anything: it is checked so the refusal can be specific, and then
 *  the bytes are read and they decide.
 *
 *  Nothing here touches hermes or the database. It is pure, which is the point: these are the rules
 *  that stand between a device and the rest of the feature, and a rule that can only be exercised
 *  through a socket is a rule that does not get tested. */

import { randomBytes } from "node:crypto";

/** Bytes, per image. Chosen against three ceilings rather than picked round: hermes' own
 *  `_ATTACH_BYTES_MAX_BYTES` is 25 MB, the Anthropic-family providers reject a single image over
 *  5 MB (hermes shrinks and retries once, which costs a whole provider round trip), and a 2048 px
 *  JPEG at q0.8 (what the app is asked to send) is well under 2 MB. 8 MB is comfortably above the
 *  thing we expect and comfortably below the thing that breaks, and refusing here rather than at
 *  hermes is what turns "the gateway is broken" into a 413 that says what happened. */
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

/** What the whole multipart envelope may weigh. The file cap plus room for the part headers and the
 *  caption, checked against `Content-Length` BEFORE the body is read, so an oversized upload costs a
 *  header parse rather than 8 MB of buffering. The delivered-bytes check below is what actually
 *  binds; this only stops the obvious case early. */
export const PHOTO_MAX_REQUEST_BYTES = PHOTO_MAX_BYTES + 64 * 1024;

/** How many photo sends this gateway will have in flight at once, per GATEWAY, for the same reason
 *  the media proxy bounds its fetches per gateway: the resource is this process's memory and its one
 *  socket to hermes, and both are shared by every paired device. A photo is expensive in a way an
 *  outbound fetch is not, which is why the number is smaller: the bytes are buffered whole, then
 *  base64-encoded (a third bigger again) into a single JSON-RPC frame. Three in flight is roughly
 *  30 MB of peak transient memory in the worst case, and a household does not need more. */
export const PHOTO_MAX_CONCURRENT = 3;

/** How long a request waits for one of those slots before it is refused, matching the media proxy's
 *  bounded-wait argument: an unbounded queue makes a client unable to tell "queued" from "slow", and
 *  an instant refusal makes an ordinary two-photo send flicker with errors. */
export const PHOTO_QUEUE_WAIT_MS = 5_000;

/** Per-device token bucket. A photo send is the most expensive thing a device can ask this gateway
 *  to do (buffer, encode, forward to hermes, and then pay for a multimodal turn), so unlike the
 *  media proxy's gateway-wide bound this one is per DEVICE: the cost here is attributable to the
 *  phone that caused it, and the failure mode being bounded is one device spending the household's
 *  token budget in a loop. A burst of `PHOTO_RATE_CAPACITY` covers picking a handful of photos and
 *  sending them one after another; the refill is what stops a script. */
export const PHOTO_RATE_CAPACITY = 8;
export const PHOTO_RATE_REFILL_MS = 5_000;

/** How long the gateway keeps a user-uploaded attachment. Long enough that scrolling back through a
 *  week of chat still shows it, short enough that a household gateway's database does not grow
 *  without bound. When a copy expires the message keeps its text and simply stops carrying the
 *  attachment block, which is what the contract promises: the bytes expire, the conversation does
 *  not. */
export const ATTACH_MEDIA_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Compatibility name for callers concerned specifically with photos. */
export const PHOTO_TTL_MS = ATTACH_MEDIA_TTL_MS;

/** How often the bridge reclaims the disk behind expired photos.
 *
 *  Note what this is NOT: it is not what makes the TTL true. Both reads filter on `created_at`, so a
 *  photo past its expiry is unreachable the moment it expires whether or not anything has swept. That
 *  ordering matters because the gateway this feature is aimed at is a quiet household box: a house
 *  that sends photos for a week and then stops would never fire a write-time sweep again, and an
 *  expiry that depended on one would simply never happen. The timer only decides how long the bytes
 *  linger on disk after they have stopped being served. */
export const PHOTO_SWEEP_MS = 60 * 60 * 1000;

/** What the app may cache a served attachment for. Same posture as the capability-7 proxy: the bytes
 *  are immutable (the id names one upload and nothing ever rewrites it) so a day of caching removes
 *  the re-fetch on every scroll-back, and `private` because the answer went through a device-token
 *  route and belongs to that device rather than to any shared cache. */
export const PHOTO_CACHE_CONTROL = "private, max-age=86400";

/** The prompt submitted when a photo arrives with no caption. Hermes spends an attached image on the
 *  NEXT `prompt.submit` and nothing else, so a photo with no words still needs words; sending an
 *  empty string would either be refused or would attach the picture to whatever the user typed next.
 *  It is deliberately neutral and deliberately visible: it is what the transcript will show as the
 *  user's line, and inventing something chattier would put words in the user's mouth. */
export const PHOTO_DEFAULT_PROMPT = "Here is a photo.";

/** The content types this route accepts, as an intersection of two lists: what a raster decoder
 *  treats as pixels, and what hermes' own inbound `_IMAGE_EXTENSIONS` will take. Note what is NOT
 *  here and why each absence is deliberate:
 *
 *  - `image/svg+xml`: a document format carrying script and external references. The capability-7
 *    reasoning applies verbatim and applies harder inbound, since these bytes are stored by this
 *    gateway and served back from an authenticated route.
 *  - `image/heic`, `image/heif`, `image/avif`, `image/tiff`: hermes will not take them
 *    (`4016 unsupported extension`), so accepting them here would buy a 502 that reads as "the
 *    gateway is broken" instead of a 415 that says "convert this first". They ARE on the capability-7
 *    OUTBOUND allow-list, and the asymmetry is the point: what a CDN may serve to a phone and what
 *    this gateway may feed to a model are different questions.
 *
 *  The value is the extension hermes is told about, which is the only thing the client's filename
 *  would have been used for and is derived from the SNIFFED bytes instead. */
export const PHOTO_ALLOWED_TYPES = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/bmp", "bmp"],
]);

/** Types a client is likely to send that this route refuses ON PURPOSE, kept apart from "we have
 *  never heard of this type" so the refusal can say something a user can act on. iOS shoots HEIC by
 *  default, so this list is the difference between "convert the photo" and a shrug. */
export const PHOTO_REFUSED_TYPES = new Map<string, string>([
  ["image/svg+xml", "svg is a document format that can carry script, so it is never accepted as a photo"],
  ["image/heic", "heic is not accepted; convert the photo to jpeg or png before sending it"],
  ["image/heif", "heif is not accepted; convert the photo to jpeg or png before sending it"],
  ["image/avif", "avif is not accepted; convert the photo to jpeg or png before sending it"],
  ["image/tiff", "tiff is not accepted; convert the photo to jpeg or png before sending it"],
]);

/** Why an upload was refused. Rides the error body as `reason`, exactly as the media proxy's does, so
 *  a client can say something true without parsing prose out of `message`. */
export type PhotoRefusalReason =
  | "content_type" // declared type is not on the allow-list, or the bytes are not what was declared
  | "too_large" // declared or delivered body over PHOTO_MAX_BYTES
  | "empty"; // no file part, or a zero-byte one

export class PhotoRefused extends Error {
  readonly reason: PhotoRefusalReason;
  constructor(reason: PhotoRefusalReason, message: string) {
    super(message);
    this.name = "PhotoRefused";
    this.reason = reason;
  }
}

/** Hermes accepted neither the attach nor the submit. Separate from every other failure because of
 *  what it guarantees: a photo send that raises this NEVER reached `prompt.submit`, so no caption
 *  landed without its picture. */
export class PhotoAttachFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoAttachFailed";
  }
}

/** The magic-byte table, mirroring hermes' own `_IMAGE_MAGIC` and adding WEBP, which hermes accepts
 *  by extension alone. Each entry is a prefix test plus, for the container formats, a second window
 *  further in.
 *
 *  This is the fact-checking half of the content-type rule. A declared type is a claim by the sender;
 *  these bytes are what a decoder will actually see. A file declared `image/png` whose bytes are a
 *  HEIC is refused here rather than travelling to hermes to be refused there. */
/** Every DIB header size a BMP has ever carried: BITMAPCOREHEADER through BITMAPV5HEADER. */
const BMP_DIB_HEADER_SIZES = new Set([12, 16, 40, 52, 56, 64, 108, 124]);

function sniff(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...expected: number[]): boolean =>
    expected.every((byte, index) => bytes[offset + index] === byte);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  // "GIF87a" / "GIF89a"
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  // "RIFF" .... "WEBP"
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(0, 0x42, 0x4d) && isBmpHeader(bytes)) return "image/bmp";
  return undefined;
}

/** BMP's signature is two ASCII letters, which is the weakest magic in the table by a wide margin:
 *  anything beginning "BM" would pass, be stored, be served back, and be forwarded into a model's
 *  context. Hermes' own `_IMAGE_MAGIC` shares that weakness, but inbound from a device this gateway
 *  can afford to look one field further, so it does.
 *
 *  Three cheap structural facts, all fixed by the format rather than by convention: the file is at
 *  least a header and an info block, the two reserved 16-bit fields at offset 6 are zero (the spec
 *  requires it and every real encoder writes zeros), and the DIB header size at offset 14 is one of
 *  the handful of values that has ever existed. Text and other formats that happen to start "BM" do
 *  not satisfy all three. */
function isBmpHeader(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 26) return false;
  if (bytes[6] !== 0 || bytes[7] !== 0 || bytes[8] !== 0 || bytes[9] !== 0) return false;
  const dibSize =
    (bytes[14] ?? 0) | ((bytes[15] ?? 0) << 8) | ((bytes[16] ?? 0) << 16) | ((bytes[17] ?? 0) << 24);
  return BMP_DIB_HEADER_SIZES.has(dibSize);
}

/** Exported so the sniff table can be exercised directly. Returns the type the BYTES are, which is
 *  the only type this module ever believes. */
export function sniffImageType(bytes: Uint8Array): string | undefined {
  return sniff(bytes);
}

export interface AcceptedPhoto {
  /** The type the bytes actually are, which is also the type served back on download. */
  mime: string;
  /** The extension hermes is told about, derived from `mime` and never from the client's filename. */
  ext: string;
  size: number;
}

/** The whole inbound rule set, in the order the answers get more expensive.
 *
 *  `declaredType` is checked FIRST and only so the refusal can be specific: a HEIC declared as a HEIC
 *  deserves "convert this", not "these bytes are not an image". Then the bytes decide, and a mismatch
 *  between the two is refused rather than resolved in the sender's favour: a client that says `png`
 *  and sends something else has either a bug or an intent, and neither is worth forwarding into a
 *  model's context. */
export function acceptPhoto(input: {
  declaredType: string | undefined;
  declaredLength: number | undefined;
  bytes: Uint8Array;
}): AcceptedPhoto {
  if (input.declaredLength !== undefined && input.declaredLength > PHOTO_MAX_BYTES) {
    throw new PhotoRefused(
      "too_large",
      `the upload declares ${input.declaredLength} bytes, over the ${PHOTO_MAX_BYTES} byte cap`,
    );
  }
  if (input.bytes.byteLength === 0) throw new PhotoRefused("empty", "the upload carried no bytes");
  // The cap again, against what actually arrived. A declared length is a claim by the sender in
  // exactly the way an upstream `Content-Length` is a claim by a host.
  if (input.bytes.byteLength > PHOTO_MAX_BYTES) {
    throw new PhotoRefused(
      "too_large",
      `the photo is ${input.bytes.byteLength} bytes, over the ${PHOTO_MAX_BYTES} byte cap`,
    );
  }

  const declared = (input.declaredType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const refusal = PHOTO_REFUSED_TYPES.get(declared);
  if (refusal !== undefined) throw new PhotoRefused("content_type", refusal);
  if (declared !== "" && !PHOTO_ALLOWED_TYPES.has(declared)) {
    throw new PhotoRefused("content_type", `${declared} is not an accepted photo type`);
  }

  const sniffed = sniff(input.bytes);
  if (sniffed === undefined) {
    throw new PhotoRefused(
      "content_type",
      "the uploaded bytes are not a png, jpeg, gif, webp or bmp image, whatever the request declared",
    );
  }
  if (declared !== "" && declared !== sniffed) {
    throw new PhotoRefused(
      "content_type",
      `the upload declared ${declared} but its bytes are ${sniffed}`,
    );
  }
  const ext = PHOTO_ALLOWED_TYPES.get(sniffed);
  if (ext === undefined) throw new PhotoRefused("content_type", `${sniffed} is not an accepted photo type`);
  return { mime: sniffed, ext, size: input.bytes.byteLength };
}

/** Buffers a request body, refusing the moment it runs past `cap`.
 *
 *  This exists because `Content-Length` is optional. A chunked upload declares nothing, so the
 *  declared-length check has nothing to check and a framework helper that "just parses the body"
 *  will happily buffer whatever arrives. Reading the stream here means the bound holds whether or not
 *  the sender said anything about the size, which is the same declared-versus-delivered discipline
 *  the per-file cap applies one layer down.
 *
 *  The cap is the whole MULTIPART envelope, not the image: the file cap is applied afterwards, to the
 *  part that is actually a photo. */
export async function readCappedBody(
  stream: ReadableStream<Uint8Array> | null,
  cap: number = PHOTO_MAX_REQUEST_BYTES,
): Promise<Uint8Array> {
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        throw new PhotoRefused("too_large", `the upload ran past the ${cap} byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The shape of a stored attachment's public id. Opaque, fixed length, and drawn from a CSPRNG: it is
 *  handed to devices and comes back in a URL path, so it must carry no filename, no path, no session
 *  id and nothing guessable. Validated on the way back in (`isPhotoFileId`) so nothing path-shaped
 *  ever reaches a lookup. */
export function newPhotoFileId(): string {
  return randomBytes(16).toString("hex");
}

const FILE_ID_RE = /^[0-9a-f]{32}$/;

export function isPhotoFileId(value: string): boolean {
  return FILE_ID_RE.test(value);
}

/** The shape of every id the attach media store will accept on upload
 *  (`POST /attach/v1/media`, packages/gateway/src/http.ts). A device fetches an attachment by
 *  the id that is written into the message's `attachments_json`, so this route must be able to
 *  serve ANY id the store was willing to hold -- a stricter check here means the gateway keeps
 *  bytes it then refuses to hand back, and a delivered attachment reads as "no longer
 *  available" forever even though nothing expired and nothing was deleted. That is exactly what
 *  a `scheduled_media_<hex>` id did against `isPhotoFileId`'s bare-32-hex shape.
 *
 *  The safety property that mattered is unchanged: the id lands in a URL path, so it stays a
 *  bounded run of `A-Za-z0-9_-` with no dot, slash, or separator of any kind. Nothing
 *  path-shaped reaches a lookup. */
const ATTACH_MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function isFetchableAttachmentId(value: string): boolean {
  return ATTACH_MEDIA_ID_RE.test(value);
}

/** The name that rides the `attachment` block. Generated, never the client's: a filename is the one
 *  field of an upload that is pure attacker-controlled text with a long history of being interpreted
 *  (path traversal, extension confusion, markup in whatever renders it), and nothing in this feature
 *  needs it. The extension comes from the sniffed bytes, so the name always describes what the file
 *  really is. */
export function photoDisplayName(ext: string): string {
  return `photo.${ext}`;
}

/** Replaces anything path-shaped in a hermes error string with a placeholder.
 *
 *  Applied ONLY to the photo routes' 502, and the narrowness is the point. Passing hermes' text
 *  through verbatim is a deliberate convention everywhere else on this surface (client feature probes
 *  match `/unknown method/i` against it), and this does not touch that. But the photo path is the one
 *  place where a routine hermes failure NAMES the images directory: a `5027 write failure` carries
 *  `/Users/<operator>/.hermes/profiles/<bot>/images/...`, and this whole capability exists partly to
 *  guarantee that no such path reaches a device. Stripping the directives out of the transcript and
 *  then handing the same path back in an error body would be closing the front door and leaving the
 *  window open.
 *
 *  What survives is everything a person debugging actually needs: the code, the verb, the reason. The
 *  filename is dropped with the rest of the path rather than kept, because the basename is hermes'
 *  own generated `upload_<stamp>_<n>.png` and says nothing a reader wants. */
export function redactHostPaths(message: string): string {
  // One pass, so a home-relative path cannot be half-eaten by a rule that ran first. A "path" here is
  // an optional `~` or drive letter, then at least two separator-joined segments: one separator is an
  // ordinary sentence, two is a location on somebody's disk.
  return message.replace(/~?(?:[A-Za-z]:)?[\\/](?:[\w.@ -]+[\\/])+[\w.@ -]*/g, "<path>");
}

export interface PhotoRateLimiter {
  /** Answers whether this device may send a photo right now, spending a token when it may. */
  take(deviceId: string, now: number): { ok: true } | { ok: false; retryAfterMs: number };
}

/** How many devices the limiter will remember at once. A bound rather than a leak: the key is a
 *  device id, so the natural size is the number of paired phones, but a limiter with no bound is a
 *  map an attacker can grow. Entries are only ever dropped when they are FULL, which is the same
 *  state a device that has never sent a photo is in, so dropping one gives nothing away. */
const RATE_MEMORY_MAX = 512;

export function createPhotoRateLimiter(
  opts: { capacity?: number; refillMs?: number } = {},
): PhotoRateLimiter {
  const capacity = opts.capacity ?? PHOTO_RATE_CAPACITY;
  const refillMs = opts.refillMs ?? PHOTO_RATE_REFILL_MS;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return {
    take(deviceId, now) {
      const bucket = buckets.get(deviceId) ?? { tokens: capacity, at: now };
      const elapsed = Math.max(0, now - bucket.at);
      const tokens = Math.min(capacity, bucket.tokens + elapsed / refillMs);
      if (tokens < 1) {
        buckets.set(deviceId, { tokens, at: now });
        return { ok: false, retryAfterMs: Math.ceil((1 - tokens) * refillMs) };
      }
      const spent = { tokens: tokens - 1, at: now };
      buckets.set(deviceId, spent);
      if (buckets.size > RATE_MEMORY_MAX) {
        for (const [key, entry] of buckets) {
          if (buckets.size <= RATE_MEMORY_MAX) break;
          if (key === deviceId) continue;
          // Refill is recomputed here, not read off the stored value. A bucket is only ever WRITTEN
          // when it is spent, so its stored `tokens` is by construction below capacity and stays
          // there however long ago that was: an eviction that trusted the stored number would find
          // nothing to evict and the map would grow past the bound it claims. What matters is whether
          // the bucket would be full NOW, which is the same state a device that has never sent a
          // photo is in, so dropping it gives that device nothing it did not already have.
          const refilled = entry.tokens + Math.max(0, now - entry.at) / refillMs;
          if (refilled >= capacity) buckets.delete(key);
        }
      }
      return { ok: true };
    },
  };
}

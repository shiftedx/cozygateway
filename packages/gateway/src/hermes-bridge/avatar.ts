import type {
  BotAvatarGenerateResponse,
  BotAvatarPet,
  BotSummary,
} from "cozygateway-contract";
import { asRecord, asString, type HermesRpc } from "./rpc.ts";

/** Capability 81: bot avatars, over the same Hermes RPCs the desktop Bot Mode plugin uses.
 *
 *  - The picture is the profile's avatar ASSET (`profiles.set_asset` / `profiles.get_asset`,
 *    `<profile>/assets/avatar.<ext>`), never `ui_meta`: the blob is capped at 64 KB and rides every
 *    `profiles.list`. An upload, a generated portrait and a chosen pet are all just that asset.
 *  - `image.generate` is probed first (`{probe: true}` -> `{available}`), because most hosts have
 *    no image backend and the option must be hidden, not broken.
 *  - `pet.gallery` / `pet.thumb` are the petdex picker; the thumb is a small PNG Hermes crops.
 *
 *  Hermes sniffs the format itself (`_ASSET_MAGIC`) and caps it at 2 MB. The gateway checks the
 *  same two things first so a bad upload is a clean 400 here, not an RPC error from there. */

/** Hermes's own cap (`profiles.set_asset`, 2_000_000 decoded bytes). */
export const AVATAR_MAX_BYTES = 2_000_000;
/** A remote image backend routinely takes 40-60 s (upstream `IMAGE_GENERATE_TIMEOUT_MS`). */
export const AVATAR_GENERATE_TIMEOUT_MS = 90_000;
/** The gallery is 4,000+ pets and may fetch the petdex manifest on a cold cache. */
export const AVATAR_PET_TIMEOUT_MS = 30_000;
/** The data-URL cap asked of `image.generate`: a portrait bigger than an asset can hold is useless. */
export const AVATAR_GENERATE_MAX_BYTES = 8_000_000;

export type AvatarMime = "image/png" | "image/jpeg" | "image/webp";

/** A client sent something that is not a PNG, JPEG or WebP of at most 2 MB. */
export class AvatarInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarInvalid";
  }
}

/** The format from the magic bytes, exactly Hermes's `_ASSET_MAGIC`. */
export function sniffAvatar(bytes: Uint8Array): AvatarMime | undefined {
  const at = (offset: number, magic: number[]) => magic.every((b, i) => bytes[offset + i] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

/** A data URL (or bare base64) to its bytes and sniffed type, or `AvatarInvalid`. */
export function decodeAvatar(data: string): { mime: AvatarMime; bytes: Buffer } {
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(data.trim());
  const payload = (match?.[2] ?? data).replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload) || payload.length % 4 !== 0) {
    throw new AvatarInvalid("avatar data is not valid base64");
  }
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0) throw new AvatarInvalid("avatar data is empty");
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new AvatarInvalid(`avatar is ${bytes.byteLength} bytes; the limit is ${AVATAR_MAX_BYTES}`);
  }
  const mime = sniffAvatar(bytes);
  if (mime === undefined) throw new AvatarInvalid("avatar must be a PNG, JPEG or WebP image");
  return { mime, bytes };
}

/** The profile's avatar asset, or undefined when it has none. */
export async function readAvatar(rpc: HermesRpc, name: string): Promise<{ mime: AvatarMime; bytes: Buffer } | undefined> {
  const result = asRecord(await rpc.request("profiles.get_asset", { name, asset: "avatar" }));
  const data = asString(result?.["data"]);
  if (result?.["found"] !== true || data === undefined) return undefined;
  try {
    return decodeAvatar(data);
  } catch {
    // Hermes only stores sniffed formats, so this is a file someone put there by hand.
    return undefined;
  }
}

/** Store the avatar (validated here first), returning the stored size. */
export async function writeAvatar(rpc: HermesRpc, name: string, data: string): Promise<number> {
  const { mime, bytes } = decodeAvatar(data);
  // Re-encoded as a canonical data URL so Hermes's own regex takes the declared type it sniffs.
  const result = asRecord(await rpc.request("profiles.set_asset", {
    name,
    asset: "avatar",
    data: `data:${mime};base64,${bytes.toString("base64")}`,
  }));
  const size = result?.["size"];
  return typeof size === "number" ? size : bytes.byteLength;
}

export async function clearAvatar(rpc: HermesRpc, name: string): Promise<void> {
  await rpc.request("profiles.set_asset", { name, asset: "avatar", clear: true });
}

/** `image.generate`, probe or portrait. The prompt wording is the desktop's, so a portrait made
 *  from the phone looks like one made on a desktop. */
export async function generatePortrait(
  rpc: HermesRpc,
  opts: { prompt?: string; probe?: boolean },
): Promise<BotAvatarGenerateResponse> {
  if (opts.probe === true || opts.prompt === undefined) {
    const probe = asRecord(await rpc.request("image.generate", { probe: true }));
    return { available: probe?.["available"] === true };
  }
  const result = asRecord(await rpc.request("image.generate", {
    prompt: `${opts.prompt.trim()}. Avatar for an AI agent: centered, bold flat vector style, solid color background, no text.`,
    aspect_ratio: "square",
    max_bytes: AVATAR_GENERATE_MAX_BYTES,
  }, { timeoutMs: AVATAR_GENERATE_TIMEOUT_MS }));
  const available = result?.["available"] !== false;
  const image = asString(result?.["image_data"]);
  if (result?.["success"] === true && image !== undefined && image.startsWith("data:image/")) {
    return { available, success: true, image };
  }
  return {
    available,
    success: false,
    error: asString(result?.["error"])
      ?? (result?.["success"] === true ? "the image backend returned no picture this gateway could read" : "generation failed"),
  };
}

/** `pet.gallery`, reduced to what a picker needs; installed and curated pets first, as upstream. */
export async function petGallery(rpc: HermesRpc, localOnly: boolean): Promise<BotAvatarPet[]> {
  const result = asRecord(await rpc.request("pet.gallery", localOnly ? { localOnly: true } : {}, { timeoutMs: AVATAR_PET_TIMEOUT_MS }));
  const rows = Array.isArray(result?.["pets"]) ? (result["pets"] as unknown[]) : [];
  const pets: BotAvatarPet[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    const slug = asString(record?.["slug"]);
    if (record === undefined || slug === undefined || slug.length === 0 || slug.length > 128) continue;
    pets.push({
      slug,
      displayName: asString(record["displayName"]) ?? slug,
      installed: record["installed"] === true,
      curated: record["curated"] === true,
      spritesheetUrl: asString(record["spritesheetUrl"]) ?? "",
    });
  }
  const rank = (pet: BotAvatarPet) => (pet.installed ? 0 : pet.curated ? 1 : 2);
  return pets.sort((a, b) => rank(a) - rank(b));
}

/** `pet.thumb`: a PNG data URI of the pet's first idle frame, or undefined. */
export async function petThumb(rpc: HermesRpc, slug: string, url: string): Promise<string | undefined> {
  const result = asRecord(await rpc.request("pet.thumb", { slug, url }, { timeoutMs: AVATAR_PET_TIMEOUT_MS }));
  const uri = asString(result?.["dataUri"]);
  return result?.["ok"] === true && uri !== undefined && uri.startsWith("data:image/") ? uri : undefined;
}

/** What a roster row should draw instead of a face, from `has_avatar` and the blob.
 *
 *  A stored asset is drawn unless the blob says the look is a drawn face (`imageKind: "shape"`):
 *  that asset is then only a raster of the face, pushed so inter-agent notices can show it, and the
 *  live face is the better picture. A legacy `pet` slug with no asset is drawn from its thumbnail.
 *  `v` is the blob's revision, which every look write bumps, so a client cache keyed on the path
 *  refetches when the picture changes. */
export function rosterAvatar(
  name: string,
  hasAvatar: boolean,
  meta: Record<string, unknown> | null,
  revision: number,
): BotSummary["avatar"] | undefined {
  const base = `/bots/${encodeURIComponent(name)}/avatar`;
  if (hasAvatar && meta?.["imageKind"] !== "shape") {
    return { kind: "image", imageUrl: `${base}?v=${revision}` };
  }
  const pet = asString(meta?.["pet"])?.trim();
  if (!hasAvatar && pet !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(pet)) {
    return { kind: "pet", petSlug: pet, imageUrl: `${base}/pets/${encodeURIComponent(pet)}` };
  }
  return undefined;
}

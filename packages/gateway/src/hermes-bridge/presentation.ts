import type { BotPresentation, BotPresentationPatch } from "cozygateway-contract";
import { asRecord, asString, type HermesRpc } from "./rpc.ts";
import { UI_META_KEY, UI_META_MAX_BYTES, uiMetaBytes } from "./roster.ts";

/** Capability 80: the synced roster presentation in `ui_meta["hermes-bots"]`.
 *
 *  The blob is the Hermes desktop Bot Mode plugin's own record, so the rules are its rules:
 *  `pinned`, `hidden`, `sectionId`, `sectionName` and `title` are plain keys beside the look
 *  (`shape`, `color`, `custom`) and anything a newer desktop adds. Hermes CAS-guards the WHOLE key
 *  (`_ui_meta_revisions["hermes-bots"]`, `tui_gateway/methods_profiles.py _configure_ui_meta`), so a
 *  write is read-merge-write under the revision that was read, and a lost race re-reads and
 *  re-applies only the keys the patch names. Nothing here ever drops a key it did not set. */

/** Attempts before a write gives up as a conflict. Each one re-reads, so three lost races in a row
 *  means another client is writing continuously, and the caller should hear it. */
export const PRESENTATION_WRITE_ATTEMPTS = 3;

/** Every attempt lost its compare-and-swap race. */
export class PresentationConflict extends Error {
  constructor(name: string) {
    super(`another client kept changing bot "${name}"; try again`);
    this.name = "PresentationConflict";
  }
}

/** Hermes answered the write without applying it and without a conflict (over the 64 KB cap, or a
 *  profile.yaml it could not write). */
export class PresentationNotApplied extends Error {
  constructor(name: string) {
    super(`hermes did not save the presentation for bot "${name}"`);
    this.name = "PresentationNotApplied";
  }
}

export interface PresentationRead {
  presentation: BotPresentation;
  /** Hermes's CAS counter for the key, or null when this Hermes predates the revision map. */
  revision: number | null;
  /** The whole `ui_meta["hermes-bots"]` blob as stored. */
  blob: Record<string, unknown>;
}

function text(value: unknown): string | undefined {
  const s = asString(value)?.trim();
  return s === undefined || s.length === 0 ? undefined : s;
}

/** The presentation keys out of a stored blob. An absent key stays absent: `pinned` missing is
 *  "never synced", which a client treats differently from `pinned: false`.
 *
 *  Capability 81 adds the LOOK the desktop writes beside them: `shape` (a free-form face string,
 *  `blobatar[:seed[:kind]]` or one of the geometric shapes), `color`, `custom` and `imageKind`, plus
 *  `cozychat`, CozyChat's own namespaced record of the exact jelly a phone chose. */
export function presentationFromMeta(meta: Record<string, unknown> | null | undefined): BotPresentation {
  const out: BotPresentation = {};
  if (typeof meta?.["pinned"] === "boolean") out.pinned = meta["pinned"];
  if (typeof meta?.["hidden"] === "boolean") out.hidden = meta["hidden"];
  for (const key of ["sectionId", "sectionName", "title", "shape", "color"] as const) {
    const value = text(meta?.[key]);
    if (value !== undefined && value.length <= (key === "shape" ? 256 : 128)) out[key] = value;
  }
  if (typeof meta?.["custom"] === "boolean") out.custom = meta["custom"];
  if (meta?.["imageKind"] === "photo" || meta?.["imageKind"] === "shape") out.imageKind = meta["imageKind"];
  const cozy = cozyLook(meta?.["cozychat"]);
  if (cozy !== undefined) out.cozychat = cozy;
  return out;
}

/** CozyChat's namespaced look record, tolerantly: only its four string keys, each only when sane. */
function cozyLook(value: unknown): BotPresentation["cozychat"] | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const out: NonNullable<BotPresentation["cozychat"]> = {};
  for (const key of ["jelly", "seed", "prism", "shape"] as const) {
    const s = text(record[key]);
    if (s !== undefined && s.length <= (key === "shape" ? 256 : 128)) out[key] = s;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Every key a presentation patch may name, in the one order the merge applies them. */
const PATCH_KEYS = [
  "pinned", "hidden", "sectionId", "sectionName", "title",
  "shape", "color", "custom", "imageKind", "cozychat",
] as const;

/** The blob to write: the stored one, verbatim, with only the patched keys set. `null` clears, and
 *  is written as `null` exactly as the desktop's `moveBotsToSection(bots, null)` does. */
export function mergePresentation(
  blob: Record<string, unknown>,
  patch: BotPresentationPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...blob };
  for (const key of PATCH_KEYS) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

/** One profile's presentation from a `profiles.list` answer, or undefined when the profile is not
 *  on it. */
export function presentationRow(result: unknown, name: string): PresentationRead | undefined {
  const rows = asRecord(result)?.["profiles"];
  if (!Array.isArray(rows)) return undefined;
  const row = rows.map(asRecord).find((r) => r !== undefined && r["name"] === name);
  if (row === undefined) return undefined;
  const blob = asRecord(asRecord(row["ui_meta"])?.[UI_META_KEY]) ?? {};
  const revisions = asRecord(row["ui_meta_revisions"]);
  const raw = revisions?.[UI_META_KEY];
  const revision = revisions === undefined ? null : typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
  return { presentation: presentationFromMeta(blob), revision, blob };
}

export async function readPresentation(rpc: HermesRpc, name: string): Promise<PresentationRead | undefined> {
  return presentationRow(await rpc.request("profiles.list", { include_sessions: false }), name);
}

/** Read, merge, compare-and-swap. A conflict re-reads and re-applies the SAME patch, so the only
 *  keys this can ever change are the ones the caller named. */
export async function writePresentation(
  rpc: HermesRpc,
  name: string,
  patch: BotPresentationPatch,
  attempts = PRESENTATION_WRITE_ATTEMPTS,
): Promise<PresentationRead | undefined> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const current = await readPresentation(rpc, name);
    if (current === undefined) return undefined;
    const next = mergePresentation(current.blob, patch);
    if (uiMetaBytes(next) > UI_META_MAX_BYTES) throw new PresentationNotApplied(name);
    const result = asRecord(await rpc.request("profiles.configure", {
      name,
      ui_meta: { [UI_META_KEY]: next },
      // A Hermes without the revision map has no CAS to ask for; the plain write is all it has.
      ...(current.revision === null ? {} : { ui_meta_expected_revisions: { [UI_META_KEY]: current.revision } }),
    }));
    const applied = asRecord(result?.["applied"]);
    if (applied?.["ui_meta"] === true) {
      const revisions = asRecord(applied["ui_meta_revisions"]);
      const written = revisions?.[UI_META_KEY];
      return {
        presentation: presentationFromMeta(next),
        revision: typeof written === "number" ? written : current.revision === null ? null : current.revision + 1,
        blob: next,
      };
    }
    if (asRecord(applied?.["ui_meta_conflicts"])?.[UI_META_KEY] !== undefined) continue;
    throw new PresentationNotApplied(name);
  }
  throw new PresentationConflict(name);
}

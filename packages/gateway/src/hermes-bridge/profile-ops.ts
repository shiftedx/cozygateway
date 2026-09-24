// Capability 82: profile operations on a Hermes-backed bot (hermes-bot parity slice S3).
//
// Every operation here is one upstream Hermes surface, called the way Hermes Desktop calls it:
//
//   identity title      profiles.configure {ui_meta: {"hermes-bots": {..., title}}}   (WS, per-key CAS)
//   identity desc.      profiles.configure {description}                             (WS)
//   rename              PATCH /api/profiles/{name} {new_name}                        (HTTP)
//   describe-auto       POST  /api/profiles/{name}/describe-auto {overwrite}         (HTTP)
//   duplicate           profiles.create {clone_from, clone_all} + ui_meta + get/set_asset (WS)
//   export              POST  /api/profiles/{name}/export -> GET /api/files/download (HTTP)
//   import              POST  /api/files/upload -> POST /api/profiles/import         (HTTP)
//   model pin           profiles.configure {model, provider, confirm_expensive_model} (WS)
//   model unpin         cli.exec ['--profile', name, 'config', 'unset', 'model']     (WS)
//   provider keys       model.save_key / model.disconnect {profile, slug}            (WS)
//   skills hub          skills.manage {profile, action: search|install}              (WS)
//
// The bridge owns the lifecycle around them (the per-profile chain, the roster refresh, the
// provisioner hook, attach identity); this module owns only the wire.

import type {
  BotDescribeAutoResponse,
  BotIdentity,
  BotIdentityPatch,
  BotModelPinRequest,
  BotModelPinResponse,
  BotSkillsHubSearch,
} from "cozygateway-contract";

import { BackendUnavailable } from "../errors.ts";
import { HermesRpcError, type HermesClient } from "./client.ts";
import { BotNameTaken, BotNotFound } from "./crud.ts";
import { UI_META_KEY } from "./roster.ts";

/** A request Hermes refused as malformed (HTTP 400 that is not a name collision). */
export class ProfileOpInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileOpInvalid";
  }
}

/** Hermes' import archives are bounded here, before any byte is staged on the host. */
export const PROFILE_IMPORT_MAX_BYTES = 256 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const segment = (name: string): string => encodeURIComponent(name);

/** `dashboardJson` with a longer bound, for the profile routes that stop a gateway (rename), run
 *  an LLM (describe-auto) or write an archive (export/import). Same error mapping. */
async function dashboardCall<T = unknown>(
  client: HermesClient,
  path: string,
  init: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown },
  timeoutMs: number,
): Promise<T> {
  const response = await client.dashboardResponse(path, { ...init, timeoutMs });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = text(record(body)?.["detail"]) || `hermes dashboard request failed (HTTP ${response.status})`;
    throw new HermesRpcError(detail, response.status, body);
  }
  return body as T;
}

/** A dashboard refusal read as the gateway's own error words. */
function mapProfileError(error: unknown, name: string): never {
  if (error instanceof HermesRpcError) {
    if (error.code === 404) throw new BotNotFound(name);
    if (/already exists|file exists/i.test(error.message)) {
      const taken = /'([^']+)'/.exec(error.message)?.[1] ?? name;
      throw new BotNameTaken(taken);
    }
    if (error.code === 400 || error.code === 4062) throw new ProfileOpInvalid(error.message);
  }
  throw error;
}

// MARK: ui_meta["hermes-bots"]

interface HermesBotsMeta {
  meta: Record<string, unknown>;
  /** Absent on a Hermes that predates the compare-and-swap; the write is then unconditional. */
  revision: number | undefined;
}

async function readHermesBotsMeta(client: HermesClient, name: string): Promise<HermesBotsMeta & { description: string }> {
  const listed = record(await client.request("profiles.list", { include_sessions: false }));
  const rows = Array.isArray(listed?.["profiles"]) ? (listed["profiles"] as unknown[]) : [];
  const row = rows.map(record).find((candidate) => candidate?.["name"] === name);
  if (row === undefined) throw new BotNotFound(name);
  const revisions = record(row["ui_meta_revisions"]);
  const revision = revisions === undefined
    ? undefined
    : typeof revisions[UI_META_KEY] === "number" ? (revisions[UI_META_KEY] as number) : 0;
  return {
    meta: { ...(record(record(row["ui_meta"])?.[UI_META_KEY]) ?? {}) },
    revision,
    description: text(row["description"]),
  };
}

/** Merges into this bot's `ui_meta["hermes-bots"]` and nothing else. Decision 1 of the bot parity
 *  spec: a revision conflict re-reads and re-applies ONCE, and never overwrites another key.
 *
 *  This is the minimal writer S3 needs for the title and a duplicate's look. Slice S1 builds the
 *  general presentation writer (row 80); on rebase this becomes a call into that one. */
export async function mergeHermesBotsMeta(
  client: HermesClient,
  name: string,
  mutate: (meta: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readHermesBotsMeta(client, name);
    const next = mutate(current.meta);
    const result = record(await client.request("profiles.configure", {
      name,
      ui_meta: { [UI_META_KEY]: next },
      ...(current.revision === undefined ? {} : { ui_meta_expected_revisions: { [UI_META_KEY]: current.revision } }),
    }));
    const applied = record(result?.["applied"]);
    if (applied?.["ui_meta"] === true) return next;
    if (record(applied?.["ui_meta_conflicts"]) === undefined)
      throw new BackendUnavailable(`hermes did not save the look for "${name}"`);
  }
  throw new BackendUnavailable(`another device kept changing "${name}"; try again`);
}

// MARK: Identity

export async function setBotIdentity(client: HermesClient, name: string, patch: BotIdentityPatch): Promise<BotIdentity> {
  if (patch.title !== undefined) {
    const title = patch.title.trim();
    await mergeHermesBotsMeta(client, name, (meta) => {
      const next = { ...meta };
      if (title.length === 0) delete next["title"];
      else next["title"] = title;
      return next;
    });
  }
  if (patch.description !== undefined) {
    const result = record(await client.request("profiles.configure", {
      name,
      description: patch.description.trim(),
    }));
    if (record(result?.["applied"])?.["description"] !== true)
      throw new BackendUnavailable(`hermes did not save the description for "${name}"`);
  }
  const after = await readHermesBotsMeta(client, name);
  return { name, title: text(after.meta["title"]), description: after.description };
}

export async function renameProfile(client: HermesClient, name: string, newName: string): Promise<string> {
  try {
    // Hermes stops the profile's gateway (a 10 second poll) before it moves the directory.
    const result = record(await dashboardCall(client, `/api/profiles/${segment(name)}`, {
      method: "PATCH",
      body: { new_name: newName },
    }, 45_000));
    return text(result?.["name"]) || newName;
  } catch (error) {
    mapProfileError(error, name);
  }
}

export async function describeProfileAuto(
  client: HermesClient, name: string, overwrite: boolean,
): Promise<BotDescribeAutoResponse> {
  try {
    const result = record(await dashboardCall(client, `/api/profiles/${segment(name)}/describe-auto`, {
      method: "POST",
      body: { overwrite },
    }, 90_000));
    const description = text(result?.["description"]);
    const reason = text(result?.["reason"]);
    return {
      ok: result?.["ok"] === true,
      ...(description.length === 0 ? {} : { description }),
      ...(reason.length === 0 ? {} : { reason }),
    };
  } catch (error) {
    mapProfileError(error, name);
  }
}

// MARK: Duplicate

/** `<base>-2`, `-3`, ... the first name the host does not already have (upstream `duplicateBot`). */
export async function freeDuplicateName(client: HermesClient, base: string): Promise<string> {
  const listed = record(await client.request("profiles.list", { include_sessions: false }));
  const taken = new Set((Array.isArray(listed?.["profiles"]) ? (listed["profiles"] as unknown[]) : [])
    .map((row) => text(record(row)?.["name"])));
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  throw new BotNameTaken(`${base}-N`);
}

/** Everything a duplicate carries beyond what `clone_all` copies on disk: the look (with the title
 *  marked as a copy) and the avatar. Best-effort: the profile already exists. */
export async function copyBotLook(client: HermesClient, source: string, target: string): Promise<void> {
  try {
    const { meta } = await readHermesBotsMeta(client, source);
    const { chat: _chat, created: _created, ...look } = meta;
    const title = text(look["title"]).trim();
    await mergeHermesBotsMeta(client, target, (current) => ({
      ...current,
      ...look,
      ...(title.length === 0 ? {} : { title: `${title} (copy)` }),
    }));
  } catch {
    // Presentation only.
  }
  try {
    const asset = record(await client.request("profiles.get_asset", { name: source, asset: "avatar" }));
    const data = text(asset?.["data"]);
    if (asset?.["found"] === true && data.length > 0)
      await client.request("profiles.set_asset", { name: target, asset: "avatar", data });
  } catch {
    // Presentation only.
  }
}

// MARK: Export / import

/** The export as a response whose body is the archive. The staged file is removed from the Hermes
 *  host once the bytes are read, because it is a copy of a whole bot sitting in a shared folder. */
export async function exportProfileArchive(client: HermesClient, name: string): Promise<{ filename: string; bytes: Uint8Array<ArrayBuffer> }> {
  let archive: string;
  try {
    const result = record(await dashboardCall(client, `/api/profiles/${segment(name)}/export`, {
      method: "POST",
      body: {},
    }, 120_000));
    archive = text(result?.["archive"]);
  } catch (error) {
    mapProfileError(error, name);
  }
  if (archive.length === 0) throw new BackendUnavailable(`hermes did not say where it wrote "${name}"'s export`);
  try {
    const response = await client.dashboardResponse(
      `/api/files/download?path=${encodeURIComponent(archive)}`,
      { timeoutMs: 120_000, headers: { accept: "application/gzip, application/octet-stream" } },
    );
    if (!response.ok) throw new BackendUnavailable(`hermes could not hand back the export (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const filename = archive.split(/[\\/]/).pop() || `${name}.tar.gz`;
    return { filename, bytes };
  } finally {
    await removeStagedFile(client, archive);
  }
}

async function removeStagedFile(client: HermesClient, path: string): Promise<void> {
  try {
    await client.dashboardResponse("/api/files", { method: "DELETE", body: { path }, timeoutMs: 15_000 });
  } catch {
    // Best-effort: Hermes' own export folder is where it would have left it anyway.
  }
}

/** Where an import is staged on the Hermes host: the export folder beside the default profile,
 *  which is the one place Hermes itself writes profile archives. */
async function importStagingPath(client: HermesClient): Promise<string> {
  const listed = record(await client.request("profiles.list", { include_sessions: false }));
  const rows = Array.isArray(listed?.["profiles"]) ? (listed["profiles"] as unknown[]) : [];
  const home = text(rows.map(record).find((row) => row?.["is_default"] === true)?.["path"]);
  if (home.length === 0) throw new BackendUnavailable("hermes did not report its home folder, so there is nowhere to stage the import");
  const separator = home.includes("\\") && !home.includes("/") ? "\\" : "/";
  const base = home.endsWith(separator) ? home.slice(0, -1) : home;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${base}${separator}profile-exports${separator}cozy-import-${stamp}.tar.gz`;
}

export async function importProfileArchive(client: HermesClient, name: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength === 0) throw new ProfileOpInvalid("the archive is empty");
  if (bytes.byteLength > PROFILE_IMPORT_MAX_BYTES) throw new ProfileOpInvalid("the archive is larger than 256 MiB");
  const staged = await importStagingPath(client);
  const dataUrl = `data:application/gzip;base64,${Buffer.from(bytes).toString("base64")}`;
  try {
    await dashboardCall(client, "/api/files/upload", {
      method: "POST",
      body: { path: staged, data_url: dataUrl, overwrite: true },
    }, 120_000);
    const result = record(await dashboardCall(client, "/api/profiles/import", {
      method: "POST",
      body: { archive: staged, name },
    }, 120_000));
    return text(result?.["name"]) || name;
  } catch (error) {
    mapProfileError(error, name);
  } finally {
    await removeStagedFile(client, staged);
  }
}

// MARK: Model pin

/** The profile's own model pin, as the Bots editor reads it (`profiles.describe` -> `model`). An
 *  empty provider or model is no pin: the launch profile's model applies. */
export async function readProfileModelPin(client: HermesClient, name: string): Promise<BotModelPinResponse> {
  const described = record(await client.request("profiles.describe", { name }));
  const model = record(described?.["model"]);
  const provider = text(model?.["provider"]);
  const id = text(model?.["default"]);
  return provider.length > 0 && id.length > 0
    ? { pinned: true, model: { provider, model: id } }
    : { pinned: false };
}

export async function pinProfileModel(
  client: HermesClient, name: string, request: BotModelPinRequest,
): Promise<BotModelPinResponse> {
  const result = record(await client.request("profiles.configure", {
    name,
    model: request.model,
    provider: request.provider,
    ...(request.confirmExpensiveModel === true ? { confirm_expensive_model: true } : {}),
  }));
  if (result?.["confirm_required"] === true) {
    return { pinned: false, confirmRequired: true, confirmMessage: text(result["confirm_message"]) };
  }
  if (record(result?.["applied"])?.["model"] !== true)
    throw new BackendUnavailable(`hermes did not pin a model for "${name}"`);
  return { pinned: true, model: { provider: request.provider, model: request.model } };
}

/** Upstream's "Inherit (launch profile)": the model key comes out of the profile's config.yaml,
 *  so the launch profile's model applies again. */
export async function unpinProfileModel(client: HermesClient, name: string): Promise<BotModelPinResponse> {
  const result = record(await client.request("cli.exec", {
    argv: ["--profile", name, "config", "unset", "model"],
    timeout: 60,
  }, { timeoutMs: 75_000 }));
  if (result?.["blocked"] === true || (typeof result?.["code"] === "number" && result["code"] !== 0)) {
    throw new BackendUnavailable(text(result?.["hint"]) || text(result?.["output"]) || `hermes could not unpin "${name}"'s model`);
  }
  return { pinned: false };
}

// MARK: Provider keys

const PROVIDER_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function providerSlug(slug: string): string {
  if (!PROVIDER_SLUG_RE.test(slug)) throw new ProfileOpInvalid("invalid provider");
  return slug;
}

/** The key is write-only: it goes into Hermes and nothing about it comes back or is logged. */
export async function saveProviderKey(client: HermesClient, name: string, slug: string, apiKey: string): Promise<{ provider: string; connected: boolean }> {
  try {
    await client.request("model.save_key", { profile: name, slug: providerSlug(slug), api_key: apiKey });
  } catch (error) {
    if (error instanceof HermesRpcError && error.code !== undefined && error.code >= 4000 && error.code < 5000)
      throw new ProfileOpInvalid(error.message);
    throw error;
  }
  return { provider: slug, connected: true };
}

export async function disconnectProvider(client: HermesClient, name: string, slug: string): Promise<{ provider: string; connected: boolean }> {
  try {
    await client.request("model.disconnect", { profile: name, slug: providerSlug(slug) });
  } catch (error) {
    // 4005: nothing was stored for it, which is the state the person asked for.
    if (!(error instanceof HermesRpcError && error.code === 4005)) {
      if (error instanceof HermesRpcError && error.code !== undefined && error.code >= 4000 && error.code < 5000)
        throw new ProfileOpInvalid(error.message);
      throw error;
    }
  }
  return { provider: slug, connected: false };
}

// MARK: Skills Hub

export async function searchSkillsHub(client: HermesClient, name: string, query: string): Promise<BotSkillsHubSearch> {
  const result = record(await client.request("skills.manage", {
    profile: name, action: "search", query,
  }, { timeoutMs: 60_000 }));
  const rows = Array.isArray(result?.["results"]) ? (result["results"] as unknown[]) : [];
  return {
    results: rows.map(record).filter((row) => text(row?.["name"]).length > 0)
      .map((row) => ({ name: text(row?.["name"]), description: text(row?.["description"]) })),
  };
}

export async function installHubSkill(client: HermesClient, name: string, identifier: string): Promise<{ installed: boolean; name: string }> {
  const result = record(await client.request("skills.manage", {
    profile: name, action: "install", query: identifier,
  }, { timeoutMs: 180_000 }));
  return { installed: result?.["installed"] === true, name: text(result?.["name"]) || identifier };
}

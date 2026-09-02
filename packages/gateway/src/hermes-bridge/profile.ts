import type {
  BotCatalog,
  BotProfile,
  BotProfilePatch,
  BotProfileApplied,
  BotProfileRuntimeInert,
} from "cozygateway-contract";

import { HermesRpcError, HermesTimeout } from "./client.ts";
import type { HermesRpc } from "./rpc.ts";

/** The edit-profile surface: everything the desktop's `EditProfileDialog` reads and everything its
 *  `applyAdvancedConfig` writes (dissection sections 4.2 and 4.3), reimplemented server-side so a
 *  phone edits a bot exactly as a desktop does.
 *
 *  THREE list semantics live here and they are not the same, which is the whole reason this module
 *  exists as a seam rather than as a passthrough:
 *
 *  - SKILLS are a DISABLED list server-side. `profiles.describe` reports `enabled` per installed
 *    skill (installed = enabled unless the name is in `skills.disabled`), and the write is the
 *    INVERTED set: `disabled_skills` carries the names that must be OFF. A client that echoed the
 *    enabled names back would disable exactly the skills the user just kept.
 *  - TOOLSETS are an ENABLED list, and it is a PIN. `profiles.describe` reports each toolset's
 *    resolved state plus `toolsets_pinned`, which says whether the profile carries a pin at all.
 *    The write is `enabled_toolsets`, and an EMPTY array POPS the pin (every toolset enabled again)
 *    rather than disabling everything. The desktop exploits that: all-checked and none-checked both
 *    send `[]`, because "all of them" and "no opinion" are the same state on this backend.
 *  - MCP SERVERS are an ENABLED list too, but the read is a UNION: `profiles.describe.mcp_servers`
 *    carries only the servers the profile actually defines (with `enabled` = not `disabled`), and
 *    `mcp.catalog` carries the bundled menu. The desktop appends catalog entries the profile does
 *    not define as `enabled: false`, which is what lets a user turn on a server the profile never
 *    had (upstream copies its definition from the LAUNCH profile on write). The write is
 *    `enabled_mcp_servers`, replace semantics; unknown names are skipped, never invented. */

/** The `applied` keys `profiles.configure` answers with, per REQUEST field. The two names differ on
 *  purpose upstream, so the mapping is stated once here rather than guessed at each call site. */
export const APPLIED_KEY_OF = {
  soul: "soul",
  disabledSkills: "skills",
  // Capability 59. A DIFFERENT key from `disabledSkills: "skills"` on purpose: two sections that
  // report under one key cannot be told apart by a client, and these two are opposite intents.
  // Not produced by `buildConfigurePayload` for a Hermes bot, whose `profiles.configure` has no
  // such call; the union member exists so this map stays total over every `BotProfilePatch` key.
  enabledSkills: "skills_enabled",
  enabledToolsets: "toolsets",
  enabledMcpServers: "mcp_servers",
  // Capability 57. Not produced by `buildConfigurePayload` for a Hermes bot (the field is not part
  // of the `profiles.configure` vocabulary this bridge translates), but the union member exists so
  // this map stays total over every `BotProfilePatch` key and so a runtime bot's peer, which
  // answers this key in its own `applied` map, is echoed under the name the client already reads.
  guardrailLevel: "guardrails",
  // Capability 58. `guardrailCeiling` is `Type.Optional(Type.Never())` on `BotProfilePatchSchema`,
  // so `patch.guardrailCeiling` is never defined and `buildConfigurePayload` never produces this
  // key: it exists only to keep this map total over every `BotProfilePatch` key.
  guardrailCeiling: "guardrail_ceiling",
} as const satisfies Record<keyof BotProfilePatch, string>;

/** How a `profiles.configure` reply was understood, the same three-way reading `saveBotMeta` uses
 *  for `ui_meta` (dissection 3.1): a reply carrying NO `applied` object at all is an OLDER GATEWAY
 *  that does not speak the per-section contract, which is different news from a gateway that spoke
 *  it and said a section did not apply. */
export type ConfigureOutcome = "applied" | "unsupported";

/** The profile sections this gateway accepts, persists and reads back, but which the BACKEND does
 *  not consult when the bot actually runs. Reported on every profile read as `runtimeInert` so a
 *  client can render the honesty note without sniffing a Hermes version.
 *
 *  Both are upstream defects on Hermes 0.20.3 / 0.20.4, not gaps in this bridge, and the desktop
 *  has the identical hole:
 *  - TOOLSETS: `profiles.configure` writes `tools.enabled_toolsets`, which only `profiles.describe`
 *    and the bot-mode capability fingerprint ever read. Runtime toolset resolution reads
 *    `config["platform_toolsets"][platform]` instead, so the pin is describe-visible only.
 *  - MCP SERVERS: `profiles.configure` writes the per-server `disabled` key, which only
 *    `profiles.describe` reads. Every runtime consumer, and `mcp_catalog.is_enabled`, reads the
 *    `enabled` key instead.
 *
 *  Kept as a constant rather than probed: nothing on the wire distinguishes a gateway that fixed
 *  this from one that did not, and claiming a section works when it might not is the failure that
 *  costs a user their trust. Narrow it when a backend that honours these lands. */
export const RUNTIME_INERT_SECTIONS: BotProfileRuntimeInert = ["toolsets", "mcpServers"];

export interface ProfileConfigureResult {
  outcome: ConfigureOutcome;
  /** Hermes' own `applied` map, VERBATIM (its keys, its booleans). Empty on `unsupported`. */
  applied: BotProfileApplied;
  /** True only when every section the request asked for came back true. False on `unsupported`,
   *  because a gateway that cannot report is a gateway that cannot be believed. */
  ok: boolean;
  /** The request fields this call carried, in request order, so a client can pair a missing
   *  `applied` key with the field that asked for it. */
  requested: (keyof BotProfilePatch)[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Maps one `profiles.describe` reply, optionally unioned with that profile's `mcp.catalog`, into
 *  the shape the edit screen reads.
 *
 *  Tolerant throughout: a field Hermes did not send degrades to its empty value rather than failing
 *  the read, because this reply is assembled from a config file, a skills directory, a toolset
 *  registry and a YAML block, and upstream drops any of them on a bad parse without erroring. */
export function mapProfileDescribe(describe: unknown, catalog?: unknown): BotProfile {
  const record = asRecord(describe) ?? {};
  const model = asRecord(record["model"]) ?? {};

  const skills = asArray(record["skills"]).flatMap((entry) => {
    const row = asRecord(entry);
    const name = asString(row?.["name"]);
    if (row === undefined || name === undefined || name.length === 0) return [];
    const description = asString(row["description"]);
    return [
      {
        name,
        // Absent means enabled: the server model is a DISABLED list, so silence is opt-in.
        enabled: row["enabled"] !== false,
        ...(description === undefined || description.length === 0 ? {} : { description }),
      },
    ];
  });

  const toolsets = asArray(record["toolsets"]).flatMap((entry) => {
    const row = asRecord(entry);
    const name = asString(row?.["name"]);
    if (row === undefined || name === undefined || name.length === 0) return [];
    const label = asString(row["label"]);
    const description = asString(row["description"]);
    const toolCount = row["tool_count"];
    return [
      {
        name,
        enabled: row["enabled"] === true,
        ...(label === undefined || label.length === 0 ? {} : { label }),
        ...(description === undefined || description.length === 0 ? {} : { description }),
        ...(typeof toolCount === "number" ? { toolCount } : {}),
      },
    ];
  });

  // The profile's own servers first, in the order Hermes returned them (it sorts by name), then the
  // catalog entries the profile does not define. `installed` is only knowable from the catalog: a
  // server the profile DEFINES is by definition installed for it, and one that only exists in the
  // catalog carries the catalog's own flag.
  const catalogRows = asArray(asRecord(catalog)?.["servers"]).flatMap((entry) => {
    const row = asRecord(entry);
    const name = asString(row?.["name"]);
    return row === undefined || name === undefined || name.length === 0 ? [] : [{ name, row }];
  });
  const catalogByName = new Map(catalogRows.map(({ name, row }) => [name, row]));

  const configured = asArray(record["mcp_servers"]).flatMap((entry) => {
    const row = asRecord(entry);
    const name = asString(row?.["name"]);
    if (row === undefined || name === undefined || name.length === 0) return [];
    const fromCatalog = catalogByName.get(name);
    return [
      mcpServer({
        name,
        // The profile defines it, so it exists for this profile whatever the bundled catalog says.
        installed: true,
        enabled: row["enabled"] !== false,
        row,
        catalogRow: fromCatalog,
      }),
    ];
  });
  const defined = new Set(configured.map((server) => server.name));
  const offered = catalogRows
    .filter(({ name }) => !defined.has(name))
    .map(({ name, row }) =>
      mcpServer({
        name,
        installed: row["installed"] === true,
        // Not defined by the profile means not enabled for it, whatever the catalog row's own
        // `enabled` says. Note this is NOT because the catalog flag describes the launch profile:
        // `readBotProfile` asks `mcp.catalog { profile: name }`, and upstream applies a hermes-home
        // override for that profile before resolving `installed`/`enabled`, so the flags are
        // already scoped to THIS bot. The reason is narrower and stronger: a row that is absent
        // from `describe.mcp_servers` is by construction absent from that profile's `config.yaml`
        // `mcp_servers` map, which is exactly what the scoped `enabled` resolves through, so the
        // flag cannot be true here for any server the profile has not defined. Forcing `false`
        // states that invariant instead of trusting it, and it is also what keeps the UNSCOPED
        // catalog (`GET /bots/catalog`, which really does describe the launch profile) from ever
        // rendering as this bot's state if a caller passes one in.
        enabled: false,
        row: undefined,
        catalogRow: row,
        fromCatalog: true,
      }),
    );

  return {
    name: asString(record["name"]) ?? "",
    description: asString(record["description"]) ?? "",
    soul: asString(record["soul"]) ?? "",
    skills,
    toolsets,
    toolsetsPinned: record["toolsets_pinned"] === true,
    mcpServers: [...configured, ...offered],
    model: {
      provider: asString(model["provider"]) ?? "",
      default: asString(model["default"]) ?? "",
    },
    // Constant, not derived from this reply: see RUNTIME_INERT_SECTIONS. Copied so a caller cannot
    // mutate the shared constant through a response object.
    runtimeInert: [...RUNTIME_INERT_SECTIONS],
  };
}

function mcpServer(input: {
  name: string;
  installed: boolean;
  enabled: boolean;
  row: Record<string, unknown> | undefined;
  catalogRow: Record<string, unknown> | undefined;
  fromCatalog?: boolean;
}): BotProfile["mcpServers"][number] {
  const source = input.catalogRow ?? {};
  const description = asString(source["description"]) ?? asString(input.row?.["description"]);
  const transport = asString(input.row?.["transport"]) ?? asString(source["transport"]);
  // `auth` is passed through when the gateway sends it. Hermes 0.20.3's `mcp.catalog` does not, so
  // it is optional rather than defaulted: inventing a value here would tell a client an unauthed
  // server needs credentials.
  const auth = asString(source["auth"]) ?? asString(input.row?.["auth"]);
  const requires = asArray(source["requires"]).filter((value): value is string => typeof value === "string");
  return {
    name: input.name,
    installed: input.installed,
    enabled: input.enabled,
    ...(auth === undefined ? {} : { auth }),
    ...(description === undefined || description.length === 0 ? {} : { description }),
    ...(transport === undefined || transport.length === 0 ? {} : { transport }),
    ...(requires.length === 0 ? {} : { requires }),
    ...(input.fromCatalog === true ? { fromCatalog: true } : {}),
  };
}

/** Reads one bot's edit-screen state. `mcp.catalog` is best-effort exactly as the desktop treats it
 *  (`.catch(() => null)`): a gateway that does not offer it still answers the profile, it just
 *  cannot offer servers the profile has not defined.
 *
 *  A REJECTION and a TIMEOUT are both swallowed, because both mean the same thing about the same
 *  optional half: this read cannot offer undefined servers, which is a smaller answer, not a wrong
 *  one. A slow-but-alive catalog turning a perfectly good `profiles.describe` into a 504 was the
 *  bug; the desktop's `.catch(() => null)` swallows its timeouts too. A `HermesUnavailable` that is
 *  NOT a timeout still propagates: the bridge is down, so the `profiles.describe` that just
 *  succeeded is the stale half, and the route should say the bridge is down. */
export async function readBotProfile(rpc: HermesRpc, name: string): Promise<BotProfile> {
  const describe = await rpc.request("profiles.describe", { name });
  let catalog: unknown;
  try {
    catalog = await rpc.request("mcp.catalog", { profile: name });
  } catch (err) {
    if (!(err instanceof HermesRpcError) && !(err instanceof HermesTimeout)) throw err;
    catalog = undefined;
  }
  return { ...mapProfileDescribe(describe, catalog), name };
}

/** Cleans one list before it goes on the wire: trims each name, drops the blanks, and dedupes,
 *  preserving first-seen order.
 *
 *  The gateway is the layer that owes the backend a clean list, and upstream's own cleaning is
 *  uneven: it filters blanks for skills and toolsets but not consistently across all three, and a
 *  single whitespace name in `enabledToolsets` survives `minLength: 1` validation only to be
 *  filtered upstream into an EMPTY list, which POPS the pin and enables every toolset. A client
 *  that sent one stray space would get the maximum-permission outcome. Trimming here makes that
 *  request refuse to be misread: a whitespace-only name is simply not a name. */
export function normalizeNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** The `profiles.configure` params for a patch, plus which fields asked for them. Only the fields
 *  present in the patch are sent, which is the desktop's "only dirty sections" rule: a section that
 *  is not on the wire is not written, and upstream never reports an `applied` key for it. */
export function buildConfigurePayload(
  name: string,
  patch: BotProfilePatch,
): { params: Record<string, unknown>; requested: (keyof BotProfilePatch)[] } {
  const params: Record<string, unknown> = { name };
  const requested: (keyof BotProfilePatch)[] = [];
  if (patch.soul !== undefined) {
    params["soul"] = patch.soul;
    requested.push("soul");
  }
  if (patch.disabledSkills !== undefined) {
    params["disabled_skills"] = normalizeNames(patch.disabledSkills);
    requested.push("disabledSkills");
  }
  if (patch.enabledToolsets !== undefined) {
    // The EMPTINESS is passed through exactly, normalization or not: `[]` is not "disable
    // everything", it pops the pin so every toolset is enabled again (dissection 4.2). Dropping an
    // empty array here would make "turn everything back on" unrepresentable. The names themselves
    // are still trimmed and deduped, and the schema has already refused a whitespace-only name, so
    // a list that arrives non-empty can never normalize down into the pin-popping empty case.
    params["enabled_toolsets"] = normalizeNames(patch.enabledToolsets);
    requested.push("enabledToolsets");
  }
  if (patch.enabledMcpServers !== undefined) {
    params["enabled_mcp_servers"] = normalizeNames(patch.enabledMcpServers);
    requested.push("enabledMcpServers");
  }
  return { params, requested };
}

/** Reads a `profiles.configure` reply into the outcome the route echoes. The `applied` map is
 *  copied key-for-key with its Hermes names and only its BOOLEAN entries, so a client reads the
 *  same words the desktop reads, and a future section this gateway does not model still reaches it.
 *
 *  `ok` is computed over the REQUESTED sections rather than over the whole map: a gateway that
 *  reports an extra key (or none for a section it silently ignored) must not make a successful
 *  write read as a failure, and a section that was asked for and is simply absent from the map is a
 *  section that did not apply. */
export function readConfigureResult(
  result: unknown,
  requested: (keyof BotProfilePatch)[],
): ProfileConfigureResult {
  const record = asRecord(result);
  const appliedRaw = asRecord(record?.["applied"]);
  if (appliedRaw === undefined) {
    return { outcome: "unsupported", applied: {}, ok: false, requested };
  }
  const applied: BotProfileApplied = {};
  for (const [key, value] of Object.entries(appliedRaw)) {
    if (typeof value === "boolean") applied[key] = value;
  }
  const ok = requested.every((field) => applied[APPLIED_KEY_OF[field]] === true);
  return { outcome: "applied", applied, ok, requested };
}

/** Applies a patch to a bot's profile. */
export async function configureBotProfile(
  rpc: HermesRpc,
  name: string,
  patch: BotProfilePatch,
): Promise<ProfileConfigureResult> {
  const { params, requested } = buildConfigurePayload(name, patch);
  return readConfigureResult(await rpc.request("profiles.configure", params), requested);
}

/** How long an edit-screen catalog is served from cache. This is an edit-screen OPEN, not a poll:
 *  the three calls behind it hit a skills hub over the network, a bundled MCP catalog, and a model
 *  inventory that upstream refreshes from provider APIs, so a user toggling between tabs must not
 *  re-spend them, while a minute is short enough that a skill installed from a desktop shows up on
 *  the next open. */
export const CATALOG_TTL_MS = 60_000;

/** How long a DEGRADED catalog (one whose `unavailable` is non-empty) is served from cache.
 *
 *  Deliberately seconds, not a minute. A degraded answer is not the screen's data, it is a report
 *  that a section could not be fetched, and the most failure-prone of the three is `model.options`
 *  with `refresh: true`: it busts upstream's model-id cache and does live discovery against every
 *  saved provider, offline local endpoints included. One flaky refresh must not pin an empty model
 *  picker in front of the user for a full minute under a message that reads "your gateway is too
 *  old" rather than "retry".
 *
 *  Cached at all, rather than not cached, because the failing call is the expensive one: a client
 *  that re-reads on every keystroke would otherwise hammer a struggling gateway with live provider
 *  discovery. A few seconds is the retry floor, not a data lifetime. */
export const CATALOG_DEGRADED_TTL_MS = 5_000;

/** How many per-query catalog answers are kept at once.
 *
 *  The cache is keyed on the skill-search query so a keystroke does not evict the previous answer,
 *  which is exactly what makes the key space CLIENT-CHOSEN and unbounded: an edit screen that reads
 *  per keystroke mints one entry per prefix, each holding a full skills + MCP + models payload, and
 *  a length cap on the query bounds the key, not the number of keys. Bounded and swept on write, so
 *  a paired device cannot grow this without limit and a decade-stale entry cannot outlive its own
 *  usefulness. Small on purpose: the value of the cache is one screen open, not a history. */
export const CATALOG_CACHE_MAX = 32;

/** Which catalog sections could not be fetched. A section here is EMPTY in the response rather than
 *  absent, so a client renders "nothing to offer" without special-casing a missing field, and can
 *  say why. */
export type CatalogSection = "skills" | "mcpServers" | "models";

export interface CachedCatalog {
  catalog: BotCatalog;
  /** When the three calls behind it were made. Cache bookkeeping only, never on the wire. */
  fetchedAt: number;
  /** How long THIS entry is good for. Per entry rather than global because a degraded answer is
   *  worth seconds and a complete one is worth a minute. */
  ttlMs: number;
}

/** The desktop's own `model.options` params (dissection 1.2 row 13). `refresh: true` is what makes
 *  the inventory probe live provider catalogs instead of serving whatever was cached at launch,
 *  which is why this result is cached HERE rather than asked for on every screen open. */
const MODEL_OPTIONS_PARAMS = { include_unconfigured: true, explicit_only: false, refresh: true };

/** Fetches the edit screen's menus: installable skills, the MCP catalog, and the model inventory.
 *
 *  Each section is INDEPENDENTLY best-effort against an RPC rejection, mirroring the desktop, which
 *  wraps each of these calls in its own catch: an older gateway missing one method still gets a
 *  usable edit screen. A TRANSPORT failure propagates instead, because then no section is
 *  trustworthy and the route should say the bridge is down rather than answer three empty lists. */
export async function readBotCatalog(rpc: HermesRpc, query: string, now: number): Promise<BotCatalog> {
  const unavailable: CatalogSection[] = [];

  const section = async <T>(name: CatalogSection, run: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof HermesRpcError)) throw err;
      unavailable.push(name);
      return empty;
    }
  };

  const [skills, mcpServers, models] = await Promise.all([
    section(
      "skills",
      async () => {
        const raw = await rpc.request("skills.manage", { action: "search", query });
        return asArray(asRecord(raw)?.["results"]).flatMap((entry) => {
          const row = asRecord(entry);
          const name = asString(row?.["name"]);
          if (row === undefined || name === undefined || name.length === 0) return [];
          const description = asString(row["description"]) ?? "";
          return [{ name, description }];
        });
      },
      [] as BotCatalog["skills"],
    ),
    section(
      "mcpServers",
      async () => {
        const raw = await rpc.request("mcp.catalog", {});
        return asArray(asRecord(raw)?.["servers"]).flatMap((entry) => {
          const row = asRecord(entry);
          const name = asString(row?.["name"]);
          if (row === undefined || name === undefined || name.length === 0) return [];
          const requires = asArray(row["requires"]).filter((value): value is string => typeof value === "string");
          const auth = asString(row["auth"]);
          const transport = asString(row["transport"]);
          return [
            {
              name,
              description: asString(row["description"]) ?? "",
              installed: row["installed"] === true,
              enabled: row["enabled"] === true,
              requires,
              ...(auth === undefined ? {} : { auth }),
              ...(transport === undefined || transport.length === 0 ? {} : { transport }),
            },
          ];
        });
      },
      [] as BotCatalog["mcpServers"],
    ),
    section(
      "models",
      async () => {
        const raw = await rpc.request("model.options", MODEL_OPTIONS_PARAMS);
        return asArray(asRecord(raw)?.["providers"]).flatMap((entry) => {
          const row = asRecord(entry);
          const slug = asString(row?.["slug"]);
          if (row === undefined || slug === undefined || slug.length === 0) return [];
          // A model row is a bare string on some builds and an object on others. Reduced to the id
          // the picker actually sends, which is what `profiles.configure` wants for `model`.
          const modelIds = asArray(row["models"]).flatMap((model) => {
            if (typeof model === "string") return model.length === 0 ? [] : [model];
            const record = asRecord(model);
            const id = asString(record?.["id"]) ?? asString(record?.["name"]);
            return id === undefined || id.length === 0 ? [] : [id];
          });
          return [{ slug, name: asString(row["name"]) ?? slug, models: modelIds }];
        });
      },
      [] as BotCatalog["models"],
    ),
  ]);

  // Sorted, because the three `section()` calls run concurrently and push in whatever order they
  // reject: an unsorted list makes the same degradation read as a different answer run to run, and
  // a client diffing responses (or a test asserting one) would see churn that means nothing.
  unavailable.sort();
  return { query, skills, mcpServers, models, unavailable, updatedAt: now };
}

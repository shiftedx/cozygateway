import type { HermesClient } from "./client.ts";
import { mapProfileDescribe, normalizeNames } from "./profile.ts";

/** The toolset floor a newly created bot starts with. It is the same pair Hermes' own "Blank
 *  Slate" install mode keeps (`hermes_cli/setup.py::_blank_slate_minimal_toolsets`): enough to
 *  read a file and run a command, which is enough to run `hermes tools` and `hermes mcp` and ask
 *  the user for anything else. */
export const BLANK_SLATE_TOOLSETS = ["file", "terminal"] as const;

/** The platforms the floor is written for.
 *
 *  `cozygateway` is the platform the attach plugin registers
 *  (`integrations/attach-plugin/cozygateway/adapter.py::PLATFORM_NAME`), so it is the platform
 *  every phone-side turn resolves tools under. `cli` is written too because a cron job or a
 *  terminal session on the box resolves under its own platform key, and a platform with no saved
 *  list falls through to that platform's BROAD default composite in
 *  `hermes_cli/tools_config.py::_get_platform_tools`. Seeding one and not the other would leave
 *  the bot blank on the phone and fully armed from cron. */
export const BLANK_SLATE_PLATFORMS = ["cozygateway", "cli"] as const;

/** The approval mode a seeded bot runs under.
 *
 *  The earn-a-tool loop is the bot running `hermes tools` or `hermes mcp` through the terminal
 *  tool, which raises a `surface="gateway"` approval; that is one of the two surfaces the attach
 *  plugin forwards as a real card (`adapter.py::ANSWERABLE_APPROVAL_SURFACES`). Under `smart` an
 *  auxiliary guardian LLM answers first and the hook fires with `surface="smart"`, which the
 *  plugin deliberately does not forward, so the request the user is meant to grant would be
 *  decided without them ever seeing it. */
export const BLANK_SLATE_APPROVAL_MODE = "manual";

/** The Hermes plugin that makes a bot reachable at all.
 *
 *  A profile is only chattable from the phone once its own gateway process loads this plugin: the
 *  plugin is what opens the attach stream the gateway's `NativeBotDataPlane` reads and writes. A
 *  profile created without it is a roster row nobody can talk to, which is exactly what issue #183
 *  was. `allow_tool_override: false` mirrors the six hand-provisioned profiles: the attach plugin
 *  does not get to widen the toolset floor the seed just wrote. */
export const ATTACH_PLUGIN_NAME = "cozygateway";

/** The plugin stanza a fresh profile needs, in the shape the working profiles carry it. */
export const ATTACH_PLUGIN_SEED = {
  enabled: [ATTACH_PLUGIN_NAME],
  disabled: [] as string[],
  entries: { [ATTACH_PLUGIN_NAME]: { allow_tool_override: false } },
} as const;

/** The complete blank-slate seed, exported as one value so the creation test asserts the whole
 *  shape rather than a hand-picked subset.
 *
 *  Deliberately absent:
 *
 *  - `agent.disabled_toolsets`. Hermes' own Blank Slate pre-populates it with ~27 toolset names as
 *    a second hard-suppression layer, and that is exactly what upstream issue #49995 is about:
 *    `_get_platform_tools` subtracts that list LAST, after `platform_toolsets`, so a toolset named
 *    there can never be turned back on from the Toolsets UI. `save_platform_toolsets` now
 *    reconciles the two, but only for toolsets re-enabled through that one path and only for the
 *    platform being saved. An earn-a-tool product cannot ship a floor whose defining feature is
 *    that raising it fights back, so the seed uses the `platform_toolsets` allowlist alone. That
 *    list is authoritative: naming configurable keys flips `has_explicit_config`, and the explicit
 *    branch resolves to exactly the named keys with no default re-expansion.
 *  - a model and a soul. The app seeds the soul and the model routes own the model.
 *
 *  Known residue, stated rather than papered over: `_get_platform_tools` still runs its
 *  "recover non-configurable platform toolsets" pass in the explicit branch, so a toolset that is
 *  not in `CONFIGURABLE_TOOLSETS` but whose tools live inside the platform composite can come back
 *  even under an explicit list. That is the exact hole `agent.disabled_toolsets` plugs upstream,
 *  and the trade above is deliberate: a slightly leaky floor a user can raise beats an airtight
 *  one they cannot. */
export const BLANK_SLATE_SEED = {
  platform_toolsets: Object.fromEntries(
    BLANK_SLATE_PLATFORMS.map((platform) => [platform, [...BLANK_SLATE_TOOLSETS]]),
  ),
  approvals: { mode: BLANK_SLATE_APPROVAL_MODE },
  plugins: ATTACH_PLUGIN_SEED,
} as const;

/** What the creating user explicitly asked this bot to start with, on top of the floor. Absent
 *  fields are "no opinion", which is not the same as an empty array. */
export interface BlankSlateSelection {
  toolsets?: readonly string[];
  mcpServers?: readonly string[];
}

export interface BlankSlateSeedOutcome {
  /** False when every key the seed would write was already present, so nothing was sent. */
  wrote: boolean;
  /** Requested toolset names Hermes does not report for this profile. Skipped, never invented. */
  unknownToolsets: string[];
  /** Requested MCP server names this profile's own config does not define. Skipped: enabling a
   *  name the profile has no definition for writes a flag onto nothing. */
  unknownMcpServers: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function profilePath(name: string): string {
  return `/api/config?profile=${encodeURIComponent(name)}`;
}

function cleanNames(names: readonly string[] | undefined): string[] {
  return names === undefined ? [] : normalizeNames(names);
}

/** The toolset names Hermes reports for a profile. `mapProfileDescribe` already owns every
 *  tolerance a `profiles.describe` reply needs, so this is the same catalog the bot's own Toolsets
 *  screen renders: a name absent from it is one no UI could have offered and no resolver honours. */
export function reportedToolsetNames(describe: unknown): Set<string> {
  return new Set(mapProfileDescribe(describe).toolsets.map((toolset) => toolset.name));
}

export interface BlankSlatePlan {
  /** The deep-merge body, or undefined when the profile already carries everything. */
  config: Record<string, unknown> | undefined;
  unknownToolsets: string[];
  unknownMcpServers: string[];
}

/** The `plugins` patch a profile needs, or undefined when it is already bound.
 *
 *  Every field is merged rather than replaced, because a `plugins` stanza that already exists
 *  belongs to whoever wrote it. `enabled` in particular is an ARRAY, and the deep merge on the
 *  other side replaces arrays wholesale, so the union has to be computed here or seeding this
 *  plugin would silently unload every other one the profile had.
 *
 *  A name sitting in `disabled` is dropped from it in the same write: Hermes reads both lists and
 *  leaving `cozygateway` in each would be an instruction that contradicts itself. That is the one
 *  place this seed overrules an existing decision, and it does so only for its own plugin. */
function planAttachPlugin(plugins: Record<string, unknown>): Record<string, unknown> | undefined {
  const enabled = Array.isArray(plugins["enabled"]) ? (plugins["enabled"] as unknown[]) : [];
  const disabled = Array.isArray(plugins["disabled"]) ? (plugins["disabled"] as unknown[]) : [];
  const entries = asRecord(plugins["entries"]) ?? {};

  const isEnabled = enabled.includes(ATTACH_PLUGIN_NAME);
  const isDisabled = disabled.includes(ATTACH_PLUGIN_NAME);
  const hasEntry = entries[ATTACH_PLUGIN_NAME] !== undefined;
  if (isEnabled && !isDisabled && hasEntry) return undefined;

  const patch: Record<string, unknown> = {};
  if (!isEnabled) patch["enabled"] = [...enabled, ATTACH_PLUGIN_NAME];
  if (isDisabled) patch["disabled"] = disabled.filter((name) => name !== ATTACH_PLUGIN_NAME);
  else if (plugins["disabled"] === undefined) patch["disabled"] = [];
  if (!hasEntry) patch["entries"] = { [ATTACH_PLUGIN_NAME]: { allow_tool_override: false } };
  return patch;
}

/** Works out the subset of the seed a profile does not already carry.
 *
 *  A key that is already present is somebody's decision -- Hermes', or a user who has since raised
 *  the floor -- and the seed never overwrites it. That is what makes a retried create, or a second
 *  pass over an existing profile, a no-op rather than a demotion back to two toolsets.
 *
 *  `blankSlate` false is the operator flag turned off. The floor, the approval mode, and the
 *  quieting of inherited MCP servers all stop; an explicit SELECTION still applies, because a
 *  selection is a user saying what this bot should have and no gateway default gets to overrule
 *  that. With the flag off and no selection, this plans nothing at all. */
export function planBlankSlateSeed(input: {
  current: unknown;
  blankSlate: boolean;
  selection?: BlankSlateSelection;
  reportedToolsets?: ReadonlySet<string>;
}): BlankSlatePlan {
  const config = asRecord(input.current) ?? {};
  const patch: Record<string, unknown> = {};

  // The plugin binding first, and NOT behind `blankSlate`. That flag is toolset policy: an
  // operator turning it off is asking for hermes' broad defaults, not for an unreachable bot.
  // Reachability is not a default anyone gets to opt out of by accident.
  const pluginPatch = planAttachPlugin(asRecord(config["plugins"]) ?? {});
  if (pluginPatch !== undefined) patch["plugins"] = pluginPatch;

  const requestedToolsets = cleanNames(input.selection?.toolsets);
  const known = input.reportedToolsets;
  const unknownToolsets =
    known === undefined ? [] : requestedToolsets.filter((name) => !known.has(name));
  const grantedToolsets = requestedToolsets.filter((name) => !unknownToolsets.includes(name));

  if (input.blankSlate || grantedToolsets.length > 0) {
    // The floor is always in the list, selection or not: a bot that cannot read a file or run a
    // command cannot ask for anything else, which would end the earn-a-tool loop before it starts.
    const list = [...new Set([...BLANK_SLATE_TOOLSETS, ...grantedToolsets])].sort();
    const currentToolsets = asRecord(config["platform_toolsets"]) ?? {};
    const missing = BLANK_SLATE_PLATFORMS.filter(
      (platform) => !Array.isArray(currentToolsets[platform]),
    );
    if (missing.length > 0) {
      patch["platform_toolsets"] = Object.fromEntries(
        missing.map((platform) => [platform, list]),
      );
    }
  }

  if (input.blankSlate) {
    const approvals = asRecord(config["approvals"]) ?? {};
    const mode = approvals["mode"];
    if (typeof mode !== "string" || mode.trim() === "") {
      patch["approvals"] = { mode: BLANK_SLATE_APPROVAL_MODE };
    }
  }

  // A profile's own `mcp_servers` map is precisely what `enabled_mcp_server_names` reads
  // (`tools_config.py`), which is what makes a write here runtime-effective where
  // `profiles.configure enabledMcpServers` is not: that RPC writes the per-server `disabled` key,
  // and every runtime consumer reads `enabled` (`profile.ts::RUNTIME_INERT_SECTIONS`).
  const servers = asRecord(config["mcp_servers"]) ?? {};
  const defined = Object.keys(servers);
  const requestedMcp = cleanNames(input.selection?.mcpServers);
  const unknownMcpServers = requestedMcp.filter((name) => !defined.includes(name));
  const grantedMcp = new Set(requestedMcp.filter((name) => defined.includes(name)));
  const mcpPatch: Record<string, unknown> = {};
  for (const name of defined) {
    // Absent means enabled (`_parse_enabled_flag(..., default=True)`), so absence is the only
    // state the seed acts on. A server the user or Hermes has already given an explicit `enabled`
    // is their call and is left exactly as it is.
    if (asRecord(servers[name])?.["enabled"] !== undefined) continue;
    if (grantedMcp.has(name)) mcpPatch[name] = { enabled: true };
    // With the flag off, a server nobody asked for keeps Hermes' inherited default rather than
    // being quieted: quieting is the blank slate's job, not the selection's.
    else if (input.blankSlate) mcpPatch[name] = { enabled: false };
  }
  if (Object.keys(mcpPatch).length > 0) patch["mcp_servers"] = mcpPatch;

  return {
    config: Object.keys(patch).length === 0 ? undefined : patch,
    unknownToolsets,
    unknownMcpServers,
  };
}

/** Seeds a profile immediately after `profiles.create` succeeds.
 *
 *  Transport is the same profile-aware Dashboard config surface the model-config routes use:
 *  `GET /api/config?profile=<name>` reads that profile's config and `PUT` with `{config: ...}`
 *  DEEP-MERGES into it, so writing three sections leaves everything Hermes wrote intact. The
 *  JSON-RPC equivalents (`config.get`/`config.set`) are scoped to the gateway process rather than
 *  an arbitrary profile and cannot address a profile that is not the bridge's own.
 *
 *  A blank config file is not a blank slate: a profile with no `platform_toolsets` entry for a
 *  platform falls through to that platform's default composite, which is the broad toolset, and a
 *  fresh profile arrives carrying a COPY of the launch profile's `mcp_servers` definitions, whose
 *  missing `enabled` flags read as on. The floor has to be written down to exist. */
export async function seedBlankSlateProfile(
  client: HermesClient,
  profile: string,
  opts: { blankSlate: boolean; selection?: BlankSlateSelection } = { blankSlate: true },
): Promise<BlankSlateSeedOutcome> {
  const path = profilePath(profile);
  const current = await client.dashboardJson(path);
  const wantsToolsets = cleanNames(opts.selection?.toolsets).length > 0;
  // Only pay for the describe round trip when a name actually has to be checked against it.
  const reportedToolsets = wantsToolsets
    ? reportedToolsetNames(await client.request("profiles.describe", { name: profile }))
    : undefined;
  const plan = planBlankSlateSeed({
    current,
    blankSlate: opts.blankSlate,
    ...(opts.selection === undefined ? {} : { selection: opts.selection }),
    ...(reportedToolsets === undefined ? {} : { reportedToolsets }),
  });
  if (plan.config !== undefined) {
    await client.dashboardJson(path, { method: "PUT", body: { config: plan.config } });
  }
  return {
    wrote: plan.config !== undefined,
    unknownToolsets: plan.unknownToolsets,
    unknownMcpServers: plan.unknownMcpServers,
  };
}

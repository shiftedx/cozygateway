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

/** The skills (playbooks) a newly created bot keeps ON, by name. Empty on purpose.
 *
 *  Skills are gated by a per-profile OFF-list: `skills.disabled` in that profile's `config.yaml`,
 *  read by `agent.skill_utils.get_disabled_skill_names` and by every consumer of
 *  `tools/skills_tool.py::_find_all_skills`. There is no enabled allowlist anywhere in the model,
 *  so a profile that names nothing has every installed skill ON. A fresh profile arrives with a
 *  skills directory copied from the launch profile and NO `skills` stanza at all, which is why a
 *  brand-new bot's create sheet reads "199 on": the blank slate leaked through the one dimension
 *  the floor did not write down.
 *
 *  Empty rather than a curated handful because a blank slate has no playbooks until it is asked
 *  for one. Autonomy rides on the TOOLSET floor (`file` + `terminal`), which is what lets the bot
 *  run `hermes skills` and ask; a skill is then one approval away through the same earn-a-tool
 *  loop, or one tap away in the app's searchable skills picker, whose
 *  `PATCH /bots/:name/profile disabledSkills` is runtime-effective (it lands on this same
 *  `skills.disabled` key through `profiles.configure disabled_skills`).
 *
 *  Operators override it with `hermes.blankSlateSkillsOn`. A name here that the profile does not
 *  actually have is simply not in the catalog and therefore not in the OFF-list either; it is not
 *  invented. */
export const BLANK_SLATE_SKILLS_ON: readonly string[] = [];

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
 *  - `skills.disabled`. It IS seeded (see `BLANK_SLATE_SKILLS_ON`), but it cannot be a constant:
 *    the OFF-list is the profile's own skill CATALOG minus the floor, and the catalog is only
 *    knowable by asking Hermes about that profile. `planBlankSlateSeed` adds the key when it is
 *    given one.
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
  /** True when the skill catalog could not be read, so the skills OFF-list was left unwritten and
   *  the bot starts with every installed skill on. Never a partial guess: an OFF-list assembled
   *  from half a catalog silently leaves the other half armed, which is worse than not writing it
   *  and saying so. */
  skillCatalogUnavailable: boolean;
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

/** The skill names Hermes reports for a profile, in the order it reported them.
 *
 *  This is the catalog, and it is the SAME read the app's create sheet enumerates skills with:
 *  `readBotProfile` -> `profiles.describe` -> `mapProfileDescribe(...).skills`. Upstream builds
 *  those rows by walking `<profile>/skills/**\/SKILL.md` under that profile's HERMES_HOME
 *  (`tui_gateway/methods_profiles.py`), so it is exactly the set of names a `skills.disabled`
 *  entry can match, spelled the way the runtime matches them (case-sensitive, verbatim directory
 *  name).
 *
 *  The `enabled` flag on each row is deliberately ignored: this is an inventory, not a state.
 *  Every row of a fresh profile reads enabled anyway, because the OFF-list it is derived from does
 *  not exist yet. */
export function reportedSkillNames(describe: unknown): string[] {
  return mapProfileDescribe(describe).skills.map((skill) => skill.name);
}

export interface BlankSlatePlan {
  /** The deep-merge body, or undefined when the profile already carries everything. */
  config: Record<string, unknown> | undefined;
  unknownToolsets: string[];
  unknownMcpServers: string[];
}

/** Works out the `skills.disabled` OFF-list a profile needs, or undefined to leave the key alone.
 *
 *  Three ways to write nothing, and they are different reasons:
 *
 *  - The profile already carries `skills.disabled`. That is somebody's decision (a user who has
 *    since armed this bot, or a previous seed pass) and the seed never overwrites it. This is what
 *    makes a retried create a no-op instead of a demotion back to zero playbooks.
 *  - The catalog is undefined: it could not be read. Handled by the caller, which logs and warns.
 *  - The catalog is EMPTY. Nothing to disable, so the honest write is no write. It also keeps a
 *    degraded `profiles.describe` (upstream drops the skills section wholesale on a bad read, and
 *    `mapProfileDescribe` is deliberately tolerant of that) from planting an empty OFF-list that
 *    would then block every later pass by simply existing.
 *
 *  The list is sorted, matching what `save_disabled_skills` writes, so a config file this seed
 *  wrote and one Hermes' own skills UI wrote read the same. */
function planDisabledSkills(
  config: Record<string, unknown>,
  catalog: readonly string[] | undefined,
  floor: readonly string[],
): string[] | undefined {
  if (catalog === undefined || catalog.length === 0) return undefined;
  const skills = asRecord(config["skills"]) ?? {};
  if (skills["disabled"] !== undefined) return undefined;
  const on = new Set(normalizeNames(floor));
  const off = [...new Set(catalog)].filter((name) => !on.has(name)).sort();
  return off;
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
 *  `blankSlate` false is the operator flag turned off. The floor, the approval mode, the skills
 *  OFF-list and the quieting of inherited MCP servers all stop; an explicit SELECTION still
 *  applies, because a selection is a user saying what this bot should have and no gateway default
 *  gets to overrule that. With the flag off and no selection, this plans nothing at all.
 *
 *  Skills follow the TOOLSET rule exactly, deliberately: with the flag off the bot keeps Hermes'
 *  own default, which for skills means every installed one on. There is no skills field on
 *  `POST /bots`, so there is no create-time selection for this dimension to honour either; the
 *  user's create-sheet skill choices arrive AFTER this pass, as their own PATCH (see
 *  `seedBlankSlateProfile`). */
export function planBlankSlateSeed(input: {
  current: unknown;
  blankSlate: boolean;
  selection?: BlankSlateSelection;
  reportedToolsets?: ReadonlySet<string>;
  /** Every skill name this profile has installed, or undefined when it could not be read. */
  skillCatalog?: readonly string[];
  /** The skills that stay ON. Defaults to `BLANK_SLATE_SKILLS_ON`, which is empty. */
  skillsOn?: readonly string[];
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
    const disabledSkills = planDisabledSkills(
      config,
      input.skillCatalog,
      input.skillsOn ?? BLANK_SLATE_SKILLS_ON,
    );
    // Merged as `skills: { disabled: [...] }`, not as a whole `skills` stanza: the deep merge on
    // the other side keeps `external_dirs`, `template_vars` and the rest of a stanza Hermes may
    // already have written, and replaces only this one array.
    if (disabledSkills !== undefined) patch["skills"] = { disabled: disabledSkills };

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
 *  missing `enabled` flags read as on, and it arrives with the launch profile's SKILLS directory
 *  and no `skills.disabled` at all, which reads as every one of them on. The floor has to be
 *  written down to exist.
 *
 *  ORDERING, and why an explicit user choice still wins.
 *
 *  This runs INSIDE `POST /bots`, before the create response is even assembled. The app's create
 *  sheet then calls `PATCH /bots/:name/profile` on the bot it just got back
 *  (`BotCreateView.submit` -> `BotProfileStore.applyDraft`). That patch is a DIFF against the
 *  baseline the sheet loaded, and its `disabledSkills` is `nil` unless the user actually touched
 *  the skills section (`BotProfileStore.patch()`: `skillsChanged = draftSkills != baseline`). So:
 *
 *  - Untouched create: no `disabledSkills` on the wire, nothing overwrites this key, and the bot
 *    keeps the floor written here.
 *  - The user picked skills in the sheet: `disabled_skills` is replace-whole
 *    (`profiles.configure`, `applied.skills`), so their selection lands on top of this key and
 *    wins wholesale. That is the right precedence, and it is why the floor does not need a
 *    create-time skills field of its own.
 *
 *  The same holds for a later edit from the app's searchable skills picker, which is the earn-a-
 *  skill half of the loop: it patches the same key, runtime-effectively. */
export async function seedBlankSlateProfile(
  client: HermesClient,
  profile: string,
  opts: { blankSlate: boolean; selection?: BlankSlateSelection; skillsOn?: readonly string[] } = {
    blankSlate: true,
  },
): Promise<BlankSlateSeedOutcome> {
  const path = profilePath(profile);
  const current = await client.dashboardJson(path);
  const wantsToolsets = cleanNames(opts.selection?.toolsets).length > 0;
  // One `profiles.describe`, two jobs: it carries the toolset names a selection is checked
  // against AND the skill catalog the OFF-list is derived from. Skipped entirely when neither is
  // wanted, so a flag-off create with no selection still costs exactly one config read.
  let describe: unknown;
  let skillCatalogUnavailable = false;
  if (wantsToolsets || opts.blankSlate) {
    try {
      describe = await client.request("profiles.describe", { name: profile });
    } catch (error) {
      // A selection has to be CHECKED, so a describe that fails there is still fatal to this pass
      // and reaches the caller's warning path exactly as it did before skills existed. With no
      // selection to check, the only casualty is the skills catalog: the rest of the floor is
      // knowable from the config read alone and is worth writing.
      if (wantsToolsets) throw error;
      skillCatalogUnavailable = true;
    }
  }
  const reportedToolsets = wantsToolsets ? reportedToolsetNames(describe) : undefined;
  const skillCatalog = skillCatalogUnavailable || !opts.blankSlate
    ? undefined
    : reportedSkillNames(describe);
  const plan = planBlankSlateSeed({
    current,
    blankSlate: opts.blankSlate,
    ...(opts.selection === undefined ? {} : { selection: opts.selection }),
    ...(reportedToolsets === undefined ? {} : { reportedToolsets }),
    ...(skillCatalog === undefined ? {} : { skillCatalog }),
    ...(opts.skillsOn === undefined ? {} : { skillsOn: opts.skillsOn }),
  });
  if (plan.config !== undefined) {
    await client.dashboardJson(path, { method: "PUT", body: { config: plan.config } });
  }
  return {
    wrote: plan.config !== undefined,
    unknownToolsets: plan.unknownToolsets,
    unknownMcpServers: plan.unknownMcpServers,
    skillCatalogUnavailable,
  };
}

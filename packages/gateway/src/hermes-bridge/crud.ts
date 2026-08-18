import type { BotCreateRequest } from "cozygateway-contract";

import { HermesRpcError } from "./client.ts";
import { UI_META_KEY } from "./roster.ts";
import type { HermesRpc } from "./canonical-chat.ts";

/** Creating and deleting bots, which upstream calls profiles. There is no `bots.*` namespace and
 *  no create/delete convenience anywhere in Hermes 0.20.3: a bot is born from `profiles.create`
 *  plus a `profiles.configure` write of the look into `ui_meta["hermes-bots"]`, and it dies
 *  through whichever teardown path the gateway offers (dissection sections 1.2, 3.1 and 4.5).
 *
 *  Everything Hermes-specific about those two flows lives here, so the bridge above deals in
 *  bots and the routes above that deal in HTTP. */

/** The on-disk profile id rule, copied from upstream `hermes_cli/profiles.py`
 *  (`_PROFILE_ID_RE`, v2026.8.16.2). A name that fails it is refused by `create_profile` with a
 *  `ValueError`, so validating here turns a 502 into a 400 that names the rule. */
export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Upstream `_RESERVED_NAMES`: these collide with the Hermes install itself or with common system
 *  binaries, and `validate_profile_name` refuses every one of them. `default` is in the set and is
 *  additionally special: it names the built-in profile, which cannot be created OR deleted. */
export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "hermes",
  "default",
  "test",
  "tmp",
  "root",
  "sudo",
]);

/** The built-in profile. Never created, never deleted, always on the roster. */
export const DEFAULT_PROFILE = "default";

/** A name the Hermes rule refuses. Carries a message written for a person, since it is what the
 *  create form shows under the field. */
export class BotNameInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotNameInvalid";
  }
}

/** The profile already exists. Distinct from every other create failure because it is the one an
 *  app can fix by picking another name, and the only one that answers 409. */
export class BotNameTaken extends Error {
  readonly botName: string;

  constructor(botName: string) {
    super(`a bot named "${botName}" already exists`);
    this.name = "BotNameTaken";
    this.botName = botName;
  }
}

/** A delete the bridge refuses on its own, before anything reaches Hermes. */
export class BotDeleteRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotDeleteRefused";
  }
}

/** The gateway's command allow-list refused the delete. `hint` is the gateway's own explanation,
 *  passed through verbatim so an operator can act on it (dissection 1.2: `cli.exec` answers
 *  `{ blocked: true, hint }` rather than an error). */
export class BotDeleteBlocked extends Error {
  readonly hint: string;

  constructor(hint: string) {
    super("the hermes gateway blocked the profile delete command");
    this.name = "BotDeleteBlocked";
    this.hint = hint;
  }
}

/** The delete ran and failed. `output` is the command's combined stdout/stderr, truncated by the
 *  gateway, and is the only diagnosis an operator gets. */
export class BotDeleteFailed extends Error {
  readonly exitCode: number;
  readonly output: string;

  constructor(exitCode: number, output: string) {
    super(`the profile delete command exited ${exitCode}`);
    this.name = "BotDeleteFailed";
    this.exitCode = exitCode;
    this.output = output;
  }
}

/** Upstream `normalize_profile_name`: profiles live lowercase on disk, and `default` is matched
 *  case-insensitively. Dashboards pass title-cased labels, so normalizing before validating is
 *  what keeps `Scout` from being refused for a rule it only breaks in its display form. */
export function normalizeProfileName(raw: string): string {
  const stripped = raw.trim();
  if (stripped.length === 0) throw new BotNameInvalid("a bot name is required");
  return stripped.toLowerCase() === DEFAULT_PROFILE ? DEFAULT_PROFILE : stripped.toLowerCase();
}

/** Normalizes and validates a name for a NEW bot, exactly as `create_profile` would before it
 *  touches the filesystem. Returns the canonical (lowercase) name the rest of the flow uses.
 *
 *  `default` is refused twice over on purpose: it is a reserved name AND the built-in profile, and
 *  upstream raises a different message for each, so the one a caller sees names the real reason. */
export function validateNewBotName(raw: string): string {
  const name = normalizeProfileName(raw);
  if (name === DEFAULT_PROFILE) {
    throw new BotNameInvalid('"default" is the built-in Hermes profile and cannot be created');
  }
  if (!PROFILE_ID_RE.test(name)) {
    throw new BotNameInvalid(
      `invalid bot name "${name}": it must match [a-z0-9][a-z0-9_-]{0,63} (lowercase letters, digits, - and _)`,
    );
  }
  if (RESERVED_PROFILE_NAMES.has(name)) {
    throw new BotNameInvalid(
      `"${name}" is reserved by Hermes: it collides with the installation itself or a common system binary`,
    );
  }
  return name;
}

/** How a `ui_meta` write landed, the desktop's three-way `saveBotMeta` outcome (dissection 3.1):
 *  `persisted` only when `applied.ui_meta === true`; `unsupported` when the gateway does not speak
 *  the contract at all (rejected the call, or answered without an `applied` object), which is a
 *  silent, expected fallback on older gateways; `failed` when it speaks the contract and said the
 *  blob did NOT apply. Only `failed` is worth telling a user about. */
export type MetaOutcome = "persisted" | "unsupported" | "failed";

/** The bot blob written into `ui_meta["hermes-bots"]` at creation. Byte-compatible with the
 *  desktop's own keys, because that blob is what a desktop reads back off the same profile.
 *  `created` is MILLISECONDS (the unit trap: `last_session.last_active` is seconds). */
export interface BotMetaBlob {
  title?: string;
  shape?: string;
  color?: string;
  created: number;
}

export interface CreatedBot {
  name: string;
  /** The description written onto the profile, empty when the caller sent none. */
  description: string;
  meta: BotMetaBlob;
  metaOutcome: MetaOutcome;
}

/** True when a `profiles.create` failure means "that name is taken". Upstream turns the
 *  `FileExistsError` from `create_profile` into error code 4062 with the message
 *  `Profile 'x' already exists at <path>`; the code is matched first, and the text second, so a
 *  build that renumbers its errors still lands on 409 rather than 502. */
export function isDuplicateProfileError(err: unknown): boolean {
  if (!(err instanceof HermesRpcError)) return false;
  return err.code === 4062 || /already exists/i.test(err.message);
}

/** Reads the `applied` map `profiles.configure` answers with. */
function metaOutcomeOf(result: unknown): MetaOutcome {
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : undefined;
  const applied = record?.["applied"];
  if (typeof applied !== "object" || applied === null) return "unsupported";
  return (applied as Record<string, unknown>)["ui_meta"] === true ? "persisted" : "failed";
}

/** Creates the profile and writes its look, returning the canonical name plus how the look write
 *  landed. Two RPCs, in this order, because `profiles.configure` addresses a profile by name and
 *  therefore needs it to exist.
 *
 *  `share_auth: true` is sent EXPLICITLY, and this is load-bearing: the backend defaults it to
 *  false while the desktop UI defaults it to on, and false COPIES `auth.json` instead of sharing
 *  the launch profile's. A copy forks the OAuth token pool, and the first refresh in either half
 *  invalidates the other for single-use refresh tokens, so a bot created without it silently
 *  breaks the main profile's login some hours later (dissection 4.1).
 *
 *  A failed look write never fails the create: the profile exists either way, and losing a color
 *  is not worth orphaning a bot the caller believes was not made. */
export async function createBotProfile(
  rpc: HermesRpc,
  input: BotCreateRequest & { name: string },
  now: number,
): Promise<CreatedBot> {
  const name = validateNewBotName(input.name);
  const description = input.description?.trim() ?? "";
  try {
    await rpc.request("profiles.create", {
      name,
      description,
      share_auth: true,
    });
  } catch (err) {
    if (isDuplicateProfileError(err)) throw new BotNameTaken(name);
    throw err;
  }

  const meta: BotMetaBlob = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.shape === undefined ? {} : { shape: input.shape }),
    ...(input.color === undefined ? {} : { color: input.color }),
    created: now,
  };
  let metaOutcome: MetaOutcome;
  try {
    metaOutcome = metaOutcomeOf(await rpc.request("profiles.configure", { name, ui_meta: { [UI_META_KEY]: meta } }));
  } catch {
    metaOutcome = "unsupported";
  }
  return { name, description, meta, metaOutcome };
}

/** Which path actually deleted the profile. Reported so an operator can tell a teardown-first
 *  delete from the CLI fallback without reading the gateway's logs. */
export type DeletePath = "rpc" | "cli";

/** The argv the desktop plugin runs for its legacy delete (dissection 1.2). Kept verbatim: the
 *  gateway's allow-list matches on argv, so a reworded flag is a blocked command. */
export const PROFILE_DELETE_ARGV = (name: string): string[] => ["profile", "delete", name, "--yes"];

/** True when Hermes rejected a call because it does not know the method. The error text is the
 *  documented feature-probe channel (`/unknown method/i`, dissection 1.1) and is never reworded
 *  anywhere in this bridge, which is exactly why matching on it is safe. */
export function isUnknownMethod(err: unknown): boolean {
  return err instanceof HermesRpcError && /unknown method/i.test(err.message);
}

/** Deletes a bot's profile, preferring a teardown-first RPC and falling back to the CLI.
 *
 *  Hermes 0.20.3 registers no `profiles.delete` method (only list/create/describe/configure/
 *  set_asset/get_asset), so in practice this always takes the `cli.exec` path today. It probes
 *  anyway, and only on a `/unknown method/i` rejection falls back, because the desktop's preferred
 *  door is a teardown-first delete: `cli.exec` bypasses backend teardown, and a pool backend
 *  holding the profile directory open races the CLI's rmtree, which is the upstream
 *  "can't delete a bot" bug (dissection 4.5). The day upstream ships the RPC, this takes it
 *  without a code change; a gateway that already has one is used correctly today.
 *
 *  `blocked` is not an error on the wire, it is a successful `cli.exec` result carrying
 *  `{ blocked: true, hint }`, and it means the gateway's command allow-list refused to run the
 *  delete at all. It is raised here so the route can surface the hint, which is the only thing
 *  that tells an operator to widen the allow-list. */
export async function deleteBotProfile(rpc: HermesRpc, rawName: string): Promise<DeletePath> {
  const name = normalizeProfileName(rawName);
  if (name === DEFAULT_PROFILE) {
    throw new BotDeleteRefused('"default" is the built-in Hermes profile and cannot be deleted');
  }

  try {
    await rpc.request("profiles.delete", { name });
    return "rpc";
  } catch (err) {
    if (!isUnknownMethod(err)) throw err;
  }

  const result = await rpc.request("cli.exec", { argv: PROFILE_DELETE_ARGV(name) });
  const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  if (record["blocked"] === true) {
    const hint = typeof record["hint"] === "string" ? record["hint"] : "no hint given";
    throw new BotDeleteBlocked(hint);
  }
  const exitCode = typeof record["code"] === "number" ? record["code"] : 0;
  if (exitCode !== 0) {
    throw new BotDeleteFailed(exitCode, typeof record["output"] === "string" ? record["output"] : "");
  }
  return "cli";
}

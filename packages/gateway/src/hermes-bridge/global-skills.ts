import { createHash } from "node:crypto";

import type { Storage } from "../storage.ts";
import { HermesUnavailable, type HermesClient } from "./client.ts";

export const HERMES_GLOBAL_SKILLS_CAPABILITY_ID = "com.cozylabs.hermes-global-skills";
export const HERMES_GLOBAL_SKILLS_CAPABILITY_VERSION = 1;
export const GLOBAL_SKILL_REQUEST_TTL_MS = 24 * 60 * 60 * 1_000;

export interface HermesGlobalSkillTarget {
  /** Gateway-local identity, used only to make the revision cover every target. */
  id: string;
  /** Hermes' un-namespaced profile name. */
  profile: string;
  client: HermesClient;
}

export interface HermesGlobalSkillsSnapshot {
  disabled: string[];
  mixed: string[];
  revision: string;
  updatedAt: number;
  targetCount: number;
}

export class GlobalSkillsInvalid extends Error {}
export class GlobalSkillsNotFound extends Error {}
export class GlobalSkillsStale extends Error {
  readonly current: HermesGlobalSkillsSnapshot;
  constructor(current: HermesGlobalSkillsSnapshot) {
    super("global skill settings changed");
    this.current = current;
  }
}
export class GlobalSkillsBusy extends Error {}
export class GlobalSkillsNoProfiles extends Error {}
export class GlobalSkillsPersistenceFailed extends Error {}

type TargetState = HermesGlobalSkillTarget & {
  config: Record<string, unknown>;
  disabled: string[];
};

async function waitForOnline(client: HermesClient, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (client.state() !== "online" && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  if (client.state() !== "online") throw new HermesUnavailable("Hermes profile catalog is not online");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Hermes' resolver trims names, discards blanks, and compares the remaining spelling exactly. */
export function normalizeGlobalSkillNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))].sort();
}

/** A skill is an identifier, never a path. Its case remains Hermes' case-sensitive spelling. */
export function normalizeGlobalSkillName(value: unknown): string {
  if (typeof value !== "string") throw new GlobalSkillsInvalid("invalid skill name");
  const name = value.trim();
  if (
    name.length === 0 || name.length > 256 || /[\\/\u0000-\u001f\u007f]/.test(name)
    || name === "." || name === ".."
  ) throw new GlobalSkillsInvalid("invalid skill name");
  return name;
}

function disabledOf(config: Record<string, unknown>): string[] {
  return normalizeGlobalSkillNames(record(config["skills"])["disabled"]);
}

function revisionOf(states: readonly TargetState[]): string {
  return createHash("sha256")
    .update(JSON.stringify(states.map(({ id, disabled }) => ({ id, disabled }))))
    .digest("base64url");
}

function snapshotOf(states: readonly TargetState[], updatedAt: number): HermesGlobalSkillsSnapshot {
  const counts = new Map<string, number>();
  for (const state of states) for (const name of state.disabled)
    counts.set(name, (counts.get(name) ?? 0) + 1);
  const disabled: string[] = [];
  const mixed: string[] = [];
  for (const [name, count] of counts) (count === states.length ? disabled : mixed).push(name);
  disabled.sort();
  mixed.sort();
  return { disabled, mixed, revision: revisionOf(states), updatedAt, targetCount: states.length };
}

function profilePath(profile: string): string {
  return `/api/config?profile=${encodeURIComponent(profile)}`;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Hermes' profile-aware Dashboard config endpoint is the only YAML writer here. It owns its
 * same-filesystem atomic replacement and config-cache invalidation; the gateway only projects the
 * single `skills.disabled` key through that existing authority.
 */
export class GatewayHermesGlobalSkills {
  readonly #targets: readonly HermesGlobalSkillTarget[];
  readonly #storage: Storage;
  readonly #now: () => number;
  #lastRevision: string | undefined;
  #lastUpdatedAt = 0;
  #busy = false;

  constructor(targets: readonly HermesGlobalSkillTarget[], storage: Storage, now: () => number = Date.now) {
    this.#targets = targets;
    this.#storage = storage;
    this.#now = now;
  }

  get available(): boolean { return this.#targets.length > 0; }
  get targetCount(): number { return this.#targets.length; }

  /**
   * Proves the two backing route dependencies without mutating config: Dashboard config is the
   * GET/PUT authority and profiles.describe is the mutation catalogue. Startup deliberately
   * withholds the whole surface when either is absent, unreachable, or shape-incompatible.
   */
  async probe(): Promise<void> {
    await this.#readState();
    await Promise.all([...new Set(this.#targets.map((target) => target.client))].map((client) => waitForOnline(client)));
    await this.#skillCatalogs();
  }

  async read(): Promise<HermesGlobalSkillsSnapshot> {
    return (await this.#readState()).snapshot;
  }

  async mutate(input: {
    skillName: unknown;
    enabled: unknown;
    expectedRevision: unknown;
    requestId: unknown;
  }): Promise<HermesGlobalSkillsSnapshot> {
    const skillName = normalizeGlobalSkillName(input.skillName);
    if (typeof input.enabled !== "boolean" || typeof input.expectedRevision !== "string"
      || input.expectedRevision.length === 0 || input.expectedRevision.length > 256
      || typeof input.requestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) {
      throw new GlobalSkillsInvalid("invalid global skill update");
    }
    const cached = this.#storage.hermesGlobalSkillRequest(input.requestId, this.#now());
    if (cached !== undefined) return cached as HermesGlobalSkillsSnapshot;
    if (this.#busy) throw new GlobalSkillsBusy("global skill update in progress");
    this.#busy = true;
    try {
      const before = await this.#readState();
      if (before.snapshot.revision !== input.expectedRevision) throw new GlobalSkillsStale(before.snapshot);
      if (!await this.#skillExists(skillName)) throw new GlobalSkillsNotFound("skill not found");

      // All target documents are read and their exact replacements computed before Hermes sees a
      // write. The Dashboard applies each replacement atomically; a later refusal restores every
      // earlier target through the same profile-aware writer.
      const replacements = before.states.map((state) => ({
        state,
        disabled: input.enabled
          ? state.disabled.filter((name) => name !== skillName)
          : [...new Set([...state.disabled, skillName])].sort(),
      }));
      let writesStarted = false;
      try {
        // A second aggregate read closes the practical read/stage/commit gap. Hermes Dashboard
        // presently exposes no ETag/conditional-write primitive, so each target is also reread
        // immediately before its write. That gives an external Dashboard or profile edit a
        // stale-revision response instead of a blind overwrite whenever it is observable.
        await this.#assertUnchanged(before);
        for (const replacement of replacements) {
          await this.#assertTargetUnchanged(replacement.state);
          writesStarted = true;
          await replacement.state.client.dashboardJson(profilePath(replacement.state.profile), {
            method: "PUT", body: { config: { skills: { disabled: replacement.disabled } } },
          });
        }
      } catch (error) {
        // A request deadline can fire after Hermes persisted a PUT. Reconcile every target, not
        // merely acknowledged writes, so that ambiguous failures cannot strand one profile in the
        // requested state. A state equal to its staged replacement is restored through Hermes'
        // normal atomic/config-cache-invalidation writer.
        if (writesStarted) await this.#restoreStagedState(before.states, replacements);
        if (error instanceof GlobalSkillsStale) throw error;
        if (error instanceof HermesUnavailable) throw error;
        throw new GlobalSkillsPersistenceFailed("could not save global skill settings");
      }
      // A successful Dashboard response is Hermes' commit acknowledgement. Construct the result
      // from exactly those acknowledged replacements instead of adding a fallible post-commit
      // read that could turn a completed write into an ambiguous retry.
      const afterStates = replacements.map(({ state, disabled }) => ({ ...state, disabled }));
      const updatedAt = this.#updatedAt(revisionOf(afterStates));
      const after = snapshotOf(afterStates, updatedAt);
      this.#storage.rememberHermesGlobalSkillRequest(input.requestId, after, this.#now() + GLOBAL_SKILL_REQUEST_TTL_MS);
      return after;
    } finally {
      this.#busy = false;
    }
  }

  async #readState(): Promise<{ states: TargetState[]; snapshot: HermesGlobalSkillsSnapshot }> {
    if (this.#targets.length === 0) throw new GlobalSkillsNoProfiles("no managed Hermes profiles");
    const states = await Promise.all(this.#targets.map(async (target) => {
      const config = record(await target.client.dashboardJson(profilePath(target.profile)));
      return { ...target, config, disabled: disabledOf(config) };
    }));
    const updatedAt = this.#updatedAt(revisionOf(states));
    return { states, snapshot: snapshotOf(states, updatedAt) };
  }

  async #assertUnchanged(before: { states: TargetState[]; snapshot: HermesGlobalSkillsSnapshot }): Promise<void> {
    const current = await this.#readState();
    if (current.snapshot.revision !== before.snapshot.revision) throw new GlobalSkillsStale(current.snapshot);
  }

  async #assertTargetUnchanged(before: TargetState): Promise<void> {
    const config = record(await before.client.dashboardJson(profilePath(before.profile)));
    if (!sameNames(disabledOf(config), before.disabled)) {
      const current = await this.#readState();
      throw new GlobalSkillsStale(current.snapshot);
    }
  }

  async #restoreStagedState(
    before: readonly TargetState[],
    replacements: readonly { state: TargetState; disabled: string[] }[],
  ): Promise<void> {
    const replacementById = new Map(replacements.map((replacement) => [replacement.state.id, replacement]));
    const live = await this.#readState();
    await Promise.allSettled(live.states.map(async (current) => {
      const original = before.find((state) => state.id === current.id);
      const replacement = replacementById.get(current.id);
      if (original === undefined || replacement === undefined || !sameNames(current.disabled, replacement.disabled)) return;
      await current.client.dashboardJson(profilePath(current.profile), {
        method: "PUT", body: { config: { skills: { disabled: original.disabled } } },
      });
    }));
    // Best-effort rollback is not enough. A completed error may only be reported after a fresh
    // read verifies every profile returned to its staged disabled list.
    const restored = await this.#readState();
    if (restored.states.some((state) => {
      const original = before.find((entry) => entry.id === state.id);
      return original === undefined || !sameNames(state.disabled, original.disabled);
    })) throw new GlobalSkillsPersistenceFailed("could not restore global skill settings");
  }

  #updatedAt(revision: string): number {
    if (revision !== this.#lastRevision) {
      this.#lastRevision = revision;
      this.#lastUpdatedAt = this.#now();
    }
    return this.#lastUpdatedAt;
  }

  async #skillExists(skillName: string): Promise<boolean> {
    const catalogs = await this.#skillCatalogs();
    return catalogs.some((skills) => skills.some((name) => name === skillName));
  }

  async #skillCatalogs(): Promise<string[][]> {
    const catalogs = await Promise.all(this.#targets.map(async ({ client, profile }) => {
      const result = record(await client.request("profiles.describe", { name: profile }));
      const rawSkills = result["skills"];
      // An actual empty array means this profile currently has no installable skills and is a
      // valid catalogue. Missing or malformed data instead means this Hermes cannot prove the
      // mutation route's validation dependency, so capability discovery must fail closed.
      if (!Array.isArray(rawSkills)) throw new HermesUnavailable("Hermes returned an invalid skill catalog");
      return rawSkills
        .flatMap((entry) => {
          const name = record(entry)["name"];
          return typeof name === "string" ? [name] : [];
        });
    }));
    return catalogs;
  }
}

import { randomUUID } from "node:crypto";

import { hashToken, mintDeviceToken } from "../auth.ts";
import type { RunnerRow, Storage } from "../storage.ts";
import { NoRunnerPaired, RunnerChoiceRequired, RunnerUnknown } from "./runtime-bots.ts";

export type { RunnerRow } from "../storage.ts";

/** The legacy `COZYGATEWAY_RUNNER_TOKEN` presented as one row, so the roster and the lane never
 *  disagree about who exists. It is never persisted, never the account default by flag, and never
 *  removable: an operator who placed the credential takes it away by unsetting the variable. */
export const LEGACY_RUNNER_ID = "legacy";
export const LEGACY_RUNNER_NAME = "legacy runner";

/** 32 random bytes, exactly the shape `mintDeviceToken` produces, so nothing downstream can tell a
 *  runner credential and a device credential apart by looking at one. */
export function mintRunnerToken(): { token: string; tokenHash: string } {
  return mintDeviceToken();
}

export interface RunnerRosterOptions {
  storage: Storage;
  now?: () => number;
}

/** Capability 52. The paired computers that run bots, and the one place that decides which of them
 *  an unaddressed operation belongs to.
 *
 *  It owns no sockets: the lane asks it who a bearer is and tells it what a `hello` reported, and
 *  every durable fact lives in the `runners` table. That split is what lets a runner be revoked
 *  from the app while its socket is still open, and what lets a freshly paired runner exist before
 *  it has ever connected. */
export class RunnerRoster {
  readonly #storage: Storage;
  readonly #now: () => number;

  constructor(opts: RunnerRosterOptions) {
    this.#storage = opts.storage;
    this.#now = opts.now ?? Date.now;
  }

  /** Writes a row and returns its one-time token. The setup code is consumed by the route before
   *  this is called: minting is not this class's admission decision. */
  pair(input: { name?: string }): { token: string; runner: RunnerRow } {
    const { token, tokenHash } = mintRunnerToken();
    const id = randomUUID();
    // The first paired runner is the default, so a single-computer account never has to be told
    // about a choice it does not have.
    const isDefault = this.#storage.countRunners() === 0;
    const name = normalizeName(input.name);
    this.#storage.createRunner({ id, name, tokenHash, createdAt: this.#now(), isDefault });
    return { token, runner: this.#storage.runner(id)! };
  }

  /** Resolves a bearer to a runner row by the same hashed lookup every other credential on this
   *  gateway goes through, so a wrong token is never compared byte by byte against a real one.
   *  `undefined` covers an absent header, a malformed one, and the legacy shared token, which the
   *  lane resolves itself. */
  resolve(bearer: string | undefined): RunnerRow | undefined {
    if (bearer === undefined) return undefined;
    const token = bearer.startsWith("Bearer ") ? bearer.slice("Bearer ".length) : "";
    if (token.length === 0) return undefined;
    return this.#storage.runnerByTokenHash(hashToken(token));
  }

  list(): readonly RunnerRow[] {
    return this.#storage.listRunners();
  }

  get(id: string): RunnerRow | undefined {
    return this.#storage.runner(id);
  }

  count(): number {
    return this.#storage.countRunners();
  }

  /** The account default: the flagged row, else the only row, else undefined. The fallback matters
   *  because a database written before this flag existed has no flagged row at all. */
  defaultRunner(): RunnerRow | undefined {
    const rows = this.#storage.listRunners();
    return rows.find((row) => row.isDefault) ?? (rows.length === 1 ? rows[0] : undefined);
  }

  setDefault(id: string): RunnerRow | undefined {
    if (!this.#storage.setDefaultRunner(id)) return undefined;
    return this.#storage.runner(id);
  }

  remove(id: string): boolean {
    return this.#storage.deleteRunner(id);
  }

  touch(id: string, at: number): void {
    this.#storage.touchRunner(id, at);
  }

  observe(
    id: string,
    seen: { name?: string; platform?: string; version?: string; backends?: readonly string[] },
  ): void {
    this.#storage.observeRunner(id, seen);
  }
}

function normalizeName(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return "runner";
  return trimmed.slice(0, 120);
}

/** The wire projection. `platform` is the flat string a client renders; the runner reports it as an
 *  object and the gateway flattens it once, here, so every reader sees the same string. */
export function runnerToWire(
  runner: RunnerRow,
  online: boolean,
  /** Capability 54. How many runtime bots this gateway placed on that computer. Omitted rather than
   *  sent as a zero by a caller that did not measure it. */
  botCount?: number,
): {
  id: string;
  name: string;
  platform: string | null;
  version: string | null;
  backends: string[];
  default: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  botCount?: number;
} {
  return {
    id: runner.id,
    name: runner.name,
    platform: runner.platform,
    version: runner.version,
    backends: [...runner.backends],
    default: runner.isDefault,
    createdAt: runner.createdAt,
    lastSeenAt: runner.lastSeenAt,
    online,
    ...(botCount === undefined ? {} : { botCount }),
  };
}

/** The legacy shared credential as one roster row, so a gateway carrying both kinds answers one
 *  honest list. It is synthesized on every read and never written, which is why `createdAt` is 0:
 *  nothing ever paired it, an operator placed it in the environment. */
export function legacyRunnerRow(seen: {
  platform?: string | null;
  version?: string | null;
  backends?: readonly string[];
  lastSeenAt?: number | null;
} = {}): RunnerRow {
  return {
    id: LEGACY_RUNNER_ID,
    name: LEGACY_RUNNER_NAME,
    platform: seen.platform ?? null,
    version: seen.version ?? null,
    backends: seen.backends ?? [],
    isDefault: false,
    createdAt: 0,
    lastSeenAt: seen.lastSeenAt ?? null,
  };
}

/** Capability 54. The one place that decides which computer a create belongs to, handed to
 *  `RuntimeBotService` as its `resolveRunner`.
 *
 *  The order is the person's own: what they asked for, then what they flagged as the default, then
 *  the only computer they have. It never picks between several silently, because a bot on the wrong
 *  machine is worse than a question, and it never falls back off a named runner that is gone,
 *  because that is a client naming a machine that is not there.
 *
 *  The operator-placed legacy shared credential counts as one computer when no runner has been
 *  paired, which is what keeps a deployment that predates pairing creating bots unchanged. */
export function createRunnerResolver(opts: {
  roster: RunnerRoster;
  /** Whether `COZYGATEWAY_RUNNER_TOKEN` is set on this gateway. */
  legacyConfigured: () => boolean;
}): (requested: string | undefined) => { id: string; name: string } {
  const legacy = { id: LEGACY_RUNNER_ID, name: LEGACY_RUNNER_NAME };
  return (requested) => {
    const rows = opts.roster.list();
    if (requested !== undefined) {
      const named = rows.find((row) => row.id === requested);
      if (named !== undefined) return { id: named.id, name: named.name };
      if (requested === LEGACY_RUNNER_ID && opts.legacyConfigured()) return legacy;
      throw new RunnerUnknown(requested);
    }
    // A paired computer is preferred over the legacy shared credential: pairing is the deliberate
    // act, and an operator who left the old variable set did not thereby choose it.
    const preferred = opts.roster.defaultRunner();
    if (preferred !== undefined) return { id: preferred.id, name: preferred.name };
    if (rows.length === 0) {
      if (opts.legacyConfigured()) return legacy;
      throw new NoRunnerPaired();
    }
    if (rows.length === 1) return { id: rows[0]!.id, name: rows[0]!.name };
    throw new RunnerChoiceRequired(rows.map((row) => ({ id: row.id, name: row.name })));
  };
}

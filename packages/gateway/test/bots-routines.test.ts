import { afterEach, describe, expect, it } from "vitest";
import type { BotRoutine, ServerFrame } from "cozygateway-contract";

import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient, type HermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  LEGACY_DELEGATED_ROUTINE_PREFIX,
  SAFE_ROUTINE_MARKER,
  mapRoutine,
  routineBot,
  routineJobName,
  routinePrompt,
  routineTimestamp,
  routineTitle,
  scheduleHuman,
  selectRoutineJobs,
  shellQuote,
} from "../src/hermes-bridge/routines.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** The routines surface over the bridge (contract/ext-bots-v1.md, routines): the `[bot:<name>]`
 *  namespace, the list mapping and its legacy auto-pause, create/patch/delete, the scoping that
 *  keeps foreign cron jobs out, and the `bot_routines` frame.
 *
 *  Everything runs against a fake Hermes whose `cron.manage` behaves like the real one, including
 *  the two behaviors that break naive clients: a refusal arrives as a SUCCESSFUL result carrying
 *  `success: false`, and a list reports the schedule NORMALIZED and the prompt TRUNCATED. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  agents: [{ id: "mock", name: "Mock", backend: "mock" }],
};

const NOW = 1_800_000_000_000;

const servers: FakeHermesServer[] = [];
const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await server.close();
  for (const storage of storages.splice(0)) storage.close();
});

async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const profilesListResult = {
  profiles: [
    { name: "scout", description: "watches CI", has_avatar: false },
    { name: "pip", description: "runs errands", has_avatar: false },
  ],
  bot_mode_protocol: true,
};

interface FakeJob {
  id: string;
  name: string;
  /** What the backend STORES, which is the normalized display string. */
  schedule: string;
  prompt: string;
  enabled: boolean;
  paused: boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_status?: string;
  repeat?: string;
  continuity?: boolean;
}

/** The backend's own schedule normalization (cron/jobs.py parse_schedule): an interval is stored in
 *  MINUTES, a bare duration becomes `once in <original>`, a cron expression is stored verbatim, and
 *  anything else is refused. Reproduced so the tests exercise the normalization a client sees rather
 *  than an echo of what they sent. */
function normalizeSchedule(schedule: string): string {
  const every = /^every (\d+)([mhd])$/.exec(schedule.trim());
  if (every !== null) {
    const n = Number(every[1]);
    const minutes = every[2] === "m" ? n : every[2] === "h" ? n * 60 : n * 1440;
    return `every ${minutes}m`;
  }
  if (/^\d+[mhd]$/.test(schedule.trim())) return `once in ${schedule.trim()}`;
  const parts = schedule.trim().split(/\s+/);
  if (parts.length >= 5 && parts.slice(0, 5).every((part) => /^[\d*\-,/]+$/.test(part))) return schedule.trim();
  throw new Error(`Invalid schedule '${schedule}'.`);
}

interface CronFake {
  jobs: FakeJob[];
  /** Every `cron.manage` call, in order, with the params it carried. */
  calls: Array<{ action: string; params: Record<string, unknown> }>;
  /** Job ids whose pause must fail (as a SOFT refusal, the way the backend refuses). */
  failPause: Set<string>;
  failRemove: Set<string>;
  /** A backend that refuses the scoped LIST, which is what an older or scoping-hostile gateway
   *  does. There is no client input in a list, so its refusal is a server-side failure. */
  failList: boolean;
  /** A backend that refuses the `add` softly rather than raising: the schedule shape it dislikes is
   *  still the user's own input. */
  failAdd: boolean;
  methods: Record<string, (params: Record<string, unknown>) => unknown>;
}

function cronFake(initial: FakeJob[] = []): CronFake {
  const fake: Partial<CronFake> = {
    jobs: [...initial],
    calls: [],
    failPause: new Set<string>(),
    failRemove: new Set<string>(),
    failList: false,
    failAdd: false,
  };
  let seq = 0;

  const format = (job: FakeJob): Record<string, unknown> => ({
    job_id: job.id,
    name: job.name,
    skill: null,
    skills: [],
    // The backend never returns a whole prompt: 100 characters plus an ellipsis.
    prompt_preview: job.prompt.length > 100 ? `${job.prompt.slice(0, 100)}...` : job.prompt,
    schedule: job.schedule,
    repeat: job.repeat ?? "forever",
    deliver: "local",
    next_run_at: job.next_run_at ?? null,
    last_run_at: job.last_run_at ?? null,
    ...(job.last_status === undefined ? {} : { last_status: job.last_status }),
    enabled: job.enabled,
    state: job.paused ? "paused" : "active",
    ...(job.continuity === true ? { continuity: true } : {}),
  });

  const find = (id: unknown): FakeJob | undefined => fake.jobs?.find((job) => job.id === id);
  const notFound = (id: unknown): Record<string, unknown> => ({
    success: false,
    error: `Job with ID or name '${String(id)}' not found. Use cronjob(action='list') to inspect jobs.`,
  });

  fake.methods = {
    "cron.manage": (params: Record<string, unknown>) => {
      const action = String(params["action"] ?? "list");
      fake.calls?.push({ action, params });
      if (action === "list") {
        if (fake.failList === true) return { success: false, error: "unknown profile scope" };
        return { success: true, count: fake.jobs?.length ?? 0, jobs: (fake.jobs ?? []).map(format) };
      }
      if (action === "add") {
        if (fake.failAdd === true) return { success: false, error: "refused the add" };
        let schedule: string;
        try {
          schedule = normalizeSchedule(String(params["schedule"] ?? ""));
        } catch (err) {
          // A schedule the backend cannot parse RAISES upstream, which surfaces as a JSON-RPC error.
          throw { code: 5023, message: err instanceof Error ? err.message : "bad schedule" };
        }
        const job: FakeJob = {
          id: `job_${++seq}`,
          name: String(params["name"] ?? ""),
          schedule,
          prompt: String(params["prompt"] ?? ""),
          enabled: true,
          paused: false,
          next_run_at: "2026-08-18T09:00:00+00:00",
          ...(typeof params["repeat"] === "number" ? { repeat: `${params["repeat"]} times` } : {}),
          ...(params["continuity"] === true ? { continuity: true } : {}),
        };
        fake.jobs?.push(job);
        return {
          success: true,
          job_id: job.id,
          name: job.name,
          schedule: job.schedule,
          next_run_at: job.next_run_at,
          job: format(job),
          message: `Cron job '${job.name}' created.`,
        };
      }
      const id = params["name"];
      const job = find(id);
      if (job === undefined) return notFound(id);
      if (action === "pause") {
        if (fake.failPause?.has(job.id) === true) return { success: false, error: `Failed to pause '${job.id}'` };
        job.paused = true;
        job.enabled = false;
        return { success: true, job: format(job) };
      }
      if (action === "resume") {
        job.paused = false;
        job.enabled = true;
        return { success: true, job: format(job) };
      }
      if (action === "remove") {
        if (fake.failRemove?.has(job.id) === true) return { success: false, error: `Failed to remove job '${job.id}'` };
        fake.jobs = (fake.jobs ?? []).filter((entry) => entry.id !== job.id);
        return { success: true, message: `Cron job '${job.name}' removed.`, removed_job: { id: job.id, name: job.name } };
      }
      return { success: false, error: `unknown cron action: ${action}` };
    },
  };
  return fake as CronFake;
}

interface Harness {
  server: FakeHermesServer;
  bridge: HermesBridge;
  client: HermesClient;
  cron: CronFake;
  frames: ServerFrame[];
  authed: (path: string, init?: RequestInit) => Promise<Response>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

async function setup(
  jobs: FakeJob[] = [],
  opts: { bridgeProfile?: string; profiles?: string[] } = {},
): Promise<Harness> {
  const cron = cronFake(jobs);
  // A roster that can hold names this gateway would never CREATE, because a profile made outside it
  // can, and the routines surface has to survive one.
  const profiles =
    opts.profiles === undefined
      ? profilesListResult
      : { profiles: opts.profiles.map((name) => ({ name, description: "", has_avatar: false })), bot_mode_protocol: true };
  const server = await startFakeHermesServer({
    methods: { "profiles.list": () => profiles, ...cron.methods },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({
    url: server.url,
    auth: { mode: "token", token: "T" },
    reconnect: { minMs: 15, maxMs: 60 },
  });
  const frames: ServerFrame[] = [];
  const bridge = new HermesBridge({
    client,
    storage,
    broadcast: (frame) => frames.push(frame),
    now: () => NOW,
    logSink: () => {},
    ...(opts.bridgeProfile === undefined ? {} : { bridgeProfile: opts.bridgeProfile }),
  });
  bridges.push(bridge);

  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": 4 } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pairRes = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pairRes.json()) as { deviceToken: string };

  bridge.start();
  await until(() => client.state() === "online");
  return {
    server,
    bridge,
    client,
    cron,
    frames,
    authed: async (path, init) =>
      app.request(path, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${deviceToken}` } }),
    request: async (path, init) => app.request(path, init),
  };
}

function body(method: string, payload: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
}

function job(over: Partial<FakeJob> & { id: string; name: string }): FakeJob {
  return {
    schedule: "0 9 * * *",
    prompt: "check the build",
    enabled: true,
    paused: false,
    next_run_at: "2026-08-18T09:00:00+00:00",
    ...over,
  };
}

describe("namespacing", () => {
  it("reads a bot out of a job name and strips the tag for display", () => {
    expect(routineBot({ name: "[bot:Scout] Morning digest" })).toBe("scout");
    expect(routineTitle({ name: "[bot:scout] Morning digest" })).toBe("Morning digest");
    // A tagged job with nothing after the tag still needs a label.
    expect(routineTitle({ name: "[bot:scout] " })).toBe("Untitled cronjob");
    expect(routineBot({ name: "nightly backup" })).toBeNull();
    expect(routineJobName("scout", "Morning digest")).toBe("[bot:scout] Morning digest");
    // A bracket inside the tag makes the name ambiguous, and the safe reading is that it belongs to
    // NOBODY: read as bot `a`, it would hand one bot another's routines to list and to delete.
    expect(routineBot({ name: "[bot:a]b] Theirs" })).toBeNull();
    expect(routineBot({ name: "[bot:scout]" })).toBe("scout");
  });

  it("round-trips a created routine through the namespace", async () => {
    const h = await setup();
    const res = await h.authed(
      "/bots/scout/routines",
      body("POST", { title: "Morning digest", schedule: "0 9 * * 1-5", prompt: "summarize the overnight builds" }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { routine: BotRoutine };
    // Stored under the desktop's exact name, and read back with the tag gone.
    expect(h.cron.jobs[0]?.name).toBe("[bot:scout] Morning digest");
    expect(created.routine.title).toBe("Morning digest");

    const list = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    expect(list.routines.map((routine) => routine.title)).toEqual(["Morning digest"]);
  });

  it("sends the profile scope on every cron call", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    await h.authed("/bots/scout/routines");
    await h.authed("/bots/scout/routines/j1", body("PATCH", { enabled: false }));
    expect(h.cron.calls.every((call) => call.params["profile"] === "scout")).toBe(true);
    // The list also asks for paused jobs, or a switched-off routine reads as deleted.
    expect(h.cron.calls[0]?.params["include_disabled"]).toBe(true);
  });
});

describe("list mapping", () => {
  it("maps schedules, timestamps and state the way the wire promises", async () => {
    const h = await setup([
      job({
        id: "j1",
        name: "[bot:scout] Inbox sweep",
        schedule: "every 120m",
        last_run_at: "2026-08-17T09:00:00+00:00",
        last_status: "success",
        repeat: "3 times",
        continuity: true,
      }),
      job({ id: "j2", name: "[bot:scout] Nightly", schedule: "0 3 * * *", enabled: false, paused: true }),
    ]);
    const res = await h.authed("/bots/scout/routines");
    expect(res.status).toBe(200);
    const { routines } = (await res.json()) as { routines: BotRoutine[] };

    expect(routines[0]).toMatchObject({
      id: "j1",
      title: "Inbox sweep",
      schedule: { raw: "every 120m", human: "Every 2h" },
      enabled: true,
      state: "active",
      legacyUnsafe: false,
      lastRun: Date.parse("2026-08-17T09:00:00+00:00"),
      nextRun: Date.parse("2026-08-18T09:00:00+00:00"),
      lastStatus: "success",
      repeat: "3 times",
      continuity: true,
    });
    // A cron expression gets no label: `human` is absent and a client renders `raw`.
    expect(routines[1]?.schedule).toEqual({ raw: "0 3 * * *" });
    expect(routines[1]?.enabled).toBe(false);
  });

  it("names only the schedule shapes it can name", () => {
    expect(scheduleHuman("every 1440m")).toBe("Daily");
    expect(scheduleHuman("every 2880m")).toBe("Every 2 days");
    expect(scheduleHuman("every 60m")).toBe("Hourly");
    expect(scheduleHuman("every 180m")).toBe("Every 3h");
    expect(scheduleHuman("every 45m")).toBe("Every 45m");
    expect(scheduleHuman("once in 30m")).toBe("Once (30m)");
    expect(scheduleHuman("30m")).toBe("Once (30m)");
    expect(scheduleHuman("0 9 * * *")).toBeUndefined();
    expect(scheduleHuman("once at 2026-02-03 14:00")).toBeUndefined();
  });

  it("reads timestamps in every shape the backend sends", () => {
    expect(routineTimestamp("2026-08-17T09:00:00+00:00")).toBe(Date.parse("2026-08-17T09:00:00+00:00"));
    expect(routineTimestamp(null)).toBeNull();
    expect(routineTimestamp("")).toBeNull();
    expect(routineTimestamp("not a date")).toBeNull();
    // Seconds and milliseconds both appear on this backend, and both land as milliseconds.
    expect(routineTimestamp(1_755_424_800)).toBe(1_755_424_800_000);
    expect(routineTimestamp(1_755_424_800_000)).toBe(1_755_424_800_000);
  });
});

describe("the legacy auto-pause", () => {
  const legacy = (id: string): FakeJob =>
    job({
      id,
      name: `[bot:scout] Legacy ${id}`,
      prompt: `${LEGACY_DELEGATED_ROUTINE_PREFIX}Legacy ${id}" for agent 'scout'. Execute it AS that agent`,
    });

  it("pauses an active legacy routine and reports it paused in the same answer", async () => {
    const h = await setup([legacy("j1"), job({ id: "j2", name: "[bot:scout] Fine" })]);
    const { routines } = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };

    expect(routines[0]).toMatchObject({ id: "j1", legacyUnsafe: true, enabled: false, autoPaused: true, state: "paused" });
    expect(routines[1]).toMatchObject({ id: "j2", legacyUnsafe: false, enabled: true });
    expect(h.cron.calls.filter((call) => call.action === "pause").map((call) => call.params["name"])).toEqual(["j1"]);
    // The pause actually landed on the backend, not just on the response.
    expect(h.cron.jobs.find((entry) => entry.id === "j1")?.paused).toBe(true);
  });

  it("does not pause an already paused legacy routine", async () => {
    const h = await setup([{ ...legacy("j1"), enabled: false, paused: true }]);
    const { routines } = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    expect(routines[0]).toMatchObject({ legacyUnsafe: true, enabled: false });
    expect(routines[0]?.autoPaused).toBeUndefined();
    expect(h.cron.calls.some((call) => call.action === "pause")).toBe(false);
  });

  it("a pause that fails never fails the list, and its row is not claimed as paused", async () => {
    const h = await setup([legacy("j1")]);
    h.cron.failPause.add("j1");
    const res = await h.authed("/bots/scout/routines");
    expect(res.status).toBe(200);
    const { routines } = (await res.json()) as { routines: BotRoutine[] };
    expect(routines).toHaveLength(1);
    expect(routines[0]?.autoPaused).toBeUndefined();
    // Still reported as off, because a legacy routine is never offered as runnable.
    expect(routines[0]).toMatchObject({ legacyUnsafe: true, enabled: false });
  });

  it("does not touch an untagged job that merely looks legacy", async () => {
    const h = await setup([
      job({ id: "j1", name: "nightly backup", prompt: `${LEGACY_DELEGATED_ROUTINE_PREFIX}Nightly" for agent 'ops'.` }),
    ]);
    const { routines } = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    expect(routines).toHaveLength(0);
    expect(h.cron.calls.some((call) => call.action === "pause")).toBe(false);
  });

  it("writes a marker-prefixed delegation, so a routine this gateway creates is never legacy", () => {
    const prompt = routinePrompt({ bot: "scout", title: "Digest", instruction: "summarize", schedulerProfile: "default" });
    expect(prompt.startsWith(SAFE_ROUTINE_MARKER)).toBe(true);
    expect(prompt.startsWith(LEGACY_DELEGATED_ROUTINE_PREFIX)).toBe(false);
    expect(prompt).toContain(`hermes -p 'scout' chat -c 'Routine: Digest' -q '[Scheduled routine] summarize'`);
    // The bot that IS the scheduler gets the bare instruction: the run already lands in its history.
    expect(routinePrompt({ bot: "scout", title: "Digest", instruction: "summarize", schedulerProfile: "Scout" })).toBe(
      "summarize",
    );
    // A quote in free text closes, escapes and reopens rather than breaking out of the command.
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  it("marks a bare instruction that happens to read like the legacy sentence", () => {
    // Otherwise a user whose own words start that way gets their routine flagged legacyUnsafe and
    // auto-paused on every single list, forever, for text they wrote themselves.
    const prompt = routinePrompt({
      bot: "scout",
      title: "Digest",
      instruction: `${LEGACY_DELEGATED_ROUTINE_PREFIX}Digest" the way I asked`,
      schedulerProfile: "scout",
    });
    expect(prompt.startsWith(SAFE_ROUTINE_MARKER)).toBe(true);
    expect(prompt).toContain(`${LEGACY_DELEGATED_ROUTINE_PREFIX}Digest" the way I asked`);
  });

  it("does not try to pause a legacy job the backend gave no id for", async () => {
    const h = await setup([
      job({ id: "", name: "[bot:scout] Legacy", prompt: `${LEGACY_DELEGATED_ROUTINE_PREFIX}Legacy" for agent 'scout'.` }),
    ]);
    const { routines } = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    // Reported as the legacy row it is; `cron.manage` resolves the row by `name`, and an empty one
    // names nothing, so the pause would be a guaranteed refusal against an unidentified job.
    expect(routines[0]).toMatchObject({ legacyUnsafe: true, enabled: false });
    expect(h.cron.calls.some((call) => call.action === "pause")).toBe(false);
  });
});

describe("create, patch and delete", () => {
  it("creates with the backend's own stored row, not an echo of the request", async () => {
    const h = await setup();
    const res = await h.authed(
      "/bots/scout/routines",
      body("POST", { title: "Sweep", schedule: "every 2h", prompt: "sweep the inbox", repeat: 3, continuity: true }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { name: string; routine: BotRoutine };
    expect(created.name).toBe("scout");
    // The backend normalizes an interval to minutes; a client rendering its own request would lie.
    expect(created.routine.schedule).toEqual({ raw: "every 120m", human: "Every 2h" });
    expect(created.routine.repeat).toBe("3 times");
    expect(created.routine.continuity).toBe(true);
    const add = h.cron.calls.find((call) => call.action === "add");
    expect(add?.params["repeat"]).toBe(3);
    expect(add?.params["continuity"]).toBe(true);
  });

  it("pauses and resumes in place, keeping the routine's id", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const off = (await (await h.authed("/bots/scout/routines/j1", body("PATCH", { enabled: false }))).json()) as {
      routine: BotRoutine;
      replacedId?: string;
    };
    expect(off.routine).toMatchObject({ id: "j1", enabled: false });
    expect(off.replacedId).toBeUndefined();
    expect(h.cron.jobs[0]?.paused).toBe(true);

    const on = (await (await h.authed("/bots/scout/routines/j1", body("PATCH", { enabled: true }))).json()) as {
      routine: BotRoutine;
    };
    expect(on.routine).toMatchObject({ id: "j1", enabled: true });
    // Row actions carry the JOB ID in `name`, which is the backend's own contract.
    const actions = h.cron.calls.filter((call) => call.action === "pause" || call.action === "resume");
    expect(actions.map((call) => call.params["name"])).toEqual(["j1", "j1"]);
  });

  it("rewrites a routine as pause, add, remove, and reports the id it replaced", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const res = await h.authed(
      "/bots/scout/routines/j1",
      body("PATCH", { title: "Digest v2", schedule: "0 8 * * *", prompt: "summarize overnight" }),
    );
    expect(res.status).toBe(200);
    const patched = (await res.json()) as { routine: BotRoutine; replacedId?: string; orphanedId?: string };
    expect(patched.replacedId).toBe("j1");
    expect(patched.orphanedId).toBeUndefined();
    expect(patched.routine.id).not.toBe("j1");
    expect(patched.routine.title).toBe("Digest v2");
    expect(h.cron.jobs.map((entry) => entry.name)).toEqual(["[bot:scout] Digest v2"]);
    // The trailing `list` is the re-read that feeds the `bot_routines` frame.
    expect(h.cron.calls.map((call) => call.action).slice(0, 4)).toEqual(["list", "pause", "add", "remove"]);
  });

  it("refuses a rewrite that does not carry the instruction", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const res = await h.authed("/bots/scout/routines/j1", body("PATCH", { schedule: "0 8 * * *" }));
    expect(res.status).toBe(400);
    const failure = (await res.json()) as { error: { code: string; message: string } };
    expect(failure.error.code).toBe("invalid_request");
    expect(failure.error.message).toContain("prompt is required");
    // Nothing was touched: the routine is exactly as it was.
    expect(h.cron.jobs[0]?.schedule).toBe("0 9 * * *");
    expect(h.cron.calls.some((call) => call.action === "add")).toBe(false);
  });

  it("restores the old routine when the replacement is refused", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const res = await h.authed(
      "/bots/scout/routines/j1",
      body("PATCH", { schedule: "every other tuesday", prompt: "summarize overnight" }),
    );
    expect(res.status).toBe(502);
    // The routine is back exactly as it was, running, with its original schedule.
    expect(h.cron.jobs).toHaveLength(1);
    expect(h.cron.jobs[0]).toMatchObject({ id: "j1", schedule: "0 9 * * *", paused: false });
    expect(h.cron.calls.map((call) => call.action).slice(0, 4)).toEqual(["list", "pause", "add", "resume"]);
  });

  it("reports a replaced job that could not be removed, and leaves it paused", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    h.cron.failRemove.add("j1");
    const patched = (await (
      await h.authed("/bots/scout/routines/j1", body("PATCH", { title: "Digest v2", prompt: "summarize" }))
    ).json()) as { routine: BotRoutine; orphanedId?: string };
    expect(patched.orphanedId).toBe("j1");
    // The leftover exists but cannot fire, so the routine never runs twice.
    expect(h.cron.jobs.find((entry) => entry.id === "j1")?.paused).toBe(true);
    expect(patched.routine.enabled).toBe(true);
  });

  it("keeps a switched-off routine off across a rewrite", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest", enabled: false, paused: true })]);
    const patched = (await (
      await h.authed("/bots/scout/routines/j1", body("PATCH", { title: "Digest v2", prompt: "summarize" }))
    ).json()) as { routine: BotRoutine };
    expect(patched.routine.enabled).toBe(false);
    expect(h.cron.jobs).toHaveLength(1);
    expect(h.cron.jobs[0]?.paused).toBe(true);
  });

  it("deletes by id and is not idempotent", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    expect((await h.authed("/bots/scout/routines/j1", { method: "DELETE" })).status).toBe(204);
    expect(h.cron.jobs).toHaveLength(0);
    expect((await h.authed("/bots/scout/routines/j1", { method: "DELETE" })).status).toBe(404);
  });

  it("refuses an empty patch", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    expect((await h.authed("/bots/scout/routines/j1", body("PATCH", {}))).status).toBe(400);
  });

  it("refuses a NUL in a title or an instruction", async () => {
    const h = await setup();
    const res = await h.authed(
      "/bots/scout/routines",
      body("POST", { title: "Dig\u0000est", schedule: "0 9 * * *", prompt: "summarize" }),
    );
    expect(res.status).toBe(400);
    expect(h.cron.calls.some((call) => call.action === "add")).toBe(false);
  });

  it("reports a refused ROW ACTION as the backend failure it is, carrying its text", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    h.cron.failPause.add("j1");
    const res = await h.authed("/bots/scout/routines/j1", body("PATCH", { enabled: false }));
    // `success: false` arrives inside a SUCCESSFUL rpc result; a bridge that ignored it would have
    // answered 200 for a pause that never happened. But a pause carries only a job id this gateway
    // resolved itself, so there is no client input for a 400 to be about.
    expect(res.status).toBe(502);
    const failure = (await res.json()) as { error: { code: string }; hermesError: string };
    expect(failure.error.code).toBe("backend_unavailable");
    expect(failure.hermesError).toContain("Failed to pause 'j1'");
  });

  it("reports a refused LIST as a backend failure, not as the client's typing", async () => {
    // The reviewer's probe: a Hermes that refuses the scoped list (an older or scoping-hostile
    // build) used to turn a GET with no body into "invalid_request", which puts "check what you
    // typed" over the whole routines pane.
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    h.cron.failList = true;
    const res = await h.authed("/bots/scout/routines");
    expect(res.status).toBe(502);
    const failure = (await res.json()) as { error: { code: string }; hermesError: string };
    expect(failure.error.code).toBe("backend_unavailable");
    expect(failure.hermesError).toContain("unknown profile scope");
  });

  it("reports a refused ADD as the client's input", async () => {
    const h = await setup();
    h.cron.failAdd = true;
    const res = await h.authed(
      "/bots/scout/routines",
      body("POST", { title: "Sweep", schedule: "0 9 * * *", prompt: "sweep" }),
    );
    // `add` is the one cron call that carries what the user typed, so its refusal really is a 400.
    expect(res.status).toBe(400);
    const failure = (await res.json()) as { error: { code: string }; hermesError: string };
    expect(failure.error.code).toBe("invalid_request");
    expect(failure.hermesError).toContain("refused the add");
  });

  it("honors `enabled` sent alongside a rewrite instead of dropping it", async () => {
    // The reviewer's probe: PATCH {title, prompt, enabled: true} on a PAUSED routine used to answer
    // with `enabled: false`, because the rewrite read the old row's state and never looked at the
    // patch.
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest", enabled: false, paused: true })]);
    const patched = (await (
      await h.authed("/bots/scout/routines/j1", body("PATCH", { title: "Digest v2", prompt: "summarize", enabled: true }))
    ).json()) as { routine: BotRoutine };
    expect(patched.routine.enabled).toBe(true);
    expect(h.cron.jobs).toHaveLength(1);
    expect(h.cron.jobs[0]).toMatchObject({ name: "[bot:scout] Digest v2", paused: false });

    // And the other direction: a rewrite that switches a running routine off.
    const off = (await (
      await h.authed(`/bots/scout/routines/${h.cron.jobs[0]?.id ?? ""}`, body("PATCH", { prompt: "again", enabled: false }))
    ).json()) as { routine: BotRoutine };
    expect(off.routine.enabled).toBe(false);
    expect(h.cron.jobs[0]?.paused).toBe(true);
  });

  it("refuses `enabled` plus `repeat` rather than answering 200 and dropping the run cap", async () => {
    // The reviewer's probe: `{enabled, repeat}` took the row-action branch, answered 200 and made
    // ZERO add calls, so the cap was accepted and thrown away. `repeat` reaches the backend only on
    // an `add`, so it is a rewrite, and a rewrite without the instruction is refused.
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const res = await h.authed("/bots/scout/routines/j1", body("PATCH", { enabled: false, repeat: 3 }));
    expect(res.status).toBe(400);
    const failure = (await res.json()) as { error: { message: string } };
    expect(failure.error.message).toContain("prompt is required");
    expect(h.cron.calls.some((call) => call.action === "add")).toBe(false);
    // Nothing was switched either: the patch was refused whole.
    expect(h.cron.jobs[0]?.paused).toBe(false);
  });

  it("carries the run cap and continuity across a rewrite that does not restate them", async () => {
    // The reviewer's probe: a title-only rewrite of a `3 times` / continuity job came back
    // `repeat: forever`, `continuity: undefined`. A typo fix must not un-bound a routine.
    const h = await setup([
      job({ id: "j1", name: "[bot:scout] Digest", repeat: "1/3", continuity: true }),
    ]);
    const patched = (await (
      await h.authed("/bots/scout/routines/j1", body("PATCH", { title: "Digest v2", prompt: "summarize" }))
    ).json()) as { routine: BotRoutine };
    // `1/3` is run 1 of 3, so what the replacement is capped at is what REMAINS.
    const add = h.cron.calls.find((call) => call.action === "add");
    expect(add?.params["repeat"]).toBe(2);
    expect(add?.params["continuity"]).toBe(true);
    expect(patched.routine.repeat).toBe("2 times");
    expect(patched.routine.continuity).toBe(true);
  });

  it("serializes concurrent rewrites, so a double-tapped Save cannot leave two live jobs", async () => {
    // The reviewer's probe, verbatim: two concurrent PATCHes of the same id. Unserialized, both
    // found the job, both paused it, both added a replacement and both removed the same old one,
    // leaving TWO enabled cron jobs where the user has one routine, firing forever.
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const [a, b] = await Promise.all([
      h.authed("/bots/scout/routines/j1", body("PATCH", { title: "A", prompt: "summarize" })),
      h.authed("/bots/scout/routines/j1", body("PATCH", { title: "B", prompt: "summarize" })),
    ]);
    // One rewrite lands; the other arrives after its job id is gone and is the 404 it is.
    expect([a.status, b.status].sort()).toEqual([200, 404]);
    expect(h.cron.jobs).toHaveLength(1);
    const list = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    expect(list.routines).toHaveLength(1);
    expect(list.routines[0]?.enabled).toBe(true);
  });

  it("serializes a create racing a delete of the same bot", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    const [created, deleted] = await Promise.all([
      h.authed("/bots/scout/routines", body("POST", { title: "Sweep", schedule: "0 8 * * *", prompt: "sweep" })),
      h.authed("/bots/scout/routines/j1", { method: "DELETE" }),
    ]);
    expect(created.status).toBe(201);
    expect(deleted.status).toBe(204);
    expect(h.cron.jobs.map((entry) => entry.name)).toEqual(["[bot:scout] Sweep"]);
  });
});

describe("the bot name is held to the profile-id rule", () => {
  // A profile whose name escapes the tag charset breaks the ONE relation this whole surface rests
  // on: `[bot:a]b] Theirs` parses as bot `a`. Gateway-created bots cannot hold such a name, but a
  // profile made outside this gateway can, and the routes are one line from being safe either way.
  const store = (): FakeJob[] => [
    job({ id: "j1", name: "[bot:a]b] Theirs" }),
    job({ id: "j2", name: "[bot:a] Mine" }),
  ];

  it("keeps a bracketed profile's routines out of another bot's list", async () => {
    const h = await setup(store(), { profiles: ["a", "a]b"] });
    const mine = (await (await h.authed("/bots/a/routines")).json()) as { routines: BotRoutine[] };
    // Without the rule, bot `a` saw `j1` as its own routine titled `b] Theirs`.
    expect(mine.routines.map((routine) => routine.id)).toEqual(["j2"]);
  });

  it("refuses a delete of another bot's routine through the bracket", async () => {
    const h = await setup(store(), { profiles: ["a", "a]b"] });
    expect((await h.authed("/bots/a/routines/j1", { method: "DELETE" })).status).toBe(404);
    expect(h.cron.jobs).toHaveLength(2);
  });

  it("refuses every routine route for a name outside the rule, before any hermes call", async () => {
    const h = await setup(store(), { profiles: ["a", "a]b"] });
    const paths = "/bots/a%5Db/routines";
    for (const res of [
      await h.authed(paths),
      await h.authed(paths, body("POST", { title: "T", schedule: "0 9 * * *", prompt: "p" })),
      await h.authed(`${paths}/j1`, body("PATCH", { enabled: false })),
      await h.authed(`${paths}/j1`, { method: "DELETE" }),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
    }
    // Nothing went out: a create used to answer 201 and orphan the job it made.
    expect(h.cron.calls).toHaveLength(0);
    expect(h.cron.jobs).toHaveLength(2);
  });
});

describe("scoping", () => {
  const store = (): FakeJob[] => [
    job({ id: "j1", name: "[bot:scout] Mine" }),
    job({ id: "j2", name: "[bot:pip] Theirs" }),
    job({ id: "j3", name: "nightly backup" }),
  ];

  it("keeps another bot's routines and the operator's own cron jobs out of a list", async () => {
    const h = await setup(store());
    const mine = (await (await h.authed("/bots/scout/routines")).json()) as { routines: BotRoutine[] };
    expect(mine.routines.map((routine) => routine.id)).toEqual(["j1"]);
    const theirs = (await (await h.authed("/bots/pip/routines")).json()) as { routines: BotRoutine[] };
    expect(theirs.routines.map((routine) => routine.id)).toEqual(["j2"]);
  });

  it("filters at the seam, so a gateway that ignored the profile scope is still correct", () => {
    const jobs = [{ name: "[bot:scout] Mine" }, { name: "[bot:pip] Theirs" }, { name: "nightly backup" }];
    expect(selectRoutineJobs(jobs, "scout").map((entry) => entry.name)).toEqual(["[bot:scout] Mine"]);
  });

  it("404s a write against a job id outside the bot's namespace, and never touches it", async () => {
    const h = await setup(store());
    for (const id of ["j2", "j3"]) {
      expect((await h.authed(`/bots/scout/routines/${id}`, body("PATCH", { enabled: false }))).status).toBe(404);
      expect((await h.authed(`/bots/scout/routines/${id}`, { method: "DELETE" })).status).toBe(404);
    }
    expect(h.cron.jobs).toHaveLength(3);
    expect(h.cron.calls.some((call) => call.action === "pause" || call.action === "remove")).toBe(false);
  });

  it("404s every routine route for a bot that does not exist", async () => {
    const h = await setup();
    expect((await h.authed("/bots/ghost/routines")).status).toBe(404);
    expect(
      (await h.authed("/bots/ghost/routines", body("POST", { title: "T", schedule: "0 9 * * *", prompt: "p" }))).status,
    ).toBe(404);
    expect((await h.authed("/bots/ghost/routines/j1", body("PATCH", { enabled: false }))).status).toBe(404);
    expect((await h.authed("/bots/ghost/routines/j1", { method: "DELETE" })).status).toBe(404);
  });

  it("requires a device token", async () => {
    const h = await setup();
    expect((await h.request("/bots/scout/routines")).status).toBe(401);
    expect((await h.request("/bots/scout/routines/j1", { method: "DELETE" })).status).toBe(401);
  });
});

describe("frames", () => {
  const routineFrames = (frames: ServerFrame[]): Array<{ bot: string; routines: BotRoutine[] }> =>
    frames.filter((frame): frame is ServerFrame & { type: "bot_routines" } => frame.type === "bot_routines");

  it("broadcasts a bot's routines when the list changes, and stays silent when it does not", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    await h.authed("/bots/scout/routines");
    await until(() => routineFrames(h.frames).length === 1);
    expect(routineFrames(h.frames)[0]?.bot).toBe("scout");
    expect(routineFrames(h.frames)[0]?.routines.map((routine) => routine.id)).toEqual(["j1"]);

    // A second read of an unchanged store adds nothing to the wire.
    await h.authed("/bots/scout/routines");
    expect(routineFrames(h.frames)).toHaveLength(1);

    await h.authed("/bots/scout/routines", body("POST", { title: "Sweep", schedule: "0 8 * * *", prompt: "sweep" }));
    await until(() => routineFrames(h.frames).length === 2);
    expect(routineFrames(h.frames)[1]?.routines.map((routine) => routine.title)).toEqual(["Digest", "Sweep"]);
  });

  it("re-reads a watched bot on cron.changed", async () => {
    const h = await setup([job({ id: "j1", name: "[bot:scout] Digest" })]);
    await h.authed("/bots/scout/routines");
    await until(() => routineFrames(h.frames).length === 1);

    // Something else changed the cron store: a desktop, or the scheduler itself.
    h.cron.jobs.push(job({ id: "j9", name: "[bot:scout] From the desktop" }));
    h.server.sendEvent("cron.changed");
    await until(() => routineFrames(h.frames).length === 2);
    expect(routineFrames(h.frames)[1]?.routines.map((routine) => routine.id)).toEqual(["j1", "j9"]);
  });

  it("does not fan out to a bot nobody has looked at", async () => {
    const h = await setup([job({ id: "j2", name: "[bot:pip] Theirs" })]);
    h.server.sendEvent("cron.changed");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(routineFrames(h.frames)).toHaveLength(0);
  });

  it("marks a delegated legacy routine on the frame too", async () => {
    const h = await setup([
      job({
        id: "j1",
        name: "[bot:scout] Legacy",
        prompt: `${LEGACY_DELEGATED_ROUTINE_PREFIX}Legacy" for agent 'scout'.`,
      }),
    ]);
    await h.authed("/bots/scout/routines");
    await until(() => routineFrames(h.frames).length === 1);
    expect(routineFrames(h.frames)[0]?.routines[0]).toMatchObject({ legacyUnsafe: true, enabled: false });
  });
});

describe("mapRoutine", () => {
  it("degrades a job that is missing everything rather than failing a list", () => {
    expect(mapRoutine({ job_id: "j1", name: "[bot:scout] X" })).toEqual({
      id: "j1",
      title: "X",
      schedule: { raw: "" },
      enabled: true,
      legacyUnsafe: false,
      lastRun: null,
      nextRun: null,
    });
  });
});

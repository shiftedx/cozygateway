import { afterEach, describe, expect, it } from "vitest";
import { BOTS_CAPABILITY_VERSION } from "cozygateway-contract";

import { testHermes } from "./support/test-config.ts";
import { openStorage, type Storage } from "../src/storage.ts";
import { createApp } from "../src/http.ts";
import { SETUP_CODE_TTL_MS, newSetupCode } from "../src/auth.ts";
import type { GatewayConfig } from "../src/config.ts";
import { createHermesClient } from "../src/hermes-bridge/client.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import {
  routineCompletedRuns,
  routineInstruction,
  routinePrompt,
  runBotRoutine,
} from "../src/hermes-bridge/routines.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

/** Capability 83, Hermes routines v2, end to end through a fake Hermes (JSON-RPC `cron.manage` plus
 *  the dashboard `/api/cron/*` REST surface), not a mocked bridge. */

const config: GatewayConfig = {
  name: "g",
  port: 8787,
  dbPath: ":memory:",
  turnTimeoutSeconds: 0,
  hermesEndpoints: [{ id: "default", ...testHermes() }],
};
const BOT = "scout";

interface Job {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
  deliver: string;
  repeat: { times: number | null; completed: number };
  context_from: string[] | null;
}

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

function listRow(job: Job): Record<string, unknown> {
  const { times, completed } = job.repeat;
  return {
    job_id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt_preview: job.prompt.length > 100 ? `${job.prompt.slice(0, 100)}...` : job.prompt,
    enabled: job.enabled,
    state: job.enabled ? "scheduled" : "paused",
    deliver: job.deliver,
    repeat: times === null ? "forever" : completed > 0 ? `${completed}/${times}` : `${times} times`,
    ...(job.context_from?.includes("self") ? { continuity: true } : {}),
  };
}

async function setup(opts: {
  gatewayRunning?: boolean | null;
  triggerDelayMs?: number;
  dashboardStatus?: number;
  messages?: unknown[];
} = {}) {
  const jobs = new Map<string, Job>();
  jobs.set("j1", {
    id: "j1",
    name: `[bot:${BOT}] Digest`,
    schedule: "0 9 * * *",
    prompt: routinePrompt({ bot: BOT, title: "Digest", instruction: `Summarize ${"the news ".repeat(20)}` }),
    enabled: true,
    deliver: "local",
    repeat: { times: 3, completed: 1 },
    context_from: ["other-job"],
  });
  jobs.set("foreign", {
    id: "foreign", name: "[bot:pip] Not yours", schedule: "every 60m", prompt: "x", enabled: true,
    deliver: "local", repeat: { times: null, completed: 0 }, context_from: null,
  });
  const puts: Array<Record<string, unknown>> = [];
  const server = await startFakeHermesServer({
    methods: {
      "profiles.list": () => ({ profiles: [{ name: "default" }, { name: BOT }], bot_mode_protocol: true }),
      "cron.manage": (params) => {
        if (params["action"] === "list") {
          return {
            success: true,
            jobs: [...jobs.values()].map(listRow),
            ...(opts.gatewayRunning === null ? {} : { gateway_running: opts.gatewayRunning ?? true }),
            scoped: params["profile"],
          };
        }
        const job = jobs.get(String(params["name"]));
        if (job === undefined) return { success: false, error: "no such job" };
        if (params["action"] === "pause") job.enabled = false;
        if (params["action"] === "resume") job.enabled = true;
        return { success: true, job: listRow(job) };
      },
    },
    dashboard: async (request) => {
      if (opts.dashboardStatus !== undefined) return { status: opts.dashboardStatus, body: { detail: "Unauthorized" } };
      if (request.query.get("profile") !== BOT) return { status: 400, body: { detail: "wrong profile" } };
      if (request.method === "GET" && request.path === "/api/cron/jobs") return { body: [...jobs.values()] };
      const run = /^\/api\/cron\/jobs\/([^/]+)\/(trigger|runs)$/.exec(request.path);
      if (run !== null) {
        const job = jobs.get(decodeURIComponent(run[1] ?? ""));
        if (job === undefined) return { status: 404, body: { detail: "Job not found" } };
        if (run[2] === "trigger") {
          await new Promise((resolve) => setTimeout(resolve, opts.triggerDelayMs ?? 0));
          return { body: { ...job, last_status: "ok" } };
        }
        return {
          body: {
            runs: [{
              id: `cron_${job.id}_20260923_030055`, started_at: 1_790_150_456.1, ended_at: 1_790_150_546.8,
              end_reason: "cron_complete", title: "Digest · Sep 23", is_active: false,
              system_prompt: "SECRET system prompt", billing_provider: "codex",
            }],
            limit: Number(request.query.get("limit")),
          },
        };
      }
      const one = /^\/api\/cron\/jobs\/([^/]+)$/.exec(request.path);
      if (one !== null) {
        const job = jobs.get(decodeURIComponent(one[1] ?? ""));
        if (job === undefined) return { status: 404, body: { detail: "Job not found" } };
        if (request.method === "GET") return { body: job };
        if (request.method === "PUT") {
          const updates = (request.body as { updates: Record<string, unknown> }).updates;
          puts.push(updates);
          if (updates["schedule"] === "nonsense") return { status: 400, body: { detail: "Invalid schedule 'nonsense'" } };
          if (typeof updates["name"] === "string") job.name = updates["name"];
          if (typeof updates["schedule"] === "string") job.schedule = updates["schedule"];
          if (typeof updates["prompt"] === "string") job.prompt = updates["prompt"];
          if (typeof updates["deliver"] === "string") job.deliver = updates["deliver"];
          if (typeof updates["repeat"] === "number") job.repeat = { ...job.repeat, times: updates["repeat"] };
          if ("repeat" in updates && updates["repeat"] === null) job.repeat = { ...job.repeat, times: null };
          if (Array.isArray(updates["context_from"])) job.context_from = updates["context_from"] as string[];
          return { body: job };
        }
      }
      const messages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(request.path);
      if (messages !== null) {
        return {
          body: {
            messages: opts.messages ?? [
              { role: "user", content: "run it" },
              { role: "assistant", content: "Here is the digest. Saved to /Users/k/.hermes/out.md" },
              { role: "assistant", content: "" },
            ],
          },
        };
      }
      if (request.path === "/api/cron/blueprints") {
        return {
          body: {
            blueprints: [{
              key: "morning-brief", title: "Morning briefing", description: "A short daily briefing.",
              category: "daily", scheduleHuman: "every day at 08:00", command: "/blueprint morning-brief",
              fields: [
                { name: "time", type: "time", label: "What time?", default: "08:00", options: [], optional: false, help: "24h" },
                { name: "deliver", type: "enum", label: "Where?", default: "origin", options: ["origin", "local", "bot-chat:scout"], optional: false, help: "" },
              ],
            }],
          },
        };
      }
      if (request.path === "/api/cron/blueprints/instantiate" && request.method === "POST") {
        const body = request.body as { blueprint: string; values: Record<string, string> };
        if (body.blueprint !== "morning-brief") return { status: 404, body: { detail: "Unknown blueprint" } };
        if (body.values["time"] === "25:00") return { status: 422, body: { detail: "time must be HH:MM" } };
        const job: Job = {
          id: "bp1", name: "Morning briefing", schedule: "0 8 * * *", prompt: "brief me", enabled: true,
          deliver: body.values["deliver"] ?? "origin", repeat: { times: null, completed: 0 }, context_from: null,
        };
        jobs.set(job.id, job);
        return { body: job };
      }
      return { status: 404, body: { detail: `unrouted ${request.method} ${request.path}` } };
    },
  });
  servers.push(server);
  const storage = openStorage(":memory:");
  storages.push(storage);
  const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" }, reconnect: { minMs: 15, maxMs: 60 } });
  const frames: unknown[] = [];
  const bridge = new HermesBridge({ client, storage, broadcast: (frame) => frames.push(frame), now: () => 1_000, logSink: () => {} });
  bridges.push(bridge);
  const app = createApp({
    storage,
    config,
    bots: bridge,
    gatewayInfo: { name: "g", version: "0.1.0", contract: "v1", capabilities: { "com.cozylabs.bots": BOTS_CAPABILITY_VERSION } },
    presenceOf: () => "online",
    submitUserMessage: () => {
      throw new Error("unused");
    },
    interruptThread: () => "idle",
    resolveApproval: () => Promise.resolve("unknown" as const),
    onDeviceRevoked: () => {},
    now: () => 1_000,
  });
  const code = newSetupCode();
  storage.createSetupCode(code, 1_000 + SETUP_CODE_TTL_MS);
  const pair = await app.request("/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: code, deviceName: "phone" }),
  });
  const { deviceToken } = (await pair.json()) as { deviceToken: string };
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const response = await app.request(path, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (response.status === 204 ? {} : await response.json()) as Record<string, unknown> };
  };
  bridge.start();
  await until(() => client.state() === "online");
  return { call, jobs, puts, frames };
}

describe("bot routines v2 (capability 83)", () => {
  it("advertises capability 87 (which includes 83)", () => {
    expect(BOTS_CAPABILITY_VERSION).toBe(87);
  });

  it("lists the full instruction, the delivery target and whether the scheduler runs", async () => {
    const { call } = await setup({ gatewayRunning: false });
    const { status, body } = await call(`/bots/${BOT}/routines`);
    expect(status).toBe(200);
    expect(body["schedulerRunning"]).toBe(false);
    const routines = body["routines"] as Array<Record<string, unknown>>;
    expect(routines.map((routine) => routine["id"])).toEqual(["j1"]);
    expect(routines[0]).toMatchObject({ title: "Digest", deliver: "local", repeat: "1/3" });
    // Whole and unwrapped, not the 100-character preview of the delegation wrapper.
    expect(routines[0]?.["prompt"]).toBe(`Summarize ${"the news ".repeat(20)}`);
  });

  it("omits schedulerRunning when Hermes could not tell", async () => {
    const { call } = await setup({ gatewayRunning: null });
    expect((await call(`/bots/${BOT}/routines`)).body).not.toHaveProperty("schedulerRunning");
  });

  it("creates with deliver bot-chat and continuity", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const server = await startFakeHermesServer({
      methods: {
        "profiles.list": () => ({ profiles: [{ name: BOT }] }),
        "cron.manage": (params) => {
          calls.push(params);
          return { success: true, job: { job_id: "n1", name: params["name"], schedule: params["schedule"], deliver: params["deliver"] } };
        },
      },
    });
    servers.push(server);
    const client = createHermesClient({ url: server.url, auth: { mode: "token", token: "T" } });
    const storage = openStorage(":memory:");
    storages.push(storage);
    const bridge = new HermesBridge({ client, storage, broadcast: () => {}, now: () => 1_000, logSink: () => {} });
    bridges.push(bridge);
    bridge.start();
    await until(() => client.state() === "online");
    const result = await bridge.createRoutine(BOT, {
      title: "Ping", schedule: "every 2h", prompt: "ping", deliver: "bot-chat", continuity: true, repeat: 4,
    });
    expect(calls.find((params) => params["action"] === "add")).toMatchObject({
      name: `[bot:${BOT}] Ping`, deliver: "bot-chat", continuity: true, repeat: 4, profile: BOT,
    });
    expect(result.routine).toMatchObject({ id: "n1", deliver: "bot-chat" });
  });

  it("edits in place: id kept, only named fields sent, repeat counted from now, continuity as self", async () => {
    const { call, jobs, puts } = await setup();
    const { status, body } = await call(`/bots/${BOT}/routines/j1`, {
      method: "PATCH",
      body: { title: "Digest v2", schedule: "every 2h", repeat: 2, deliver: "bot-chat", continuity: true },
    });
    expect(status).toBe(200);
    expect(body).not.toHaveProperty("replacedId");
    expect(body["routine"]).toMatchObject({ id: "j1", title: "Digest v2", deliver: "bot-chat", continuity: true });
    expect(puts).toEqual([{
      name: `[bot:${BOT}] Digest v2`, schedule: "every 2h", repeat: 3, deliver: "bot-chat",
      context_from: ["other-job", "self"],
      // The rename re-wraps the same instruction under the new title.
      prompt: routinePrompt({ bot: BOT, title: "Digest v2", instruction: `Summarize ${"the news ".repeat(20)}` }),
    }]);
    expect(jobs.get("j1")?.prompt).toContain("Summarize");
  });

  it("clears a run cap back to forever with repeat: null", async () => {
    const { call, puts } = await setup();
    const { status, body } = await call(`/bots/${BOT}/routines/j1`, { method: "PATCH", body: { repeat: null } });
    expect(status).toBe(200);
    expect(puts).toEqual([{ repeat: null }]);
    expect(body["routine"]).toMatchObject({ id: "j1", repeat: "forever" });
  });

  it("re-wraps a new instruction and composes enabled with an edit", async () => {
    const { call, jobs } = await setup();
    const { status, body } = await call(`/bots/${BOT}/routines/j1`, {
      method: "PATCH", body: { prompt: "Say it's done", enabled: false },
    });
    expect(status).toBe(200);
    expect(body["routine"]).toMatchObject({ id: "j1", enabled: false, prompt: "Say it's done" });
    expect(routineInstruction(jobs.get("j1")?.prompt ?? "")).toBe("Say it's done");
    expect(jobs.get("j1")?.prompt).toMatch(/^\[bot-mode:routine:v2\] /);
  });

  it("caps a forever routine that has already run from the stored completed count", async () => {
    const { call, jobs, puts } = await setup();
    // `cron.manage list` shows "forever" for this job however often it ran; the record says 5.
    jobs.set("daily", {
      id: "daily", name: `[bot:${BOT}] Daily`, schedule: "0 9 * * *",
      prompt: routinePrompt({ bot: BOT, title: "Daily", instruction: "go" }), enabled: true, deliver: "local",
      repeat: { times: null, completed: 5 }, context_from: null,
    });
    const { status } = await call(`/bots/${BOT}/routines/daily`, { method: "PATCH", body: { repeat: 2 } });
    expect(status).toBe(200);
    expect(puts).toEqual([{ repeat: 7 }]);
  });

  it("keeps a bare prompt bare when its instruction is edited", async () => {
    const { call, jobs, puts } = await setup();
    jobs.set("bp", {
      id: "bp", name: `[bot:${BOT}] Morning briefing`, schedule: "0 8 * * *", prompt: "brief me", enabled: true,
      deliver: "local", repeat: { times: null, completed: 0 }, context_from: null,
    });
    jobs.set("quiet", {
      id: "quiet", name: `[bot:${BOT}] Quiet`, schedule: "0 8 * * *",
      prompt: routinePrompt({ bot: BOT, title: "Quiet", instruction: "old", schedulerProfile: BOT }), enabled: true,
      deliver: "local", repeat: { times: null, completed: 0 }, context_from: null,
    });
    expect((await call(`/bots/${BOT}/routines/bp`, { method: "PATCH", body: { prompt: "brief me twice" } })).status).toBe(200);
    expect(jobs.get("bp")?.prompt).toBe("brief me twice");
    // A rename of a bare job leaves its prompt alone.
    expect((await call(`/bots/${BOT}/routines/bp`, { method: "PATCH", body: { title: "Brief" } })).status).toBe(200);
    expect(puts.at(-1)).toEqual({ name: `[bot:${BOT}] Brief` });
    expect((await call(`/bots/${BOT}/routines/quiet`, { method: "PATCH", body: { prompt: "new" } })).status).toBe(200);
    expect(jobs.get("quiet")?.prompt).toBe(routinePrompt({ bot: BOT, title: "Quiet", instruction: "new", schedulerProfile: BOT }));
  });

  it("re-wraps the wrapper with the new title on a rename", async () => {
    const { call, jobs } = await setup();
    const { status, body } = await call(`/bots/${BOT}/routines/j1`, { method: "PATCH", body: { title: "Headlines" } });
    expect(status).toBe(200);
    const instruction = `Summarize ${"the news ".repeat(20)}`;
    expect(jobs.get("j1")?.prompt).toBe(routinePrompt({ bot: BOT, title: "Headlines", instruction }));
    expect(jobs.get("j1")?.prompt).not.toContain("Digest");
    expect(body["routine"]).toMatchObject({ title: "Headlines", prompt: instruction });
  });

  it("reports a dashboard 401 or 403 as the backend being unavailable", async () => {
    for (const status of [401, 403]) {
      const { call } = await setup({ dashboardStatus: status });
      const reply = await call(`/bots/${BOT}/routines/j1`, { method: "PATCH", body: { schedule: "every 2h" } });
      expect(reply.status).toBe(502);
      expect(reply.body).toMatchObject({ error: { code: "backend_unavailable" } });
    }
  });

  it("cleans a run's output like any transcript, content-part arrays included", async () => {
    const { call } = await setup({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Done.\u0007 See ~/notes/today.md" },
            { type: "image", image_url: "data:x" },
            { type: "text", text: "MEDIA:/tmp/chart.png and /etc/hosts" },
          ],
        },
      ],
    });
    const output = await call(`/bots/${BOT}/routines/j1/runs/cron_j1_1/output`);
    expect(output.status).toBe(200);
    const text = String(output.body["output"]);
    expect(text).toContain("Done. See <path>");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("/tmp");
    expect(text).not.toContain("/etc");
  });

  it("reports Hermes's refusal of an edit as the client's input", async () => {
    const { call } = await setup();
    const { status, body } = await call(`/bots/${BOT}/routines/j1`, { method: "PATCH", body: { schedule: "nonsense" } });
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: "invalid_request" }, hermesError: "Invalid schedule 'nonsense'" });
  });

  it("never edits, runs or reads another bot's routine", async () => {
    const { call, puts } = await setup();
    expect((await call(`/bots/${BOT}/routines/foreign`, { method: "PATCH", body: { title: "mine now" } })).status).toBe(404);
    expect((await call(`/bots/${BOT}/routines/foreign/run`, { method: "POST" })).status).toBe(404);
    expect((await call(`/bots/${BOT}/routines/foreign/runs`)).status).toBe(404);
    expect(puts).toEqual([]);
  });

  it("runs now and answers without waiting for the whole run", async () => {
    const { call, frames } = await setup({ triggerDelayMs: 3_000 });
    const started = Date.now();
    const { status, body } = await call(`/bots/${BOT}/routines/j1/run`, { method: "POST" });
    expect(status).toBe(200);
    expect(Date.now() - started).toBeLessThan(2_900);
    expect(body).toMatchObject({ routine: { id: "j1" }, startedAt: 1_000 });
    // When the run ends the list it changed is broadcast.
    await until(() => frames.some((frame) => (frame as { type?: string }).type === "bot_routines"), 6_000);
  }, 10_000);

  it("surfaces a fast trigger refusal", async () => {
    const port = {
      request: async () => ({ jobs: [{ job_id: "j1", name: `[bot:${BOT}] X` }] }),
      dashboardJson: async () => {
        throw Object.assign(new Error("Job is already running"), { code: 409 });
      },
    };
    await expect(runBotRoutine(port, BOT, "j1")).rejects.toThrow("Job is already running");
  });

  it("lists runs without leaking session internals, and reads a run's output", async () => {
    const { call } = await setup();
    const runs = await call(`/bots/${BOT}/routines/j1/runs?limit=5`);
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual({
      name: BOT, id: "j1",
      runs: [{
        id: "cron_j1_20260923_030055", startedAt: 1_790_150_456_100, endedAt: 1_790_150_546_800,
        status: "cron_complete", title: "Digest · Sep 23", active: false,
      }],
    });
    expect(JSON.stringify(runs.body)).not.toContain("SECRET");
    const output = await call(`/bots/${BOT}/routines/j1/runs/cron_j1_20260923_030055/output`);
    expect(output.body).toEqual({ runId: "cron_j1_20260923_030055", output: "Here is the digest. Saved to <path>" });
    // A session that is not one of this routine's runs is not readable through it.
    expect((await call(`/bots/${BOT}/routines/j1/runs/cron_other_1/output`)).status).toBe(404);
  });

  it("lists blueprints and instantiates one for this bot", async () => {
    const { call } = await setup();
    const list = await call(`/bots/${BOT}/routine-blueprints`);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      name: BOT,
      blueprints: [{
        key: "morning-brief", title: "Morning briefing", description: "A short daily briefing.", category: "daily",
        scheduleHuman: "every day at 08:00",
        fields: [
          { name: "time", type: "time", label: "What time?", default: "08:00", options: [], optional: false, help: "24h" },
          { name: "deliver", type: "enum", label: "Where?", default: "origin", options: ["origin", "local", "bot-chat:scout"], optional: false },
        ],
      }],
    });
    const created = await call(`/bots/${BOT}/routine-blueprints/morning-brief/instantiate`, {
      method: "POST", body: { values: { time: "07:30", deliver: "bot-chat:scout" } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: BOT, routine: { id: "bp1", title: "Morning briefing", deliver: "bot-chat:scout" } });
    const refused = await call(`/bots/${BOT}/routine-blueprints/morning-brief/instantiate`, {
      method: "POST", body: { values: { time: "25:00" } },
    });
    expect(refused).toMatchObject({ status: 400, body: { hermesError: "time must be HH:MM" } });
    expect((await call(`/bots/${BOT}/routine-blueprints/morning-brief/instantiate`, { method: "POST", body: { values: 3 } })).status).toBe(400);
  });

  it("unwraps both wrapper shapes and reads completed runs", () => {
    const instruction = "Check 'the' mail\nand reply";
    expect(routineInstruction(routinePrompt({ bot: BOT, title: "T", instruction }))).toBe(instruction);
    expect(routineInstruction(routinePrompt({ bot: BOT, title: "T", instruction, schedulerProfile: BOT }))).toBe(instruction);
    const desktop = `[bot-mode:routine:v2] You are running the scheduled routine "T" for agent 'scout'. Execute it AS that agent so the run lands in its own history: run this in the terminal and relay the output:\n\nhermes -p 'scout' chat -c 'Routine: T' -q '[Scheduled routine] it'"'"'s fine'\n\nIf the command fails, report the error instead.`;
    expect(routineInstruction(desktop)).toBe("it's fine");
    expect(routineInstruction("plain words")).toBe("plain words");
    // A title that itself contains ` -q '` (and the whole anchor) does not move the unwrap.
    for (const title of ["a -q 'b", "x -q '[Scheduled routine] y"]) {
      expect(routineInstruction(routinePrompt({ bot: BOT, title, instruction }))).toBe(instruction);
    }
    expect(routineCompletedRuns({ repeat: "1/3" })).toBe(1);
    expect(routineCompletedRuns({ repeat: "3 times" })).toBe(0);
    expect(routineCompletedRuns({ repeat: "forever" })).toBe(0);
  });
});

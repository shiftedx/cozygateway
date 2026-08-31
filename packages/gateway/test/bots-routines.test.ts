import { afterEach, describe, expect, it } from "vitest";
import type { ServerFrame } from "cozygateway-contract";

import {
  buildRoutineAddParams,
  createBotRoutine,
  listBotRoutines,
  mapRoutine,
  patchBotRoutine,
  patchNeedsRewrite,
  ROUTINE_DELIVERY_ERROR_MAX_LENGTH,
  RoutineRefused,
  routineDeliveryError,
  routineJobName,
  routinePrompt,
  selectRoutineJobs,
} from "../src/hermes-bridge/routines.ts";
import { HermesBridge } from "../src/hermes-bridge/bridge.ts";
import type { HermesClient } from "../src/hermes-bridge/client.ts";
import { openStorage, type Storage } from "../src/storage.ts";

const bridges: HermesBridge[] = [];
const storages: Storage[] = [];

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const storage of storages.splice(0)) storage.close();
});

describe("bot routines", () => {
  it("exposes tagged routines and existing cron jobs from the bot's profile", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return {
          jobs: [
            { job_id: "mine", name: "[bot:scout] Morning digest", schedule: "every 60m", enabled: true },
            { job_id: "theirs", name: "[bot:pip] Private", schedule: "every 60m", enabled: true },
            { job_id: "old", name: "nightly backup", schedule: "0 3 * * *", enabled: true },
            { job_id: "broken-tag", name: "[bot:scout]broken] Private", schedule: "every 60m", enabled: true },
          ],
        };
      },
    };

    await expect(listBotRoutines(rpc, "scout")).resolves.toEqual({
      routines: [
        expect.objectContaining({ id: "mine", title: "Morning digest", schedule: { raw: "every 60m", human: "Hourly" } }),
        expect.objectContaining({ id: "old", title: "nightly backup", schedule: { raw: "0 3 * * *" } }),
      ],
    });
    expect(calls).toEqual([{ method: "cron.manage", params: { action: "list", include_disabled: true, profile: "scout" } }]);
  });

  it("uses the tagged name and the safe current delegation marker", () => {
    expect(routineJobName("scout", "Digest")).toBe("[bot:scout] Digest");
    const prompt = routinePrompt({ bot: "scout", title: "Digest", instruction: "summarize", schedulerProfile: "default" });
    expect(prompt).toMatch(/^\[bot-mode:routine:v2\] /);
    expect(prompt).toContain("Silence-first:");
    expect(prompt).toContain("'scout'");
    expect(routinePrompt({ bot: "scout", title: "Digest", instruction: "summarize", schedulerProfile: "scout" }))
      .toMatch(/^Silence-first:.*\n\nsummarize$/s);
    expect(buildRoutineAddParams("scout", { title: " Digest ", schedule: " every 2h ", prompt: " summarize " }))
      .toMatchObject({ action: "add", name: "[bot:scout] Digest", schedule: "every 2h", profile: "scout" });
  });

  it("keeps the tagged routine wire shape lean", () => {
    expect(mapRoutine({ job_id: "j1", name: "[bot:scout] X" })).toEqual({
      id: "j1",
      title: "X",
      schedule: { raw: "" },
      enabled: true,
      lastRun: null,
      nextRun: null,
    });
    expect(selectRoutineJobs([{ name: "[bot:scout] Mine" }, { name: "existing cron" }], "scout")).toHaveLength(2);
    expect(patchNeedsRewrite({ enabled: false })).toBe(false);
    expect(patchNeedsRewrite({ title: "Renamed" })).toBe(true);
  });

  it("projects only bounded display-safe delivery failures and redacts every host path family", () => {
    const projected = routineDeliveryError(String.raw`send failed at /Users/k/.hermes/out.log, C:\Users\k\AppData\out.log, \\server\share\out.log and ~/.hermes/out.log`);
    expect(projected).toBe("send failed at <path> <path> <path> and <path>");
    expect(routineDeliveryError(`  timeout\nretrying\u0000now  `)).toBe("timeout retrying now");
    expect(routineDeliveryError("x".repeat(700))).toHaveLength(ROUTINE_DELIVERY_ERROR_MAX_LENGTH);
    expect(routineDeliveryError(`${"x".repeat(511)}😀`)).toBe("x".repeat(511));
    for (const value of [undefined, null, 7, {}, "", "   ", "\u0000\n"]) {
      expect(routineDeliveryError(value)).toBeUndefined();
    }
  });

  it("maps the optional Hermes field while older replies keep the original lean shape", () => {
    expect(mapRoutine({ job_id: "old", name: "existing" })).not.toHaveProperty("lastDeliveryError");
    expect(mapRoutine({
      job_id: "new", name: "existing", last_delivery_error: "platform 'telegram' not configured",
    })).toMatchObject({ lastDeliveryError: "platform 'telegram' not configured" });
    expect(mapRoutine({ job_id: "bad", name: "existing", last_delivery_error: { detail: "no" } }))
      .not.toHaveProperty("lastDeliveryError");
  });

  it("returns the backend delivery failure from a create readback without adding it to the write", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = {
      request: async (_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        if (params["action"] === "add") return { success: true, job_id: "created" };
        return { jobs: [{
          job_id: "created", name: "[bot:scout] Digest", schedule: "every 60m",
          last_delivery_error: "notification timed out",
        }] };
      },
    };
    await expect(createBotRoutine(rpc, "scout", {
      title: "Digest", schedule: "every 1h", prompt: "summarize",
    })).resolves.toMatchObject({ id: "created", lastDeliveryError: "notification timed out" });
    expect(calls[0]).not.toHaveProperty("lastDeliveryError");
    expect(calls[0]).not.toHaveProperty("last_delivery_error");
  });

  it("does not carry an old delivery failure through a patch rewrite", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const rpc = {
      request: async (_method: string, params: Record<string, unknown>) => {
        calls.push(params);
        if (params["action"] === "list") return { jobs: [{
          job_id: "old", name: "[bot:scout] Digest", schedule: "every 60m", enabled: true,
          last_delivery_error: "old delivery failure",
        }] };
        if (params["action"] === "add") return { success: true, job: {
          job_id: "new", name: "[bot:scout] Digest v2", schedule: "every 60m", enabled: true,
        } };
        return { success: true };
      },
    };
    const result = await patchBotRoutine(rpc, "scout", "old", {
      title: "Digest v2", prompt: "summarize again",
    });
    expect(result.routine).not.toHaveProperty("lastDeliveryError");
    const add = calls.find((call) => call["action"] === "add");
    expect(add).not.toHaveProperty("lastDeliveryError");
    expect(add).not.toHaveProperty("last_delivery_error");
    expect(JSON.stringify(add)).not.toContain("old delivery failure");
  });

  it("keeps a backend add refusal truthful", async () => {
    const rpc = { request: async () => ({ success: false, error: "delivery route is invalid" }) };
    await expect(createBotRoutine(rpc, "scout", {
      title: "Digest", schedule: "bad", prompt: "summarize",
    })).rejects.toBeInstanceOf(RoutineRefused);
  });

  it("broadcasts full replacements so a healed Hermes row clears the prior delivery failure", async () => {
    let deliveryError: string | undefined = "notification timed out";
    let onEvent: ((event: { type: string }) => void) | undefined;
    const client = {
      request: async (method: string) => method === "profiles.list"
        ? { profiles: [{ name: "scout" }], bot_mode_protocol: true }
        : { jobs: [{
          job_id: "job", name: "[bot:scout] Digest", schedule: "every 60m",
          ...(deliveryError === undefined ? {} : { last_delivery_error: deliveryError }),
        }] },
      onStateChange: () => {},
      onEvent: (listener: (event: { type: string }) => void) => { onEvent = listener; },
      start: () => {},
      close: async () => {},
      state: () => "online" as const,
    } as unknown as HermesClient;
    const storage = openStorage(":memory:");
    storages.push(storage);
    const frames: ServerFrame[] = [];
    const bridge = new HermesBridge({ client, storage, broadcast: (frame) => frames.push(frame), now: () => 1_800_000_000_000 });
    bridges.push(bridge);
    bridge.start();

    await bridge.routines("scout");
    deliveryError = undefined;
    onEvent?.({ type: "cron.changed" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const routineFrames = frames.filter((frame) => frame.type === "bot_routines");
    expect(routineFrames).toHaveLength(2);
    expect(routineFrames[0]).toMatchObject({ routines: [{ lastDeliveryError: "notification timed out" }] });
    expect(routineFrames[1]).toMatchObject({ routines: [{ id: "job" }] });
    if (routineFrames[1]?.type === "bot_routines")
      expect(routineFrames[1].routines[0]).not.toHaveProperty("lastDeliveryError");
  });
});

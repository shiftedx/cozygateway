import { describe, expect, it } from "vitest";

import {
  buildRoutineAddParams,
  listBotRoutines,
  mapRoutine,
  patchNeedsRewrite,
  routineJobName,
  routinePrompt,
  selectRoutineJobs,
} from "../src/hermes-bridge/routines.ts";

describe("bot routines", () => {
  it("exposes only jobs in the current tagged namespace", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return {
          jobs: [
            { job_id: "mine", name: "[bot:scout] Morning digest", schedule: "every 60m", enabled: true },
            { job_id: "theirs", name: "[bot:pip] Private", schedule: "every 60m", enabled: true },
            { job_id: "old", name: "nightly backup", schedule: "0 3 * * *", enabled: true },
          ],
        };
      },
    };

    await expect(listBotRoutines(rpc, "scout")).resolves.toEqual({
      routines: [
        expect.objectContaining({ id: "mine", title: "Morning digest", schedule: { raw: "every 60m", human: "Hourly" } }),
      ],
    });
    expect(calls).toEqual([{ method: "cron.manage", params: { action: "list", include_disabled: true, profile: "scout" } }]);
  });

  it("uses the tagged name and the safe current delegation marker", () => {
    expect(routineJobName("scout", "Digest")).toBe("[bot:scout] Digest");
    expect(routinePrompt({ bot: "scout", title: "Digest", instruction: "summarize", schedulerProfile: "default" }))
      .toMatch(/^\[bot-mode:routine:v2\] /);
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
    expect(selectRoutineJobs([{ name: "[bot:scout] Mine" }, { name: "unowned" }], "scout")).toHaveLength(1);
    expect(patchNeedsRewrite({ enabled: false })).toBe(false);
    expect(patchNeedsRewrite({ title: "Renamed" })).toBe(true);
  });
});

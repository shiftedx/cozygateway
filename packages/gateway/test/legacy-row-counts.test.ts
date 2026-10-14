import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openStorage } from "../src/storage.ts";

it("counts legacy CozyAgents rows without touching them", () => {
  const directory = mkdtempSync(join(tmpdir(), "cozygateway-legacy-counts-"));
  const path = join(directory, "gateway.sqlite");
  try {
    const fresh = openStorage(path);
    expect(fresh.legacyRowCounts()).toEqual({ runtimeBots: 0, runnerOperations: 0, nonHermesExecutions: 0 });
    fresh.close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO runtime_bots (id, name, avatar, token, runtime, spec_generation, created_at)
        VALUES ('sage', 'Sage', NULL, 'token-sage', 'cozyagents', 1, 5);
      INSERT INTO runner_operations (operation_id, bot, kind, spec_generation, payload_json, stage, created_at, updated_at)
        VALUES ('op_1', 'sage', 'create_runtime', 1, '{}', 'waiting_for_runner', 5, 5);
      INSERT INTO chat_executions (execution_id, bot, session_id, runner_id, token, operation_id, workspace_json, harness, stage, created_at)
        VALUES ('chatx_00000000000000000000000000000000', 'sage', 's', 'r', 't', 'o', '{}', 'cozyagents', 'ready', 6);`);
    raw.close();
    const reopened = openStorage(path);
    expect(reopened.legacyRowCounts()).toEqual({ runtimeBots: 1, runnerOperations: 1, nonHermesExecutions: 1 });
    expect(reopened.legacyRowCounts()).toEqual({ runtimeBots: 1, runnerOperations: 1, nonHermesExecutions: 1 });
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

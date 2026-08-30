import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  HERMES_SESSION_MANAGEMENT_CAPABILITY_ID,
  HERMES_SESSION_MANAGEMENT_CAPABILITY_VERSION,
  HermesSessionListResponseSchema,
  HermesSessionMessagesResponseSchema,
  HermesSessionMutationResponseSchema,
  HermesSessionSearchResponseSchema,
  assertValid,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/hermes-session-management-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

describe("Hermes session management v1 client fixture", () => {
  it("pins capability, lineage, privacy projection, and mutation reread shape", () => {
    expect(fixture["capability"]).toEqual({
      id: HERMES_SESSION_MANAGEMENT_CAPABILITY_ID,
      version: HERMES_SESSION_MANAGEMENT_CAPABILITY_VERSION,
    });
    assertValid(HermesSessionListResponseSchema, fixture["list"]);
    assertValid(HermesSessionSearchResponseSchema, fixture["search"]);
    assertValid(HermesSessionMessagesResponseSchema, fixture["messages"]);
    assertValid(HermesSessionMutationResponseSchema, fixture["mutation"]);
    expect(JSON.stringify(fixture)).not.toMatch(/system_prompt|model_config|cwd|tool_calls|args|reasoning|\/Users\/|[A-Za-z]:\\/);
    expect(JSON.stringify(fixture)).not.toContain('"sessionId"');
  });
});

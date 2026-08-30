import { describe, expect, it } from "vitest";

import {
  HERMES_SESSION_LIST_MAX,
  HermesSessionExportSchema,
  HermesSessionListResponseSchema,
  HermesSessionMessagesResponseSchema,
  HermesSessionPatchSchema,
  HermesSessionSearchResponseSchema,
  check,
} from "../src/index.ts";

const session = {
  hermesSessionId: "hermes-tip",
  hermesLineageId: "hermes-root",
  title: "Release notes",
  startedAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_100_000,
  messageCount: 2,
  archived: false,
  pinned: true,
};
const message = { role: "assistant", text: "Done", hermesMessageId: "42", createdAt: 1_700_000_100_000 };

describe("Hermes session management v1 schemas", () => {
  it("accepts the privacy projection and keeps Bot Mode ids out of it", () => {
    const list = {
      sessions: [session],
      pagination: { limit: 50, offset: 0, returned: 1, total: 1 },
    };
    expect(check(HermesSessionListResponseSchema, list)).toBe(true);
    expect(check(HermesSessionMessagesResponseSchema, {
      hermesSessionId: "hermes-tip",
      messages: [message],
      pagination: { limit: 100, offset: 0, order: "latest", returned: 1, nextOffset: null },
    })).toBe(true);
    expect(check(HermesSessionExportSchema, { session, messages: [message] })).toBe(true);
    expect(JSON.stringify({ list, message })).not.toContain('"sessionId"');
  });

  it("accepts lineage-aware search and only visible transcript roles", () => {
    expect(check(HermesSessionSearchResponseSchema, {
      results: [{ ...session, snippet: "release", matchedRole: "user" }],
    })).toBe(true);
    expect(check(HermesSessionSearchResponseSchema, {
      results: [{ ...session, snippet: "private", matchedRole: "system" }],
    })).toBe(false);
    expect(check(HermesSessionMessagesResponseSchema, {
      hermesSessionId: "hermes-tip",
      messages: [{ role: "tool", text: "hidden" }],
      pagination: { limit: 1, offset: 0, order: "latest", returned: 1, nextOffset: null },
    })).toBe(false);
  });

  it("pins list and mutation bounds", () => {
    expect(check(HermesSessionListResponseSchema, {
      sessions: Array.from({ length: HERMES_SESSION_LIST_MAX + 1 }, () => session),
      pagination: { limit: HERMES_SESSION_LIST_MAX, offset: 0, returned: HERMES_SESSION_LIST_MAX + 1, total: 101 },
    })).toBe(false);
    expect(check(HermesSessionPatchSchema, { title: "Renamed", archived: true, pinned: false })).toBe(true);
    expect(check(HermesSessionPatchSchema, { hidden: true })).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  isDesktopHermesSession,
  type SessionRow,
} from "../src/hermes-bridge/sessions.ts";

function session(source: string): SessionRow {
  return {
    id: `${source}-session`,
    title: "",
    preview: null,
    source,
    startedAt: 1,
    lastActiveAt: 2,
  };
}

describe("Hermes interactive session discovery", () => {
  it("includes Desktop, TUI, and classic CLI conversations while excluding service sessions", () => {
    expect(["desktop", "tui", "cli"].filter((source) =>
      isDesktopHermesSession(session(source)),
    )).toEqual(["desktop", "tui", "cli"]);

    expect(["cozygateway", "cron", "subagent", "tool"].filter((source) =>
      isDesktopHermesSession(session(source)),
    )).toEqual([]);
  });
});

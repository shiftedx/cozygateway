import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotMcpServerSchema,
  BotProfilePatchSchema,
  BotProfileSchema,
  assertValid,
  check,
  type BotProfile,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/bot-mcp-repair-policy-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

/** Capability 63, contract/ext-bots-v1.md row 63. A PORTABLE fixture rather than a live case: the
 *  policy rides the capability-48 `bot_config` `profile.read`, which needs a runtime peer, so what
 *  a black-box client can be held to without one is the payload shape itself. Any decoder, in any
 *  language, can read this file and check it answers the same way this suite does. */
describe("bot MCP repair policy v1 client fixture", () => {
  it("pins the capability floor a client gates the policy on", () => {
    expect(fixture["capability"]).toEqual({ id: BOTS_CAPABILITY_ID, minimumVersion: 63 });
    // `>=`, never equality: the contract's own gating rule, so a later row does not invalidate the
    // fixture and a gateway below 63 is correctly read as not offering the field.
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(63);
  });

  it("accepts both policy names and a row that carries none, on one real profile read", () => {
    const profile = assertValid(BotProfileSchema, fixture["profileRead"]) as BotProfile;
    expect(profile.mcpServers.map((server) => server.repair)).toEqual([
      "approve_once",
      "auto_refresh",
      undefined,
    ]);
    // Absent is SILENCE, not a default. The key is missing from the row, so a client that reads it
    // as `approve_once` is inventing a permission nobody set.
    const unset = profile.mcpServers[2];
    expect(unset && "repair" in unset).toBe(false);
  });

  it("refuses every value outside the closed pair, rather than passing a string through", () => {
    for (const row of fixture["refused"] as unknown[]) {
      expect(check(BotMcpServerSchema, row), JSON.stringify(row)).toBe(false);
    }
  });

  it("offers no write surface: the patch names MCP servers by name and only by name", () => {
    const patch = fixture["patch"] as Record<string, unknown>;
    expect(check(BotProfilePatchSchema, patch["accepted"])).toBe(true);
    expect(check(BotProfilePatchSchema, patch["refused"])).toBe(false);
  });

  it("carries no credential, token, or host path", () => {
    const raw = JSON.stringify(fixture);
    expect(raw).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
    expect(raw).not.toMatch(/authorization|bearer|api[-_]?key|secret|token|password/i);
  });
});

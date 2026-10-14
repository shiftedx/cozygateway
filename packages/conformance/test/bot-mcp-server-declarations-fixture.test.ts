import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  BotMcpServerDeclarationSchema,
  BotProfilePatchSchema,
  BotProfileSchema,
  assertValid,
  check,
  mcpServerDeclarationProblem,
  type BotProfile,
  type BotProfilePatch,
} from "cozygateway-contract";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/bot-mcp-server-declarations-v1.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

/** Capability 89, contract/ext-bots-v1.md row 89. A PORTABLE fixture, as capability 63's is: the
 *  declaration rides the capability-48 `bot_config` `profile.write`, which needs a runtime peer that
 *  negotiated `mcp_server_declarations`, so what a black-box client can be held to without one is
 *  the payload shape and the cross-field check. */
describe("bot MCP server declarations v1 client fixture", () => {
  it("pins the capability floor a client gates the editor on", () => {
    expect(fixture["capability"]).toEqual({ id: BOTS_CAPABILITY_ID, minimumVersion: 89 });
    expect(BOTS_CAPABILITY_VERSION).toBeGreaterThanOrEqual(89);
  });

  it("accepts a declare, remove and enable in one patch, and passes the cross-field check", () => {
    const patch = assertValid(BotProfilePatchSchema, fixture["patch"]) as BotProfilePatch;
    expect(mcpServerDeclarationProblem(patch)).toBeUndefined();
  });

  it("reads a client declaration back on its row, and none on an operator's row", () => {
    const profile = assertValid(BotProfileSchema, fixture["profileRead"]) as BotProfile;
    expect(profile.mcpServers.map((server) => server.declaration?.name)).toEqual(["home", undefined]);
  });

  it("refuses every stdio shape, literal secret, foreign variable and harness-owned field", () => {
    for (const declaration of fixture["schemaRefused"] as unknown[]) {
      expect(check(BotMcpServerDeclarationSchema, declaration), JSON.stringify(declaration)).toBe(false);
    }
  });

  it("names a problem for every body the schema admits but the contract refuses", () => {
    for (const patch of fixture["checkRefused"] as unknown[]) {
      const valid = assertValid(BotProfilePatchSchema, patch) as BotProfilePatch;
      expect(mcpServerDeclarationProblem(valid), JSON.stringify(patch)).toBeDefined();
    }
  });

  // Every header value in an ACCEPTED shape is a variable NAME: nothing a client sends, and nothing
  // the peer projects back, is ever the credential itself.
  it("carries only COZY_MCP_ variable names where a credential goes, and no host path", () => {
    const raw = JSON.stringify({ patch: fixture["patch"], profileRead: fixture["profileRead"] });
    const values = [...raw.matchAll(/"Authorization":"([^"]*)"/g)].map(([, value]) => value);
    expect(values).toHaveLength(2);
    for (const value of values) expect(value).toMatch(/^Bearer \$\{COZY_MCP_[A-Z0-9_]+\}$/);
    expect(JSON.stringify(fixture)).not.toMatch(/\/Users\/|[A-Za-z]:\\/);
  });
});

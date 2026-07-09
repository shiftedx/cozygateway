import { describe, expect, it } from "vitest";

import { parseOpenClawOptions } from "../src/adapters/openclaw/config.ts";
import { DEFAULT_TURN_TIMEOUT_SECONDS } from "../src/adapters/openclaw/adapter.ts";
import { PROTOCOL_VERSION } from "../src/adapters/openclaw/protocol.ts";

const agent = (id: string, options?: Record<string, unknown>) => ({
  id,
  name: id,
  backend: "openclaw",
  ...(options === undefined ? {} : { options }),
});

describe("parseOpenClawOptions", () => {
  it("requires options.url", () => {
    expect(() => parseOpenClawOptions(agent("a1", { tokenEnv: "X" }), {})).toThrow(/options\.url/);
    expect(() => parseOpenClawOptions(agent("a1", { url: "", tokenEnv: "X" }), {})).toThrow(/options\.url/);
  });

  it("requires options.tokenEnv", () => {
    expect(() => parseOpenClawOptions(agent("a1", { url: "wss://host:1" }), {})).toThrow(
      /options\.tokenEnv/,
    );
    expect(() =>
      parseOpenClawOptions(agent("a1", { url: "wss://host:1", tokenEnv: "" }), {}),
    ).toThrow(/options\.tokenEnv/);
  });

  it("requires the named environment variable to be set and non-empty", () => {
    expect(() =>
      parseOpenClawOptions(agent("a1", { url: "wss://host:1", tokenEnv: "A1_TOKEN" }), {}),
    ).toThrow(/A1_TOKEN/);
    expect(() =>
      parseOpenClawOptions(agent("a1", { url: "wss://host:1", tokenEnv: "A1_TOKEN" }), { A1_TOKEN: "" }),
    ).toThrow(/A1_TOKEN/);
  });

  it("parses valid options and applies defaults", () => {
    const parsed = parseOpenClawOptions(agent("a1", { url: "wss://host:1234", tokenEnv: "A1_TOKEN" }), {
      A1_TOKEN: "secret-token-value",
    });
    expect(parsed).toEqual({
      url: "wss://host:1234",
      token: "secret-token-value",
      turnTimeoutMs: DEFAULT_TURN_TIMEOUT_SECONDS * 1000,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it("accepts a positive turnTimeoutSeconds and an explicit protocolVersion, rejects a non-positive turnTimeoutSeconds", () => {
    const parsed = parseOpenClawOptions(
      agent("a1", {
        url: "wss://host:1",
        tokenEnv: "A1_TOKEN",
        turnTimeoutSeconds: 5,
        protocolVersion: 7,
      }),
      { A1_TOKEN: "secret" },
    );
    expect(parsed.turnTimeoutMs).toBe(5_000);
    expect(parsed.protocolVersion).toBe(7);

    for (const bad of [0, -1, "5", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseOpenClawOptions(
          agent("a1", { url: "wss://host:1", tokenEnv: "A1_TOKEN", turnTimeoutSeconds: bad }),
          { A1_TOKEN: "secret" },
        ),
      ).toThrow(/turnTimeoutSeconds/);
    }
  });

  it("never leaks the token value into a thrown error message", () => {
    const SENTINEL_TOKEN = "sk-sentinel-should-never-appear-in-an-error";

    // The non-positive-timeout error path still has the resolved token in scope; it must not
    // leak into the message.
    try {
      parseOpenClawOptions(
        agent("a1", { url: "wss://host:1", tokenEnv: "A1_TOKEN", turnTimeoutSeconds: -1 }),
        { A1_TOKEN: SENTINEL_TOKEN },
      );
      throw new Error("expected parseOpenClawOptions to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(SENTINEL_TOKEN);
      expect(message).toMatch(/turnTimeoutSeconds/);
    }

    // The unset-env-var error path: the env var NAME must be present, and since the variable is
    // unset there is no token value at all to leak, but the sentinel must not appear regardless.
    try {
      parseOpenClawOptions(agent("a1", { url: "wss://host:1", tokenEnv: "MISSING_TOKEN_ENV" }), {});
      throw new Error("expected parseOpenClawOptions to throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("MISSING_TOKEN_ENV");
      expect(message).not.toContain(SENTINEL_TOKEN);
    }
  });
});

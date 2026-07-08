import { describe, expect, it } from "vitest";

import { parseCliConfig } from "../src/cli.ts";

describe("parseCliConfig", () => {
  it("applies defaults", () => {
    expect(parseCliConfig([])).toEqual({ port: 8788, host: "127.0.0.1", dbPath: "relay.db", dailyCap: 500 });
  });

  it("parses overrides", () => {
    expect(parseCliConfig(["--port", "0", "--host", "0.0.0.0", "--db", ":memory:", "--daily-cap", "5"])).toEqual({
      port: 0,
      host: "0.0.0.0",
      dbPath: ":memory:",
      dailyCap: 5,
    });
  });

  it("rejects a non-numeric port and a zero cap", () => {
    expect(() => parseCliConfig(["--port", "abc"])).toThrow("invalid --port");
    expect(() => parseCliConfig(["--daily-cap", "0"])).toThrow("invalid --daily-cap");
  });
});

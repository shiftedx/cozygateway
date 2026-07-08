import { describe, expect, it } from "vitest";

import { parseCliConfig } from "../src/cli.ts";

describe("parseCliConfig", () => {
  it("applies defaults (loopback bind: restrictEgress off)", () => {
    expect(parseCliConfig([])).toEqual({
      port: 8788,
      host: "127.0.0.1",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: false,
    });
  });

  it("parses overrides (non-loopback bind: restrictEgress defaults on)", () => {
    expect(
      parseCliConfig([
        "--port",
        "0",
        "--host",
        "0.0.0.0",
        "--db",
        ":memory:",
        "--daily-cap",
        "5",
        "--max-registrations",
        "10",
      ]),
    ).toEqual({
      port: 0,
      host: "0.0.0.0",
      dbPath: ":memory:",
      dailyCap: 5,
      maxRegistrations: 10,
      restrictEgress: true,
    });
  });

  it("rejects a non-numeric port, a zero daily cap, and a zero registration cap", () => {
    expect(() => parseCliConfig(["--port", "abc"])).toThrow("invalid --port");
    expect(() => parseCliConfig(["--daily-cap", "0"])).toThrow("invalid --daily-cap");
    expect(() => parseCliConfig(["--max-registrations", "0"])).toThrow("invalid --max-registrations");
  });

  it("--restrict-egress forces restriction on even on a loopback bind", () => {
    expect(parseCliConfig(["--restrict-egress"])).toEqual({
      port: 8788,
      host: "127.0.0.1",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: true,
    });
  });

  it("--no-restrict-egress forces restriction off even on a non-loopback bind", () => {
    expect(parseCliConfig(["--host", "0.0.0.0", "--no-restrict-egress"])).toEqual({
      port: 8788,
      host: "0.0.0.0",
      dbPath: "relay.db",
      dailyCap: 500,
      maxRegistrations: 10000,
      restrictEgress: false,
    });
  });

  it("rejects passing both --restrict-egress and --no-restrict-egress", () => {
    expect(() => parseCliConfig(["--restrict-egress", "--no-restrict-egress"])).toThrow("mutually exclusive");
  });

  it("localhost bind host also defaults restrictEgress off", () => {
    expect(parseCliConfig(["--host", "localhost"]).restrictEgress).toBe(false);
  });
});

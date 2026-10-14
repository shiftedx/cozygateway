import { describe, expect, it } from "vitest";
import { ContractViolation, GatewaySettingsSchema, assertValid } from "../src/index.ts";

const endpoint = {
  id: "home",
  label: "Home Mac",
  url: "ws://home:8790/api/ws",
  tokenEnv: "HERMES_SESSION",
  profiles: { sage: { tokenEnv: "SAGE_ATTACH" } },
};

describe("gateway management contract", () => {
  it("accepts environment variable names without credential values", () => {
    expect(assertValid(GatewaySettingsSchema, { name: "Home", hermesEndpoints: [endpoint] }))
      .toMatchObject({ hermesEndpoints: [{ tokenEnv: "HERMES_SESSION" }] });
  });

  it.each(["token", "password", "secret", "credential"])("rejects inline %s values", (field) => {
    expect(() => assertValid(GatewaySettingsSchema, {
      name: "Home",
      hermesEndpoints: [{ ...endpoint, [field]: "actual-secret" }],
    })).toThrow(ContractViolation);
  });
});

import { readFileSync } from "node:fs";

import { type Static, Type } from "@sinclair/typebox";
import { ContractViolation, assertValid } from "cozygateway-contract";

const AgentConfigSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  avatar: Type.Optional(Type.String()),
  backend: Type.String({ minLength: 1 }),
  options: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type AgentConfig = Static<typeof AgentConfigSchema>;

const GatewayConfigSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  port: Type.Integer({ minimum: 1, maximum: 65535, default: 8787 }),
  dbPath: Type.String({ minLength: 1, default: "cozygateway.db" }),
  agents: Type.Array(AgentConfigSchema, { minItems: 1 }),
  /** Capability id -> integer version, surfaced verbatim as GatewayInfo.capabilities (contract
   *  v1.md section 5). Optional; a gateway with nothing to advertise omits it and gets an empty
   *  map (see server.ts). Ids under com.cozylabs.* are vendor extensions. */
  capabilities: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
});
export type GatewayConfig = Static<typeof GatewayConfigSchema>;

export function loadConfig(path: string): GatewayConfig {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const withDefaults =
    typeof raw === "object" && raw !== null
      ? { port: 8787, dbPath: "cozygateway.db", ...raw }
      : raw;
  const config = assertValid(GatewayConfigSchema, withDefaults);
  const seen = new Set<string>();
  for (const agent of config.agents) {
    if (seen.has(agent.id)) {
      throw new ContractViolation(`duplicate agent id "${agent.id}"`, "/agents");
    }
    seen.add(agent.id);
  }
  return config;
}

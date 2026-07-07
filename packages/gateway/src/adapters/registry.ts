import type { AgentConfig } from "../config.ts";
import type { BackendAdapter } from "./types.ts";
import { createMockAdapter } from "./mock.ts";

export function buildAdapters(agents: AgentConfig[]): Map<string, BackendAdapter> {
  const adapters = new Map<string, BackendAdapter>();
  for (const agent of agents) {
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else {
      throw new Error(`unknown backend "${agent.backend}" for agent "${agent.id}"`);
    }
  }
  return adapters;
}

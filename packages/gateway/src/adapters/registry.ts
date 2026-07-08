import type { AgentConfig } from "../config.ts";
import type { BackendAdapter } from "./types.ts";
import { createMockAdapter } from "./mock.ts";
import {
  createAttachAdapter,
  parseAttachOptions,
  type AttachAdapter,
  type TurnEndpoint,
} from "./attach/adapter.ts";

/** What the attach backend needs from the caller: the live ingress (turn delivery), the
 *  environment (token resolution), and a registration hook so ingress events route back to
 *  each built adapter. startGateway wires all three; bare callers without attach agents may
 *  omit it. */
export interface AttachWiring {
  endpoint: TurnEndpoint;
  env: Record<string, string | undefined>;
  register(agentId: string, adapter: AttachAdapter): void;
}

export function buildAdapters(
  agents: AgentConfig[],
  attach?: AttachWiring,
): Map<string, BackendAdapter> {
  const adapters = new Map<string, BackendAdapter>();
  for (const agent of agents) {
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else if (agent.backend === "attach") {
      if (attach === undefined) {
        throw new Error(
          `agent "${agent.id}": the attach backend requires the gateway's attach wiring`,
        );
      }
      const options = parseAttachOptions(agent, attach.env);
      const adapter = createAttachAdapter({
        agentId: agent.id,
        endpoint: attach.endpoint,
        turnTimeoutMs: options.turnTimeoutMs,
      });
      attach.register(agent.id, adapter);
      adapters.set(agent.id, adapter);
    } else {
      throw new Error(`unknown backend "${agent.backend}" for agent "${agent.id}"`);
    }
  }
  return adapters;
}

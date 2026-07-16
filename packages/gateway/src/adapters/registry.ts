import type { AgentConfig } from "../config.ts";
import type { BackendAdapter } from "./types.ts";
import { createMockAdapter, createSteerMockAdapter } from "./mock.ts";
import {
  createAttachAdapter,
  parseAttachOptions,
  type AttachAdapter,
  type TurnEndpoint,
} from "./attach/adapter.ts";
import { createOpenClawAdapter } from "./openclaw/adapter.ts";
import { createOpenClawClient, type OpenClawClient } from "./openclaw/client.ts";
import { parseOpenClawOptions } from "./openclaw/config.ts";
import { generateDeviceIdentity } from "./openclaw/device-auth.ts";

/** What the attach backend needs from the caller: the live ingress (turn delivery), the
 *  environment (token resolution), and a registration hook so ingress events route back to
 *  each built adapter. startGateway wires all three; bare callers without attach agents may
 *  omit it. */
export interface AttachWiring {
  endpoint: TurnEndpoint;
  env: Record<string, string | undefined>;
  register(agentId: string, adapter: AttachAdapter): void;
}

/** What the openclaw backend needs from the caller: the environment (token resolution) and a
 *  registration hook. Unlike attach, openclaw dials OUT (this branch owns one OpenClawClient per
 *  agent, generating a fresh per-agent DeviceIdentity and starting the connect+reconnect loop),
 *  so there is no shared ingress to construct; the hook instead hands the built client back to
 *  the caller so it can wire the client's presence into the hub and close it on shutdown.
 *  startGateway wires both; bare callers without openclaw agents may omit it. */
export interface OpenClawWiring {
  env: Record<string, string | undefined>;
  register(agentId: string, client: OpenClawClient): void;
}

export function buildAdapters(
  agents: AgentConfig[],
  attach?: AttachWiring,
  openclaw?: OpenClawWiring,
): Map<string, BackendAdapter> {
  const adapters = new Map<string, BackendAdapter>();
  for (const agent of agents) {
    if (agent.backend === "mock") {
      adapters.set(agent.id, createMockAdapter(agent.options as { failOn?: string } | undefined));
    } else if (agent.backend === "mock-steer") {
      adapters.set(agent.id, createSteerMockAdapter());
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
    } else if (agent.backend === "openclaw") {
      if (openclaw === undefined) {
        throw new Error(
          `agent "${agent.id}": the openclaw backend requires the gateway's openclaw wiring`,
        );
      }
      const options = parseOpenClawOptions(agent, openclaw.env);
      const client = createOpenClawClient({
        url: options.url,
        token: options.token,
        identity: generateDeviceIdentity(),
        protocolVersion: options.protocolVersion,
      });
      client.start();
      openclaw.register(agent.id, client);
      const adapter = createOpenClawAdapter({
        agentId: agent.id,
        client,
        turnTimeoutMs: options.turnTimeoutMs,
      });
      adapters.set(agent.id, adapter);
    } else {
      throw new Error(`unknown backend "${agent.backend}" for agent "${agent.id}"`);
    }
  }
  return adapters;
}

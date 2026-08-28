import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_INBOX_CAPABILITY_ID,
  BOTS_CAPABILITY_ID,
  BOTS_CAPABILITY_VERSION,
  type GatewayInfo,
} from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";

const gateways: RunningGateway[] = [];
const servers: FakeHermesServer[] = [];
afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  delete process.env["INBOX_RETIREMENT_HERMES_TOKEN"];
  delete process.env["INBOX_RETIREMENT_ATTACH_TOKEN"];
});

describe("hidden agent inbox", () => {
  it("does not register either legacy read route or advertise the dormant capability", async () => {
    const hermes = await startFakeHermesServer({ methods: { "profiles.list": () => ({ profiles: [] }) } });
    servers.push(hermes);
    process.env["INBOX_RETIREMENT_HERMES_TOKEN"] = "test-token";
    process.env["INBOX_RETIREMENT_ATTACH_TOKEN"] = "attach-token";
    const gateway = await startGateway({
      name: "inbox-retirement",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      hermes: {
        url: hermes.url,
        tokenEnv: "INBOX_RETIREMENT_HERMES_TOKEN",
        profiles: { sage: { tokenEnv: "INBOX_RETIREMENT_ATTACH_TOKEN", name: "Sage" } },
      },
    });
    gateways.push(gateway);

    expect((await fetch(`${gateway.url}/bots/sage/inbox`)).status).toBe(404);
    expect((await fetch(`${gateway.url}/bots/sage/inbox/thread-1/messages`)).status).toBe(404);
    expect((await fetch(`${gateway.url}/bots/sage/inbox/thread-1/messages`, { method: "POST" })).status).toBe(404);

    const health = (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;
    expect(health.capabilities?.[BOTS_CAPABILITY_ID]).toBe(BOTS_CAPABILITY_VERSION);
    expect(health.capabilities?.[AGENT_INBOX_CAPABILITY_ID]).toBeUndefined();
  });
});

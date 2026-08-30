import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_WORKSPACE_CAPABILITY_ID } from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";
import { testHermes } from "./support/test-config.ts";

const ROOT = "/srv/private-managed-files";
const servers: FakeHermesServer[] = [];
const gateways: RunningGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

async function start(root: string | null): Promise<RunningGateway> {
  const hermes = await startFakeHermesServer({
    dashboard: ({ path }) => path === "/api/files"
      ? {
          body: {
            path: root ?? "/Users/operator",
            parent: null,
            entries: [],
            root,
            locked_root: root,
            can_change_path: root === null,
          },
        }
      : { status: 404, body: { detail: "Not Found" } },
  });
  servers.push(hermes);
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  const gateway = await startGateway({
    name: "workspace-capability",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermes: testHermes(hermes.url),
  });
  gateways.push(gateway);
  return gateway;
}

describe("workspace startup capability proof", () => {
  it("advertises and serves the extension only after Hermes reports a locked root", async () => {
    const gateway = await start(ROOT);
    const health = await (await fetch(`${gateway.url}/health`)).json() as { capabilities?: Record<string, number> };
    expect(health.capabilities?.[HARNESS_WORKSPACE_CAPABILITY_ID]).toBe(1);
    expect(JSON.stringify(health)).not.toContain(ROOT);

    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
    });
    const token = (await pair.json() as { deviceToken: string }).deviceToken;
    const list = await fetch(`${gateway.url}/gateway/harnesses/default/scopes/mock/workspace`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ path: "", parent: null, entries: [] });
  });

  it("keeps the capability and route absent for a changeable or null root", async () => {
    const gateway = await start(null);
    const health = await (await fetch(`${gateway.url}/health`)).json() as { capabilities?: Record<string, number> };
    expect(health.capabilities?.[HARNESS_WORKSPACE_CAPABILITY_ID]).toBeUndefined();

    const pair = await fetch(`${gateway.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
    });
    const token = (await pair.json() as { deviceToken: string }).deviceToken;
    const list = await fetch(`${gateway.url}/gateway/harnesses/default/scopes/mock/workspace`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(404);
  });

  it("keeps the capability absent when the locked root itself is sensitive", async () => {
    for (const root of ["/srv/secrets", "/srv/hermes/config"]) {
      const gateway = await start(root);
      const health = await (await fetch(`${gateway.url}/health`)).json() as {
        capabilities?: Record<string, number>;
      };
      expect(health.capabilities?.[HARNESS_WORKSPACE_CAPABILITY_ID]).toBeUndefined();
      expect(JSON.stringify(health)).not.toContain(root);
    }
  });
});

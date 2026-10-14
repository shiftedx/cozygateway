import { afterEach, describe, expect, it } from "vitest";
import {
  HERMES_SESSION_MANAGEMENT_CAPABILITY_ID,
  HERMES_SESSION_MANAGEMENT_CAPABILITY_VERSION,
} from "cozygateway-contract";

import { startGateway, type RunningGateway } from "../src/server.ts";
import { startFakeHermesServer, type FakeHermesServer } from "./support/fake-hermes-server.ts";
import { testHermes } from "./support/test-config.ts";

const servers: FakeHermesServer[] = [];
const gateways: RunningGateway[] = [];

afterEach(async () => {
  for (const gateway of gateways.splice(0)) await gateway.close();
  for (const server of servers.splice(0)) await server.close();
  delete process.env.TEST_HERMES_CONTROL_TOKEN;
  delete process.env.TEST_ATTACH_TOKEN;
});

function queryParameters(...names: string[]) {
  return names.map((name) => ({ name, in: "query", schema: { type: "string" } }));
}

function openApi(complete: boolean, exactDetail: boolean): unknown {
  return {
    paths: {
      "/api/sessions": { get: { parameters: queryParameters("limit", "offset", "archived", "order", "profile") } },
      "/api/sessions/search": { get: { parameters: queryParameters("q", "limit", "profile") } },
      "/api/sessions/{session_id}": {
        get: exactDetail ? { parameters: queryParameters("profile") } : {},
        patch: {
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/SessionRename" } } },
          },
        },
        ...(complete ? { delete: {} } : {}),
      },
      "/api/sessions/{session_id}/messages": {
        get: { parameters: queryParameters("limit", "offset", "order", "include_compacted", "profile") },
      },
    },
    components: {
      schemas: {
        SessionRename: {
          properties: { title: {}, archived: {}, pinned: {}, profile: {} },
        },
      },
    },
  };
}

async function start(mode: "v2" | "v1" | "older" | "unreachable"): Promise<RunningGateway> {
  const hermes = await startFakeHermesServer(mode === "unreachable" ? {} : {
    dashboard: ({ path }) => {
      if (path === "/openapi.json")
        return { body: openApi(mode === "v2" || mode === "v1", mode === "v2") };
      if (path === "/api/sessions/search") return { body: { results: [] } };
      if (path === "/api/sessions") return { body: { sessions: [], total: 0 } };
      return { status: 404, body: { detail: "Not Found" } };
    },
  });
  servers.push(hermes);
  process.env.TEST_HERMES_CONTROL_TOKEN = "control-secret";
  process.env.TEST_ATTACH_TOKEN = "attach-secret";
  const gateway = await startGateway({
    name: "session-capability",
    port: 0,
    dbPath: ":memory:",
    turnTimeoutSeconds: 0,
    hermesEndpoints: [{ id: "default", ...testHermes(hermes.url) }],
  });
  gateways.push(gateway);
  return gateway;
}

async function pairedToken(gateway: RunningGateway): Promise<string> {
  const response = await fetch(`${gateway.url}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ setupCode: gateway.issueSetupCode(), deviceName: "phone" }),
  });
  return (await response.json() as { deviceToken: string }).deviceToken;
}

describe("Hermes session-management startup capability proof", () => {
  it("advertises and serves the extension only after current routes and shapes answer", async () => {
    const gateway = await start("v2");
    const health = await (await fetch(`${gateway.url}/health`)).json() as { capabilities?: Record<string, number> };
    expect(health.capabilities?.[HERMES_SESSION_MANAGEMENT_CAPABILITY_ID])
      .toBe(HERMES_SESSION_MANAGEMENT_CAPABILITY_VERSION);

    const response = await fetch(`${gateway.url}/gateway/harnesses/default/scopes/mock/sessions`, {
      headers: { authorization: `Bearer ${await pairedToken(gateway)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessions: [], pagination: { total: 0 } });
  });

  it("keeps an unparameterized detail GET at v1 and fails the exact action closed", async () => {
    const gateway = await start("v1");
    const health = await (await fetch(`${gateway.url}/health`)).json() as { capabilities?: Record<string, number> };
    expect(health.capabilities?.[HERMES_SESSION_MANAGEMENT_CAPABILITY_ID]).toBe(1);

    const response = await fetch(
      `${gateway.url}/gateway/harnesses/default/scopes/mock/sessions/hermes-1`,
      { headers: { authorization: `Bearer ${await pairedToken(gateway)}` } },
    );
    expect(response.status).toBe(503);
  });

  it.each(["older", "unreachable"] as const)("omits the capability and route for %s Hermes", async (mode) => {
    const gateway = await start(mode);
    const health = await (await fetch(`${gateway.url}/health`)).json() as { capabilities?: Record<string, number> };
    expect(health.capabilities?.[HERMES_SESSION_MANAGEMENT_CAPABILITY_ID]).toBeUndefined();

    const response = await fetch(`${gateway.url}/gateway/harnesses/default/scopes/mock/sessions`, {
      headers: { authorization: `Bearer ${await pairedToken(gateway)}` },
    });
    expect(response.status).toBe(404);
  });
});

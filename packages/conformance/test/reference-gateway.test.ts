/** In-repo runner: the reference gateway proves it speaks contract v1 by running the exact
 *  same black-box conformance suite a third party would run. The gateway is exercised only
 *  over HTTP + WebSocket; the suite (src/) never imports gateway internals. */
import { afterAll, beforeAll } from "vitest";
import { startGateway, type RunningGateway } from "cozygateway";

import { registerConformanceSuite } from "../src/suite.ts";

let gateway: RunningGateway;

beforeAll(async () => {
  gateway = await startGateway({
    name: "conformance-reference",
    port: 0,
    dbPath: ":memory:",
    agents: [{ id: "conformance-echo", name: "Echo", backend: "mock" }],
  });
});

afterAll(async () => {
  await gateway.close();
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
});

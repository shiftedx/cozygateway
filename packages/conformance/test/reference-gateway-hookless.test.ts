/** Portability guard for the OPTIONAL stall hook (issue #21).
 *
 *  The live in-flight interrupt group needs a stall-capable backend, which not every gateway
 *  has. This runner is the standing proof that the hook stayed optional: it boots the reference
 *  gateway with the echo backend ONLY, declares no `stallAgentId`, and runs the whole portable
 *  suite. A green run here means a third-party gateway with no stall backend still passes exactly
 *  what it passed before the hook existed, with the live-202 cases reported as skipped rather
 *  than failing. Should someone ever make the hook mandatory (assert it in the env, or reach for
 *  it outside the gated group), this file goes red first. */
import { afterAll, beforeAll } from "vitest";
import { startGateway, type RunningGateway } from "cozygateway";

import { registerConformanceSuite } from "../src/suite.ts";

let gateway: RunningGateway;

// Same rationale as the primary runner: the push group registers an unroutable relayUrl, so the
// notifier's one failed delivery attempt goes to this sink instead of stderr.
const notifierLogLines: string[] = [];

beforeAll(async () => {
  gateway = await startGateway(
    {
      name: "conformance-reference-hookless",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      agents: [{ id: "conformance-echo", name: "Echo", backend: "mock" }],
    },
    { notifierLog: (message) => notifierLogLines.push(message) },
  );
});

afterAll(async () => {
  await gateway.close();
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
  // Deliberately no stallAgentId: this is the hookless gateway a third party may be.
});

/** In-repo runner: the reference gateway proves it speaks contract v1 by running the exact
 *  same black-box conformance suite a third party would run. The gateway is exercised only
 *  over HTTP + WebSocket; the suite (src/) never imports gateway internals. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGateway, type RunningGateway } from "cozygateway";
import type { GatewayInfo } from "cozygateway-contract";

import { registerConformanceSuite } from "../src/suite.ts";

let gateway: RunningGateway;

// The push-registration group below registers a real-looking but unroutable relayUrl (spec
// section 5 only requires the registration call to succeed, never an actual delivery), so the
// gateway's fire-and-forget push notifier is expected to fail its one delivery attempt against
// it. That failure is harmless and correct, but would otherwise print an unstructured
// "push: notify failed for device <id>: fetch failed" line to real stderr on every conformance
// run. `notifierLog` (issue #10) redirects it into this in-memory sink instead, so `pnpm check`
// output stays pristine without weakening the notifier's default production logging (which is
// untouched: a real gateway with no override still writes straight to stderr).
const notifierLogLines: string[] = [];

// Issue #16: the reference gateway advertises one fake vendor capability so this file (not the
// portable suite in src/, which stays generic across arbitrary gateways under test) can prove a
// com.cozylabs.* capability travels end to end: configured here, read back below.
const FAKE_VENDOR_CAPABILITY = "com.cozylabs.test";

beforeAll(async () => {
  gateway = await startGateway(
    {
      name: "conformance-reference",
      port: 0,
      dbPath: ":memory:",
      turnTimeoutSeconds: 0,
      agents: [{ id: "conformance-echo", name: "Echo", backend: "mock" }],
      capabilities: { [FAKE_VENDOR_CAPABILITY]: 1 },
    },
    { notifierLog: (message) => notifierLogLines.push(message) },
  );
});

afterAll(async () => {
  await gateway.close();
  // The sink should only ever have collected the expected, harmless notify failure against the
  // unroutable relayUrl above, never some unrelated notifier error it accidentally swallowed.
  for (const line of notifierLogLines) {
    expect(line).toMatch(/^push: notify failed for device .+: fetch failed$/);
  }
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
});

// This end-to-end check is specific to the reference gateway's own fixture (a fake
// com.cozylabs.test vendor capability), so it lives here rather than in the portable
// registerConformanceSuite: a legitimate third-party gateway has no reason to implement this
// exact made-up id, and the shared suite must not require it (see src/suite.ts's own generic
// "capabilities" describe block for the assertions every gateway is held to).
describe("reference gateway vendor capability (issue #16)", () => {
  it("advertises the configured com.cozylabs.test capability end to end via GET /health", async () => {
    const info = (await (await fetch(`${gateway.url}/health`)).json()) as GatewayInfo;
    expect(info.capabilities?.[FAKE_VENDOR_CAPABILITY]).toBe(1);
  });
});

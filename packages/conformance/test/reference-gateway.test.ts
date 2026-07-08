/** In-repo runner: the reference gateway proves it speaks contract v1 by running the exact
 *  same black-box conformance suite a third party would run. The gateway is exercised only
 *  over HTTP + WebSocket; the suite (src/) never imports gateway internals. */
import { afterAll, beforeAll, expect } from "vitest";
import { startGateway, type RunningGateway } from "cozygateway";

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

beforeAll(async () => {
  gateway = await startGateway(
    {
      name: "conformance-reference",
      port: 0,
      dbPath: ":memory:",
      agents: [{ id: "conformance-echo", name: "Echo", backend: "mock" }],
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

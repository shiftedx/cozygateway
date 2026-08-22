/** In-repo runner: the reference gateway proves it speaks contract v1 by running the exact
 *  same black-box conformance suite a third party would run. The gateway is exercised only
 *  over HTTP + WebSocket; the suite (src/) never imports gateway internals. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayInfo } from "cozygateway-contract";

import { registerConformanceSuite } from "../src/suite.ts";
import { ReferenceAttachGateway } from "./reference-attach.ts";

let reference: ReferenceAttachGateway;

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
  reference = new ReferenceAttachGateway(true, (message) => notifierLogLines.push(message));
  await reference.start();
});

afterAll(async () => {
  await reference.close();
  // The sink should only ever have collected the expected, harmless notify failures against the
  // unroutable relayUrl above, never some unrelated notifier error it accidentally swallowed.
  // Both push legs land here: an agent reply ("notify failed") and, since the approval agent above
  // raises one per turn, the approval leg ("approval notify failed").
  for (const line of notifierLogLines) {
    expect(line).toMatch(/^push: (approval )?notify failed for device .+: fetch failed$/);
  }
});

registerConformanceSuite({
  baseUrl: () => reference.gateway?.url ?? "",
  issueSetupCode: () => Promise.resolve(reference.gateway?.issueSetupCode() ?? ""),
  echoAgentId: "conformance-echo",
  stallAgentId: "conformance-stall",
  approvalAgentId: "conformance-approval",
});

// This end-to-end check is specific to the reference gateway's own fixture (a fake
// com.cozylabs.test vendor capability), so it lives here rather than in the portable
// registerConformanceSuite: a legitimate third-party gateway has no reason to implement this
// exact made-up id, and the shared suite must not require it (see src/suite.ts's own generic
// "capabilities" describe block for the assertions every gateway is held to).
describe("reference gateway vendor capability (issue #16)", () => {
  it("advertises the configured com.cozylabs.test capability end to end via GET /health", async () => {
    const info = (await (await fetch(`${reference.gateway?.url}/health`)).json()) as GatewayInfo;
    expect(info.capabilities?.[FAKE_VENDOR_CAPABILITY]).toBe(1);
  });
});

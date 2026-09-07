/** F9: the portable black-box conformance suite (`../src/suite.ts`) run against a Hermes-free
 *  reference gateway. This is the escalation R1's own report named and deferred: "a third runner
 *  of the whole portable suite against a Hermes-free reference gateway", reverted there because
 *  it failed 15 cases for reasons that had nothing to do with rooms.
 *
 *  Every one of those 15 traced back to two things:
 *
 *  1. `GET /health`'s documented Hermes-free shape, `bridges: { hermes: "absent" }`
 *     (`packages/gateway/src/http.ts:924,948`), is a STRING, but `GatewayInfoSchema.bridges` only
 *     accepted the `BridgeLivenessSchema` object shape. Every helper in the portable suite that
 *     validates a `GatewayInfo` (directly, or embedded in `PairResponseSchema` / `ReadyFrameSchema`)
 *     therefore rejected the very first `/pair` call, which is why the failure count was so much
 *     larger than "the health case" alone: `pairDevice()` is the suite's own precondition for
 *     nearly everything else. Fixed by widening `GatewayInfoSchema.bridges`'s value type to accept
 *     either the object or the literal `"absent"` (`packages/contract/src/resources.ts`), matching
 *     the gateway's own already-documented behavior rather than changing the gateway to match the
 *     suite.
 *  2. `POST /threads { agentId }` accepted a runtime bot id (the bot is a real row in the shared
 *     `agents` table, so 404 was never the failure), but every send against that thread answered
 *     503 `backend_unavailable`. The gateway's adapter/router registration loop
 *     (`packages/gateway/src/server.ts`) only ever built a `BackendAdapter` for Hermes profiles,
 *     never for runtime bots, even though rooms already prove a runtime bot's turns can be routed
 *     over the exact same attach-v1 ingress via `sendNativeTurn`. That was a genuine gateway gap,
 *     not a suite assumption: a plain 1:1 thread against a runtime bot is supposed to work exactly
 *     like a Hermes-profile one. Fixed by registering runtime bots into the same `adapters`/
 *     `router` maps the Hermes profiles already use.
 *
 *  The one portable-suite group NOT enabled here, capability 68's phone request lifecycle, is not
 *  a third finding: `com.cozylabs.mobile-node` is genuinely gated on having a Hermes endpoint
 *  configured (`packages/gateway/src/server.ts`'s `gatewayInfoForConfig`), because the phone bridge
 *  it versions is a Hermes-Dashboard feature. A Hermes-free gateway correctly does not advertise
 *  it, so this runner omits `mobileRequestLifecycle`, the same way the hookless runner omits the
 *  stall and approval hooks it genuinely lacks.
 *
 *  Both existing in-repo runners (`reference-gateway.test.ts`, `reference-gateway-hookless.test.ts`)
 *  stay green and unchanged: neither fix above narrows what a Hermes-attached gateway is held to,
 *  since a `bridges.hermes` object still validates and every Hermes-profile adapter is still
 *  registered exactly as before. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GatewayInfoSchema, PairResponseSchema, assertValid } from "cozygateway-contract";

import { registerConformanceSuite } from "../src/suite.ts";
import { ReferenceAttachGatewayHermesFree } from "./reference-attach.ts";

let reference: ReferenceAttachGatewayHermesFree;

beforeAll(async () => {
  reference = new ReferenceAttachGatewayHermesFree();
  await reference.start();
});

afterAll(async () => {
  await reference.close();
});

// The two fixes named in the file header, pinned as their own cases so either one going red again
// says exactly which finding regressed, ahead of the full portable suite below.
describe("Hermes-free gateway fixes (F9)", () => {
  it("the health case accepts the Hermes-absent bridge string shape", async () => {
    const res = await fetch(`${reference.gateway?.url}/health`);
    expect(res.status).toBe(200);
    const info = assertValid(GatewayInfoSchema, await res.json());
    expect(info.bridges?.hermes).toBe("absent");
  });

  it("thread creation and turns work against a runtime bot echo peer with no Hermes profile behind it", async () => {
    const pairRes = await fetch(`${reference.gateway?.url}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupCode: reference.gateway?.issueSetupCode(), deviceName: "hermes-free-thread" }),
    });
    expect(pairRes.status).toBe(200);
    const paired = assertValid(PairResponseSchema, await pairRes.json());

    const thread = await (await fetch(`${reference.gateway?.url}/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${paired.deviceToken}` },
      body: JSON.stringify({ agentId: "conformance-echo", title: "hermes-free thread" }),
    })).json() as { id: string };

    const sent = await fetch(`${reference.gateway?.url}/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${paired.deviceToken}` },
      body: JSON.stringify({ blocks: [{ type: "paragraph", text: "hello runtime bot" }] }),
    });
    // Before the gateway fix this was 503 backend_unavailable: no adapter was ever registered for
    // a runtime bot id, only for Hermes profiles.
    expect(sent.status).toBe(200);
  });
});

registerConformanceSuite({
  durableTasks: true,
  artifactDelivery: true,
  // Deliberately omitted: mobileRequestLifecycle. `com.cozylabs.mobile-node` is a Hermes-Dashboard
  // phone bridge capability; a Hermes-free gateway correctly never advertises it, so declaring the
  // hook here would assert a promise this gateway shape does not make.
  baseUrl: () => reference.gateway?.url ?? "",
  issueSetupCode: () => Promise.resolve(reference.gateway?.issueSetupCode() ?? ""),
  echoAgentId: "conformance-echo",
  stallAgentId: "conformance-stall",
  approvalAgentId: "conformance-approval",
  repairApproval: { botName: "conformance-approval" },
});

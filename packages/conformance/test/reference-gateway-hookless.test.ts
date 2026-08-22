/** Portability guard for the OPTIONAL hooks: the stall hook (issue #21), approval hook
 *  (issue #19), Hermes bot model-config hook (issue #106), bot stop hook (issue #114), and bot
 *  new-session hook (issue #115).
 *
 *  The live in-flight interrupt group needs a stall-capable backend, and the approval group needs
 *  an approval-capable one; not every gateway has either. This runner is the standing proof that
 *  both hooks stayed optional: it boots the reference gateway with the echo backend ONLY, declares
 *  neither hook, and runs the whole portable suite. A green run here means a third-party gateway
 *  with no such backends still passes exactly what it passed before the hooks existed, with the
 *  live-202 and approval cases reported as skipped rather than failing. Should someone ever make
 *  either hook mandatory (assert it in the env, or reach for it outside its gated group), this
 *  file goes red first. */
import { afterAll, beforeAll } from "vitest";

import { registerConformanceSuite } from "../src/suite.ts";
import { ReferenceAttachGateway } from "./reference-attach.ts";

let reference: ReferenceAttachGateway;

// Same rationale as the primary runner: the push group registers an unroutable relayUrl, so the
// notifier's one failed delivery attempt goes to this sink instead of stderr.
const notifierLogLines: string[] = [];

beforeAll(async () => {
  reference = new ReferenceAttachGateway(false, (message) => notifierLogLines.push(message));
  await reference.start();
});

afterAll(async () => {
  await reference.close();
});

registerConformanceSuite({
  baseUrl: () => reference.gateway?.url ?? "",
  issueSetupCode: () => Promise.resolve(reference.gateway?.issueSetupCode() ?? ""),
  echoAgentId: "conformance-echo",
  // Deliberately no stallAgentId, approvalAgentId, botModelConfig, botChatStop, or botNewSession:
  // this is the hookless gateway a third party may be.
});

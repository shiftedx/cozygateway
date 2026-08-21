# cozygateway-conformance

A black-box conformance suite for the cozygateway wire contract v1. Point it at any gateway
implementation and it proves, over HTTP and WebSocket alone, that the implementation speaks
the wire the contract describes.

## What conformance means

A gateway is conformant when this suite passes against it while the gateway exposes the
reference echo backend. Every assertion is authored from the frozen spec (`contract/v1.md`)
and the `cozygateway-contract` schemas, never from any gateway's source code. The suite reads
and writes only the public REST and WebSocket surface, so a green run is evidence the
implementation matches the contract, not that it shares the reference code.

The suite covers the core groups: health, capabilities, pairing, the auth wall, device lifecycle,
agents, thread lifecycle, message round trip and seq discipline, WebSocket lifecycle, streaming
order, reconnect dedup, turn failure, mid-turn interrupt, the live in-flight interrupt, and the
approval lifecycle, plus the agent inbox. Optional backend-specific groups activate only when the
gateway declares the matching hook and are otherwise reported as skipped.

The capabilities group checks the additive `GatewayInfo.capabilities` block (contract v1.md
section 5, issue #16) generically: that it agrees across `GET /health`, the pair response, and
the `ready` frame when present, and that the wire schema tolerates it being entirely absent
(older gateways) or carrying capability ids the suite has never heard of. It never pins a
specific capability id, so it stays portable across any gateway under test, including one that
advertises no capabilities at all. This repo's own reference-gateway runner additionally proves
one fake `com.cozylabs.*` vendor capability travels end to end (see "Running the reference
gateway's own conformance" below); that check is specific to the reference gateway's fixture and
intentionally lives outside the portable suite.

## The reference echo backend

The suite drives the reference echo backend, whose semantics are frozen in section 7 of the
contract. An agent whose reply to a message whose first block is
`{ "type": "paragraph", "text": T }` produces:

1. exactly two draft frames, then
2. a commit of `[{ "type": "paragraph", "text": "Echo: " + T }]`.

A value of `T` that contains the substring `[[fail]]` fails the turn: the gateway completes it
as a `turn.failed` system message rather than an echo commit (a committed `role: "system"`
message carrying `marker: "turn.failed"`, plus a `turn_failed` error frame, and no `done`
frame).

## Wiring it into your own vitest run

The package exports one function:

```ts
import { registerConformanceSuite } from "cozygateway-conformance";
```

`registerConformanceSuite(env)` calls vitest's `describe`/`it` to register the whole suite, so
call it at the top level of a test file in your own vitest project. You supply a
`ConformanceEnv` that reaches your gateway under test:

```ts
export interface ConformanceEnv {
  /** Base HTTP URL of the gateway under test, no trailing slash. */
  baseUrl: () => string;
  /** Mint a fresh single-use setup code on the gateway under test. */
  issueSetupCode: () => Promise<string>;
  /** Agent id of the reference echo backend on the gateway under test. */
  echoAgentId: string;
  /** Optional: agent id of a stall-capable, interruptible backend. See "The optional stall hook". */
  stallAgentId?: string;
  /** Optional: agent id of an approval-capable backend. See "The optional approval hook". */
  approvalAgentId?: string;
  /** Optional: one seeded capability-17 a2a thread. See "The optional agent inbox hook". */
  botInbox?: { botName: string; threadId: string };
  /** Optional: one capability-18 Hermes bot. See "The optional bot model-config hook". */
  botModelConfig?: { botName: string };
  /** Optional: one capability-19 Hermes bot. See "The optional bot chat-stop hook". */
  botChatStop?: { botName: string; prompt?: string };
}
```

A minimal runner that boots the gateway, registers the suite, and tears it down:

```ts
import { afterAll, beforeAll } from "vitest";

import { registerConformanceSuite } from "cozygateway-conformance";
import { startYourGateway } from "./your-gateway.ts";

let gateway;

beforeAll(async () => {
  gateway = await startYourGateway({ echoAgentId: "conformance-echo" });
});

afterAll(async () => {
  await gateway.close();
});

registerConformanceSuite({
  baseUrl: () => gateway.url,
  issueSetupCode: () => Promise.resolve(gateway.issueSetupCode()),
  echoAgentId: "conformance-echo",
});
```

Your gateway must expose the reference echo backend under the `echoAgentId` you pass. Boot it
on an ephemeral port with an in-memory or temp-dir database so the run stays isolated. Peer
dependency: `vitest >= 3`.

## The optional bot model-config hook

Declare `botModelConfig` with the name of a capability-18 Hermes bot to check the fixed
`GET /bots/:name/model-config` shape, its device-auth wall, and unknown-model validation on PUT.
The suite deliberately sends only a model id that cannot be in the returned catalog, so the
conformance run does not mutate the bot's live profile.

## The optional bot chat-stop hook

Declare `botChatStop` with a capability-19 Hermes bot whose configured model stays in flight after
the supplied prompt until interrupted. The fixture must be idle when the group begins. The suite
checks the device-auth wall, the idle 409, a live send followed by stop, the fixed
`{ "status": "stopped" }` response, the shared `bot_chat_state` complete frame, and the return to
idle. Omit the hook and this group is reported as skipped.

## The optional stall hook

The echo backend is queue-only: it finishes a turn as fast as it can, so a black-box run has no
in-flight window in which to interrupt it. That leaves the 202 path of
`POST /threads/:id/interrupt` (contract v1.md section 5) provable only at the schema level. The
stall hook closes that gap.

Declare `stallAgentId` and the suite adds one group that drives the real sequence: it sends into
a thread on that agent, waits for the draft, interrupts mid-flight, and holds your gateway to the
contract's 202 semantics.

**What the hook promises.** `stallAgentId` names an agent on the gateway under test whose backend:

1. on a send, emits at least one `draft` frame for the turn and then **stays in flight**: it never
   commits, never emits `done`, and never fails on its own. It ends only when interrupted.
2. honors a hard interrupt, so that while that turn is in flight
   `POST /threads/:id/interrupt` answers `202` with body `{"status":"interrupting"}`, and the turn
   then ends as a committed `role: "system"` message carrying `marker: "turn.interrupted"` with
   the interrupted turn's `turnId`, followed by a `done` frame for that same turn, and **no**
   `error` frame (in particular neither `turn_failed` nor `interrupt_unsupported`). The system
   message is durable: it shows up in `GET /threads/:id/messages`, and no agent message does.
3. leaves the thread idle afterward, so a second interrupt on it is `204`.

Anything satisfying that is a valid hook. The reference gateway implements it with its
`mock-steer` backend (one draft, then it waits for a steer or an interrupt); a third-party gateway
can point it at any test backend of its own, or at a real backend it can reliably park.

**It is optional on purpose.** Omit `stallAgentId` and the group is reported as skipped while
every other assertion runs unchanged, so a gateway with no stall-capable backend passes exactly
what it passed before the hook existed. This repo keeps a second runner
(`test/reference-gateway-hookless.test.ts`) that declares no hook, as standing proof that the
suite stays portable.

## The optional approval hook

The approval surface (contract v1.md section 5a, capability `approvals`) is optional, and the
echo backend never pauses on a tool call, so a black-box run has no pending approval to decide.
The approval hook closes that gap the same way the stall hook does.

Declare `approvalAgentId` and the suite adds one group that drives the real sequence: it sends
into a thread on that agent, waits for the `approval_pending` frame, resolves it over
`POST /threads/:id/approvals/:toolCallId/{approve,deny}`, and holds your gateway to the
contract's semantics for both verbs plus the error paths.

**What the hook promises.** `approvalAgentId` names an agent on the gateway under test whose
backend:

1. on a send, emits at least one `approval_pending` frame for the turn -- carrying that turn's
   `turnId`, a non-empty `toolCallId`, and a non-empty tool `name` -- and then **stays in
   flight**: it does not commit and does not emit `done` before the approval is resolved.
2. honors both verbs, so `POST /threads/:id/approvals/:toolCallId/approve` answers `202` with
   body `{"status":"approved"}` (and `deny` answers `202 {"status":"denied"}`), followed by
   exactly one `approval_resolved` frame carrying the same `threadId`, `turnId`, `toolCallId`
   and the matching `outcome`.
3. leaves the decision final: resolving the same `toolCallId` again is `409`
   `approval_not_pending` and produces no second frame.

The suite additionally asserts what any gateway implementing the surface owes: an unknown
`toolCallId` is `404 not_found`, an unauthenticated resolve is `401 unauthorized`, and
`GET /health` advertises the `approvals` capability at version 1.

The group does not require the third terminal state (`expired`) to be drivable: a lapse depends
on a timeout the suite cannot force from outside, so it stays in the implementation's own tests.

**It is optional on purpose**, exactly like the stall hook: omit `approvalAgentId` and the group
is reported as skipped while every other assertion runs unchanged. The same hookless runner
(`test/reference-gateway-hookless.test.ts`) is the standing proof, since it declares neither hook.

The reference gateway implements it with its `mock-approval` backend (one draft, one pending
approval, then it parks until the approval is resolved or its own bounded window lapses).

## The optional agent inbox hook

The agent inbox is a vendor extension backed by Hermes rather than the reference echo backend, so a
portable conformance run cannot create its own a2a fixture. Declare `botInbox` when the gateway under
test has a seeded capability-17 thread. `botName` names its owning bot and `threadId` names a thread
that must appear in that bot's newest 50 inbox rows.

The suite validates both authenticated GET routes against the contract schemas. It also checks the
50-row bound, newest-first ordering, device authentication, per-agent `member` attribution, and the
absence of a POST send route. Omit `botInbox` and this group is reported as skipped.

## Running the reference gateway's own conformance

This repo ships two runners, both exercised by one command:

```bash
pnpm --filter cozygateway-conformance test
```

- `test/reference-gateway.test.ts` starts the reference gateway with the mock echo adapter, the
  `mock-steer` stall backend **and** the `mock-approval` backend, declares both hooks, and runs
  the whole suite including the live in-flight interrupt and approval groups.
- `test/reference-gateway-hookless.test.ts` starts it with the echo adapter alone and declares no
  hooks, so the live-202, approval, and agent-inbox cases are skipped and the rest must still be green.

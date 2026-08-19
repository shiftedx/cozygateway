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

The suite covers fourteen groups: health, capabilities, pairing, the auth wall, device lifecycle,
agents, thread lifecycle, message round trip and seq discipline, WebSocket lifecycle, streaming
order, reconnect dedup, turn failure, mid-turn interrupt, and the live in-flight interrupt. Every
group but the last runs against any gateway; the last one activates only when the gateway
declares the optional stall hook (see "The optional stall hook" below) and is otherwise reported
as skipped.

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

## Running the reference gateway's own conformance

This repo ships two runners, both exercised by one command:

```bash
pnpm --filter cozygateway-conformance test
```

- `test/reference-gateway.test.ts` starts the reference gateway with the mock echo adapter **and**
  the `mock-steer` stall backend, declares the stall hook, and runs the whole suite including the
  live in-flight interrupt group.
- `test/reference-gateway-hookless.test.ts` starts it with the echo adapter alone and declares no
  hook, so the live-202 cases are skipped and the rest must still be green.
